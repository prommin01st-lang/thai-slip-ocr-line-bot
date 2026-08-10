// ledger.js — ตรรกะสมุดบัญชี: ยินยอม → กันซ้ำ → ตัดสินทิศทาง → บันทึก → สรุป
//
// แยกจาก db.js (schema/connection) เพื่อให้เทสได้โดยใช้ DB ในหน่วยความจำ
import { createHash, randomBytes } from "node:crypto";
import { open, toCents, fromCents, nowIso, nowLocal } from "./db.js";
import { guessCategory } from "./categories.js";

/**
 * วันที่ที่ใช้จัดกลุ่มรายการในสรุป (นิพจน์ SQL)
 *
 * `occurred_at` เป็น NULL ได้ — สลิปที่ OCR อ่านวันที่ไม่ออกจะไม่มีวันที่เลย
 * เดิมสรุปกรอง `occurred_at IS NOT NULL` ทิ้ง ทำให้เงินก้อนนั้น**หายจากทุกสรุป
 * รวมทั้ง "สรุปทั้งหมด"** ทั้งที่บอทตอบว่าบันทึกสำเร็จ (ผู้ใช้เจอจริงแล้ว)
 *
 * จึงถอยไปใช้วันที่ที่บันทึก — บันทึกวันไหนก็ลงวันนั้น ดีกว่าหายไปเฉย ๆ
 * `created_at` เก็บเป็น UTC จึงต้อง +7 ชม. ให้เป็นวันตามเวลาไทย
 * (`recentTxns` ใช้หลักเดียวกันอยู่แล้ว — ตรงนั้นถึงยังเห็นรายการที่สรุปมองไม่เห็น)
 */
const DATE_OF = "COALESCE(date(occurred_at), date(created_at, '+7 hours'))";

let _db = null;
export function db() {
  if (!_db) _db = open();
  return _db;
}
export function setDb(d) { _db = d; }   // ใช้ในเทส

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---------- ผู้ใช้ / ความยินยอม (PDPA) ----------

export function getUser(userId) {
  return db().prepare("SELECT * FROM users WHERE line_user_id = ?").get(userId) ?? null;
}

// ---------- สิทธิ์ใช้งาน (แอดมินอนุมัติจากในแชท) ----------

/** null = ไม่เคยขอ · 'pending' | 'approved' | 'rejected' */
export function accessStatus(userId) {
  return db().prepare("SELECT status FROM access WHERE line_user_id = ?").get(userId)?.status ?? null;
}

/**
 * บันทึกคำขอ — คืน true เฉพาะตอนที่เป็น "คำขอใหม่จริง ๆ"
 *
 * ต้องแยกให้ออก เพราะฝั่งเรียกใช้เอาผลนี้ไปตัดสินใจว่าจะ push หาแอดมินไหม
 * ถ้ากดขอซ้ำแล้ว push ทุกครั้ง คนเดียวก็เผาโควตา 300/เดือนหมดได้
 * ถูกปฏิเสธไปแล้วก็ขอใหม่ไม่ได้ ต้องให้แอดมินปลดให้เอง
 */
export function requestAccess(userId) {
  const cur = accessStatus(userId);
  if (cur) return false;
  db().prepare(`INSERT INTO access (line_user_id, status, requested_at) VALUES (?, 'pending', ?)`)
    .run(userId, nowIso());
  return true;
}

/** แอดมินตัดสิน — คืน false ถ้าไม่มีคำขอนั้นอยู่ (กัน postback ปลอม) */
export function decideAccess(userId, status, adminId) {
  if (!["approved", "rejected"].includes(status)) return false;
  return db().prepare(`
    UPDATE access SET status = ?, decided_at = ?, decided_by = ?
    WHERE line_user_id = ?`).run(status, nowIso(), adminId, userId).changes > 0;
}

/** เพิ่มสิทธิ์ให้ตรง ๆ โดยไม่ต้องรอให้เขากดขอ (แอดมินรู้ ID อยู่แล้ว) */
export function grantAccess(userId, adminId) {
  db().prepare(`
    INSERT INTO access (line_user_id, status, requested_at, decided_at, decided_by)
    VALUES (?, 'approved', ?, ?, ?)
    ON CONFLICT (line_user_id) DO UPDATE SET status='approved', decided_at=?, decided_by=?`)
    .run(userId, nowIso(), nowIso(), adminId, nowIso(), adminId);
  return true;
}

export function accessList(status) {
  return db().prepare(`
    SELECT a.*, u.display_name FROM access a
    LEFT JOIN users u ON u.line_user_id = a.line_user_id
    WHERE a.status = ? ORDER BY COALESCE(a.decided_at, a.requested_at) DESC`).all(status);
}

export function ensureUser(userId, displayName = null) {
  db().prepare(`INSERT INTO users (line_user_id, display_name, created_at) VALUES (?, ?, ?)
                ON CONFLICT (line_user_id) DO UPDATE SET display_name = COALESCE(?, display_name)`)
    .run(userId, displayName, nowIso(), displayName);
  return getUser(userId);
}

/** ยังไม่กด "ยินยอม" = ห้ามบันทึกอะไรทั้งสิ้น (แค่ตอบผลให้ดูได้) */
export function hasConsent(userId) {
  return !!getUser(userId)?.consent_at;
}

export function grantConsent(userId, displayName = null) {
  ensureUser(userId, displayName);
  db().prepare("UPDATE users SET consent_at = ? WHERE line_user_id = ?").run(nowIso(), userId);
}

