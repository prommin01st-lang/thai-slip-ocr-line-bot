import { AsyncLocalStorage } from "node:async_hooks";
import { atomic } from "./db.js";

const context = new AsyncLocalStorage();
export const withEvent = (eventKey, fn) =>
  context.run({ eventKey, slot: 0 }, fn);

// Never use text/amount as an idempotency key: identical purchases can be legitimate.
export function replayWrite(db, fn) {
  const ctx = context.getStore();
  if (!ctx) return fn();
  return eventValue(db, ctx.slot++, fn);
}

// Negative slots hold stable decisions (rate admission and attachment routing).
// Replaying an accepted event must not consume another rate-limit allowance.
export function eventValue(db, slot, fn) {
  const ctx = context.getStore();
  if (!ctx) return fn();
  return atomic(db, () => {
    const saved = db
      .prepare("SELECT result FROM event_results WHERE event_key=? AND slot=?")
      .get(ctx.eventKey, slot);
    if (saved) return JSON.parse(saved.result);
    const result = fn();
    db.prepare("INSERT INTO event_results VALUES(?,?,?)").run(
      ctx.eventKey,
      slot,
      JSON.stringify(result),
    );
    return result;
  });
}
