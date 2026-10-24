import { randomUUID } from "node:crypto";
import * as L from "./ledger.js";
import * as D from "./documents.js";
import { atomic } from "./db.js";
import { replayWrite } from "./replay.js";
import { UserError } from "./errors.js";

const KEY = "issuer_setup";
const steps = ["name", "address", "phone", "confirm"];
const write = (fn) => replayWrite(L.db(), () => atomic(L.db(), fn));
const persist = (user, draft) => {
  draft = { ...draft, expiresAt: Date.now() + 10 * 60000 };
  L.setPref(user, KEY, JSON.stringify(draft));
  return draft;
};
export function getDraft(user) {
  try {
    const draft = JSON.parse(L.getPref(user, KEY) || "null");
    return draft && draft.expiresAt > Date.now() && steps.includes(draft.stage)
      ? draft
      : null;
  } catch {
    return null;
  }
}
export function begin(user) {
  return write(() => {
    if (!L.hasConsent(user)) throw new UserError("กรุณาให้ความยินยอมก่อน");
    return persist(user, {
      id: randomUUID(),
      stage: "name",
      fields: D.getIssuer(user) || {},
    });
  });
}
function current(user, expected) {
  const draft = getDraft(user);
  if (
    !draft ||
    draft.id !== expected?.id ||
    (expected.stage && draft.stage !== expected.stage)
  )
    throw new UserError(
      "คำขอกรอกข้อมูลหมดอายุหรือถูกแทนที่ กดกรอกข้อมูลผู้ออกใหม่ครับ",
    );
  return draft;
}
export function advance(user, expected, value) {
  return write(() => {
    const draft = current(user, expected);
    if (draft.stage === "confirm")
      throw new UserError("ตรวจข้อมูลแล้วกดบันทึก หรือย้อนกลับเพื่อแก้ไขครับ");
    const field = draft.stage;
    const fields = {
      ...draft.fields,
      [field]: D.validateIssuerField(field, value),
    };
    return persist(user, {
      ...draft,
      fields,
      stage: steps[steps.indexOf(field) + 1],
    });
  });
}
export function back(user, expected) {
  return write(() => {
    const draft = current(user, expected);
    return persist(user, {
      ...draft,
      stage: steps[Math.max(steps.indexOf(draft.stage) - 1, 0)],
    });
  });
}
export function cancel(user, id) {
  return write(() => {
    const draft = getDraft(user);
    if (id && draft?.id !== id) return false;
    L.db()
      .prepare("DELETE FROM prefs WHERE line_user_id=? AND key=?")
      .run(user, KEY);
    return true;
  });
}
export function save(user, id) {
  return write(() => {
    const draft = current(user, { id, stage: "confirm" });
    const profile = D.saveIssuer(user, draft.fields);
    L.db()
      .prepare("DELETE FROM prefs WHERE line_user_id=? AND key=?")
      .run(user, KEY);
    return profile;
  });
}
