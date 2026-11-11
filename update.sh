#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# stack-updater: keep a compose stack on its images' newest versions, and take
# back an update that breaks it.
#
# A service follows either a floating tag (:latest), or, when it's in
# $RELEASES, its newest release: the highest x.y.z tag in its registry, which
# this writes into .env (APP_TAG=1.2.3) for the compose file to use. That's for
# images whose :latest is a build of every commit, not a release.
# Nothing changes until this pulls. Daily at $UPDATE_AT (HH:MM, in $TZ) it:
#   1. tags every service's running image as <project>-rollback/<service>:previous
#      — that keeps it from the host's `docker image prune` once the pull leaves
#      it untagged, and is what a rollback puts back;
#   2. pulls each service's tag, or its newest release (only ever forwards); an
#      image it rolled back before is held back (the tag is pointed at the
#      running image again, or .env left as it is), until a newer one comes.
#      When a pull fails, the scheduled run is done again a little later
#      ($PULL_RETRIES times, $PULL_RETRY_WAIT seconds apart);
#   3. dumps the database of a service named windmill before a new Windmill
#      starts on it: Windmill migrates its database on start, so its old image
#      can't simply be put back. No dump, no Windmill update;
#   4. recreates the stack with `docker compose up -d --wait`, which recreates
#      a container joined to another's network (network_mode: service:x) along
#      with it; Watchtower, recreating one container alone, leaves the joined
#      one without a network;
#   5. checks that the stack still works, as its clients use it: every service
#      running and staying up, the $CHECK_URLS answering, and the built-in
#      $CHECKS (gluetun, search, windmill, alertmanager) passing;
#   6. if a check fails, puts every updated service's previous image (or
#      release tag) back, holds the new ones, and checks again. A service in
#      $NO_ROLLBACK isn't put back: it migrates a database on start, which its
#      old image may not run on. The alert says so instead;
#   7. once the stack works, untags the images it no longer runs (prune).
# What it can't fix, or a hold, it reports to Alertmanager ($ALERTMANAGER_URL;
# unset = nothing is sent; lib/alert.sh) as stack-update, resolved by the
# next update that passes.
#
# It should be the only thing that updates its stack: two updaters racing to
# recreate one container (Watchtower and a compose `up`) fail on each other's
# container names. Itself it updates last, through a helper started from its
# new image (self_update).
#
#   sh update.sh         run daily at $UPDATE_AT, or every $UPDATE_EVERY seconds
#                        (the container's command)
#   sh update.sh now     one update, now
#   sh update.sh check   the checks alone, without updating; never alerts
# now and check exit 0 when the stack ends up working, 1 when it doesn't.
set -u

