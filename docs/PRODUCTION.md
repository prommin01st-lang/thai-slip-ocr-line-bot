# Production readiness and operation

Phases 1–5 are implemented locally. Deployment to `root@peq` is phase 6. Do not treat a local test result as confirmation of LINE, Google, storage or VM credentials.

## Configuration

Use Node 22. Copy `.env.production.example` to `.env` **on the target host** and set permissions to `600`. Fill LINE credentials, `ADMIN_USERS` (comma-separated LINE IDs), a random `OCR_TOKEN` of at least 32 characters, and a real HTTPS `PUBLIC_URL` origin. `ADMIN_USERS` enables approval-based access; admins can approve additional users in chat. Group/room events are ignored even when they include a user ID.

`docker compose` passes the same OCR token to both services and keeps OCR internal. The bot binds only to `127.0.0.1:3000`; put an HTTPS reverse proxy in front. `DB_PATH` must stay inside the persistent `/app/data` volume. Google integration requires both SA email and PEM key. Never print `docker compose config` or an unfiltered environment into shared logs.

```bash
npm ci
npm run check:env                         # static check; names/results only
node scripts/check-env.mjs --production --online
# In the bot container after deployment:
docker compose exec -T bot node scripts/check-env.mjs --production --online
```

The online check reads LINE bot/webhook configuration, OCR health/auth flag, S3 bucket access, Google credential token exchange and, when configured, tabs from `CHECK_SPREADSHEET_ID`. Without a target sheet, per-sheet access is explicitly skipped; users must share/link their own sheet. It sends no LINE messages. OCR health does not prove token equality; the signed end-to-end smoke test must also read a slip. S3 HEAD does not prove write/delete permission or bucket privacy; verify those independently before enabling evidence.

After changing `.env`, use `docker compose up -d`; `restart` retains old environment values. Back up before a code/schema upgrade. Migration 8 is additive and runs in a transaction. A rollback should use the pre-upgrade backup when the previous code cannot read the new schema.

## Private evidence

Configure a private S3-compatible bucket, HTTPS endpoint, region and credentials (or AWS IAM role). Deny public reads/listing. Allow the app bucket-scoped GetObject, PutObject, DeleteObject and bucket HEAD. Keep bucket versioning **disabled**: deletion removes the current object; versioned copies require a separate purge/retention policy. Credentials never enter LINE messages or generated URLs. Files travel through the backend; links contain random bearer tokens, expire after five minutes, and resolve ownership on every request. Anyone holding a live link can use it until expiry; do not forward financial links.

Explicitly attaching a file constitutes consent to store that file. Automatic originals are off per user until `เก็บต้นฉบับ เปิด`. `เก็บต้นฉบับ ปิด` stops future storage; it does not erase existing evidence. Only JPEG, PNG, WebP and PDF are accepted, max 10 MB and ten files per transaction. File type is checked from bytes; this is not malware scanning. Downloads use safe content headers.

Deleting evidence, a transaction, or a user revokes access immediately and writes a durable physical-deletion job. Cleanup runs every 30 seconds, including when new attachments are disabled but the bucket is still configured. Uploads interrupted before metadata commit have a cleanup ticket delayed one hour. Keep storage credentials until all cleanup jobs have drained. Check jobs with `node scripts/jobs.mjs list`. External copies already downloaded and old backups are outside live deletion; apply a documented retention policy (default local DB backups: 14 days).

## Durable jobs and recovery

Signed webhook events are persisted before HTTP 200. Failed persistence returns 503 so LINE can retry. Event IDs remain as deduplication tombstones; successful payloads are cleared. Accounting writes and per-event replay results commit together. Identical text in a new event remains a valid new purchase. Image selections still batch up to ten files. Import previews persist for ten minutes.

In-flight jobs recover on startup. Transient failures use exponential backoff, then enter `failed` after five attempts. Failed payloads remain for seven days for operator recovery, then are erased while the event ID is retained. LINE content may expire before a very late recovery; ask the user to resend in that case. Financial writes are replay-safe; a crash after an external LINE send but before job completion can still duplicate the notification.

