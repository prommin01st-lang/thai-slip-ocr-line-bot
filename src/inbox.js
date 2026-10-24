import { createHash } from "node:crypto";
import { atomic } from "./db.js";
import { withEvent } from "./replay.js";

export function eventKey(event) {
  if (event.webhookEventId) return event.webhookEventId;
  if (event.message?.id)
    return `message:${event.source?.userId}:${event.message.id}`;
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...event,
        replyToken: undefined,
        deliveryContext: undefined,
      }),
    )
    .digest("hex");
}

export class Inbox {
  constructor(
    db,
    handle,
    { now = Date.now, retryMs = 5000, handleBatch = null } = {},
  ) {
    this.db = db;
    this.handle = handle;
    this.now = now;
    this.retryMs = retryMs;
    this.handleBatch = handleBatch;
  }
  accept(events) {
    if (!Array.isArray(events) || events.length > 100)
      throw new Error("invalid events");
    return atomic(this.db, () => {
      for (const event of events) {
        // Financial replies belong exclusively in a private conversation.
        if (event.source?.type && event.source.type !== "user") continue;
        if (
          this.db
            .prepare("SELECT 1 FROM event_inbox WHERE event_key=?")
            .get(eventKey(event))
        )
          continue;
        if (
          this.db
            .prepare(
              "SELECT count(*) n FROM event_inbox WHERE status IN ('queued','running')",
            )
            .get().n >= 1000
        )
          throw new Error("inbox capacity reached");
        this.db
          .prepare(
            `INSERT OR IGNORE INTO event_inbox
          (event_key,line_user_id,payload,created_at,available_at) VALUES(?,?,?,?,?)`,
          )
          .run(
            eventKey(event),
            event.source?.userId ?? null,
            JSON.stringify(event),
            this.now(),
            this.now() +
              (this.handleBatch && event.message?.type === "image" ? 1500 : 0),
          );
      }
    });
  }
  recover() {
    this.db
      .prepare("UPDATE event_inbox SET status='queued' WHERE status='running'")
      .run();
  }
  prune() {
    const before = this.now() - 7 * 24 * 3600000;
    atomic(this.db, () => {
      this.db.prepare(`DELETE FROM prefs WHERE key='issuer_setup' AND
        CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.expiresAt'),0) ELSE 0 END <= ?`).run(this.now());
      for (const table of [
        "pending_inputs",
        "attachment_intents",
        "private_links",
      ])
        this.db
          .prepare(`DELETE FROM ${table} WHERE expires_at<=?`)
          .run(this.now());
      this.db
        .prepare(
          `DELETE FROM event_results WHERE event_key IN
        (SELECT event_key FROM event_inbox WHERE created_at<? AND status IN ('done','failed','expired'))`,
        )
        .run(before);
      this.db
        .prepare(
          `UPDATE event_inbox SET payload=NULL,line_user_id=NULL,last_error=NULL,
        status=CASE WHEN status='failed' THEN 'expired' ELSE status END
        WHERE created_at<? AND status IN ('done','failed','expired')`,
        )
        .run(before);
    });
  }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.stopping) {
        const row = this.db
          .prepare(
            `SELECT i.*,i.rowid AS sequence FROM event_inbox i WHERE i.status='queued'
          AND i.available_at<=? AND NOT EXISTS (SELECT 1 FROM event_inbox earlier
            WHERE earlier.line_user_id=i.line_user_id AND earlier.rowid<i.rowid
              AND earlier.status IN ('queued','running'))
          ORDER BY i.rowid LIMIT 1`,
          )
          .get(this.now());
        if (!row) break;
        const rows = [row];
        if (
          this.handleBatch &&
          JSON.parse(row.payload).message?.type === "image"
        ) {
          for (const next of this.db
            .prepare(
              `SELECT * FROM event_inbox WHERE status='queued'
            AND line_user_id=? AND rowid>? ORDER BY rowid LIMIT 9`,
            )
            .all(row.line_user_id, row.sequence)) {
            if (
              next.attempts ||
              JSON.parse(next.payload).message?.type !== "image"
            )
              break;
            rows.push(next);
          }
        }
        for (const item of rows)
          this.db
            .prepare(
              "UPDATE event_inbox SET status='running',attempts=attempts+1 WHERE event_key=?",
            )
            .run(item.event_key);
        try {
          if (rows.length > 1)
            await this.handleBatch(rows.map((r) => JSON.parse(r.payload)));
          else {
            const event = JSON.parse(row.payload);
            await withEvent(row.event_key, () =>
              this.handle(event, { durable: true }),
            );
          }
          for (const item of rows)
            this.db
              .prepare(
                "UPDATE event_inbox SET status='done',payload=NULL,last_error=NULL WHERE event_key=?",
              )
              .run(item.event_key);
        } catch {
          // No exception bodies here: provider errors may include credentials/PII.
          for (const item of rows)
            this.db
              .prepare(
                `UPDATE event_inbox SET status=?,available_at=?,last_error='processing failed'
            WHERE event_key=? AND status!='done'`,
              )
              .run(
                item.attempts >= 4 ? "failed" : "queued",
                this.now() + this.retryMs * 2 ** item.attempts,
                item.event_key,
              );
        }
      }
    } finally {
      this.busy = false;
    }
  }
  start() {
    this.recover();
    this.prune();
    let ticks = 0;
    this.timer = setInterval(() => {
      if (++ticks % 3600 === 0) this.prune();
      this.drain().catch(() => console.error("[inbox] processing unavailable"));
    }, 1000);
    this.timer.unref();
    return this.drain();
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
  }
}
