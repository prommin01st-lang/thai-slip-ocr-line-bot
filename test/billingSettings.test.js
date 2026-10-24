import assert from "node:assert/strict";
import { open } from "../src/db.js";
import * as L from "../src/ledger.js";
import * as D from "../src/documents.js";
import { handleEvent } from "../src/handlers.js";
import { issuerCard } from "../src/financeCommands.js";

L.setDb(open(":memory:"));
const u = "issuer-settings-owner",
  other = "issuer-settings-other";
for (const id of [u, other]) {
  L.ensureUser(id);
  L.grantConsent(id);
}
let sent = [];
globalThis.fetch = async (url, options) => {
  if (String(url).includes("/message/"))
    sent.push(JSON.parse(options.body).messages);
  return Response.json({});
};
const fire = async (message, user = u) => {
  sent = [];
  await handleEvent({
    source: { type: "user", userId: user },
    replyToken: "test-reply",
    ...message,
  });
  assert.ok(sent.length);
  return JSON.stringify(sent);
};
const text = (t) => ({ type: "message", message: { type: "text", text: t } });
const button = (data) => ({ type: "postback", postback: { data } });
const settings = await fire(text("ตั้งค่า"));
assert.ok(settings.includes("act=issuer"));
assert.ok(settings.includes("act=billing"));
assert.ok(settings.includes("ยังไม่ได้ตั้งค่า"));
const empty = await fire(button("act=issuer"));
assert.ok(empty.includes("กรอกข้อมูลผู้ออก"));
assert.ok(empty.includes("act=issueredit"));
const editor = await fire(button("act=issueredit"));
assert.ok(editor.includes("ชื่อ-นามสกุล"));
assert.ok(empty.includes("openKeyboard"));
await fire(text("ผู้ออก ชื่ออย่างเดียว"));
assert.equal(D.getIssuer(u), null);
const saved = await fire(
  text("ผู้ออก ร้านเจ้าของ | 123 กรุงเทพฯ | 0812345678"),
);
assert.ok(saved.includes("บันทึกข้อมูลผู้ออกแล้ว"));
assert.ok(saved.includes("ร้านเจ้าของ"));
assert.ok((await fire(text("ตั้งค่า"))).includes("ร้านเจ้าของ"));
const menu = await fire(button("act=billing"));
assert.ok(menu.includes("act=billprompt"));
assert.ok(menu.includes("act=receiptprompt"));
const prompt = await fire(button("act=billprompt"));
assert.ok(prompt.includes("สร้างร่างบิล"));
assert.equal(
  D.listDocuments(u).length,
  0,
  "opening the editor must not create a document",
);
await fire(text("บิล ลูกค้าทดสอบ\nบริการ | 1 | 100"));
const doc = D.listDocuments(u)[0];
assert.equal(D.getDocument(u, doc.id).snapshot.issuer.name, "ร้านเจ้าของ");
D.issueDocument(u, doc.id);
await fire(text("ผู้ออก ชื่อใหม่ | ที่อยู่ใหม่ | 02"));
assert.equal(D.getDocument(u, doc.id).snapshot.issuer.name, "ร้านเจ้าของ");
const isolated = await fire(button("act=issuer"), other);
assert.ok(!isolated.includes("ชื่อใหม่"));
assert.equal(
  L.countTxns(u),
  0,
  "settings and document menus must not add financial transactions",
);
D.setIssuer(other, `ร้านทดสอบ | ${"ก".repeat(500)} | 02`);
const actions = issuerCard(other)
  .contents.footer.contents.map((x) => x.action)
  .filter(Boolean);
assert.ok(
  actions.filter((a) => a.fillInText).every((a) => a.fillInText.length <= 300),
);
L.db().close();
console.log(
  "billingSettings.test: visible settings → issuer editor → save → draft, profile isolation and immutable issued snapshots passed",
);