/**
 * ลบข้อมูลผู้ใช้ **ทั้งหมดจริง ๆ** ไม่ใช่ซ่อน — สิทธิ์ตาม PDPA
 * (`PRAGMA foreign_keys = ON` ใน db.js ทำให้ CASCADE ทำงาน; push_log ไม่มี FK ต้องลบเอง)
 */
export function deleteAllData(userId) {
  const d = db();
  const before = countUserRows(userId);
  // ⚠️ ตารางที่ **ไม่มี FOREIGN KEY** ไปที่ users จะไม่ถูก CASCADE — ต้องลบเอง
  //    (`push_log`, `alert_log` ตั้งใจไม่ผูก FK เพราะเป็น log ที่ต้องเขียนได้เร็ว)
  //    ลืมตัวใดตัวหนึ่ง = "ลบข้อมูลของฉัน" ลบไม่หมดจริง ผิด PDPA
  for (const t of ["push_log", "alert_log", "slips"]) {
    d.prepare(`DELETE FROM ${t} WHERE line_user_id = ?`).run(userId);
  }
  d.prepare("DELETE FROM users WHERE line_user_id = ?").run(userId);   // CASCADE ที่เหลือ
  return before;
}

/** นับทุกตารางที่ผูกกับผู้ใช้ — ใช้ทั้งแสดงผลและเป็นตัวตรวจว่า deleteAllData ลบหมดจริง */
export function countUserRows(userId) {
  const d = db();
  const one = (t) => d.prepare(`SELECT COUNT(*) n FROM ${t} WHERE line_user_id = ?`)
    .get(userId)?.n ?? 0;
  return {
    txns: one("txns"),
    slips: one("slips"),
    accounts: one("user_accounts"),
    hints: one("category_hints"),
    budgets: one("budgets"),
    prefs: one("prefs"),
    alerts: one("alert_log"),
    pushes: one("push_log"),
  };
}

