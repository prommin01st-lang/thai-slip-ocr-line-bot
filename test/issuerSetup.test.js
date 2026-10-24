import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../src/db.js";
import * as L from "../src/ledger.js";
import * as D from "../src/documents.js";
import * as S from "../src/issuerSetup.js";
import * as RL from "../src/ratelimit.js";
import { handleEvent } from "../src/handlers.js";
import { withEvent } from "../src/replay.js";
import { Inbox } from "../src/inbox.js";

const dir = mkdtempSync(join(tmpdir(), "issuer-setup-")),
  path = join(dir, "test.db");
let db = open(path);
L.setDb(db);
const u = "thai-name-owner",
  other = "thai-name-other";
for (const id of [u, other]) {
  L.ensureUser(id);
  L.grantConsent(id);
}
let replies = [],
  fail = false;
globalThis.fetch = async (url, opts) => {
  if (fail) throw new Error("temporary LINE delivery failure");
  if (String(url).includes("/message/"))
    replies.push(JSON.parse(opts.body).messages);
  return Response.json({});
};
const text = (t) => ({ type: "message", message: { type: "text", text: t } });
const action = (act, d = S.getDraft(u)) => ({
  type: "postback",
  postback: { data: `act=${act}&f=${d.id}&s=${d.stage}` },
});
const fire = async (part, key, user = u) => {
  RL._reset();
  replies = [];
  const event = {
    source: { type: "user", userId: user },
    replyToken: "mock",
    ...part,
  };
  await withEvent(key, () => handleEvent(event, { durable: true }));
  return JSON.stringify(replies);
};
try {
  assert.equal(
    D.validateIssuerField("name", "  สมชาย   ใจดี  "),
    "สมชาย   ใจดี",
  );
  assert.throws(() => D.setIssuer(u, "สมชาย ใจดี"), /ที่อยู่/);
  await fire(
    { type: "postback", postback: { data: "act=issueredit" } },
    "begin",
  );
  assert.equal(S.getDraft(u).stage, "name");
  fail = true;
  await assert.rejects(() => fire(text("สมชาย ใจดี"), "name"));
  fail = false;
  await fire(text("สมชาย ใจดี"), "name");
  assert.equal(S.getDraft(u).stage, "address");
  assert.equal(S.getDraft(u).fields.name, "สมชาย ใจดี");
  assert.equal(
    D.getIssuer(u),
    null,
    "name alone must not overwrite an issuer profile",
  );
  db.close();
  db = open(path);
  L.setDb(db);
  assert.equal(
    S.getDraft(u).fields.name,
    "สมชาย ใจดี",
    "draft must survive restart",
  );
  const invalidAddress = await fire(text("ก".repeat(501)), "bad-address");
  assert.ok(invalidAddress.includes("ที่อยู่ผู้ออกยาวเกิน 500"));
  assert.equal(S.getDraft(u).stage, "address");
  await fire(text("123 ถนนสุขุมวิท\r\nแขวงคลองเตย กรุงเทพฯ 10110"), "address");
  assert.equal(S.getDraft(u).stage, "phone");
  const phoneError = await fire(text("1".repeat(41)), "bad-phone");
  assert.ok(phoneError.includes("เบอร์โทรศัพท์ยาวเกิน 40"));
  await fire(action("issuerphoneomit"), "omit");
  assert.equal(S.getDraft(u).stage, "confirm");
  assert.equal(D.getIssuer(u), null);
  const save = action("issuersave");
  await fire(save, "save");
  await fire(save, "save");
  assert.deepEqual(D.getIssuer(u), {
    name: "สมชาย ใจดี",
    address: "123 ถนนสุขุมวิท\nแขวงคลองเตย กรุงเทพฯ 10110",
    phone: "",
  });
  assert.equal(S.getDraft(u), null);
  const invoice = D.issueDocument(
    u,
    D.createDraft(u, D.parseDocument("บิล ลูกค้าทดสอบ\nบริการ | 1 | 100")).id,
  );

  await fire(
    { type: "postback", postback: { data: "act=issueredit" } },
    "edit-again",
  );
  await fire(text("ชื่อใหม่ นามสกุลใหม่"), "new-name");
  const own = S.getDraft(u);
  await fire(action("issuersave", own), "foreign-save", other);
  assert.equal(D.getIssuer(other), null);
  assert.equal(S.getDraft(u).id, own.id);
  await fire(action("issuerback"), "back");
  assert.equal(S.getDraft(u).stage, "name");
  await fire(action("issuercancel"), "cancel");
  assert.equal(D.getIssuer(u).name, "สมชาย ใจดี");
  await fire(text("ผู้ออก ชื่อไทย นามสกุลไทย"), "legacy-name-only");
  assert.equal(
    S.getDraft(u).stage,
    "address",
    "old prefilled buttons must accept a name-only message",
  );
  await fire(text("456 ที่อยู่ใหม่"), "new-address");
  await fire(text("081 234 5678"), "new-phone");
  const oldSave = action("issuersave");
  await fire(
    { type: "postback", postback: { data: "act=issueredit" } },
    "replace-flow",
  );
  await fire(oldSave, "stale-save");
  assert.equal(D.getIssuer(u).name, "สมชาย ใจดี");
  await fire(text("ตั้งค่า"), "leave");
  assert.equal(S.getDraft(u), null);
  await fire(
    text("ผู้ออก ชื่อใหม่ นามสกุลใหม่ | ที่อยู่ใหม่ | 02 123 4567"),
    "legacy-full",
  );
  assert.equal(D.getIssuer(u).name, "ชื่อใหม่ นามสกุลใหม่");
  assert.equal(D.getDocument(u, invoice.id).snapshot.issuer.name, "สมชาย ใจดี");
  assert.equal(L.countTxns(u), 0, "setup messages must never become expenses");
  S.begin(u);
  const expired = S.getDraft(u);
  expired.expiresAt = 0;
  L.setPref(u, "issuer_setup", JSON.stringify(expired));
  new Inbox(db, () => {}).prune();
  assert.equal(L.getPref(u, "issuer_setup"), null);
  S.begin(u);
  L.deleteAllData(u);
  assert.equal(S.getDraft(u), null);
  console.log(
    "issuerSetup.test: Thai full names, field errors, confirmation/cancel/back, restart/replay, old buttons, ownership and expiry passed",
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
