# SPDX-License-Identifier: MPL-2.0
# alert.sh: raise and resolve alerts in Alertmanager, through its standard API
# (POST /api/v2/alerts). Sourced by update.sh.
#
#   alert <alertname> <raise|resolve> [summary]
#
# Labels are the alert's name and $ALERT_SENDER, nothing more: Alertmanager
# matches a resolve to its raise by labels, so anything that varies between
# the two (the message) goes in the `summary` annotation instead.
#
# A raise is sent once, so it carries an endsAt $ALERT_FIRING_FOR seconds
# ahead (30 days). Without one, Alertmanager resolves an alert nobody re-sends
# after its resolve_timeout (5 minutes), which suits Prometheus re-evaluating
# rules but would close these before anyone read them. A resolve is an endsAt
# of now; resolving something never raised sends nothing.
#
# No ALERTMANAGER_URL, or ALERT_QUIET=1 (a script's check mode), sends nothing.
# A failed send is logged and never fatal: an alert must not stop the fix.

alert() { # <alertname> <raise|resolve> [summary]
  [ "${ALERT_QUIET:-}" = 1 ] && return 0
  [ -n "${ALERTMANAGER_URL:-}" ] || return 0
  now=$(date +%s)
  case $2 in
    raise) ends=$((now + ${ALERT_FIRING_FOR:-2592000})) ;;
    resolve) ends=$now ;;
    *) return 1 ;;
  esac
  body=$(jq -nc --arg name "$1" --arg sender "${ALERT_SENDER:-}" --arg summary "${3:-}" \
    --argjson ends "$ends" '[{
      labels: ({alertname: $name} + (if $sender == "" then {} else {sender: $sender} end)),
      annotations: (if $summary == "" then {} else {summary: $summary} end),
      endsAt: ($ends | todate)
    }]')
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' --data-binary "$body" \
    "$ALERTMANAGER_URL/api/v2/alerts" >/dev/null 2>&1 \
    || echo "$(date '+%F %T') could not send $1 ($2) to $ALERTMANAGER_URL"
}