// ---------- ทิศทาง: รับ หรือ จ่าย ----------

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/** เลข 4 ตัวท้ายจาก "xxx-x-x8888-x" → "8888" (มาสก์แล้วก็ยังพอใช้เทียบได้) */
export function acctTail(s) {
  const digits = String(s ?? "").replace(/[^0-9]/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function matchesUser(userId, party) {
  if (!party) return false;
  const rows = db().prepare("SELECT name_hint, acct_tail FROM user_accounts WHERE line_user_id = ?")
    .all(userId);
  const p = norm(party);
  const tail = acctTail(party);
  return rows.some((r) =>
    (r.name_hint && p.includes(norm(r.name_hint))) ||
    (r.acct_tail && tail && r.acct_tail === tail));
}

/**
 * สลิปบอกแค่ "จาก A ไป B" — เป็นรายรับหรือรายจ่ายขึ้นกับว่าผู้ใช้คือใครในสลิป
 * ต้องเทียบกับบัญชีที่ผู้ใช้ลงทะเบียนไว้ ถ้ายังไม่มีข้อมูลก็ตอบ 'unknown' แล้วไปถามเอา
 */
export function guessDirection(userId, parsed) {
  const isFrom = matchesUser(userId, parsed.from);
  const isTo = matchesUser(userId, parsed.to);
  if (isFrom && !isTo) return "out";
  if (isTo && !isFrom) return "in";
  return "unknown";      // ไม่ตรงเลย หรือตรงทั้งคู่ (โอนหาตัวเอง)
}

/** บัญชีที่จำไว้ — ให้ผู้ใช้เห็นว่าระบบใช้อะไรตัดสินว่าใบไหนรับ/จ่าย */
export function getAccounts(userId) {
  return db().prepare(
    "SELECT bank, name_hint, acct_tail FROM user_accounts WHERE line_user_id = ? ORDER BY id")
    .all(userId);
}

/**
 * ลืมบัญชีที่จำไว้ทั้งหมด → สลิปใบถัดไปจะกลับมาถาม "รับหรือจ่าย" ใหม่
 *
 * จำเป็นเพราะถ้าเรียนผิดตั้งแต่ใบแรก (เช่นตอบผิด หรือ OCR อ่านชื่อมาไม่ครบ)
 * สลิปทุกใบหลังจากนั้นจะถูกเดาผิดหมดโดยไม่ถามอีกเลย และไม่มีทางแก้นอกจาก
 * ลบข้อมูลทิ้งทั้งบัญชี ซึ่งแรงเกินไปสำหรับความผิดพลาดแค่จุดเดียว
 */
export function forgetAccounts(userId) {
  return db().prepare("DELETE FROM user_accounts WHERE line_user_id = ?").run(userId).changes;
}

/** ลืมบัญชีเดียวที่เรียนมาจากชื่อคู่ค้าตัวนี้ — ใช้ตอนผู้ใช้แก้คำตอบว่าเดาผิด */
export function forgetAccount(userId, party) {
  if (!party) return 0;
  const name = String(party).replace(/[0-9xX*\-\s]{6,}/g, "").trim() || null;
  const tail = acctTail(party);
  if (!name && !tail) return 0;
  return db().prepare(`DELETE FROM user_accounts WHERE line_user_id = ?
                       AND (( ? IS NOT NULL AND name_hint = ?) OR (? IS NOT NULL AND acct_tail = ?))`)
    .run(userId, name, name, tail, tail).changes;
}

/** จำบัญชีของผู้ใช้จากคำตอบ ("ใบนี้คุณเป็นผู้โอน") → ครั้งหน้าเดาเองได้ */
export function learnAccount(userId, party, bank = null) {
  if (!party) return false;
  const tail = acctTail(party);
  const name = String(party).replace(/[0-9xX*\-\s]{6,}/g, "").trim() || null;
  if (!name && !tail) return false;
  db().prepare(`INSERT INTO user_accounts (line_user_id, bank, name_hint, acct_tail, created_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(userId, bank, name, tail, nowIso());
  return true;
}

// ---------- กันซ้ำ 3 ชั้น ----------

export function occurredAt(parsed) {
  if (!parsed.date) return null;
  return parsed.time ? `${parsed.date} ${parsed.time}` : parsed.date;
}

/**
 * คืน {layer, txn} ถ้าเคยบันทึกแล้ว, ไม่งั้น null
 *
 * 3 ชั้นเรียงตามความมั่นใจ:
 *   1. `image_sha256` — ไฟล์เดียวกันเป๊ะ **เช็คก่อน OCR ได้ → ประหยัดไปเลย ~6 วิ**
 *   2. `ref`          — คนละไฟล์แต่เป็นสลิปใบเดียวกัน
 *   3. fuzzy          — ยอด+ธนาคารตรงกัน และเวลาห่างกัน < 2 นาที
 *
 * ชั้น 3 จำเป็นเพราะวัดจริงแล้ว `ref` อ่านถูก ~96% — พึ่ง ref อย่างเดียวยอดจะเบิ้ล
 */
export function findDuplicate(userId, { imageSha256 = null, ref = null, parsed = null } = {}) {
  const d = db();
  // ⚠️ ต้อง INNER JOIN + กรอง rejected ทั้ง 3 ชั้น
  //
  // deleteTxn() เป็น soft delete (status='rejected') แถวใน slips ก็ยังอยู่
  // ถ้าไม่กรอง รายการที่ผู้ใช้ "ลบ" ไปแล้วจะยังบล็อกการส่งสลิปใบเดิมซ้ำอยู่ตลอดไป
  // → ลบผิดแล้วอัปใหม่ไม่ได้เลย เงินก้อนนั้นบันทึกไม่ได้อีกเลยจนกว่าจะแก้ DB เอง
  // (ผู้ใช้เจอจริง แล้วบอทยังตอบว่า "บันทึกไว้เรียบร้อยแล้ว" ซึ่งไม่จริง)
  //
  // INNER JOIN สำคัญ: slip ที่ txn ถูกลบถาวรไปแล้ว (กำพร้า) ต้องไม่บล็อกเหมือนกัน
  const join = `SELECT s.*, t.id AS txn_id_, t.amount_cents, t.occurred_at, t.direction
                FROM slips s JOIN txns t ON t.id = s.txn_id AND t.status != 'rejected'`;

  if (imageSha256) {
    const hit = d.prepare(`${join} WHERE s.line_user_id = ? AND s.image_sha256 = ?`)
      .get(userId, imageSha256);
    if (hit) return { layer: "image", slip: hit, txn: hit, txnId: hit.txn_id_ };
  }
  if (ref) {
    const hit = d.prepare(`${join} WHERE s.line_user_id = ? AND s.ref = ?`).get(userId, ref);
    if (hit) return { layer: "ref", slip: hit, txn: hit, txnId: hit.txn_id_ };
  }
  if (parsed) {
    const cents = toCents(parsed.amount);
    const at = occurredAt(parsed);
    if (cents !== null && at) {
      // หน้าต่าง ±2 นาที — เทียบเป็นสตริงไม่ได้ ต้องให้ SQLite คิดเวลาให้
      const hit = d.prepare(`
        SELECT t.* FROM txns t
        WHERE t.line_user_id = ? AND t.amount_cents = ? AND t.occurred_at IS NOT NULL
          AND t.status != 'rejected'
          AND ABS(strftime('%s', t.occurred_at) - strftime('%s', ?)) <= 120
        LIMIT 1`).get(userId, cents, at);
      if (hit) return { layer: "fuzzy", txn: hit, txnId: hit.id };
    }
  }
  return null;
}

// ---------- บันทึก ----------

/**
 * ผลจาก parser → บันทึกลง DB
 *
 * confidence ตัดสินว่าจะบันทึกยังไง (ตาม DESIGN-ledger.md):
 *   high   → confirmed  บันทึกเลย
 *   medium → pending    บันทึกแต่รอผู้ใช้ยืนยัน
 *   low    → ไม่บันทึก  ข้อมูลผิดที่เก็บเงียบ ๆ แย่กว่าไม่เก็บ
 */
export function recordSlip(userId, parsed, { imageSha256 = null, direction = null } = {}) {
  if (!hasConsent(userId)) return { ok: false, reason: "no_consent" };

  const cents = toCents(parsed.amount);
  if (cents === null) return { ok: false, reason: "no_amount" };
  if (parsed.confidence === "low") return { ok: false, reason: "low_confidence" };

  const dup = findDuplicate(userId, { imageSha256, ref: parsed.ref, parsed });
  if (dup) return { ok: false, reason: "duplicate", duplicate: dup };

  const d = db();
  const dir = direction ?? guessDirection(userId, parsed);
  const status = parsed.confidence === "high" ? "confirmed" : "pending";
  const counterparty = dir === "in" ? parsed.from : parsed.to;

  const info = d.prepare(`
    INSERT INTO txns (line_user_id, direction, amount_cents, currency, occurred_at,
                      counterparty, category, source, confidence, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'slip', ?, ?, ?)`)
    .run(userId, dir, cents, parsed.currency || "THB", occurredAt(parsed),
         counterparty ?? null, categoryFor(userId, counterparty), parsed.confidence ?? null,
         status, nowIso());
  const txnId = info.lastInsertRowid;

  d.prepare(`INSERT INTO slips (txn_id, line_user_id, ref, bank, image_sha256,
                                fields_json, warnings_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(txnId, userId, parsed.ref ?? null, (parsed.banks ?? [])[0] ?? null, imageSha256,
         JSON.stringify(parsed), JSON.stringify(parsed.warnings ?? []), nowIso());

  return { ok: true, txnId: Number(txnId), direction: dir, status, amountCents: cents };
}

/**
 * บันทึกรายการจากข้อความแชท (ผลของ nlu.parseEntry)
 *
 * ไม่มีการกันซ้ำแบบสลิป — ข้อความ "กาแฟ 60" สองครั้งอาจเป็นกาแฟสองแก้วจริง ๆ
 * (ต่างจากสลิปที่ใบเดียวกันส่งซ้ำได้แน่นอน)
 */
export function recordEntry(userId, entry, { occurredAt: at = null } = {}) {
  if (!hasConsent(userId)) return { ok: false, reason: "no_consent" };
  if (!entry || entry.amountCents == null) return { ok: false, reason: "no_amount" };

  const d = db();
  const when = at ?? nowLocal();          // เวลาไทย ไม่ใช่ UTC — ดู nowLocal() ใน db.js
  const info = d.prepare(`
    INSERT INTO txns (line_user_id, direction, amount_cents, currency, occurred_at,
                      counterparty, category, note, source, confidence, status, created_at)
    VALUES (?, ?, ?, 'THB', ?, NULL, ?, ?, 'chat', ?, ?, ?)`)
    .run(userId, entry.direction, entry.amountCents, when,
         categoryFor(userId, entry.note), entry.note ?? null,
         entry.guessed ? "medium" : "high",
         entry.guessed ? "pending" : "confirmed", nowIso());
  return {
    ok: true, txnId: Number(info.lastInsertRowid),
    direction: entry.direction, amountCents: entry.amountCents,
    status: entry.guessed ? "pending" : "confirmed",
  };
}

// ---------- หมวดหมู่ (เรียนจากผู้ใช้เอง ไม่ต้องมีโมเดล) ----------

const patternOf = (counterparty) => norm(counterparty).slice(0, 40) || null;

export function categoryFor(userId, counterparty) {
  const p = patternOf(counterparty);
  if (!p) return null;
  const learned = db().prepare(
    "SELECT category FROM category_hints WHERE line_user_id = ? AND pattern = ?")
    .get(userId, p)?.category;
  // ที่ผู้ใช้เคยกดเลือกเองมาก่อนพจนานุกรมเสมอ — เขารู้ดีกว่าเรา
  return learned ?? guessCategory(counterparty);
}

/**
 * ตั้งหมวดให้รายการ **แล้วจำไว้ใช้ครั้งหน้า**
 *
 * การจำคือหัวใจ — ถ้าแค่ตั้งค่าให้รายการเดียว ผู้ใช้ต้องกดใหม่ทุกครั้งที่ซื้อร้านเดิม
 * ผูกกับ `counterparty` (สลิป) ถ้าไม่มีก็ใช้ `note` (ข้อความที่พิมพ์ในแชท)
 */
export function setCategory(userId, txnId, category) {
  const t = getTxn(userId, txnId);
  if (!t) return false;
  db().prepare("UPDATE txns SET category = ? WHERE id = ? AND line_user_id = ?")
    .run(category, txnId, userId);
  learnCategory(userId, t.counterparty ?? t.note, category);
  return true;
}

/**
 * ผู้ใช้ตรวจแล้วบอกว่าถูก → เลิกเป็น pending
 *
 * เดิมมีทางเดียวที่จะพ้น pending คือ "แก้ยอด" (updateTxn เคลียร์ให้) — แต่ถ้าเลขที่
 * ระบบอ่านมาถูกอยู่แล้ว ผู้ใช้ไม่มีอะไรจะแก้ การ์ดสรุปจึงขึ้นว่ารอตรวจค้างอยู่ตลอด
 * โดยไม่มีทางปิด
 */
export function confirmTxn(userId, txnId) {
  return db().prepare(`
    UPDATE txns SET status = 'confirmed'
    WHERE id = ? AND line_user_id = ? AND status = 'pending'`).run(txnId, userId).changes > 0;
}

export function learnCategory(userId, counterparty, category) {
  const p = patternOf(counterparty);
  if (!p) return false;
  db().prepare(`INSERT INTO category_hints (line_user_id, pattern, category, hits) VALUES (?, ?, ?, 1)
                ON CONFLICT (line_user_id, pattern)
                DO UPDATE SET category = excluded.category, hits = hits + 1`)
    .run(userId, p, category);
  return true;
}

// ---------- สรุป ----------

/** ยอดรับ/จ่าย/คงเหลือ + หมวดที่ใช้มากสุด ในช่วง [from, to] (สตริง 'YYYY-MM-DD') */
export function summary(userId, from, to) {
  const d = db();
  const rows = d.prepare(`
    SELECT direction, SUM(amount_cents) AS cents, COUNT(*) AS n
    FROM txns
    WHERE line_user_id = ? AND status != 'rejected'
      AND ${DATE_OF} BETWEEN ? AND ?
    GROUP BY direction`).all(userId, from, to);

  const get = (dir) => rows.find((r) => r.direction === dir) ?? { cents: 0, n: 0 };
  const income = get("in"), expense = get("out"), unknown = get("unknown");

  const topCats = d.prepare(`
    SELECT COALESCE(category, 'ไม่ระบุ') AS category, SUM(amount_cents) AS cents, COUNT(*) AS n
    FROM txns
    WHERE line_user_id = ? AND direction = 'out' AND status != 'rejected'
      AND ${DATE_OF} BETWEEN ? AND ?
    GROUP BY 1 ORDER BY cents DESC LIMIT 3`).all(userId, from, to);

  // รายการที่อยู่ "นอกช่วง" — สลิปมักลงวันที่ตามที่พิมพ์บนใบ ซึ่งอาจเป็นเดือนก่อน
  // ถ้าไม่บอก ผู้ใช้จะเห็นเหมือนยอดหายไป (เจอมาแล้วตอนใช้จริง)
  const outside = d.prepare(`
    SELECT COUNT(*) n, MIN(${DATE_OF}) oldest, MAX(${DATE_OF}) newest
    FROM txns
    WHERE line_user_id = ? AND status != 'rejected'
      AND ${DATE_OF} NOT BETWEEN ? AND ?`).get(userId, from, to);

  return {
    from, to,
    income_cents: income.cents ?? 0, income_n: income.n,
    expense_cents: expense.cents ?? 0, expense_n: expense.n,
    // ยอดของรายการที่ยังไม่รู้ว่ารับหรือจ่าย — เดิมนับแต่จำนวน ไม่คิดยอด
    // ทำให้สลิปที่ผู้ใช้กด "ข้ามไปก่อน" ขึ้นเป็น รับ 0.00 / จ่าย 0.00 เหมือนเงินหาย
    unknown_n: unknown.n, unknown_cents: unknown.cents ?? 0,
    net_cents: (income.cents ?? 0) - (expense.cents ?? 0),
    top_categories: topCats.map((c) => ({ ...c, amount: fromCents(c.cents) })),
    // ต้องกรองช่วงวันเดียวกับยอดด้านบน — เดิมนับทั้งชีวิต ทำให้การ์ด "สรุปเดือนนี้"
    // ขึ้นว่ามีรายการรอตรวจ ทั้งที่รายการนั้นอยู่คนละเดือน กดเข้าไปก็ไม่เจอ
    pending_n: d.prepare(`
      SELECT COUNT(*) n FROM txns
      WHERE line_user_id = ? AND status = 'pending'
        AND ${DATE_OF} BETWEEN ? AND ?`).get(userId, from, to).n,
    outside_n: outside.n,
    outside_oldest: outside.oldest,
    outside_newest: outside.newest,
  };
}

/** ช่วงวันที่ที่มีข้อมูลทั้งหมดของผู้ใช้ — ใช้ทำ "สรุปทั้งหมด" */
export function fullRange(userId) {
  const r = db().prepare(`
    SELECT MIN(${DATE_OF}) a, MAX(${DATE_OF}) b FROM txns
    WHERE line_user_id = ? AND status != 'rejected'`).get(userId);
  return r?.a ? [r.a, r.b] : null;
}

// ---------- แก้/ลบรายการย้อนหลัง ----------

/**
 * เงื่อนไข WHERE ร่วมของ "รายการ" — ใช้ทั้งตอนดึงและตอนนับ
 * แยกออกมาเพื่อไม่ให้สองที่หลุดจากกัน (นับได้ 5 แต่แสดง 3 คือบั๊กที่หาสาเหตุยาก)
 */
function txnFilter(userId, { direction, category, status } = {}) {
  const where = ["t.line_user_id = ?", "t.status != 'rejected'"];
  const args = [userId];
  if (direction === "in" || direction === "out" || direction === "unknown") {
    where.push("t.direction = ?");
    args.push(direction);
  }
  // "-" = ยังไม่ได้จัดหมวด — ต้องกรองได้ ไม่งั้นหารายการที่ค้างรอจัดหมวดไม่เจอเลย
  if (category === "-") where.push("t.category IS NULL");
  else if (category) { where.push("t.category = ?"); args.push(category); }
  if (status === "pending") where.push("t.status = 'pending'");
  return { sql: where.join(" AND "), args };
}

/** รายการล่าสุด N รายการ (ใหม่ก่อน) — ใช้ให้ผู้ใช้เลือกแก้/ลบ/กรอง */
export function recentTxns(userId, limit = 10, filter = {}) {
  const f = txnFilter(userId, filter);
  return db().prepare(`
    SELECT t.id, t.direction, t.amount_cents, t.occurred_at, t.counterparty,
           t.category, t.note, t.source, t.status, s.ref
    FROM txns t LEFT JOIN slips s ON s.txn_id = t.id
    WHERE ${f.sql}
    ORDER BY COALESCE(t.occurred_at, t.created_at) DESC, t.id DESC
    LIMIT ?`).all(...f.args, limit);
}

/**
 * ยอดรวมรายหมวด สำหรับหน้าจอ "กรองตามหมวด"
 *
 * คืนเฉพาะหมวดที่ **มีรายการจริง** — เดิมหน้านั้นโชว์ปุ่มครบทุกหมวดตายตัว
 * ผู้ใช้เลยเจอหมวดที่ยังไม่เคยใช้ กดเข้าไปก็ว่างเปล่า
 *
 * เฉพาะรายจ่าย เพราะหมวดมีไว้คุมงบ (`category` ของรายรับไม่ถูกใช้ที่ไหน)
 * `category = '-'` คือยังไม่ได้จัดหมวด — ต้องอยู่ในลิสต์ด้วย ไม่งั้นไล่เก็บไม่ได้
 */
export function categoryTotals(userId) {
  return db().prepare(`
    SELECT COALESCE(category, '-') AS category, SUM(amount_cents) AS cents, COUNT(*) AS n
    FROM txns
    WHERE line_user_id = ? AND status != 'rejected' AND direction = 'out'
    GROUP BY 1 ORDER BY cents DESC`).all(userId);
}

/**
 * จำนวนรายการทั้งหมดที่ตรงตัวกรอง — การ์ดโชว์ได้แค่ 8 แถว
 * ถ้าไม่บอกจำนวนจริง ผู้ใช้จะเข้าใจว่ามีอยู่เท่าที่เห็นแล้วสรุปผิด
 */
export function countTxns(userId, filter = {}) {
  const f = txnFilter(userId, filter);
  return db().prepare(`SELECT COUNT(*) n FROM txns t WHERE ${f.sql}`).get(...f.args).n;
}

export function getTxn(userId, txnId) {
  return db().prepare("SELECT * FROM txns WHERE id = ? AND line_user_id = ?")
    .get(txnId, userId) ?? null;
}

/**
 * ลบรายการ — ใช้ soft delete (`status='rejected'`) ไม่ใช่ DELETE จริง
 *
 * เหตุผล: `slips.ref` มี UNIQUE index ถ้าลบ txn ทิ้งแต่ slip ยังอยู่ ผู้ใช้จะส่งสลิปใบเดิม
 * เข้ามาใหม่ไม่ได้ (ติด dedup) ส่วนถ้าลบ slip ด้วย ก็จะกลายเป็นบันทึกซ้ำได้
 * → เก็บไว้แต่ไม่นับในยอดรวม (ทุก query กรอง `status != 'rejected'` อยู่แล้ว)
 *
 * "ลบข้อมูลของฉัน" ยังลบจริงทั้งหมดตามเดิม — คนละเรื่องกัน
 */
/**
 * ลบรายการ — `txns` เป็น soft delete แต่ **`slips` ต้องลบจริง**
 *
 * เหตุผลที่ต้องลบแถว slips ด้วย ไม่ใช่แค่กรอง rejected ตอนค้นหา:
 * มี UNIQUE index บน (line_user_id, image_sha256) และ (line_user_id, ref)
 * ถ้าแถวเก่ายังอยู่ พอผู้ใช้ส่งสลิปใบเดิมเข้ามาใหม่ INSERT จะชน constraint
 * แล้วโยน error ออกมากลางทาง — ผู้ใช้เห็นแค่ "เกิดข้อผิดพลาด" โดยไม่รู้สาเหตุ
 *
 * ลบทิ้งได้ไม่เสียอะไร: แถวนี้มีไว้กันซ้ำกับเก็บ metadata ของสลิป ซึ่งไม่มีความหมาย
 * แล้วเมื่อรายการที่มันอ้างถึงถูกลบไป — และการทิ้ง hash ของรูปที่ผู้ใช้ลบแล้ว
 * ก็ตรงกับเจตนาของ PDPA มากกว่าเก็บไว้เฉย ๆ
 */
export function deleteTxn(userId, txnId) {
  const d = db();
  const info = d.prepare(
    "UPDATE txns SET status='rejected' WHERE id=? AND line_user_id=? AND status!='rejected'")
    .run(txnId, userId);
  if (info.changes > 0) {
    d.prepare("DELETE FROM slips WHERE txn_id = ? AND line_user_id = ?").run(txnId, userId);
  }
  return info.changes > 0;
}

/** แก้ไขรายการ — ส่งเฉพาะฟิลด์ที่จะแก้ */
export function updateTxn(userId, txnId, { amountCents, direction, category, note } = {}) {
  const sets = [], vals = [];
  if (amountCents != null) { sets.push("amount_cents = ?"); vals.push(amountCents); }
  if (direction) { sets.push("direction = ?"); vals.push(direction); }
  if (category !== undefined) { sets.push("category = ?"); vals.push(category); }
  if (note !== undefined) { sets.push("note = ?"); vals.push(note); }
  if (!sets.length) return false;
  // แก้แล้วถือว่าผู้ใช้ยืนยันเอง → เลิกเป็น pending
  sets.push("status = CASE WHEN status='pending' THEN 'confirmed' ELSE status END");
  vals.push(txnId, userId);
  return db().prepare(`UPDATE txns SET ${sets.join(", ")} WHERE id = ? AND line_user_id = ?`)
    .run(...vals).changes > 0;
}

/**
 * ย้ายรายการไปลงวันที่อื่น (ผู้ใช้เลือกว่าจะลงเดือนตามสลิป หรือเดือนปัจจุบัน)
 * `at` = 'YYYY-MM-DD HH:MM' หรือ null
 */
export function setOccurredAt(userId, txnId, at) {
  return db().prepare("UPDATE txns SET occurred_at = ? WHERE id = ? AND line_user_id = ?")
    .run(at, txnId, userId).changes > 0;
}

/** วันที่เดิมที่พิมพ์บนสลิป — เก็บไว้ใน fields_json ตอนบันทึก จึงย้อนกลับได้เสมอ */
export function slipOccurredAt(userId, txnId) {
  const s = db().prepare(`SELECT s.fields_json FROM slips s JOIN txns t ON t.id = s.txn_id
                          WHERE s.txn_id = ? AND t.line_user_id = ?`).get(txnId, userId);
  if (!s?.fields_json) return null;
  try {
    return occurredAt(JSON.parse(s.fields_json));
  } catch {
    return null;
  }
}

/** ผู้ใช้ตอบว่าตัวเองเป็นผู้โอน/ผู้รับ → ตั้งทิศทาง + จำบัญชีไว้ใช้ครั้งหน้า */
export function confirmDirection(userId, txnId, direction) {
  const t = getTxn(userId, txnId);
  if (!t) return false;
  const slip = db().prepare("SELECT fields_json, bank FROM slips WHERE txn_id = ?").get(txnId);
  // เรียนบัญชีเฉพาะตอนที่ระบบ "ถามเพราะไม่รู้" เท่านั้น
  //
  // ถ้าเป็นการ **แก้คำตอบเดิม** ห้ามเรียนฝั่งใหม่เด็ดขาด — ฝั่งใหม่คือคู่ค้า
  // ไม่ใช่บัญชีผู้ใช้ การเรียนมันเข้าไปจะทำให้ทั้งสองฝั่งของสลิปใบหน้าแมตช์
  // แล้วเดาแย่ลงเรื่อย ๆ (ยิ่งแก้ยิ่งพัง) — เทสจับได้ตอนเขียนเทสปุ่มสลับทิศทาง
  const wasAsked = t.direction === "unknown";
  let learned = false;
  if (slip?.fields_json) {
    try {
      const f = JSON.parse(slip.fields_json);
      // ผู้ใช้เป็นผู้โอน → ฝั่ง `from` คือบัญชีของผู้ใช้ (และกลับกัน)
      if (wasAsked) {
        learned = learnAccount(userId, direction === "out" ? f.from : f.to, slip.bank);
      } else {
        // แก้คำตอบ = ที่เคยเรียนจากสลิปใบนี้ผิด → ถอนออก ไม่งั้นค้างผิดไปตลอด
        forgetAccount(userId, t.direction === "out" ? f.from : f.to);
      }
      const other = direction === "out" ? f.to : f.from;
      if (other) db().prepare("UPDATE txns SET counterparty = ? WHERE id = ?").run(other, txnId);
    } catch { /* fields_json เสีย ก็แค่ไม่ได้เรียนรู้ */ }
  }
  updateTxn(userId, txnId, { direction });
  return { ok: true, learned, corrected: !wasAsked };
}

// ---------- งบประมาณ + แจ้งเตือน ----------

export function setBudget(userId, limitCents, category = "*") {
  db().prepare(`INSERT INTO budgets (line_user_id, category, limit_cents) VALUES (?, ?, ?)
                ON CONFLICT (line_user_id, category) DO UPDATE SET limit_cents = excluded.limit_cents`)
    .run(userId, category, limitCents);
}

export function getBudgets(userId) {
  return db().prepare("SELECT category, limit_cents FROM budgets WHERE line_user_id = ?").all(userId);
}

/** งบไหนใช้เกิน/ใกล้เกินบ้าง (คืนเฉพาะที่ถึงเกณฑ์ warnAt) */
export function budgetStatus(userId, from, to, warnAt = 0.8) {
  const d = db();
  const out = [];
  for (const b of getBudgets(userId)) {
    // ใช้ DATE_OF เหมือน summary() — ถ้ากรอง occurred_at IS NOT NULL ทิ้ง
    // สลิปที่อ่านวันที่ไม่ออกจะไม่ถูกนับเข้างบ ทั้งที่เป็นเงินที่จ่ายไปจริง
    // แล้วยอดในการ์ดงบจะไม่ตรงกับยอดในสรุป ซึ่งชวนสับสนหนักกว่าเดิม
    const q = b.category === "*"
      ? d.prepare(`SELECT COALESCE(SUM(amount_cents),0) c FROM txns WHERE line_user_id=?
                   AND direction='out' AND status!='rejected'
                   AND ${DATE_OF} BETWEEN ? AND ?`)
          .get(userId, from, to)
      : d.prepare(`SELECT COALESCE(SUM(amount_cents),0) c FROM txns WHERE line_user_id=?
                   AND direction='out' AND status!='rejected' AND category=?
                   AND ${DATE_OF} BETWEEN ? AND ?`)
          .get(userId, b.category, from, to);
    const ratio = b.limit_cents > 0 ? q.c / b.limit_cents : 0;
    if (ratio >= warnAt) {
      out.push({ category: b.category, used_cents: q.c, limit_cents: b.limit_cents,
                 ratio, over: q.c > b.limit_cents });
    }
  }
  return out;
}

/**
 * จับ "รายการประจำ" — คู่ค้าเดิม จ่ายซ้ำอย่างน้อย `minTimes` ครั้ง
 * และเดือนนี้ยังไม่มีรายการ → น่าจะยังไม่ได้จ่าย
 */
export function recurringDue(userId, thisMonthStart, minTimes = 3) {
  return db().prepare(`
    SELECT counterparty,
           COUNT(*)               AS times,
           AVG(amount_cents)      AS avg_cents,
           MAX(occurred_at)       AS last_at
    FROM txns
    WHERE line_user_id = ? AND direction = 'out' AND status != 'rejected'
      AND counterparty IS NOT NULL AND occurred_at IS NOT NULL
      AND date(occurred_at) < ?
    GROUP BY counterparty
    HAVING times >= ?
       AND NOT EXISTS (
         SELECT 1 FROM txns t2
         WHERE t2.line_user_id = txns.line_user_id
           AND t2.counterparty = txns.counterparty
           AND t2.status != 'rejected'
           AND date(t2.occurred_at) >= ?)
    ORDER BY times DESC LIMIT 5`).all(userId, thisMonthStart, minTimes, thisMonthStart);
}

/** กันเตือนซ้ำเรื่องเดิมในรอบเดิม — คืน true ถ้า "ยังไม่เคยเตือน" (และจดไว้แล้ว) */
export function claimAlert(userId, kind, period) {
  try {
    db().prepare("INSERT INTO alert_log (line_user_id, kind, period, sent_at) VALUES (?,?,?,?)")
      .run(userId, kind, period, nowIso());
    return true;
  } catch {
    return false;   // ชน PRIMARY KEY = เคยเตือนไปแล้ว
  }
}

// ---------- การตั้งค่าของผู้ใช้ ----------

export function setPref(userId, key, value) {
  db().prepare(`INSERT INTO prefs (line_user_id, key, value) VALUES (?, ?, ?)
                ON CONFLICT (line_user_id, key) DO UPDATE SET value = excluded.value`)
    .run(userId, key, value);
}

export function getPref(userId, key) {
  return db().prepare("SELECT value FROM prefs WHERE line_user_id = ? AND key = ?")
    .get(userId, key)?.value ?? null;
}

/** ผู้ใช้ที่เปิดฟีเจอร์นี้ไว้ **และให้ความยินยอมแล้ว** (ไม่งั้นห้ามส่งอะไรทั้งนั้น) */
export function usersWithPref(key, value = "on") {
  return db().prepare(`
    SELECT u.line_user_id FROM users u
    JOIN prefs p ON p.line_user_id = u.line_user_id AND p.key = ? AND p.value = ?
    WHERE u.consent_at IS NOT NULL`).all(key, value).map((r) => r.line_user_id);
}

// ---------- ส่งออก CSV ----------

const EXPORT_TTL_MIN = Number(process.env.EXPORT_TTL_MIN || 15);

/** สร้างลิงก์ดาวน์โหลดชั่วคราว — คืน token (สุ่ม เดาไม่ได้) */
export function createExportToken(userId) {
  const token = randomBytes(32).toString("base64url");
  const exp = new Date(Date.now() + EXPORT_TTL_MIN * 60_000).toISOString();
  const d = db();
  // เก็บบ้านไปด้วย: ลบ token ที่หมดอายุแล้วทิ้ง ไม่ให้สะสม
  d.prepare("DELETE FROM export_tokens WHERE expires_at < ?").run(new Date().toISOString());
  d.prepare(`INSERT INTO export_tokens (token, line_user_id, expires_at, created_at)
             VALUES (?, ?, ?, ?)`).run(token, userId, exp, nowIso());
  return { token, expiresAt: exp, ttlMin: EXPORT_TTL_MIN };
}

/**
 * ตรวจ token → คืน userId ถ้าใช้ได้ ไม่งั้น null
 *
 * ใช้ได้ครั้งเดียว: ประทับ `used_at` แล้วครั้งต่อไปปฏิเสธ
 * (ลิงก์ที่มีข้อมูลการเงินไม่ควรเปิดซ้ำได้เรื่อย ๆ เผื่อหลุดไปอยู่ในประวัติเบราว์เซอร์)
 */
export function consumeExportToken(token) {
  if (!token) return null;
  const d = db();
  const row = d.prepare("SELECT * FROM export_tokens WHERE token = ?").get(token);
  if (!row || row.used_at || row.expires_at < new Date().toISOString()) return null;
  d.prepare("UPDATE export_tokens SET used_at = ? WHERE token = ?").run(nowIso(), token);
  return row.line_user_id;
}

const CSV_COLS = [
  ["id", (t) => t.id],
  ["วันที่", (t) => t.occurred_at ?? ""],
  ["ประเภท", (t) => ({ in: "รายรับ", out: "รายจ่าย", unknown: "ยังไม่ระบุ" }[t.direction])],
  ["จำนวน", (t) => fromCents(t.amount_cents).replace(/,/g, "")],   // ไม่ใส่คอมมา — Sheets จะได้อ่านเป็นตัวเลข
  ["สกุลเงิน", (t) => t.currency],
  ["หมวดหมู่", (t) => t.category ?? ""],
  ["คู่ค้า", (t) => t.counterparty ?? ""],
  ["รายละเอียด", (t) => t.note ?? ""],
  ["ที่มา", (t) => ({ slip: "สลิป", chat: "พิมพ์เอง", manual: "กรอกเอง" }[t.source] ?? t.source)],
  ["สถานะ", (t) => ({ confirmed: "ยืนยันแล้ว", pending: "รอตรวจ" }[t.status] ?? t.status)],
  ["เลขอ้างอิง", (t) => t.ref ?? ""],
  ["ธนาคาร", (t) => t.bank ?? ""],
];

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * ธุรกรรมทั้งหมดของผู้ใช้ → สตริง CSV
 *
 * ขึ้นต้นด้วย BOM (﻿) — **จำเป็น** ไม่งั้น Excel เปิดแล้วภาษาไทยเป็นตัวยึกยือ
 * (Google Sheets อ่านได้อยู่แล้ว แต่ Excel เดา encoding เป็น cp874/1252)
 */
export function exportCsv(userId) {
  const rows = db().prepare(`
    SELECT t.*, s.ref, s.bank
    FROM txns t LEFT JOIN slips s ON s.txn_id = t.id
    WHERE t.line_user_id = ? AND t.status != 'rejected'
    ORDER BY COALESCE(t.occurred_at, t.created_at), t.id`).all(userId);

  const lines = [CSV_COLS.map(([h]) => csvCell(h)).join(",")];
  for (const t of rows) lines.push(CSV_COLS.map(([, f]) => csvCell(f(t))).join(","));
  return { csv: "﻿" + lines.join("\r\n") + "\r\n", count: rows.length };
}

// ---------- โควตา push (300/เดือน — ต้องนับเอง) ----------

export function pushUsedThisMonth() {
  return db().prepare(
    `SELECT COUNT(*) n FROM push_log WHERE sent_at >= date('now','start of month')`).get().n;
}

export function logPush(userId, kind) {
  db().prepare("INSERT INTO push_log (line_user_id, kind, sent_at) VALUES (?, ?, ?)")
    .run(userId, kind, nowIso());
}

export { toCents, fromCents };
