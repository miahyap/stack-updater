// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The REAL update.sh, run with `docker`, `curl`, `sleep` and `flock` stubbed on
// PATH. The docker stub keeps a small registry: what each tag points at, what a
// pull would fetch, and each service's container. An image can be marked
// broken in a way the checks would see (its API gone, no network, crash loop).
//
// What it guards: floating tags mean an update can arrive that breaks the
// stack, so it must be noticed by checking the stack as clients use it, taken
// back for every service whose old image can simply be put back, and never
// taken back for Windmill, whose database the new one has already migrated
// (that one gets a dump beforehand instead). And gluetun is only ever
// recreated through compose, which recreates SearXNG (joined to its network)
// with it: Watchtower recreating gluetun alone leaves SearXNG with no network.
//
// The stubbed stack is a VPN (gluetun), a search engine on its network
// (SearXNG), Windmill, Alertmanager and a sidecar: the services the built-in
// checks are for.

const SCRIPT = join(import.meta.dirname, "update.sh");

const STUBS = {
  // A small registry: ref/<ref> is what a tag points at locally, registry/<ref>
  // what a pull of it fetches, c/<service> each container. The compose file's
  // images take ${VAR}s from the --env-file, as compose does.
  docker: `#!/bin/sh
echo "$*" >>"$STUB/calls"
key() { printf '%s' "$1" | tr '/:' '__'; }
envfile=
if [ "$1" = compose ]; then
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      -p) shift 2 ;;
      -f) echo "$2" >>"$STUB/compose_files"; shift 2 ;;
      --env-file) envfile=$2; shift 2 ;;
      *) break ;;
    esac
  done
  set -- compose "$@"
fi
render() {
  cfg=$(cat "$STUB/config.json")
  while IFS='=' read -r k v; do
    case $k in "" | \\#*) continue ;; esac
    cfg=$(printf '%s' "$cfg" | sed "s|\\\${$k}|$v|g")
  done <"$envfile"
  printf '%s\\n' "$cfg"
}
img_of_svc() { render | jq -r --arg s "$1" '.services[$s].image'; }
marked() { [ -f "$STUB/broken/$1" ] && grep -qx "$2" "$STUB/broken/$1"; }
create() { # <service> <image id>: the container (re)created from that image
  if marked "$2" exits; then st="exited		1	1"
  else st="running		0	0"; fi
  printf '%s\\t%s\\n' "$2" "$st" >"$STUB/c/$1"
  echo "$1" >>"$STUB/created"
}
case $1 in
  compose)
    shift
    sub=$1; shift
    case $sub in
      config) case "$*" in *--services*) cat "$STUB/services" ;; *) render ;; esac ;;
      ps) eval svc=\\\${$#}; [ -f "$STUB/c/$svc" ] && echo "c-$svc" ;;
      up)
        rc=0
        for a; do
          case $a in -* | [0-9]* | never) continue ;; esac
          id=$(cat "$STUB/ref/$(key "$(img_of_svc "$a")")")
          [ "$(cut -f1 "$STUB/c/$a" 2>/dev/null)" = "$id" ] || create "$a" "$id"
          marked "$id" exits && rc=1
        done
        exit $rc ;;
    esac ;;
  pull)
    k=$(key "$3")
    [ -f "$STUB/pullfail/$k" ] && exit 1
    if [ -f "$STUB/registry/$k" ]; then cp "$STUB/registry/$k" "$STUB/ref/$k"
    elif [ ! -f "$STUB/ref/$k" ]; then exit 1; fi ;;
  inspect)
    if [ "$2" = -f ]; then
      svc=\${4#c-}; line=$(cat "$STUB/c/$svc")
      if marked "$(printf '%s' "$line" | cut -f1)" crashloop; then
        line=$(printf '%s\\n' "$line" | awk -F'\\t' 'BEGIN { OFS = "\\t" } { $4 = $4 + 1; print }')
        printf '%s\\n' "$line" >"$STUB/c/$svc"
      fi
      printf '%s\\n' "$line"
    else
      echo 'HTTP_CONTROL_SERVER_AUTH_DEFAULT_ROLE={"auth":"basic","username":"controlserver","password":"pw"}'
    fi ;;
  image) k=$(key "$5"); [ -f "$STUB/ref/$k" ] || exit 1; cat "$STUB/ref/$k" ;;
  tag)
    case $2 in sha256:*) id=$2 ;; *) id=$(cat "$STUB/ref/$(key "$2")") ;; esac
    echo "$id" >"$STUB/ref/$(key "$3")" ;;
  rmi)
    # As docker does without -f: refuses an image's last tag while a container
    # uses it, and only untags an image tagged otherwise.
    k=$(key "$2")
    [ -f "$STUB/ref/$k" ] || exit 1
    id=$(cat "$STUB/ref/$k")
    if cut -f1 "$STUB"/c/* | grep -qxF "$id" && [ "$(grep -lxF "$id" "$STUB"/ref/* | wc -l)" -eq 1 ]; then
      echo "conflict: unable to remove repository reference $2" >&2; exit 1
    fi
    rm -f "$STUB/ref/$k" ;;
  run)
    if [ "$2" = -d ]; then echo "$*" >>"$STUB/helpers"; exit 0; fi
    [ -f "$STUB/dumpfail" ] && exit 1
    echo "\${PGURL:-}" >"$STUB/pgurl"
    vol=; prev=
    for a; do [ "$prev" = -v ] && vol=\${a%%:*}; prev=$a; done
    eval last=\\\${$#}
    touch "$vol/$(printf '%s' "$last" | sed -nE 's#.*/backup/([^ ]+).*#\\1#p')" ;;
esac
exit 0
`,
  // The checks: what each endpoint answers depends on the image its service
  // runs, so a broken image shows up only once it's running. And the
  // registries' tag lists, two pages where tags/<repo>.2 exists.
  curl: `#!/bin/sh
url=; data=; headers=; prev=
for a; do
  case $prev in --data-binary) data=$a ;; -D) headers=$a ;; esac
  case $a in http*) url=$a ;; esac
  prev=$a
done
[ -n "$headers" ] && : >"$headers"
broken() { f="$STUB/broken/$(cut -f1 "$STUB/c/$1" 2>/dev/null)"; [ -f "$f" ] && grep -qx "$2" "$f"; }
case $url in
  */api/v2/alerts) printf '%s\\n' "$data" >>"$STUB/alerts" ;;
  */token\\?*) echo '{"token":"anonymous"}' ;;
  */v2/*/tags/list*)
    [ -f "$STUB/tagsfail" ] && exit 22
    echo "$url" >>"$STUB/tag_urls"
    name=$(printf '%s' "$url" | sed -E 's#^https://[^/]+/v2/(.*)/tags/list.*#\\1#')
    f="$STUB/tags/$(printf '%s' "$name" | tr '/' '_')"
    case $url in
      *last=*) f=$f.2 ;;
      *) [ -f "$f.2" ] && printf 'Link: </v2/%s/tags/list?n=1000&last=x>; rel="next"\\r\\n' "$name" >"$headers" ;;
    esac
    jq -Rn '{tags: [inputs | select(. != "")]}' "$f" ;;
  */v1/vpn/status) broken gluetun api && exit 22; echo '{"status":"running"}' ;;
  */v1/vpn/settings)
    broken gluetun api && exit 22
    broken gluetun settings && { echo '{"vpn":{"provider":{}}}'; exit 0; }
    echo '{"type":"wireguard","provider":{"name":"example-vpn","server_selection":{"regions":[]}},"wireguard":{"private_key":"PRIVATE-KEY"}}' ;;
  */search*)
    if broken gluetun nonet || broken searxng nonet; then
      echo '{"results":[],"unresponsive_engines":[["brave","HTTP connection error"],["google","HTTP connection error"]]}'
      exit 0
    fi
    broken searxng api && exit 22
    if [ -f "$STUB/blocked" ]; then
      echo '{"results":[],"unresponsive_engines":[["brave","CAPTCHA"],["google","access denied"]]}'
      exit 0
    fi
    echo '{"results":[{"url":"https://a.example"}],"unresponsive_engines":[]}' ;;
  */api/version) broken windmill api && exit 22; echo "CE v1.846.0" ;;
  */-/healthy) broken alertmanager api && exit 22; echo OK ;;
  */down) exit 22 ;;
esac
exit 0
`,
  sleep: "#!/bin/sh\nexit 0\n",
  flock: '#!/bin/sh\necho "$*" >>"$STUB/flocks"\nexit 0\n',
};