PROJECT=${PROJECT:-}
STACK_DIR=${STACK_DIR:-}
COMPOSE_FILE=${COMPOSE_FILE:-$STACK_DIR/docker-compose.yml}
ENV_FILE=${ENV_FILE:-$STACK_DIR/.env}
# An override file every `up` must include, when it exists: Unraid's Compose
# Manager adds one of its own (icon and web UI labels) to every `up`. This one's `up`s must use it too, or each would see
# the other's containers as changed and recreate them. A folder mounted at the
# same path as on the host, like the stack's, for the self-update helper.
OVERRIDE_DIR=${OVERRIDE_DIR:-}
OVERRIDE_FILE=${OVERRIDE_FILE:-docker-compose.override.yml}
# This container's service: updated last, by a helper (self_update), since
# recreating itself from in here would stop the run partway.
SELF=${SELF:-stack-updater}
UPDATE_AT=${UPDATE_AT:-04:00}
# Instead: every this many seconds (a stack that deploys on every merge).
UPDATE_EVERY=${UPDATE_EVERY:-}
# Services that follow their newest release, "service=VARIABLE ...", VARIABLE
# being the .env variable holding its tag. Empty: none.
RELEASES=${RELEASES:-}
# Built-in checks beyond every service running, by name (gluetun, search,
# windmill, alertmanager). Empty: none.
CHECKS=${CHECKS:-}
# Plain HTTP checks, "name=url ...": each must answer 2xx.
CHECK_URLS=${CHECK_URLS:-}
# Services never put back after a failed check: they migrate a database on
# start, which their old image may not run on.
NO_ROLLBACK=${NO_ROLLBACK:-}
# Unraid's Compose Manager takes <dir>/<project>.lock for every action on a
# stack; holding it too means an update and a UI action (or Compose Manager's
# `up` at boot) wait for each other instead of recreating the same containers
# at once. How long to wait for it before skipping a run.
CM_LOCK_DIR=${CM_LOCK_DIR:-}
CM_LOCK_WAIT=${CM_LOCK_WAIT:-600}
# A scheduled run in which a pull failed is done again this many times, this
# many seconds apart, when that comes before the next run would: the network
# down for a minute (a router restarting) shouldn't cost a day. 0: never.
PULL_RETRIES=${PULL_RETRIES:-3}
PULL_RETRY_WAIT=${PULL_RETRY_WAIT:-600}
DATA_DIR=${DATA_DIR:-/data}
HELD=$DATA_DIR/held
LOCK=$DATA_DIR/lock
# Left by a run whose pulls failed, for the schedule to try it again.
RETRY=$DATA_DIR/pull-retry
# Each service's image as the stack last ran it, "<service>\t<ref>": what
# prune compares the stack with.
IMAGES=$DATA_DIR/images
# Windmill's dumps: a host path, mounted at the same path here, since the
# pg_dump container it starts is the host's to mount.
BACKUP_DIR=${BACKUP_DIR:-}
BACKUP_KEEP=${BACKUP_KEEP:-3}
PG_IMAGE=${PG_IMAGE:-postgres:alpine}
WINDMILL_DATABASE_URL=${WINDMILL_DATABASE_URL:-}
GLUETUN_CONTAINER=${GLUETUN_CONTAINER:-gluetun}
GLUETUN_API=${GLUETUN_API:-http://127.0.0.1:8001}
SEARXNG_URL=${SEARXNG_URL:-http://127.0.0.1:8083}
WINDMILL_URL=${WINDMILL_URL:-http://127.0.0.1:8000}
WAIT_TIMEOUT=${WAIT_TIMEOUT:-600}
# After `up --wait`, how long a service must stay up before it counts: a
# Windmill that dies on a migration error is healthy for its first seconds.
SETTLE=${SETTLE:-60}
# A tunnel just brought up can take a few tries to search through.
SEARCH_TRIES=${SEARCH_TRIES:-3}
SEARCH_WAIT=${SEARCH_WAIT:-20}
# The sender label on its alerts: one per stack, so each stack's are its own.
ALERT_SENDER=${ALERT_SENDER:-stack-updater}
ALERT_NAME=stack-update
# Beside this script in the image; in the repo, lib/.
ALERT_LIB=${ALERT_LIB:-$(dirname "$0")/alert.sh}
[ -f "$ALERT_LIB" ] || ALERT_LIB=$(dirname "$0")/lib/alert.sh
. "$ALERT_LIB"

# The compose project names everything this makes (its rollback tags, its
# helper, Compose Manager's lock): there's no sensible default.
[ -n "$PROJECT" ] || { echo "PROJECT must be set: the stack's compose project name"; exit 1; }

log() { echo "$(date '+%F %T') $*"; }

# The compose files, as arguments: the stack's, then the override if there is one.
compose_files() {
  printf -- '-f\n%s\n' "$COMPOSE_FILE"
  if [ -n "$OVERRIDE_DIR" ] && [ -f "$OVERRIDE_DIR/$OVERRIDE_FILE" ]; then
    printf -- '-f\n%s\n' "$OVERRIDE_DIR/$OVERRIDE_FILE"
  fi
}

dc() {
  set -- $(compose_files | tr '\n' ' ') --env-file "$ENV_FILE" "$@"
  docker compose -p "$PROJECT" "$@"
}

# The stack's services, less this one.
services() {
  dc config --services | while IFS= read -r s; do [ "$s" = "$SELF" ] || echo "$s"; done
}

image_of() { dc config --format json | jq -r --arg s "$1" '.services[$s].image'; }

# A service's container: "<image id>\t<status>\t<health>\t<restarts>\t<exit code>".
# Empty when it has none.
container() {
  cid=$(dc ps -a -q "$1" | head -1)
  [ -n "$cid" ] || return 0
  docker inspect -f '{{.Image}}	{{.State.Status}}	{{if .State.Health}}{{.State.Health.Status}}{{end}}	{{.RestartCount}}	{{.State.ExitCode}}' "$cid"
}

field() { printf '%s\n' "$1" | cut -f"$2"; }

image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }

rollback_ref() { echo "$PROJECT-rollback/$1:previous"; }

is_held() { grep -qxF "$(printf '%s\t%s' "$1" "$2")" "$HELD" 2>/dev/null; }

hold() { is_held "$1" "$2" || printf '%s\t%s\n' "$1" "$2" >>"$HELD"; }

# --- releases ---

# The .env variable a service's release tag lives in; empty if it floats.
release_var() {
  for r in $RELEASES; do [ "${r%%=*}" = "$1" ] && { echo "${r#*=}"; return; }; done
}

env_get() { sed -nE "s/^$1=\"?([^\"]*)\"?$/\1/p" "$ENV_FILE" | tail -1; }

# Set one variable in .env, leaving every other line as it is. Written in
# place (not moved over), so the file keeps its owner and mode.
env_set() { # <var> <value>
  tmp=$DATA_DIR/env.new
  awk -v k="$1" -v v="$2" '
    $0 ~ "^" k "=" { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" >"$tmp" && cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
}

is_release() { printf '%s\n' "$1" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+$'; }

# Is $1 a later release than $2? Anything is later than a tag that isn't one.
later() {
  [ "$1" != "$2" ] || return 1
  is_release "$2" || return 0
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

# Every tag of a repository (ghcr.io/owner/name, or a Docker Hub owner/name),
# from its registry's API, anonymously, following its pages.
registry_tags() { # <repository>
  case $1 in
    ghcr.io/*)
      host=ghcr.io name=${1#ghcr.io/}
      token_url="https://ghcr.io/token?scope=repository:$name:pull" ;;
    *.*/*) log "can't list tags on ${1%%/*}"; return 1 ;;
    */*)
      host=registry-1.docker.io name=$1
      token_url="https://auth.docker.io/token?service=registry.docker.io&scope=repository:$name:pull" ;;
    *)
      host=registry-1.docker.io name=library/$1
      token_url="https://auth.docker.io/token?service=registry.docker.io&scope=repository:$name:pull" ;;
  esac
  token=$(curl -fsS -m 20 "$token_url" | jq -r '.token // .access_token // empty') || return 1
  [ -n "$token" ] || return 1
  url="https://$host/v2/$name/tags/list?n=1000"
  headers=$DATA_DIR/tags.headers
  pages=0
  while [ -n "$url" ] && [ "$pages" -lt 100 ]; do
    pages=$((pages + 1))
    page=$(curl -fsS -m 30 -D "$headers" -H "Authorization: Bearer $token" "$url") || return 1
    printf '%s\n' "$page" | jq -r '.tags[]?' || return 1
    next=$(tr -d '\r' <"$headers" | sed -nE 's/^[Ll]ink: *<([^>]*)>.*rel="next".*/\1/p')
    case $next in
      "") url= ;;
      http*) url=$next ;;
      *) url="https://$host$next" ;;
    esac
  done
}

# The repository's highest x.y.z (or vx.y.z) tag: builds, pre-releases and
# variants (main, latest, 1.2.3-rc1, 1.2.3-full) are left out.
newest_release() { # <repository>
  tags=$(registry_tags "$1") || return 1
  printf '%s\n' "$tags" | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
}

# gluetun's control-server password, read from its own env so it isn't stored here.
password() {
  docker inspect "$GLUETUN_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n 's/^HTTP_CONTROL_SERVER_AUTH_DEFAULT_ROLE=//p' \
    | sed -E 's/.*"password" *: *"([^"]*)".*/\1/'
}

windmill_version() { curl -fsS -m 10 "$WINDMILL_URL/api/version" 2>/dev/null; }

# The image that wrote a dump, kept under a tag named for it:
# windmill-<stamp>-<version>.dump -> <project>-rollback/windmill:<stamp>.
# Restoring a dump needs the Windmill that matches it, and the :previous tag
# moves on every run.
dump_image() { # <dump file>
  stamp=$(basename "$1" | sed -nE 's/^windmill-([0-9]{8}-[0-9]{6})-.*/\1/p')
  [ -n "$stamp" ] && echo "$PROJECT-rollback/windmill:$stamp"
}

# Dump Windmill's database to BACKUP_DIR, and tag the image running on it;
# prints the file. Through a postgres container, so pg_dump is as new as the
# server it dumps.
backup_windmill() {
  [ -n "$BACKUP_DIR" ] && [ -n "$WINDMILL_DATABASE_URL" ] || { log "no BACKUP_DIR or WINDMILL_DATABASE_URL"; return 1; }
  mkdir -p "$BACKUP_DIR"
  version=$(windmill_version | tr -c 'A-Za-z0-9.\n' '-' | head -1)
  file="windmill-$(date '+%Y%m%d-%H%M%S')-${version:-unknown}.dump"
  # pg_dump must be at least as new as the server, and nothing else keeps this
  # image current: pull it first (a failed pull dumps with what's here).
  docker pull -q "$PG_IMAGE" >/dev/null 2>&1 || log "couldn't pull $PG_IMAGE; dumping with the local one"
  # The URL goes in through the environment, not the command line, where
  # `docker ps` and the host's process list would show its password.
  if ! PGURL=$WINDMILL_DATABASE_URL docker run --rm -e PGURL -v "$BACKUP_DIR:/backup" "$PG_IMAGE" \
    sh -c "pg_dump -Fc -d \"\$PGURL\" -f /backup/$file" >&2; then
    rm -f "$BACKUP_DIR/$file"
    return 1
  fi
  docker tag "$(field "$(container windmill)" 1)" "$(dump_image "$file")" >&2
  # Only the newest BACKUP_KEEP, and their images: a Windmill image is ~1.5GB.
  ls -1t "$BACKUP_DIR"/windmill-*.dump 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | while IFS= read -r old; do
    rm -f "$old"
    tag=$(dump_image "$old") && docker rmi "$tag" >/dev/null 2>&1
  done
  echo "$BACKUP_DIR/$file"
}

# --- checks: each prints why it failed, and returns 1 ---

# Up, healthy if it has a healthcheck, and not restarted since $2 restarts.
check_running() { # <service> [restarts before]
  c=$(container "$1")
  [ -n "$c" ] || { echo "$1 has no container"; return 1; }
  [ "$(field "$c" 2)" = running ] || { echo "$1 is $(field "$c" 2)"; return 1; }
  h=$(field "$c" 3)
  [ -z "$h" ] || [ "$h" = healthy ] || { echo "$1 is $h"; return 1; }
  [ -z "${2:-}" ] || [ "$(field "$c" 4)" = "$2" ] || { echo "$1 restarted $(($(field "$c" 4) - $2)) times"; return 1; }
}

# The control server answers, the tunnel is up, and the settings still carry
# the fields a client that moves the VPN exit reads and writes (provider, type,
# server_selection.regions).
check_gluetun() {
  pw=$(password)
  [ -n "$pw" ] || { echo "gluetun has no control-server password"; return 1; }
  status=$(curl -fsS -m 10 -u "controlserver:$pw" "$GLUETUN_API/v1/vpn/status" 2>/dev/null) \
    || { echo "gluetun's control server doesn't answer"; return 1; }
  [ "$(printf '%s' "$status" | jq -r '.status // empty' 2>/dev/null)" = running ] \
    || { echo "gluetun's VPN isn't running ($status)"; return 1; }
  # Parsed here and never printed: the settings hold the VPN keys.
  curl -fsS -m 10 -u "controlserver:$pw" "$GLUETUN_API/v1/vpn/settings" 2>/dev/null \
    | jq -e '(.provider.name | type == "string") and (.type | type == "string")
        and (.provider.server_selection | type == "object" and has("regions"))' >/dev/null 2>&1 \
    || { echo "gluetun's /v1/vpn/settings no longer has provider.name, type and provider.server_selection.regions"; return 1; }
}

# A search answers, in the JSON clients read. Engines refusing the VPN exit
# isn't the update's doing (moving the exit is); no answer at all, or
# every engine failing to connect, is.
check_search() {
  try=1
  while :; do
    why=$(search_once) && return 0
    [ "$try" -ge "$SEARCH_TRIES" ] && { echo "$why"; return 1; }
    try=$((try + 1))
    sleep "$SEARCH_WAIT"
  done
}

search_once() {
  body=$(curl -fsS -m 30 "$SEARXNG_URL/search?q=weather&format=json" 2>/dev/null) \
    || { echo "SearXNG doesn't answer a search"; return 1; }
  shape=$(printf '%s\n' "$body" | jq -er '
    select((.results | type == "array") and (.unresponsive_engines | type == "array"))
    | [ (.results | length),
        ([.unresponsive_engines[] | select(.[1] | test("connection error"; "i"))] | length),
        (.unresponsive_engines | length) ] | @tsv' 2>/dev/null) \
    || { echo "SearXNG's JSON answer has changed shape"; return 1; }
  if [ "$(field "$shape" 1)" -eq 0 ] && [ "$(field "$shape" 2)" -gt 0 ] \
    && [ "$(field "$shape" 2)" = "$(field "$shape" 3)" ]; then
    echo "SearXNG has no network: every engine fails to connect"
    return 1
  fi
}

check_windmill() {
  windmill_version >/dev/null || { echo "Windmill doesn't answer /api/version"; return 1; }
}

# Where the alerts go: an update that breaks it would silence the rest.
check_alertmanager() {
  [ -n "${ALERTMANAGER_URL:-}" ] || return 0
  curl -fsS -m 10 "$ALERTMANAGER_URL/-/healthy" >/dev/null 2>&1 \
    || { echo "Alertmanager isn't healthy"; return 1; }
}

check_urls() {
  for c in $CHECK_URLS; do
    curl -fsS -m 10 -o /dev/null "${c#*=}" 2>/dev/null || echo "${c%%=*} doesn't answer ${c#*=}"
  done
}

# Every check; prints one line per failure. RESTARTS holds "<service>\t<n>"
# lines taken right after `up`.
check_stack() {
  for s in $(services); do
    check_running "$s" "$(printf '%s\n' "${RESTARTS:-}" | awk -F'\t' -v s="$s" '$1 == s { print $2 }')"
  done
  for c in $CHECKS; do
    case $c in
      gluetun) check_gluetun ;;
      search) check_search ;;
      windmill) check_windmill ;;
      alertmanager) check_alertmanager ;;
      *) echo "unknown check: $c" ;;
    esac
  done
  check_urls
}

