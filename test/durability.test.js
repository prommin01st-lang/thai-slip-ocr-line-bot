import assert from "node:assert/strict";
import { open, nowLocal } from "../src/db.js";
import * as L from "../src/ledger.js";
import { config } from "../src/config.js";
import { withEvent } from "../src/replay.js";
import { handleEvent, handleDurableImageBatch } from "../src/handlers.js";
import { setStorage } from "../src/storage.js";
import * as E from "../src/evidence.js";
import * as pending from "../src/pending.js";
import * as RL from "../src/ratelimit.js";
import { Inbox } from "../src/inbox.js";

const db = open(":memory:");
L.setDb(db);
const u = "Uc0000000000000000000000000000000";
L.ensureUser(u);
L.grantConsent(u);
config.evidenceEnabled = true;
const objects = new Map();
setStorage({
  put: async (k, b) => objects.set(k, b),
  get: async () => {},
  delete: async (k) => objects.delete(k),
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
let failDelivery = true;
const sent = [];
globalThis.fetch = async (url, options) => {
  const path = String(url);
  if (path.includes("/content")) {
    const id = Number(/(\d+)\/content/.exec(path)[1]);
    return new Response(Buffer.concat([png, Buffer.from([id])]), {
      status: 200,
    });
  }
  if (path.endsWith("/parse")) {
    const n = Buffer.from(JSON.parse(options.body).image_b64, "base64").at(-1);
    return new Response(
      JSON.stringify({
        amount: `${n}.00`,
        confidence: "high",
        currency: "THB",
        date: nowLocal().slice(0, 10),
        time: "12:00",
        ref: `REF-${n}`,
        banks: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (path.includes("/message/push")) {
    if (failDelivery) throw new Error("delivery unavailable");
    sent.push(JSON.parse(options.body));
  }
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const images = [101, 102].map((id) => ({
  webhookEventId: `batch-${id}`,
  type: "message",
  source: { type: "user", userId: u },
  message: { type: "image", id: String(id) },
}));
await assert.rejects(() => handleDurableImageBatch(images));
assert.equal(L.countTxns(u), 2);
failDelivery = false;
for (let i = 0; i < 20; i++) RL.take(u, "image");
await handleDurableImageBatch(images);
assert.equal(L.countTxns(u), 2);
assert.ok(JSON.stringify(sent).includes("บันทึก 2 จาก 2 ใบ"));
console.log(
  "  ✓ image batch retries after delivery failure retain one transaction per source event",
);
RL._reset();
const t = L.recentTxns(u)[0];
E.beginAttachment(u, t.id);
await handleDurableImageBatch(
  [103, 104].map((id) => ({
    webhookEventId: `proof-${id}`,
    type: "message",
    source: { type: "user", userId: u },
    message: { type: "image", id: String(id) },
  })),
);
assert.equal(E.listEvidence(u, t.id).length, 2);
assert.equal(L.countTxns(u), 2);
console.log(
  "  ✓ multiple files selected after attach intent all remain evidence, never new expenses",
);

pending.put(u, {
  filename: "import.csv",
  entries: [
    {
      direction: "out",
      amountCents: 300,
      note: "a",
      occurredAt: `${nowLocal().slice(0, 10)} 13:00`,
    },
    {
      direction: "out",
      amountCents: 400,
      note: "b",
      occurredAt: `${nowLocal().slice(0, 10)} 13:01`,
    },
  ],
});
const confirmation = {
  webhookEventId: "confirm",
  type: "postback",
  source: { type: "user", userId: u },
  postback: { data: "act=import" },
};
failDelivery = true;
await assert.rejects(() =>
  withEvent("confirm", () => handleEvent(confirmation, { durable: true })),
);
assert.equal(L.countTxns(u), 4);
failDelivery = false;
await withEvent("confirm", () => handleEvent(confirmation, { durable: true }));
assert.equal(L.countTxns(u), 4);
console.log(
  "  ✓ import confirmation replays after its preview was consumed without partial/duplicate import",
);

let now = Date.now(),
  batches = 0,
  solo = 0;
const inbox = new Inbox(
  db,
  () => {
    solo++;
  },
  {
    now: () => now,
    handleBatch: async (events) => {
      batches++;
      assert.equal(events.length, 2);
    },
  },
);
inbox.accept(
  images.map((e) => ({ ...e, webhookEventId: `queue-${e.webhookEventId}` })),
);
inbox.accept([
  {
    webhookEventId: "after-batch",
    type: "message",
    source: { type: "user", userId: u },
    message: { type: "text", text: "summary" },
  },
]);
await inbox.drain();
assert.equal(solo, 0);
now += 1500;
await inbox.drain();
assert.equal(batches, 1);
assert.equal(solo, 1);
console.log(
  "  ✓ durable batching preserves source order, including later text events",
);
const failed = new Inbox(
  db,
  () => {
    throw new Error("offline");
  },
  { retryMs: 0 },
);
failed.accept([
  {
    webhookEventId: "failed",
    source: { type: "user", userId: u },
    type: "message",
    message: { type: "text", text: "private" },
  },
]);
await failed.drain();
assert.equal(
  db.prepare("SELECT attempts FROM event_inbox WHERE event_key='failed'").get()
    .attempts,
  5,
);
assert.equal(
  db.prepare("SELECT status FROM event_inbox WHERE event_key='failed'").get()
    .status,
  "failed",
);
db.prepare(
  "UPDATE event_inbox SET created_at=0 WHERE event_key='failed'",
).run();
failed.prune();
assert.equal(
  db.prepare("SELECT payload FROM event_inbox WHERE event_key='failed'").get()
    .payload,
  null,
);
console.log(
  "  ✓ exhausted retries stay observable; expired failed payloads are scrubbed",
);
db.close();
console.log("durability.test: 5/5 passed");
