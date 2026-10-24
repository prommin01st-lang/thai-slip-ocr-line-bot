// Import previews survive restart; consuming one is replay-safe within a webhook event.
import * as L from "./ledger.js";
import { replayWrite } from "./replay.js";
const DEFAULT_TTL_MS = 10 * 60000;
export function put(userId, data, ttlMs = DEFAULT_TTL_MS) {
  L.db()
    .prepare("DELETE FROM pending_inputs WHERE expires_at<=?")
    .run(Date.now());
  L.db()
    .prepare(
      `INSERT INTO pending_inputs VALUES(?,?,?) ON CONFLICT(line_user_id)
    DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at`,
    )
    .run(userId, JSON.stringify(data), Date.now() + ttlMs);
  return data;
}
export function peek(userId) {
  const row = L.db()
    .prepare(
      "SELECT data FROM pending_inputs WHERE line_user_id=? AND expires_at>?",
    )
    .get(userId, Date.now());
  return row ? JSON.parse(row.data) : null;
}
export function take(userId) {
  return replayWrite(L.db(), () => {
    const result = peek(userId);
    drop(userId);
    return result;
  });
}
export const drop = (userId) =>
  L.db().prepare("DELETE FROM pending_inputs WHERE line_user_id=?").run(userId)
    .changes > 0;
export const _reset = () => L.db().exec("DELETE FROM pending_inputs");