restarts() { for s in $(services); do printf '%s\t%s\n' "$s" "$(field "$(container "$s")" 4)"; done; }

up() { # [--pull never]
  dc up -d --wait --wait-timeout "$WAIT_TIMEOUT" "$@" $(services) >&2
}

verify() {
  up_ok=0
  up "$@" || up_ok=1
  RESTARTS=$(restarts)
  sleep "$SETTLE"
  FAILED=$(check_stack)
  [ "$up_ok" = 0 ] || FAILED="docker compose up failed${FAILED:+
$FAILED}"
  [ -z "$FAILED" ]
}

# This container, after the rest: pulled like them, but recreated by a helper
# container started from the new image, which outlives this one. No checks or
# rollback: nothing of this run is left to do them, and a broken updater
# breaks nothing but the next update.
self_update() {
  ref=$(image_of "$SELF")
  old=$(field "$(container "$SELF")" 1)
  docker pull -q "$ref" >/dev/null 2>&1 || { log "$SELF: pull of $ref failed"; return 0; }
  new=$(image_id "$ref")
  [ -n "$old" ] && [ -n "$new" ] && [ "$new" != "$old" ] || return 0
  log "$SELF: recreating on $ref ($new), from a helper"
  docker rm -f "$PROJECT-self-update" >/dev/null 2>&1
  # Under Compose Manager's lock too, when there is one.
  lock=
  [ -n "$CM_LOCK_DIR" ] && [ -d "$CM_LOCK_DIR" ] && lock="flock -w $CM_LOCK_WAIT '$CM_LOCK_DIR/$PROJECT.lock' "
  docker run -d --rm --name "$PROJECT-self-update" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$STACK_DIR:$STACK_DIR" \
    ${OVERRIDE_DIR:+-v "$OVERRIDE_DIR:$OVERRIDE_DIR:ro"} ${lock:+-v "$CM_LOCK_DIR:$CM_LOCK_DIR"} "$ref" \
    sh -c "sleep 5; ${lock}docker compose -p '$PROJECT' $(compose_files | sed "/^-f$/!s/.*/'&'/" | tr '\n' ' ')--env-file '$ENV_FILE' up -d --no-deps '$SELF'" >/dev/null
}

