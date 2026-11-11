# stack-updater — follow the newest version, and take back what breaks

A container that keeps a Docker Compose stack on its images' newest versions,
checks the stack after every update, and rolls back what breaks. Run one per
stack, as a service in the stack's own compose file.

- **Updates through compose**, never container by container: `docker compose
  up` recreates what changed, along with whatever depends on it.
- **Checks the stack as its clients use it**: every service running and
  healthy, staying up past a settle period, and any HTTP endpoints you name
  answering.
- **Rolls back** every updated service when a check fails, and **holds** the
  images that broke it until a newer one is published.
- **Follows releases, not just tags**: for an image whose `:latest` is a build
  of every commit, it finds the highest `x.y.z` tag in the registry and moves
  a variable in `.env` forward to it.
- **Alerts** through Alertmanager when it rolls back, holds, or can't pull.
- **Updates itself last**, through a short-lived helper container.

## Why compose, not Watchtower

Watchtower recreates one container at a time through the Docker API, outside
compose. A container on another's network (`network_mode: service:vpn`) is
joined to that container's ID when it's created, so when Watchtower replaces
the `vpn` container, the one joined to it is left with no network, and won't
start again until it's recreated. `docker compose up` recreates both.

Two updaters on one container also race: if Watchtower and a compose `up`
both recreate a container, one fails on the name the other took. So
stack-updater should be the only updater for its stack: no service should
carry Watchtower's label.

## Running it

Add it to the stack's compose file:

```yaml
services:
  updater:
    # A major version: its fixes and features, never a breaking change.
    image: ghcr.io/miahyap/stack-updater:1
    restart: unless-stopped
    # Checks reach the services at their host ports, as clients do.
    network_mode: host
    environment:
      PROJECT: mystack
      STACK_DIR: /srv/mystack
      SELF: updater
      UPDATE_AT: "04:00"
      TZ: Europe/London
      # The app migrates its database on start: never put back.
      NO_ROLLBACK: app
      CHECK_URLS: app=http://127.0.0.1:8080/health
      ALERTMANAGER_URL: http://127.0.0.1:9093
      ALERT_SENDER: mystack-updater
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # The stack's folder at the SAME path as on the host (see below).
      - /srv/mystack:/srv/mystack
      # The host's registry logins, for private images.
      - /root/.docker:/root/.docker:ro
      # What it remembers between runs: held images, the last images run.
      - ./data/updater:/data
```

**The stack's folder must be mounted at the same path as on the host**
(`STACK_DIR`). Compose resolves relative paths (`./data`, an `env_file`)
against the compose file's folder, and the host's Docker daemon has to find
them there. It's writable because release tags are kept in `.env`.

## Versions

