# stack-updater — guidance for Claude

A container that keeps a Docker Compose stack on its images' newest versions,
checks it, and rolls back what breaks (README.md). It runs with the host's
Docker socket, and every stack on `:latest` takes a new image on its next run:
a broken image here breaks updates everywhere at once, so change it with the
tests.

## Never print secrets

It reads gluetun's control-server password from gluetun's env, and gets a
database URL for the Windmill dump. Neither may reach a log, a command line
(`docker ps` shows it) or an alert.

## Fixing bugs — always add a regression test

A behavioural fix comes with a test that fails before it and passes after, in
the same change, with a comment naming the original symptom.
`update.test.ts` runs the real `update.sh` against stubbed `docker`, `curl`,
`sleep` and `flock`; `lib/alert.test.ts` pins the Alertmanager protocol;
`workflows.test.ts` pins who can publish the image.

## Settings

Defaults are neutral: no releases, no built-in checks, nothing exempt from
rollback, and `PROJECT` required. Keep them that way. A changed default
reaches every stack that leaves the setting out, on its next run. Keep
README.md's settings table current.

## Publishing

`.github/workflows/release.yml` publishes only after `test` passes on a push
to this repo's own `main`. Never loosen its `if`: `workflow_run`'s `branches`
filter matches a fork's branch named `main` too.

## License

MPL-2.0 (LICENSE), file by file: a new source file starts with an
`SPDX-License-Identifier: MPL-2.0` line (after the shebang). Don't copy in
code under a license that can't be combined with the MPL (GPL-only code is
fine only as a separate program, not pasted into a file here).

## Formatting and commits

Run `pnpm format` before committing (CI runs `pnpm format:check`). Split
independent changes into focused commits, each passing `pnpm lint` and
`pnpm test`, and stage explicit paths, never `git add -A`.