# --- cleanup ---

images_now() { for s in $(services); do printf '%s\t%s\n' "$s" "$(image_of "$s")"; done; }

# Untag what the stack ran before and no longer runs: the release it moved
# past, a tag its compose file no longer names, and the :previous of a service
# it no longer has. `docker image prune` takes untagged images, but nothing
# takes these, and every release a stack moves past would pile up. Only after
# a run that left the stack working, since a rollback to the release before
# needs its tag. `docker rmi` without -f refuses an image a container uses
# (another stack's too: that ref is tried again next run), and only untags one
# tagged otherwise (:previous, the image of a Windmill dump).
prune() {
  now=$(images_now)
  # Compose couldn't read the stack: everything would look gone.
  if [ -z "$now" ] || printf '%s\n' "$now" | cut -f2 | grep -qxE '|null'; then
    log "couldn't read the stack's images; not pruning"
    return 0
  fi
  left=
  if [ -f "$IMAGES" ]; then
    while IFS='	' read -r s ref; do
      [ -n "$ref" ] || continue
      if ! printf '%s\n' "$now" | cut -f1 | grep -qxF "$s"; then
        docker rmi "$(rollback_ref "$s")" >/dev/null 2>&1 \
          && log "$s: no longer in the stack; untagged $(rollback_ref "$s")"
      fi
      printf '%s\n' "$now" | cut -f2 | grep -qxF "$ref" && continue
      if docker rmi "$ref" >/dev/null 2>&1; then
        log "$s: untagged $ref, which the stack no longer runs"
      elif [ -n "$(image_id "$ref")" ]; then
        left="$left$s	$ref
"
      fi
    done <"$IMAGES"
  fi
  printf '%s%s\n' "$left" "$now" >"$IMAGES"
}

