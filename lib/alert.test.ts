// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// lib/alert.sh, the one place stack-updater speaks Alertmanager's API. What it
// guards: a raise stays firing until it's resolved (Alertmanager closes an
// alert nobody re-sends after 5 minutes, and these are sent once), a resolve
// matches its raise (same labels), the message survives any characters, and a
// failed send never stops the caller.

const LIB = join(import.meta.dirname, "alert.sh");
const ALERTMANAGER_IMAGE = "prom/alertmanager:latest";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Source alert.sh and run `alert <args>`; curl records what it's sent (or fails). */
function send(args: string[], env: Record<string, string> = {}, curlFails = false) {
  const dir = mkdtempSync(join(tmpdir(), "alert-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "curl"),
    `#!/bin/sh
${curlFails ? "exit 7" : ""}
url=; data=; prev=
for a; do
  case $prev in --data-binary) data=$a ;; esac
  case $a in http*) url=$a ;; esac
  prev=$a
done
printf '%s\\n' "$url" >>"$STUB/urls"
printf '%s\\n' "$data" >>"$STUB/bodies"
`,
  );
  chmodSync(join(dir, "curl"), 0o755);
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const res = spawnSync("sh", ["-c", `. '${LIB}'; alert ${quoted}; echo "rc=$?"`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB: dir, ...env },
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return {
    out: res.stdout,
    urls: read("urls").trim().split("\n").filter(Boolean),
    bodies: read("bodies")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (b) =>
          JSON.parse(b) as {
            labels: Record<string, string>;
            annotations: Record<string, string>;
            endsAt: string;
          }[],
      ),
  };
}

const ON = { ALERTMANAGER_URL: "http://am.test", ALERT_SENDER: "test-sender" };

describe("alert.sh", () => {
  it("raises an alert that stays firing until resolved", () => {
    const r = send(["vpn-blocked", "raise", "still blocked"], ON);
    expect(r.urls).toEqual(["http://am.test/api/v2/alerts"]);
    const [a] = r.bodies[0]!;
    expect(a!.labels).toEqual({ alertname: "vpn-blocked", sender: "test-sender" });
    expect(a!.annotations).toEqual({ summary: "still blocked" });
    // 30 days out, not Alertmanager's 5-minute default.
    const days = (Date.parse(a!.endsAt) - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it("resolves with the raise's labels, ending now", () => {
    const [a] = send(["vpn-blocked", "resolve"], ON).bodies[0]!;
    expect(a!.labels).toEqual({ alertname: "vpn-blocked", sender: "test-sender" });
    expect(a!.annotations).toEqual({});
    expect(Math.abs(Date.parse(a!.endsAt) - Date.now())).toBeLessThan(5000);
  });

  it("carries any message intact", () => {
    const message = `quotes "and" 'these', <html>, $HOME, a \\ and\na second line`;
    const [a] = send(["x", "raise", message], ON).bodies[0]!;
    expect(a!.annotations.summary).toBe(message);
  });

  it("sends nothing without an Alertmanager, or when told to be quiet", () => {
    expect(send(["x", "raise", "m"], {}).urls).toEqual([]);
    expect(send(["x", "raise", "m"], { ...ON, ALERT_QUIET: "1" }).urls).toEqual([]);
  });

  it("never fails its caller when Alertmanager can't be reached", () => {
    const r = send(["x", "raise", "m"], ON, true);
    expect(r.out).toContain("could not send x (raise) to http://am.test");
    expect(r.out).toContain("rc=0");
  });
});

// Against a real Alertmanager, when there's a Docker daemon to run one.
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasDocker)("alert.sh against Alertmanager", () => {
  const name = `alert-test-${process.pid}`;
  const port = 19000 + (process.pid % 900);
  const url = `http://127.0.0.1:${port}`;
  const env = { ALERTMANAGER_URL: url, ALERT_SENDER: "test-sender" };

  beforeAll(async () => {
    const config = "route: {receiver: none}\nreceivers: [{name: none}]\n";
    const res = spawnSync("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:9093`,
      "--entrypoint",
      "sh",
      ALERTMANAGER_IMAGE,
      "-c",
      `printf '${config}' >/tmp/am.yml && exec alertmanager --config.file=/tmp/am.yml --storage.path=/tmp`,
    ]);
    expect(res.status, String(res.stderr)).toBe(0);
    for (let i = 0; i < 60; i++) {
      if ((await fetch(`${url}/-/ready`).catch(() => null))?.ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Alertmanager didn't start");
  }, 120_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  });

  /** alert.sh with the real curl, to the real Alertmanager. */
  function realSend(args: string[]) {
    const quoted = args.map((a) => `'${a}'`).join(" ");
    const res = spawnSync("sh", ["-c", `. '${LIB}'; alert ${quoted}`], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    expect(res.stdout + res.stderr).toBe("");
  }

  async function active(alertname: string) {
    const res = await fetch(
      `${url}/api/v2/alerts?active=true&filter=alertname%3D%22${alertname}%22`,
    );
    return (await res.json()) as { annotations: Record<string, string> }[];
  }

  it("is still firing after Alertmanager's resolve_timeout would have closed it", async () => {
    realSend(["held-open", "raise", "first"]);
    // Accepted with an endsAt in the future, so it stays active until resolved.
    const [a] = await active("held-open");
    expect(a?.annotations.summary).toBe("first");
  });

  it("is resolved by a resolve with no message", async () => {
    realSend(["resolved-later", "raise", "it broke"]);
    expect(await active("resolved-later")).toHaveLength(1);
    realSend(["resolved-later", "resolve"]);
    expect(await active("resolved-later")).toHaveLength(0);
  });
});
