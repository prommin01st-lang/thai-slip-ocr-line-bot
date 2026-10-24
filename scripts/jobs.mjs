#!/usr/bin/env node
import "dotenv/config";
import * as L from "../src/ledger.js";
const [command = "list", key] = process.argv.slice(2),
  db = L.db();
if (command === "list") {
  console.table(
    db
      .prepare(
        "SELECT status,count(*) AS count FROM event_inbox GROUP BY status",
      )
      .all(),
  );
  console.table(
    db
      .prepare(
        "SELECT event_key,attempts,last_error FROM event_inbox WHERE status='failed' ORDER BY created_at LIMIT 30",
      )
      .all(),
  );
  console.log(
    "Object cleanup jobs:",
    db.prepare("SELECT count(*) n FROM object_gc").get().n,
  );
} else if (command === "retry" && key) {
  const result = db
    .prepare(
      "UPDATE event_inbox SET status='queued',attempts=0,available_at=0,last_error=NULL WHERE event_key=? AND status='failed' AND payload IS NOT NULL",
    )
    .run(key);
  console.log(
    result.changes ? "Queued for retry" : "No recoverable failed job found",
  );
  if (!result.changes) process.exitCode = 1;
} else {
  console.error("Usage: node scripts/jobs.mjs list | retry EVENT_ID");
  process.exitCode = 1;
}
db.close();