# One run at a time: a manual `now` during the nightly one waits for it. And
# none while Compose Manager is acting on the stack, nor it while one runs.
locked() {
  mkdir -p "$DATA_DIR"
  (
    flock 9
    if [ -n "$CM_LOCK_DIR" ] && [ -d "$CM_LOCK_DIR" ]; then
      exec 8>>"$CM_LOCK_DIR/$PROJECT.lock"
      flock -w "$CM_LOCK_WAIT" 8 || { log "Compose Manager is busy with $PROJECT; skipping this run"; exit 1; }
    fi
    "$@"
  ) 9>"$LOCK"
}

is_no_rollback() { case " $NO_ROLLBACK " in *" $1 "*) return 0 ;; esac; return 1; }

# Put a service back on the image it ran before this run: its release tag in
# .env, or its floating tag pointed at the old image.
put_back() { # <service>
  retag=$(printf '%s\n' "$RETAGGED" | awk -F'\t' -v s="$1" '$1 == s { print $2 "\t" $3 }')
  if [ -n "$retag" ]; then
    env_set "$(field "$retag" 1)" "$(field "$retag" 2)"
  else
    docker tag "$(rollback_ref "$1")" "$(image_of "$1")"
  fi
}

update() {
  mkdir -p "$DATA_DIR"
  touch "$HELD"
  changed=
  held_now=
  # "<service>\t<var>\t<old tag>" for each release tag this run moved.
  RETAGGED=
  # "<ref>: <error>" for each pull that failed.
  pull_failed=
  for s in $(services); do
    ref=$(image_of "$s")
    old=$(field "$(container "$s")" 1)
    [ -n "$old" ] && docker tag "$old" "$(rollback_ref "$s")"
    target=$ref
    var=$(release_var "$s")
    if [ -n "$var" ]; then
      current=${ref##*:}
      if newest=$(newest_release "${ref%:*}") && [ -n "$newest" ]; then
        later "$newest" "$current" && target=${ref%:*}:$newest
      else
        log "$s: couldn't list ${ref%:*}'s releases; keeping $current"
      fi
    fi
    if ! err=$(docker pull -q "$target" 2>&1 >/dev/null); then
      log "$s: pull of $target failed; keeping what runs"
      pull_failed="$pull_failed$target: $(printf '%s' "$err" | tail -1)
"
      continue
    fi
    new=$(image_id "$target")
    [ -n "$old" ] && [ -n "$new" ] && [ "$new" != "$old" ] || continue
    if is_held "$s" "$new"; then
      # Point the tag back, so nothing that runs `up` meanwhile (Compose
      # Manager at boot) starts the image that failed. A release tag in .env
      # hasn't moved, so needs nothing.
      [ "$target" = "$ref" ] && docker tag "$old" "$ref"
      held_now="$held_now $s"
      log "$s: holding back $target ($new), which failed its checks before"
      continue
    fi
    if [ "$target" != "$ref" ]; then
      env_set "$var" "${target##*:}"
      RETAGGED="$RETAGGED$s	$var	$current
"
      log "$s: $current -> ${target##*:}"
    fi
    changed="$changed $s"
  done

  # A pull that keeps failing (an expired registry login) stops updates
  # without breaking anything, so it would go unnoticed. One that fails while
  # the schedule has another try left (RETRY_AFTER) isn't reported yet: the
  # last try is, if it fails too.
  rm -f "$RETRY"
  if [ -n "$pull_failed" ] && [ -n "${RETRY_AFTER:-}" ]; then
    : >"$RETRY"
  elif [ -n "$pull_failed" ]; then
    alert "$ALERT_NAME-pull" raise "Couldn't pull, so these weren't updated (a 403, \"denied\" or \"unauthorized\" from ghcr.io means the host's docker login has expired): $(printf '%s' "$pull_failed" | tr '\n' ';')"
  else
    alert "$ALERT_NAME-pull" resolve
  fi

  backup=
  case " $changed " in
    *" windmill "*)
      if backup=$(backup_windmill); then
        log "windmill: database dumped to $backup"
      else
        log "windmill: database dump failed; not updating Windmill"
        put_back windmill
        changed=$(printf '%s\n' $changed | grep -vx windmill | tr '\n' ' ')
        alert "$ALERT_NAME" raise "Windmill wasn't updated: dumping its database to $BACKUP_DIR failed, and Windmill migrates its database on start. The other services were updated as usual."
        DUMP_FAILED=1
      fi
      ;;
  esac

  if [ -z "$(printf '%s' "$changed" | tr -d ' ')" ]; then
    log "up to date${held_now:+ (holding back:$held_now)}"
    # Nothing new and nothing held: an alert from an earlier update is over
    # once the stack checks out (e.g. Windmill restored by hand).
    [ -z "$held_now" ] && [ -z "${DUMP_FAILED:-}" ] && [ -z "$(check_stack)" ] && alert "$ALERT_NAME" resolve
    return 0
  fi
  log "updating:$changed"
  if verify; then
    log "updated:$changed — checks pass"
    [ -n "$held_now" ] || [ -n "${DUMP_FAILED:-}" ] || alert "$ALERT_NAME" resolve
    return 0
  fi
  log "checks failed after updating$changed:"
  printf '%s\n' "$FAILED" | sed 's/^/  /'
  first_failure=$FAILED

  # Put back every updated service but those that migrate a database, and
  # hold the new images.
  rolled=
  windmill_note=
  for s in $changed; do
    if is_no_rollback "$s"; then
      if [ "$s" = windmill ]; then
        windmill_note="$windmill_note Windmill was updated too and is NOT rolled back (an older Windmill can't run on the database the new one migrated); if it is the one broken, restore $backup with pg_restore and start the image that wrote it, $(dump_image "$backup")."
      else
        windmill_note="$windmill_note $s was updated too and is NOT rolled back: it migrates its database on start, which its old image may not run on."
      fi
      continue
    fi
    hold "$s" "$(image_id "$(image_of "$s")")"
    put_back "$s"
    rolled="$rolled $s"
  done
  if [ -n "$rolled" ] && verify --pull never; then
    log "rolled back$rolled — checks pass"
    alert "$ALERT_NAME" raise "An update broke the stack, so$rolled went back to the images it ran before; those new images are held until newer ones come. What failed: $(printf '%s' "$first_failure" | tr '\n' ';')$windmill_note"
    return 0
  fi
  log "still failing${rolled:+ after rolling back$rolled}:"
  printf '%s\n' "$FAILED" | sed 's/^/  /'
  alert "$ALERT_NAME" raise "An update broke the stack and it is still broken${rolled:+ after rolling back$rolled}. Updated:$changed. What fails now: $(printf '%s' "$FAILED" | tr '\n' ';')$windmill_note"
  return 1
}

