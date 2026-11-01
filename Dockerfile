# SPDX-License-Identifier: MPL-2.0
# stack-updater: pull + up of a compose stack, checked, rolled back when an
# update breaks it. Built by .github/workflows/release.yml; see README.md.
FROM docker:cli AS runner
# util-linux flock: busybox's can't wait with a timeout (-w).
RUN apk add --no-cache curl jq tzdata flock
COPY update.sh /update.sh
# Beside the script, where it looks for it.
COPY lib/alert.sh /alert.sh
VOLUME /data
CMD ["sh", "/update.sh"]
