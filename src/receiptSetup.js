import { randomUUID } from "node:crypto";
import * as L from "./ledger.js";
import * as D from "./documents.js";
import { atomic } from "./db.js";
import { replayWrite } from "./replay.js";
import { UserError } from "./errors.js";

const KEY = "receipt_setup";
const write = (fn) => replayWrite(L.db(), () => atomic(L.db(), fn));
export function getIntent(user) {
  try {
    const value = JSON.parse(L.getPref(user, KEY) || "null");
    return value && value.expiresAt > Date.now() ? value : null;
  } catch {
    return null;
  }
}
export function begin(user, txnId) {
  return write(() => {
    if (!L.hasConsent(user)) throw new UserError("กรุณาให้ความยินยอมก่อน");
    D.receiptTransaction(user, txnId);
    const intent = {
      id: randomUUID(),
      txnId,
      expiresAt: Date.now() + 10 * 60000,
    };
    L.setPref(user, KEY, JSON.stringify(intent));
    return intent;
  });
}
export function cancel(user, id) {
  return write(() => {
    const active = getIntent(user);
    if (id && active?.id !== id) return false;
    L.db()
      .prepare("DELETE FROM prefs WHERE line_user_id=? AND key=?")
      .run(user, KEY);
    return true;
  });
}
export function complete(user, expected, name) {
  return write(() => {
    const active = getIntent(user);
    if (!active || active.id !== expected?.id)
      throw new UserError("คำขอหมดอายุ กดออกใบเสร็จจากรายการอีกครั้งครับ");
    const doc = D.receiptForTransaction(user, active.txnId, name);
    L.db()
      .prepare("DELETE FROM prefs WHERE line_user_id=? AND key=?")
      .run(user, KEY);
    return doc;
  });
}