const IMAGES: Record<string, string> = {
  gluetun: "qmcgaw/gluetun:${GLUETUN_TAG}",
  searxng: "searxng/searxng:latest",
  windmill: "ghcr.io/windmill-labs/windmill:${WINDMILL_TAG}",
  alertmanager: "prom/alertmanager:latest",
  sidecar: "ghcr.io/example/sidecar:latest",
  "stack-updater": "ghcr.io/miahyap/stack-updater:latest",
};
/** Every service but stack-updater, which updates itself last, through a helper. */
const STACK = ["gluetun", "searxng", "windmill", "alertmanager", "sidecar"];

/**
 * The services that follow their newest release: the .env variable, the tag
 * running, the next release, and what else the registry lists (builds,
 * pre-releases, variants, older releases) that must never be taken.
 */
const RELEASES: Record<string, { v: string; now: string; next: string; also: string[] }> = {
  windmill: {
    v: "WINDMILL_TAG",
    now: "1.846.0",
    next: "1.846.1",
    also: ["1.9.0", "1.845.0", "main", "latest", "1.847.0-rc1", "1.846.1-full", "1.100.0"],
  },
  gluetun: {
    v: "GLUETUN_TAG",
    now: "v3.41.2",
    next: "v3.41.3",
    also: ["latest", "v3.9.0", "pr-12"],
  },
};
const ENV = `# the stack's settings
TZ=UTC
WINDMILL_TAG=1.846.0
GLUETUN_TAG=v3.41.2
SEARXNG_SECRET=keep-me
`;
const DB_URL = "postgres://windmill:db-s3cret@db.test:5432/windmill";