Releases follow [semantic versioning](https://semver.org): a breaking change
(a setting renamed or removed, a default changed) is a new major version.

| Tag | What it follows |
|---|---|
| `:1` | The newest 1.x release. Recommended |
| `:1.2` | The newest 1.2.x release: fixes only |
| `:1.2.3` | That release, never updated |
| `:latest` | Every change merged to `main`, released or not |
| `:sha-<commit>` | That commit's build |

It updates itself like any other service, so the tag you give it is the one
it follows: `:1` takes every 1.x release, and never 2.0. Each image is
attested (SECURITY.md, "Verifying the image"). Release notes are on the
[releases page](https://github.com/miahyap/stack-updater/releases).

## A run

Daily at `UPDATE_AT` (in `TZ`), every `UPDATE_EVERY` seconds, or on demand:

1. **Tags each running image** as `<project>-rollback/<service>:previous`.
   That's the way back, and it keeps the old image from `docker image prune`,
   which removes untagged images: a pull leaves the old one untagged.
2. **Pulls each service** but itself: its tag, or its newest release. A
   failed pull keeps what runs, and a scheduled run is done again
   `PULL_RETRY_WAIT` seconds later, up to `PULL_RETRIES` times (unless the
   next run comes sooner): the network being down for a minute at
   `UPDATE_AT` doesn't cost a day. A new image that was **held** (rolled back
   before) isn't taken: a floating tag is pointed at the running image again
   and a release tag in `.env` is left as it is, so another `up` meanwhile
   can't start it either. A newer image than the held one is tried as usual.
3. **Recreates the stack**: `docker compose up -d --wait` on every service but
   its own.
4. **Checks it**, after `SETTLE` seconds: every service is running (healthy,
   where it has a healthcheck) and hasn't restarted since the `up`; every
   `CHECK_URLS` endpoint answers 2xx; and any built-in `CHECKS` pass.
5. **On a failed check**, puts back the previous image (or release tag) of
   **every** updated service except those in `NO_ROLLBACK`, holds the new
   ones, recreates, and checks again. It doesn't try to work out which update
   was at fault: a held image costs only the wait for the next release.
6. **Untags what the stack no longer runs**, once a run leaves it working: a
   release it moved past, a tag the compose file no longer names, and the
   `:previous` of a service that's gone, so a later prune can reclaim the
   space. `docker rmi` without `-f` keeps anything a container still uses,
   including another stack's.

It raises `stack-update` in Alertmanager when it rolls back, holds, or is left
broken, and `stack-update-pull` when a pull fails and so does every retry (an
expired registry login would otherwise stop updates silently). A later run
that comes out clean resolves them.

## Two ways to follow an image

**A floating tag** (`:latest`, `postgres:alpine`): an update is a new digest
behind the same tag.

**Its newest release** (`RELEASES`), for images whose `:latest` is a build of
every commit. `RELEASES="app=APP_TAG"` means the `app` service's image tag
comes from `APP_TAG` in `.env` (`image: example/app:${APP_TAG}` in the
compose file). The updater lists the registry's tags (anonymously, every
page), takes the highest `x.y.z` or `vx.y.z` (never `main`, `1.2.3-rc1` or
`1.2.3-full`), and once that image has pulled, writes it into `.env`. It only
moves forward: a tag set by hand to a later version stays. A registry it can't
list leaves the release as it is. Docker Hub and GHCR are supported.

## Services that can't go back

A service that migrates a database on start may not run on that database once
a newer version has migrated it. List it in `NO_ROLLBACK`: it's never put
back, and the alert says so, so you can restore its data by hand.

## Updating itself

It can't recreate its own container: compose would stop it, and the run doing
it, before starting the new one. So after every run it pulls its own image
(`SELF`), and if that changed, starts a detached helper from the new image
(`<project>-self-update`) that waits five seconds and runs
`docker compose up -d --no-deps <SELF>`. The helper removes itself. Nothing
checks the new updater or rolls it back: a broken one breaks nothing but the
next update, which its logs show.

## Unraid Compose Manager

Compose Manager holds `<dir>/<project>.lock` through every action it takes on
a stack: a UI click, its own update, its `up` at boot. Set `CM_LOCK_DIR` to
that folder (`/var/run/compose.manager`, mounted at the same path) and the
updater and its self-update helper hold the same lock, so an update and a UI
action wait for each other. Compose Manager also adds an override file of its
own to every `up` (icons, web UI links); set `OVERRIDE_DIR` to its folder,
mounted at the same path, so the updater's `up` uses it too, or each would see
the other's containers as changed.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `PROJECT` | required | The compose project name |
| `STACK_DIR` | — | The stack's folder, mounted at the same path |
| `COMPOSE_FILE` | `$STACK_DIR/docker-compose.yml` | The compose file |
| `ENV_FILE` | `$STACK_DIR/.env` | Its `.env`, where release tags are written |
| `OVERRIDE_DIR`, `OVERRIDE_FILE` | —, `docker-compose.override.yml` | An extra compose file every `up` includes, when it exists |
| `SELF` | `stack-updater` | This container's service, updated last |
| `UPDATE_AT` | `04:00` | Daily run time, `HH:MM` in `TZ` |
| `UPDATE_EVERY` | — | Instead: every this many seconds (at least 60) |
| `RELEASES` | — | `service=VARIABLE ...`: services that follow their newest release |
| `CHECKS` | — | Built-in checks to run, by name (below) |
| `CHECK_URLS` | — | `name=url ...`: each must answer 2xx |
| `NO_ROLLBACK` | — | Services never put back |
| `PULL_RETRIES`, `PULL_RETRY_WAIT` | `3`, `600` | How many times a scheduled run is done again when a pull fails, and the seconds between; `0` retries never |
| `SETTLE` | `60` | Seconds a service must stay up after the `up` |
| `WAIT_TIMEOUT` | `600` | Seconds `up --wait` may take |
| `CM_LOCK_DIR`, `CM_LOCK_WAIT` | —, `600` | Compose Manager's lock folder, and how long to wait for it before skipping a run |
| `DATA_DIR` | `/data` | Where it keeps held images and the last images run |
| `ALERTMANAGER_URL` | — | Alertmanager's base URL; unset, nothing is sent |
| `ALERT_SENDER` | `stack-updater` | The `sender` label on its alerts |