[ -n "$STACK_DIR" ] || { log "STACK_DIR isn't set"; exit 1; }

case ${1:-} in
  check)
    ALERT_QUIET=1
    FAILED=$(check_stack)
    if [ -z "$FAILED" ]; then log "checks pass"; exit 0; fi
    printf '%s\n' "$FAILED"
    exit 1
    ;;
  now)
    locked update
    rc=$?
    [ "$rc" != 0 ] || locked prune
    locked self_update
    exit $rc
    ;;
esac

# Seconds until the next UPDATE_AT. A loop rather than crond, whose jobs don't
# inherit the container's environment, and the settings are all in it.
until_next() {
  now=$(date +%s)
  at=$(date -d "$(date +%F) $UPDATE_AT" +%s) || return 1
  [ "$at" -gt "$now" ] || at=$((at + 86400))
  echo $((at - now))
}

# A scheduled run. Pulls that fail (the network down while a router restarts,
# a registry's bad minute) would otherwise wait for the next run, a day away:
# the run is done again PULL_RETRY_WAIT seconds later, up to PULL_RETRIES
# times, unless the next run comes sooner than that. update holds its pull
# alert back until the last of them. Outside the locks while it waits.
scheduled() {
  retries=0
  while :; do
    RETRY_AFTER=
    [ "$retries" -lt "$PULL_RETRIES" ] && [ "$PULL_RETRY_WAIT" -lt "${UPDATE_EVERY:-$(until_next)}" ] \
      && RETRY_AFTER=$PULL_RETRY_WAIT
    rm -f "$RETRY"
    locked update && locked prune
    [ -n "$RETRY_AFTER" ] && [ -f "$RETRY" ] || break
    retries=$((retries + 1))
    log "pulls failed; trying again in ${PULL_RETRY_WAIT}s ($retries of $PULL_RETRIES)"
    sleep "$PULL_RETRY_WAIT" &
    wait $!
  done
  locked self_update
}

case $PULL_RETRIES$PULL_RETRY_WAIT in
  *[!0-9]*) log "PULL_RETRIES and PULL_RETRY_WAIT must be numbers"; exit 1 ;;
esac
if [ -n "$UPDATE_EVERY" ]; then
  case $UPDATE_EVERY in *[!0-9]*) UPDATE_EVERY=0 ;; esac
  [ "$UPDATE_EVERY" -ge 60 ] || { log "UPDATE_EVERY must be a number of seconds, at least 60"; exit 1; }
  log "updating $PROJECT every ${UPDATE_EVERY}s ($COMPOSE_FILE)"
else
  until_next >/dev/null || { log "UPDATE_AT must be HH:MM, not '$UPDATE_AT'"; exit 1; }
  log "updating $PROJECT daily at $UPDATE_AT ($COMPOSE_FILE)"
fi
# As PID 1, sh ignores a stop's SIGTERM unless it traps it, and defers even
# that until a foreground `sleep` ends: sleep in the background and wait.
trap 'exit 0' TERM INT
while :; do
  sleep "${UPDATE_EVERY:-$(until_next)}" &
  wait $!
  scheduled
done