```bash
node scripts/jobs.mjs list
node scripts/jobs.mjs retry EVENT_ID       # after correcting the dependency failure
```

## Backup, restore and validation

`node scripts/backup.mjs --keep 14` uses `VACUUM INTO`, not a raw copy of a live WAL database. Backups include evidence metadata, document snapshots, pending work and replay results, but **not S3 object bytes**. Protect off-host backups and coordinate object retention with your recovery window. Restore only with the bot stopped: preserve the current volume first, restore the selected snapshot to `DB_PATH`, and remove stale WAL/SHM files associated with the replaced database. Recovering an old snapshot may re-expose data previously deleted; reconcile deletion history and verify object availability before resuming traffic.

`npm test` runs offline with synthetic LINE credentials. Tests cover accounting rollback, replay, restart recovery, batch routing, evidence ownership/deletion, document snapshots/numbering, HTTP signatures, private links, env validation and backup restoration. PDF QA uses Thai fonts and multipage examples. `npm audit --omit=dev` checks dependency advisories.

Before production sign-off, verify actual storage privacy and upload/delete, Google access, LINE webhook reachability, a real slip, proof attachment and document download. These live checks belong to phase 6 and require configured services and a human LINE test.

## Single-VM storage on peq

`compose.storage.yml` adds SeaweedFS 4.48 (pinned image digest) with a persistent evidence volume and an isolated `internal: true` Docker network. No storage ports are published. Set `COMPOSE_FILE=docker-compose.yml:compose.storage.yml`, `S3_ENDPOINT=http://storage:8333`, `S3_REGION=us-east-1`, `S3_FORCE_PATH_STYLE=true`, `S3_INTERNAL_NETWORK=on`, and strong generated S3 credentials in the VM's `.env`. The HTTP exception is limited to this exact service endpoint; other production S3 endpoints still require HTTPS. `S3_BUCKET` is pre-created privately at startup, and anonymous access must be tested before enabling the webhook.

On peq the public bot endpoint uses a dedicated Cloudflare Tunnel at `https://slipingman.petanque21st.com`, while bot port 3000, OCR and storage remain unpublished to external interfaces. The VM uses a dedicated read-only GitHub deploy key. No source machine's private key or GitHub token is transferred.

## Dedicated Cloudflare subdomain

Use `COMPOSE_FILE=docker-compose.yml:compose.storage.yml:compose.cloudflare.yml` on peq. The new `slipingman` tunnel routes `slipingman.petanque21st.com` to `http://bot:3000` on this project's Docker network. Existing website and ContextGate tunnels are not changed. Set `CLOUDFLARE_TUNNEL_CONFIG=/etc/slipingman/cloudflared.yml` and `CLOUDFLARE_TUNNEL_CREDENTIALS` to the dedicated credential JSON path on the VM. Only that tunnel's credential file is mounted into the connector; the account certificate remains on the host. Set `PUBLIC_URL=https://slipingman.petanque21st.com` before starting the bot. Tailscale is used for SSH administration; Funnel is not required.

## VM snapshots

`sudo scripts/backup-stack.sh` creates a full, consistent snapshot of this project's `bot-data` (including live WAL) and `evidence-data` volumes in `/var/backups/slipingman`, mode 600. It briefly pauses **only bot and storage** while copying, and always resumes them on exit/error. The tunnel may briefly wait during that window. Seven full snapshots are retained; daily application DB backups retain fourteen. Schedule full snapshots outside active hours and monitor disk usage. Copy archives securely off the VM for protection against VM/disk loss; no off-host destination is configured automatically.

Restore with the app stopped, into **new** Docker volumes first; extract the `bot/` and `evidence/` trees preserving ownership. Inspect SQLite integrity and expected row counts, and verify signed S3 reads using the matching VM credentials before switching volumes. Do not overlay a restored DB/WAL onto a running volume. The archive contains private application data and S3 metadata; protect it accordingly. LINE/Google `.env` and Cloudflare host credentials are not included in this archive.
