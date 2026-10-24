import assert from "node:assert/strict";
import { open } from "../src/db.js";
import * as L from "../src/ledger.js";
import * as D from "../src/documents.js";
import * as R from "../src/receiptSetup.js";
import * as RL from "../src/ratelimit.js";
import { handleEvent } from "../src/handlers.js";
import { withEvent } from "../src/replay.js";
import { receiptActions, txnListBubble } from "../src/flex.js";

L.setDb(open(":memory:"));
const u = "receipt-owner",
  other = "receipt-other";
for (const id of [u, other]) {
  L.ensureUser(id);
  L.grantConsent(id);
}
let sent = [],
  fail = false;
globalThis.fetch = async (url, options) => {
  if (fail) throw new Error("temporary delivery failure");
  if (options?.body) sent.push(JSON.parse(options.body).messages);
  return Response.json({});
};
const text = (t) => ({ type: "message", message: { type: "text", text: t } });
const pb = (data) => ({ type: "postback", postback: { data } });
const fire = async (event, key, user = u) => {
  RL._reset();
  sent = [];
  await withEvent(key, () =>
    handleEvent(
      { source: { type: "user", userId: user }, replyToken: "fake", ...event },
      { durable: true },
    ),
  );
  return JSON.stringify(sent);
};
const added = await fire(text("ได้เงินค่าบริการ 500"), "income");
const income = L.recentTxns(u)[0];
assert.equal(income.direction, "in");
assert.equal(income.status, "confirmed");
assert.ok(added.includes(`act=txnreceipt&id=${income.id}`));
const missing = await fire(pb(`act=txnreceipt&id=${income.id}`), "no-issuer");
assert.ok(missing.includes("ตั้งข้อมูลผู้ออก"));
assert.equal(R.getIntent(u), null);
D.setIssuer(u, "ร้านเจ้าของ | กรุงเทพมหานคร | 02");
await fire(pb(`act=txnreceipt&id=${income.id}`), "start");
assert.ok(R.getIntent(u));
assert.equal(D.listDocuments(u).length, 0);
await fire(
  { type: "message", message: { type: "image", id: "must-not-download" } },
  "image-during-name",
);
assert.equal(L.countTxns(u), 1);
fail = true;
await assert.rejects(() => fire(text("สมชาย ใจดี"), "customer"));
fail = false;
await fire(text("สมชาย ใจดี"), "customer");
let doc = D.receiptForEntry(u, income.id);
assert.equal(doc.txn_id, income.id);
assert.equal(doc.snapshot.totalCents, 50000);
assert.equal(doc.snapshot.customer.name, "สมชาย ใจดี");
assert.equal(doc.status, "draft");
assert.equal(L.countTxns(u), 1);
assert.equal(D.listDocuments(u).length, 1);
assert.equal(R.getIntent(u), null);
await fire(pb(`act=txnreceipt&id=${income.id}`), "repeat-click");
assert.equal(R.getIntent(u), null);
assert.equal(D.listDocuments(u).length, 1);
assert.equal(D.receiptForTransaction(u, income.id, "ชื่ออื่น").id, doc.id);
D.issueDocument(u, doc.id);
await fire(pb(`act=txnreceipt&id=${income.id}`), "issued-click");
assert.equal(D.listDocuments(u).length, 1);
await fire(pb(`act=txnreceipt&id=${income.id}`), "foreign-click", other);
assert.equal(D.listDocuments(other).length, 0);

const pending = L.recordSlip(
  u,
  { amount: "100.00", confidence: "medium", currency: "THB" },
  { imageSha256: "pending", direction: "in" },
);
await fire(pb(`act=txnreceipt&id=${pending.txnId}`), "pending-refuse");
assert.equal(R.getIntent(u), null);
assert.ok(
  (await fire(pb(`act=ok&id=${pending.txnId}`), "confirm-income")).includes(
    `act=txnreceipt&id=${pending.txnId}`,
  ),
);
const unknown = L.recordSlip(
  u,
  { amount: "200.00", confidence: "high", currency: "THB" },
  { imageSha256: "unknown" },
);
assert.ok(
  (
    await fire(pb(`act=dir&id=${unknown.txnId}&v=in`), "direction-income")
  ).includes(`act=txnreceipt&id=${unknown.txnId}`),
);
const out = L.recordEntry(u, {
  direction: "out",
  amountCents: 6000,
  note: "กาแฟ",
});
const usd = L.recordSlip(
  u,
  { amount: "12.00", confidence: "high", currency: "USD" },
  { imageSha256: "usd", direction: "in" },
);
for (const t of [L.getTxn(u, out.txnId), L.getTxn(u, usd.txnId)]) {
  assert.deepEqual(receiptActions(t), []);
  assert.ok(
    !JSON.stringify(txnListBubble([t], L.fromCents)).includes("act=txnreceipt"),
  );
  await fire(pb(`act=txnreceipt&id=${t.id}`), `reject-${t.id}`);
  assert.equal(R.getIntent(u), null);
}
await fire(pb(`act=txnreceipt&id=${pending.txnId}`), "next-start");
const intent = R.getIntent(u);
await fire(pb(`act=receiptcancel&f=${intent.id}`), "cancel");
assert.equal(R.getIntent(u), null);
assert.equal(D.receiptForEntry(u, pending.txnId), null);
await fire(pb(`act=txnreceipt&id=${pending.txnId}`), "next-start-again");
const before = L.countTxns(u);
await fire(text("บิล ใจดี"), "bill-as-full-name");
assert.equal(
  D.receiptForEntry(u, pending.txnId).snapshot.customer.name,
  "บิล ใจดี",
);
assert.equal(L.countTxns(u), before);
D.cancelDocument(u, doc.id);
await fire(pb(`act=txnreceipt&id=${income.id}`), "recreate-after-cancel");
await fire(text("ลูกค้า ใหม่"), "new-customer");
assert.notEqual(D.receiptForEntry(u, income.id).id, doc.id);
assert.equal(L.countTxns(u), before);
L.db().close();
console.log(
  "transactionReceipt.test: saved income → receipt action → customer → reused draft, eligibility/ownership, retry/cancel and unchanged ledger passed",
);