## Built-in checks and the database dump

A few checks and one pre-update step are written for particular services, and
run only when named. They're optional:

| `CHECKS` name | Checks | Settings |
|---|---|---|
| `gluetun` | A [gluetun](https://github.com/qdm12/gluetun) VPN's control server answers, the VPN is running, and `/v1/vpn/settings` still has `provider.name`, `type` and `provider.server_selection.regions` | `GLUETUN_CONTAINER`, `GLUETUN_API` (its password is read from the container's env) |
| `search` | A [SearXNG](https://docs.searxng.org) search answers in its JSON API. Engines refusing the VPN exit isn't a failure; every engine failing to connect is | `SEARXNG_URL`, `SEARCH_TRIES`, `SEARCH_WAIT` |
| `windmill` | [Windmill](https://www.windmill.dev) answers `/api/version` | `WINDMILL_URL` |
| `alertmanager` | Alertmanager answers `/-/healthy` | `ALERTMANAGER_URL` |

**A service named `windmill`** gets its database dumped before a new image
starts on it: `pg_dump` in a `PG_IMAGE` container, into `BACKUP_DIR` (a host
path, mounted at the same path) as `windmill-<date>-<time>-<version>.dump`,
and the running image is tagged `<project>-rollback/windmill:<date>-<time>`,
since restoring a dump needs the version that wrote it. The newest
`BACKUP_KEEP` (3) dumps and their images are kept. The database URL
(`WINDMILL_DATABASE_URL`) reaches `pg_dump` through the environment, never a
command line. No dump, no update: Windmill is left as it is, and an alert
says so.

## Running it by hand

    docker exec <container> sh /update.sh check    # the checks only; never alerts
    docker exec <container> sh /update.sh now      # an update now (waits for a running one; no retries)
    cat <data dir>/held                            # what's held back

To take a held image anyway, delete its line from `held` and run `now`. Both
commands exit 0 when the stack ends up working, 1 when it doesn't.

## Development

    pnpm install
    pnpm lint && pnpm test      # update.test.ts runs the real update.sh against
                                # stubbed docker, curl, sleep and flock
    pnpm format                 # before committing; CI checks it

`update.test.ts` marks images broken in the ways the checks look for, and pins
each decision above. `lib/alert.test.ts` starts a real Alertmanager, so it's
skipped without a Docker daemon.

## Security

To report a vulnerability, or to verify that an image was built from this
repository, see [SECURITY.md](SECURITY.md).

## Use of AI tools

This repository was written with the help of AI coding tools, chiefly
[Claude Code](https://claude.com/claude-code): code, tests and documentation
alike. A person directed the work and reviewed the changes, and every change
goes through the test suite and CI before it's published. Review it as you
would any code before running it with access to your Docker socket.

## License

[Mozilla Public License 2.0](LICENSE). You can run it, change it and ship it
inside your own work, closed or open. If you distribute a changed version of
one of this repo's files (a modified `update.sh` in an image, say), that
file's source must stay available under the MPL. Your own files alongside it
can be under any license. Each file carries an `SPDX-License-Identifier:
MPL-2.0` line.
