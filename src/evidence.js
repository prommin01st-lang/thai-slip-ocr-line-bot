import { UserError } from "./errors.js";
import { randomBytes, createHash } from "node:crypto";
import * as L from "./ledger.js";
import { atomic } from "./db.js";
import { storage } from "./storage.js";

export function fileType(bytes) {
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  throw new UserError(
    "รองรับเฉพาะรูป JPEG/PNG/WebP และ PDF ที่ชนิดไฟล์ถูกต้อง",
  );
}
export function beginAttachment(userId, txnId) {
  if (
    !L.hasConsent(userId) ||
    !L.getTxn(userId, txnId) ||
    L.getTxn(userId, txnId).status === "rejected"
  )
    throw new UserError("ไม่พบรายการ");
  L.db()
    .prepare(
      `INSERT INTO attachment_intents VALUES(?,?,?) ON CONFLICT(line_user_id)
    DO UPDATE SET txn_id=excluded.txn_id,expires_at=excluded.expires_at`,
    )
    .run(userId, txnId, Date.now() + 10 * 60000);
}
export const cancelAttachment = (u) =>
  L.db().prepare("DELETE FROM attachment_intents WHERE line_user_id=?").run(u);
export const attachmentIntent = (u) =>
  L.db()
    .prepare(
      "SELECT * FROM attachment_intents WHERE line_user_id=? AND expires_at>?",
    )
    .get(u, Date.now());

export async function attach(userId, txnId, bytes) {
  const t = L.getTxn(userId, txnId);
  if (!L.hasConsent(userId) || !t || t.status === "rejected")
    throw new UserError("ไม่พบรายการ");
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new UserError("หลักฐานต้องไม่เกิน 10 MB");
  const mime = fileType(bytes),
    sha = L.sha256(bytes),
    db = L.db();
  const existing = db
    .prepare(
      "SELECT * FROM evidence WHERE txn_id=? AND line_user_id=? AND sha256=?",
    )
    .get(txnId, userId, sha);
  if (existing) return existing;
  if (listEvidence(userId, txnId).length >= 10)
    throw new UserError("แนบได้สูงสุด 10 ไฟล์ต่อรายการ");
  const key = `evidence/${randomBytes(24).toString("hex")}`;
  // A crash after upload leaves a durable cleanup ticket, not an untracked private file.
  db.prepare("INSERT INTO object_gc(object_key,available_at) VALUES(?,?)").run(
    key,
    Date.now() + 3600000,
  );
  await storage().put(key, bytes, mime);
  return atomic(db, () => {
    const current = L.getTxn(userId, txnId);
    if (!L.hasConsent(userId) || !current || current.status === "rejected")
      throw new UserError("รายการถูกลบแล้ว");
    const duplicate = db
      .prepare("SELECT * FROM evidence WHERE txn_id=? AND sha256=?")
      .get(txnId, sha);
    if (duplicate) return duplicate;
    const id = db
      .prepare(
        `INSERT INTO evidence(line_user_id,txn_id,object_key,mime,size_bytes,sha256,created_at)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        userId,
        txnId,
        key,
        mime,
        bytes.length,
        sha,
        new Date().toISOString(),
      ).lastInsertRowid;
    db.prepare("DELETE FROM object_gc WHERE object_key=?").run(key);
    return getEvidence(userId, Number(id));
  });
}
export const listEvidence = (u, t) =>
  L.db()
    .prepare(
      "SELECT * FROM evidence WHERE line_user_id=? AND txn_id=? ORDER BY id",
    )
    .all(u, t);
export const getEvidence = (u, id) =>
  L.db()
    .prepare("SELECT * FROM evidence WHERE line_user_id=? AND id=?")
    .get(u, id);
export function deleteEvidence(u, id) {
  return (
    L.db()
      .prepare("DELETE FROM evidence WHERE line_user_id=? AND id=?")
      .run(u, id).changes > 0
  );
}
export async function collectGarbage() {
  for (const row of L.db()
    .prepare("SELECT object_key FROM object_gc WHERE available_at<=? LIMIT 30")
    .all(Date.now())) {
    try {
      await storage().delete(row.object_key);
      L.db()
        .prepare("DELETE FROM object_gc WHERE object_key=?")
        .run(row.object_key);
    } catch {
      L.db()
        .prepare(
          "UPDATE object_gc SET attempts=attempts+1,available_at=? WHERE object_key=?",
        )
        .run(Date.now() + 60000, row.object_key);
    }
  }
}
const digest = (s) => createHash("sha256").update(s).digest("hex");
export function privateLink(userId, kind, id, ttl = 5 * 60000) {
  if (!["evidence", "document"].includes(kind))
    throw new UserError("ไม่พบข้อมูล");
  if (
    !(kind === "evidence"
      ? getEvidence(userId, id)
      : L.db()
          .prepare("SELECT id FROM documents WHERE id=? AND line_user_id=?")
          .get(id, userId))
  )
    throw new UserError("ไม่พบข้อมูล");
  const token = randomBytes(32).toString("hex");
  L.db()
    .prepare("DELETE FROM private_links WHERE expires_at<=?")
    .run(Date.now());
  L.db()
    .prepare("INSERT INTO private_links VALUES(?,?,?,?,?)")
    .run(digest(token), userId, kind, id, Date.now() + ttl);
  return `/private/${token}`;
}
export const resolveLink = (token) =>
  /^[a-f0-9]{64}$/.test(token)
    ? L.db()
        .prepare("SELECT * FROM private_links WHERE token=? AND expires_at>?")
        .get(digest(token), Date.now())
    : null;