const key = (ref: string) => ref.replace(/[/:]/g, "_");
const id = (service: string, n: number) => `sha256:${service}${n}`;
const repo = (s: string) => IMAGES[s]!.replace(/:[^:/]*$/, "");
/** A service's image ref, with .env's tags filled in. */
const resolve = (s: string, env: string) =>
  IMAGES[s]!.replace(
    /\$\{(\w+)\}/,
    (_, v: string) => env.match(new RegExp(`^${v}=(.*)$`, "m"))![1]!,
  );

interface Setup {
  /** Services whose registry has a newer image (…2) than the one running (…1). */
  newer?: string[];
  /** Image id → how it's broken: "api", "settings", "nonet", "exits", "crashloop". */
  broken?: Record<string, string>;
  /** Image ids a previous run rolled back, per service. */
  held?: [string, string][];
  /** The VPN exit is blocked: searches get refusals and no results. */
  blocked?: boolean;
  dumpFails?: boolean;
  pullFails?: string[];
  /** The registries can't be listed. */
  tagsFail?: boolean;
  /** Windmill's tags come in two pages, the next release on the second. */
  paged?: boolean;
  /** Dumps already in the backup folder, oldest first. */
  oldDumps?: string[];
  env?: string;
  /** Unraid Compose Manager's override file exists in OVERRIDE_DIR. */
  override?: boolean;
  /** /data/images: each service's ref as an earlier run left the stack. */
  ran?: [string, string][];
  /** More local tags, ref → image id. */
  refs?: Record<string, string>;
  /** More containers, name → image id: another stack's. */
  others?: Record<string, string>;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function stub(setup: Setup) {
  const dir = mkdtempSync(join(tmpdir(), "stack-updater-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  for (const d of ["ref", "registry", "c", "broken", "pullfail", "data", "backups", "tags"]) {
    mkdirSync(join(dir, d));
  }
  const env = setup.env ?? ENV;
  writeFileSync(join(dir, ".env"), env);
  chmodSync(join(dir, ".env"), 0o600);
  writeFileSync(join(dir, "services"), Object.keys(IMAGES).join("\n") + "\n");
  const services = Object.fromEntries(Object.entries(IMAGES).map(([s, image]) => [s, { image }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ services }));
  for (const s of Object.keys(IMAGES)) {
    writeFileSync(join(dir, "ref", key(resolve(s, env))), id(s, 1) + "\n");
    writeFileSync(join(dir, "c", s), `${id(s, 1)}\trunning\t\t0\t0\n`);
  }
  for (const [s, r] of Object.entries(RELEASES)) {
    const tags = [r.now, ...r.also, ...((setup.newer ?? []).includes(s) ? [r.next] : [])];
    const file = join(
      dir,
      "tags",
      repo(s)
        .replace(/^ghcr\.io\//, "")
        .replace(/\//g, "_"),
    );
    if (setup.paged && s === "windmill") {
      writeFileSync(file, tags.slice(0, -1).join("\n") + "\n");
      writeFileSync(file + ".2", tags.slice(-1).join("\n") + "\n");
    } else {
      writeFileSync(file, tags.join("\n") + "\n");
    }
  }
  for (const s of setup.newer ?? []) {
    const r = RELEASES[s];
    writeFileSync(
      join(dir, "registry", key(r ? `${repo(s)}:${r.next}` : resolve(s, env))),
      id(s, 2) + "\n",
    );
  }
  for (const [image, how] of Object.entries(setup.broken ?? {})) {
    writeFileSync(join(dir, "broken", image), how + "\n");
  }
  if (setup.held) {
    writeFileSync(join(dir, "data", "held"), setup.held.map((h) => h.join("\t")).join("\n") + "\n");
  }
  if (setup.blocked) writeFileSync(join(dir, "blocked"), "");
  if (setup.dumpFails) writeFileSync(join(dir, "dumpfail"), "");
  if (setup.tagsFail) writeFileSync(join(dir, "tagsfail"), "");
  mkdirSync(join(dir, "override"));
  mkdirSync(join(dir, "locks"));
  if (setup.override) {
    writeFileSync(join(dir, "override", "docker-compose.override.yml"), "services: {}\n");
  }
  for (const s of setup.pullFails ?? []) {
    const r = RELEASES[s];
    writeFileSync(join(dir, "pullfail", key(resolve(s, env))), "");
    if (r) writeFileSync(join(dir, "pullfail", key(`${repo(s)}:${r.next}`)), "");
  }
  if (setup.ran) {
    writeFileSync(
      join(dir, "data", "images"),
      setup.ran.map((r) => r.join("\t")).join("\n") + "\n",
    );
  }
  for (const [ref, image] of Object.entries(setup.refs ?? {})) {
    writeFileSync(join(dir, "ref", key(ref)), image + "\n");
  }
  for (const [name, image] of Object.entries(setup.others ?? {})) {
    writeFileSync(join(dir, "c", name), `${image}\trunning\t\t0\t0\n`);
  }
  (setup.oldDumps ?? []).forEach((name, i) => {
    const f = join(dir, "backups", name);
    writeFileSync(f, "");
    const t = Date.now() / 1000 - 86400 * (10 - i);
    utimesSync(f, t, t);
  });
  return dir;
}

/** Run `update.sh <mode>` against a stubbed stack. */
/** env: settings over the stubbed stack's; undefined leaves one out (spawnSync drops it). */
function run(
  mode: "now" | "check",
  setup: Setup = {},
  env: Record<string, string | undefined> = {},
) {
  const dir = stub(setup);
  // "schedule": no argument, as the container runs it.
  const args = mode === ("schedule" as string) ? [SCRIPT] : [SCRIPT, mode];
  const res = spawnSync("sh", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STUB: dir,
      // The stubbed stack's settings, as its compose file would set them.
      PROJECT: "demo",
      STACK_DIR: "/srv/demo",
      RELEASES: "windmill=WINDMILL_TAG gluetun=GLUETUN_TAG",
      CHECKS: "gluetun search windmill alertmanager",
      NO_ROLLBACK: "windmill",
      ENV_FILE: join(dir, ".env"),
      OVERRIDE_DIR: join(dir, "override"),
      DATA_DIR: join(dir, "data"),
      BACKUP_DIR: join(dir, "backups"),
      WINDMILL_DATABASE_URL: DB_URL,
      ALERTMANAGER_URL: "http://alertmanager.test",
      ...env,
      ...(env.CM_LOCK_DIR ? { CM_LOCK_DIR: join(dir, "locks") } : {}),
    },
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  const lines = (f: string) => read(f).trim().split("\n").filter(Boolean);
  const calls = lines("calls");
  const envNow = read(".env");
  return {
    status: res.status,
    out: res.stdout + res.stderr,
    calls,
    /** The service lists `docker compose up` was given, in order. */
    ups: calls
      .filter((c) => / up /.test(c))
      .map((c) => ({
        services: c.split(" ").filter((a) => Object.keys(IMAGES).includes(a)),
        pullNever: c.includes("--pull never"),
      })),
    /** The refs pulled. */
    pulls: calls.filter((c) => c.startsWith("pull ")).map((c) => c.split(" ").pop()!),
    created: lines("created"),
    env: envNow,
    envMode: statSync(join(dir, ".env")).mode & 0o777,
    /** The image a service's ref (with .env's tags as they are now) points at. */
    tag: (s: string) => read(join("ref", key(resolve(s, envNow)))).trim(),
    running: (s: string) => read(join("c", s)).split("\t")[0],
    held: lines("data/held"),
    /** The stack-update alerts; pull failures are pullAlerts. */
    alerts: lines("alerts")
      .map(alertOf)
      .filter((a) => a.labels.alertname === "stack-update"),
    pullAlerts: lines("alerts")
      .map(alertOf)
      .filter((a) => a.labels.alertname === "stack-update-pull"),
    flocks: lines("flocks"),
    lockFiles: readdirSync(join(dir, "locks")),
    dumps: existsSync(join(dir, "backups")) ? readdirSync(join(dir, "backups")).sort() : [],
    pgurl: read("pgurl").trim(),
    /** Containers started detached: the self-update helper. */
    helpers: lines("helpers"),
    /** Every -f any compose call was given. */
    composeFiles: [...new Set(lines("compose_files"))],
    overridePath: join(dir, "override", "docker-compose.override.yml"),
    tagUrls: lines("tag_urls"),
    /** /data/images after the run. */
    ran: lines("data/images"),
    /** The refs `docker rmi` was given. */
    rmis: calls.filter((c) => c.startsWith("rmi ")).map((c) => c.slice(4)),
    /** Whether a ref is still tagged locally. */
    tagged: (ref: string) => existsSync(join(dir, "ref", key(ref))),
  };
}

/** One POST to Alertmanager: a raise ends in the future, a resolve now. */
function alertOf(body: string) {
  const [a] = JSON.parse(body) as {
    labels: Record<string, string>;
    annotations: { summary?: string };
    endsAt: string;
  }[];
  const state = Date.parse(a!.endsAt) > Date.now() + 3600_000 ? "raise" : "resolve";
  return {
    is: `${a!.labels.alertname}:${state}`,
    labels: a!.labels,
    summary: a!.annotations.summary ?? "",
  };
}

describe("update.sh", () => {
  it("does nothing when no image is new, and resolves an old alert once the stack checks out", () => {
    const r = run("now");
    expect(r.status).toBe(0);
    expect(r.ups).toEqual([]);
    expect(r.out).toContain("up to date");
    expect(r.alerts.map((a) => a.is)).toEqual(["stack-update:resolve"]);
  });

  it("updates a sidecar like the rest", () => {
    // Not Watchtower: two updaters racing for one container fail on each
    // other's container names.
    const r = run("now", { newer: ["sidecar"] });
    expect(r.ups).toEqual([{ services: STACK, pullNever: false }]);
    expect(r.running("sidecar")).toBe(id("sidecar", 2));
    const broken = run("now", {
      newer: ["sidecar"],
      broken: { [id("sidecar", 2)]: "exits" },
    });
    expect(broken.tag("sidecar")).toBe(id("sidecar", 1));
  });

  describe("itself", () => {
    it("is pulled last, and never recreated in place", () => {
      // Recreating stack-updater from inside it would stop the run partway.
      const r = run("now", { newer: ["searxng", "stack-updater"] });
      expect(r.pulls).toEqual([...STACK, "stack-updater"].map((s) => resolve(s, ENV)));
      for (const u of r.ups) expect(u.services).not.toContain("stack-updater");
      expect(r.running("stack-updater")).toBe(id("stack-updater", 1));
    });

    it("is recreated by a helper started from its new image, after the rest", () => {
      const r = run("now", { newer: ["stack-updater"] });
      expect(r.helpers).toHaveLength(1);
      const helper = r.helpers[0]!;
      expect(helper).toContain("--name demo-self-update");
      expect(helper).toContain("ghcr.io/miahyap/stack-updater:latest");
      expect(helper).toMatch(/up -d --no-deps 'stack-updater'/);
      // The stack's files at the host's path, as for the updater itself.
      expect(helper).toContain("-v /srv/demo:/srv/demo");
      expect(r.calls.indexOf(r.calls.find((c) => c.startsWith("run -d"))!)).toBeGreaterThan(
        r.calls.findLastIndex((c) => c.startsWith("pull ")),
      );
    });

    it("starts no helper when its image hasn't changed", () => {
      expect(run("now", { newer: ["searxng"] }).helpers).toEqual([]);
    });

    it("has the helper use Compose Manager's override too", () => {
      const r = run("now", { newer: ["stack-updater"], override: true });
      expect(r.helpers[0]).toContain(`-f '${r.overridePath}'`);
      expect(r.helpers[0]).toContain(`-v ${r.overridePath.replace(/\/[^/]*$/, "")}:`);
    });

    it("doesn't update itself in check mode", () => {
      expect(run("check", { newer: ["stack-updater"] }).helpers).toEqual([]);
    });
  });

  describe("Unraid's Compose Manager override", () => {
    // Compose Manager adds its override (icon and web UI labels) to every
    // `up`. An `up` without it sees each container as changed, so the two would
    // recreate the whole stack back and forth.
    it("is in every compose call when it exists", () => {
      const r = run("now", { newer: ["searxng"], override: true });
      expect(r.composeFiles).toEqual(["/srv/demo/docker-compose.yml", r.overridePath]);
    });

    it("is left out when there is none", () => {
      const r = run("now", { newer: ["searxng"] });
      expect(r.composeFiles).toEqual(["/srv/demo/docker-compose.yml"]);
    });
  });

  describe("defaults", () => {
    // The defaults were once one particular stack's (its checks, its releases,
    // its database service never rolled back), so a stack that left a setting
    // out got that stack's. They're neutral now, and PROJECT, which names
    // every tag, helper and lock this makes, has to be given.
    const UNSET = { RELEASES: undefined, CHECKS: undefined, NO_ROLLBACK: undefined };

    it("refuses to run without PROJECT", () => {
      const r = run("check", {}, { PROJECT: undefined });
      expect(r.status).toBe(1);
      expect(r.out).toContain("PROJECT must be set");
      expect(r.calls).toEqual([]);
    });

    it("runs no built-in check when CHECKS is unset", () => {
      const r = run("check", { broken: { [id("gluetun", 1)]: "api" } }, UNSET);
      expect(r.status).toBe(0);
    });

    it("follows no release, and rolls every service back, when unset", () => {
      const r = run(
        "now",
        { newer: ["windmill"], broken: { [id("windmill", 2)]: "exits" } },
        UNSET,
      );
      expect(r.tagUrls).toEqual([]);
      expect(r.env).toBe(ENV);
      expect(r.tag("windmill")).toBe(id("windmill", 1));
    });
  });

  describe("another stack", () => {
    // Another stack runs its own instance: its checks, no releases, its web
    // app never rolled back (it migrates its database), alerts as itself.
    const OTHER = {
      CHECKS: "",
      RELEASES: "",
      NO_ROLLBACK: "searxng",
      ALERT_SENDER: "other-updater",
    };

    it("runs only the checks it names, and its URL checks", () => {
      const ok = run("check", { broken: { [id("windmill", 1)]: "api" } }, OTHER);
      expect(ok.status).toBe(0);
      const urls = {
        ...OTHER,
        CHECK_URLS: "web=http://127.0.0.1:3000/down bot=http://bot.test/up",
      };
      const bad = run("check", {}, urls);
      expect(bad.status).toBe(1);
      expect(bad.out).toContain("web doesn't answer http://127.0.0.1:3000/down");
    });

    it("follows no release when RELEASES is empty", () => {
      const r = run("now", { newer: ["windmill"] }, OTHER);
      expect(r.tagUrls).toEqual([]);
      expect(r.env).toBe(ENV);
    });

    it("never puts back a NO_ROLLBACK service, and says why", () => {
      const r = run("now", { newer: ["searxng"], broken: { [id("searxng", 2)]: "exits" } }, OTHER);
      expect(r.status).toBe(1);
      expect(r.tag("searxng")).toBe(id("searxng", 2));
      expect(r.alerts[0]!.summary).toContain("searxng was updated too and is NOT rolled back");
      expect(r.alerts[0]!.labels.sender).toBe("other-updater");
    });
  });

  describe("Compose Manager's lock", () => {
    // Its UI, and its `up` at boot, hold <dir>/<project>.lock. Taking it too
    // means neither recreates containers the other is recreating (two that
    // do fail on each other's container names).
    it("is held for a run", () => {
      const r = run("now", {}, { CM_LOCK_DIR: "LOCKS" });
      expect(r.lockFiles).toEqual(["demo.lock"]);
      expect(r.flocks).toContain("-w 600 8");
    });

    it("is held by the self-update helper too", () => {
      const r = run("now", { newer: ["stack-updater"] }, { CM_LOCK_DIR: "LOCKS" });
      expect(r.helpers[0]).toMatch(/flock -w 600 '[^']*\/demo\.lock' docker compose/);
      expect(r.helpers[0]).toMatch(/-v [^ ]*locks:[^ ]*locks /);
    });

    it("isn't needed off Unraid", () => {
      expect(run("now").flocks).not.toContain("-w 600 8");
    });
  });

  describe("pull failures", () => {
    it("raise an alert, since updates stop without anything breaking", () => {
      // What an expired GHCR login looks like: pulls refused, the old images
      // running on.
      const r = run("now", { newer: ["searxng"], pullFails: ["searxng"] });
      expect(r.pullAlerts.map((a) => a.is)).toEqual(["stack-update-pull:raise"]);
      expect(r.pullAlerts[0]!.summary).toContain("searxng/searxng:latest");
      expect(r.pullAlerts[0]!.summary).toContain("docker login has expired");
    });

    it("resolve once every pull works", () => {
      const r = run("now");
      expect(r.pullAlerts.map((a) => a.is)).toEqual(["stack-update-pull:resolve"]);
    });
  });

  it("refuses an UPDATE_EVERY shorter than a minute", () => {
    const r = run("schedule" as "now", {}, { UPDATE_EVERY: "30" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("at least 60");
  });

  describe("releases", () => {
    it("moves Windmill and gluetun to their newest release, in .env", () => {
      const r = run("now", { newer: ["windmill", "gluetun"] });
      expect(r.status).toBe(0);
      expect(r.env).toContain("WINDMILL_TAG=1.846.1\n");
      expect(r.env).toContain("GLUETUN_TAG=v3.41.3\n");
      expect(r.running("windmill")).toBe(id("windmill", 2));
      expect(r.running("gluetun")).toBe(id("gluetun", 2));
    });

    it("takes only x.y.z releases: never a build, a pre-release or a variant", () => {
      // Windmill's :latest and :main are builds of every commit.
      const r = run("now");
      expect(r.pulls).toContain("ghcr.io/windmill-labs/windmill:1.846.0");
      expect(r.env).toBe(ENV);
      expect(r.ups).toEqual([]);
    });

    it("never moves a release backwards", () => {
      const ahead = ENV.replace("WINDMILL_TAG=1.846.0", "WINDMILL_TAG=1.900.0");
      const r = run("now", { env: ahead });
      expect(r.env).toContain("WINDMILL_TAG=1.900.0\n");
      expect(r.pulls).toContain("ghcr.io/windmill-labs/windmill:1.900.0");
    });

    it("reads every page of the registry's tags", () => {
      const r = run("now", { newer: ["windmill"], paged: true });
      expect(r.tagUrls.filter((u) => u.includes("windmill"))).toHaveLength(2);
      expect(r.env).toContain("WINDMILL_TAG=1.846.1\n");
    });

    it("keeps the release it runs when the registry can't be listed", () => {
      const r = run("now", { newer: ["windmill"], tagsFail: true });
      expect(r.env).toBe(ENV);
      expect(r.running("windmill")).toBe(id("windmill", 1));
      expect(r.out).toContain("couldn't list");
    });

    it("changes nothing in .env but the tag, and keeps the file private", () => {
      const r = run("now", { newer: ["gluetun"] });
      expect(r.env).toBe(ENV.replace("GLUETUN_TAG=v3.41.2", "GLUETUN_TAG=v3.41.3"));
      expect(r.envMode).toBe(0o600);
    });

    it("puts the old release back in .env when the new one fails, and holds it", () => {
      const r = run("now", { newer: ["gluetun"], broken: { [id("gluetun", 2)]: "api" } });
      expect(r.env).toBe(ENV);
      expect(r.running("gluetun")).toBe(id("gluetun", 1));
      expect(r.held).toEqual([`gluetun\t${id("gluetun", 2)}`]);
    });

    it("leaves .env alone for a held release", () => {
      const r = run("now", { newer: ["gluetun"], held: [["gluetun", id("gluetun", 2)]] });
      expect(r.env).toBe(ENV);
      expect(r.ups).toEqual([]);
    });
  });

  it("recreates the stack through compose when gluetun updates, and checks it", () => {
    const r = run("now", { newer: ["gluetun"] });
    expect(r.status).toBe(0);
    expect(r.ups).toEqual([{ services: STACK, pullNever: false }]);
    expect(r.running("gluetun")).toBe(id("gluetun", 2));
    expect(r.alerts.map((a) => a.is)).toEqual(["stack-update:resolve"]);
    // The old image stays tagged, so the host's prune can't take the way back.
    expect(r.calls).toContain(`tag ${id("gluetun", 1)} demo-rollback/gluetun:previous`);
  });

  it("puts gluetun back when its control server no longer has the settings clients edit", () => {
    const r = run("now", { newer: ["gluetun"], broken: { [id("gluetun", 2)]: "settings" } });
    expect(r.status).toBe(0);
    expect(r.tag("gluetun")).toBe(id("gluetun", 1));
    expect(r.running("gluetun")).toBe(id("gluetun", 1));
    expect(r.ups.map((u) => u.pullNever)).toEqual([false, true]);
    expect(r.held).toEqual([`gluetun\t${id("gluetun", 2)}`]);
    expect(r.alerts.map((a) => a.is)).toEqual(["stack-update:raise"]);
    expect(r.alerts[0]!.summary).toContain("no longer has provider.name");
    expect(r.alerts[0]!.labels).toEqual({ alertname: "stack-update", sender: "stack-updater" });
  });

  it("puts an update back when SearXNG is left with no network", () => {
    // What a stranded SearXNG looks like: every engine fails to connect.
    const r = run("now", { newer: ["gluetun"], broken: { [id("gluetun", 2)]: "nonet" } });
    expect(r.tag("gluetun")).toBe(id("gluetun", 1));
    expect(r.alerts[0]!.summary).toContain("no network");
  });

  it("doesn't blame an update for engines refusing the VPN exit", () => {
    // Moving the exit fixes that, not putting back an image.
    const r = run("now", { newer: ["searxng"], blocked: true });
    expect(r.status).toBe(0);
    expect(r.tag("searxng")).toBe(id("searxng", 2));
    expect(r.held).toEqual([]);
  });

  it("puts back a service that won't start, or keeps restarting", () => {
    const exits = run("now", { newer: ["searxng"], broken: { [id("searxng", 2)]: "exits" } });
    expect(exits.tag("searxng")).toBe(id("searxng", 1));
    expect(exits.alerts[0]!.summary).toContain("docker compose up failed");
    const loops = run("now", {
      newer: ["alertmanager"],
      broken: { [id("alertmanager", 2)]: "crashloop" },
    });
    expect(loops.tag("alertmanager")).toBe(id("alertmanager", 1));
    expect(loops.alerts[0]!.summary).toContain("alertmanager restarted");
  });

  it("holds back an image it rolled back, until a newer one comes", () => {
    const held: Setup = { newer: ["gluetun"], held: [["gluetun", id("gluetun", 2)]] };
    const r = run("now", held);
    expect(r.ups).toEqual([]);
    // The tag points at what runs again, so a boot-time `up` can't start it.
    expect(r.tag("gluetun")).toBe(id("gluetun", 1));
    expect(r.out).toContain("holding back");
    // Still held: the raise from when it failed stays open.
    expect(r.alerts).toEqual([]);

    const newer = run("now", { newer: ["gluetun"], held: [["gluetun", id("gluetun", 9)]] });
    expect(newer.running("gluetun")).toBe(id("gluetun", 2));
  });

  describe("Windmill", () => {
    it("dumps its database before a new Windmill starts on it", () => {
      const r = run("now", { newer: ["windmill"] });
      expect(r.status).toBe(0);
      const dump = r.calls.findIndex((c) => c.startsWith("run "));
      const up = r.calls.findIndex((c) => / up /.test(c));
      expect(dump).toBeGreaterThan(-1);
      expect(dump).toBeLessThan(up);
      expect(r.dumps).toEqual([
        expect.stringMatching(/^windmill-\d{8}-\d{6}-CE-v1\.846\.0\.dump$/),
      ]);
      // And the Windmill that wrote it, under a tag the next run won't move.
      const stamp = r.dumps[0]!.split("-").slice(1, 3).join("-");
      expect(r.calls).toContain(`tag ${id("windmill", 1)} demo-rollback/windmill:${stamp}`);
    });

    it("keeps the database URL off every command line", () => {
      // `docker ps` and the host's process list would show its password.
      const r = run("now", { newer: ["windmill"] });
      expect(r.pgurl).toBe(DB_URL);
      for (const c of r.calls) expect(c).not.toContain("db-s3cret");
    });

    it("keeps only the newest BACKUP_KEEP dumps, and their images", () => {
      const old = [
        "windmill-20261001-040000-CE-v1.840.0.dump",
        "windmill-20261002-040000-CE-v1.841.0.dump",
        "windmill-20261003-040000-CE-v1.842.0.dump",
      ];
      const r = run("now", { newer: ["windmill"], oldDumps: old });
      expect(r.dumps).toHaveLength(3);
      expect(r.dumps).not.toContain(old[0]);
      expect(r.dumps).toContain(old[2]);
      expect(r.calls).toContain("rmi demo-rollback/windmill:20261001-040000");
      expect(r.calls.filter((c) => c.startsWith("rmi "))).toHaveLength(1);
    });

    it("doesn't update Windmill when the dump fails, and says so", () => {
      const r = run("now", { newer: ["windmill", "searxng"], dumpFails: true });
      expect(r.tag("windmill")).toBe(id("windmill", 1));
      expect(r.running("windmill")).toBe(id("windmill", 1));
      expect(r.running("searxng")).toBe(id("searxng", 2));
      expect(r.alerts.map((a) => a.is)).toEqual(["stack-update:raise"]);
      expect(r.alerts[0]!.summary).toContain("Windmill wasn't updated");
    });

    it("never puts Windmill back, and names the dump to restore from", () => {
      // An old Windmill can't run on the database the new one migrated.
      const r = run("now", { newer: ["windmill"], broken: { [id("windmill", 2)]: "api" } });
      expect(r.status).toBe(1);
      expect(r.tag("windmill")).toBe(id("windmill", 2));
      expect(r.held).toEqual([]);
      expect(r.alerts[0]!.summary).toContain("NOT rolled back");
      expect(r.alerts[0]!.summary).toContain(r.dumps[0]);
      const stamp = r.dumps[0]!.split("-").slice(1, 3).join("-");
      expect(r.alerts[0]!.summary).toContain(`demo-rollback/windmill:${stamp}`);
    });

    it("still puts the others back when Windmill updated alongside them", () => {
      const r = run("now", {
        newer: ["windmill", "searxng"],
        broken: { [id("searxng", 2)]: "api" },
      });
      expect(r.tag("searxng")).toBe(id("searxng", 1));
      expect(r.tag("windmill")).toBe(id("windmill", 2));
      expect(r.held).toEqual([`searxng\t${id("searxng", 2)}`]);
    });
  });

  describe("cleanup", () => {
    // `docker image prune` takes untagged images, but nothing takes the tagged
    // ones a stack stopped running: every release it moves past piles up.
    const ranOf = (env: string) => STACK.map((s) => `${s}\t${resolve(s, env)}`);
    const RAN = STACK.map((s): [string, string] => [s, resolve(s, ENV)]);

    it("records the stack on its first run, and untags nothing", () => {
      const r = run("now", { newer: ["windmill"] });
      expect(r.rmis).toEqual([]);
      expect(r.ran).toEqual(ranOf(r.env));
    });

    it("untags the release it moved past, and keeps the image as :previous", () => {
      const r = run("now", { newer: ["windmill"], ran: RAN });
      expect(r.status).toBe(0);
      expect(r.rmis).toContain("ghcr.io/windmill-labs/windmill:1.846.0");
      expect(r.tagged("ghcr.io/windmill-labs/windmill:1.846.0")).toBe(false);
      expect(r.tagged("demo-rollback/windmill:previous")).toBe(true);
      expect(r.ran).toEqual(ranOf(r.env));
      expect(r.out).toContain("untagged ghcr.io/windmill-labs/windmill:1.846.0");
    });

    it("keeps the release it rolled back to", () => {
      const r = run("now", { newer: ["gluetun"], broken: { [id("gluetun", 2)]: "api" }, ran: RAN });
      expect(r.status).toBe(0);
      expect(r.rmis).toEqual([]);
      expect(r.tagged("qmcgaw/gluetun:v3.41.2")).toBe(true);
    });

    it("untags nothing when the run leaves the stack broken", () => {
      const r = run("now", {
        newer: ["windmill"],
        broken: { [id("windmill", 2)]: "api" },
        ran: RAN,
      });
      expect(r.status).toBe(1);
      expect(r.rmis).toEqual([]);
      expect(r.ran).toEqual(ranOf(ENV));
    });

    it("untags the image and :previous of a service no longer in the stack", () => {
      const r = run("now", {
        ran: [...RAN, ["pihole", "pihole/pihole:latest"]],
        refs: {
          "pihole/pihole:latest": "sha256:pihole1",
          "demo-rollback/pihole:previous": "sha256:pihole1",
        },
      });
      expect(r.rmis).toEqual(["demo-rollback/pihole:previous", "pihole/pihole:latest"]);
      expect(r.tagged("pihole/pihole:latest")).toBe(false);
      expect(r.ran).toEqual(ranOf(ENV));
    });

    it("leaves an image another stack's container runs, and tries it again next run", () => {
      const r = run("now", {
        ran: [...RAN, ["db", "postgres:16-alpine"]],
        refs: { "postgres:16-alpine": "sha256:pg1" },
        others: { "data-postgres": "sha256:pg1" },
      });
      expect(r.tagged("postgres:16-alpine")).toBe(true);
      expect(r.ran).toContain("db\tpostgres:16-alpine");
    });
  });

  it("keeps what runs when a pull fails, and updates the rest", () => {
    const r = run("now", { newer: ["searxng", "gluetun"], pullFails: ["gluetun"] });
    expect(r.running("gluetun")).toBe(id("gluetun", 1));
    expect(r.running("searxng")).toBe(id("searxng", 2));
  });

  it("checks without updating or alerting in check mode", () => {
    const ok = run("check", { newer: ["gluetun"] });
    expect(ok.status).toBe(0);
    expect(ok.pulls).toEqual([]);
    expect(ok.alerts).toEqual([]);
    const bad = run("check", { broken: { [id("windmill", 1)]: "api" } });
    expect(bad.status).toBe(1);
    expect(bad.out).toContain("Windmill doesn't answer");
    expect(bad.alerts).toEqual([]);
  });

  it("refuses to run without STACK_DIR", () => {
    expect(run("now", {}, { STACK_DIR: "" }).status).toBe(1);
  });
});
