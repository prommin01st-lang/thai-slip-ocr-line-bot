#!/usr/bin/env bash
# Consistent single-VM snapshot: pause only this app's writers, include SQLite WAL + S3 metadata/data.
set -euo pipefail
cd "$(dirname "$0")/.."
backup_dir="${BACKUP_DIR:-/var/backups/slipingman}"
keep="${KEEP_FULL_BACKUPS:-7}"
project="${COMPOSE_PROJECT_NAME:-slipingman}"
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo 'KEEP_FULL_BACKUPS must be positive' >&2; exit 1; }
install -d -m 700 "$backup_dir"
exec 9>"$backup_dir/.lock"
flock -n 9 || exit 0
archive="slipingman-full-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
paused=0
complete=0
cleanup() {
  if [[ "$paused" == 1 ]]; then docker compose -p "$project" unpause bot storage >/dev/null 2>&1 || true; fi
  if [[ "$complete" == 0 ]]; then rm -f -- "$backup_dir/$archive.partial"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
docker volume inspect "${project}_bot-data" "${project}_evidence-data" >/dev/null
# Pull before pausing, so a registry outage cannot extend downtime.
docker image inspect alpine:3.22 >/dev/null 2>&1 || docker pull alpine:3.22 >/dev/null
paused=1
docker compose -p "$project" pause bot storage >/dev/null
docker run --rm --network none --read-only \
  --mount "type=volume,source=${project}_bot-data,target=/snapshot/bot,readonly" \
  --mount "type=volume,source=${project}_evidence-data,target=/snapshot/evidence,readonly" \
  --mount "type=bind,source=$backup_dir,target=/backups" \
  --env "ARCHIVE_NAME=$archive" alpine:3.22 sh -c \
  'umask 077; tar -czf "/backups/$ARCHIVE_NAME.partial" --exclude="bot/backups" -C /snapshot bot evidence'
docker compose -p "$project" unpause bot storage >/dev/null
paused=0
gzip -t "$backup_dir/$archive.partial"
mv -- "$backup_dir/$archive.partial" "$backup_dir/$archive"
chmod 600 "$backup_dir/$archive"
complete=1
find "$backup_dir" -maxdepth 1 -type f -name 'slipingman-full-*.tar.gz' -printf '%f\n' \
  | sort -r | tail -n "+$((keep+1))" | while IFS= read -r old; do rm -- "$backup_dir/$old"; done
printf 'Full snapshot verified: %s\n' "$backup_dir/$archive"
