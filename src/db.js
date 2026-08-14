// db.js — SQLite (ใช้ `node:sqlite` ที่มากับ Node 22 → ไม่ต้องลง native module บน VPS)
//
// เลือก SQLite เพราะ: ไฟล์เดียว, ไม่ต้องดูแล service, เร็วพอสำหรับงานระดับนี้,
// และลงเครื่อง 2 cores / 3.8GB ได้โดยไม่กินอะไรเลย
//
// 🔒 ไฟล์ DB มีข้อมูลการเงินของคนจริง — gitignore ไว้แล้ว
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// migration เรียงตามลำดับ; `PRAGMA user_version` บอกว่ารันถึงตัวไหนแล้ว
// เพิ่มของใหม่ต่อท้ายเสมอ ห้ามแก้ของเก่า (DB ที่ deploy ไปแล้วจะไม่ตรง)
const MIGRATIONS = [
  `
  CREATE TABLE users (
    line_user_id TEXT PRIMARY KEY,
    display_name TEXT,
    tz           TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    consent_at   TEXT,                       -- NULL = ยังไม่ยินยอม → ห้ามเขียน txns
    created_at   TEXT NOT NULL
  );

  CREATE TABLE user_accounts (
    id           INTEGER PRIMARY KEY,
    line_user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    bank         TEXT,
    name_hint    TEXT,                       -- ชื่อบนสลิป (บางส่วนก็พอ)
    acct_tail    TEXT,                       -- เก็บแค่ 4 ตัวท้าย
    created_at   TEXT NOT NULL,
    UNIQUE (line_user_id, bank, acct_tail)
  );

  CREATE TABLE txns (
    id           INTEGER PRIMARY KEY,
    line_user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    direction    TEXT NOT NULL CHECK (direction IN ('in','out','unknown')),
    amount_cents INTEGER NOT NULL,           -- **สตางค์** เงินห้ามเก็บเป็น float
    currency     TEXT NOT NULL DEFAULT 'THB',
    occurred_at  TEXT,                       -- 'YYYY-MM-DD HH:MM' หรือ NULL ถ้าอ่านไม่ออก
    counterparty TEXT,
    category     TEXT,
    note         TEXT,
    source       TEXT NOT NULL CHECK (source IN ('slip','chat','manual')),
    confidence   TEXT,
    status       TEXT NOT NULL DEFAULT 'confirmed'
                 CHECK (status IN ('confirmed','pending','rejected')),
    created_at   TEXT NOT NULL
  );
  CREATE INDEX txns_user_time ON txns (line_user_id, occurred_at);
  CREATE INDEX txns_dedupe    ON txns (line_user_id, amount_cents, occurred_at);

  CREATE TABLE slips (
    id            INTEGER PRIMARY KEY,
    txn_id        INTEGER REFERENCES txns ON DELETE CASCADE,
    line_user_id  TEXT NOT NULL,
    ref           TEXT,
    bank          TEXT,
    image_sha256  TEXT,                      -- ไม่เก็บรูปจริง เก็บแค่ hash ไว้กันซ้ำ
    fields_json   TEXT,
    warnings_json TEXT,
    created_at    TEXT NOT NULL
  );
  -- กันซ้ำ 2 ชั้นแรกทำที่ระดับ DB เลย จะได้ไม่ต้องพึ่งโค้ดอย่างเดียว
  CREATE UNIQUE INDEX slips_ref_uniq  ON slips (line_user_id, ref)          WHERE ref IS NOT NULL;
  CREATE UNIQUE INDEX slips_hash_uniq ON slips (line_user_id, image_sha256) WHERE image_sha256 IS NOT NULL;

  CREATE TABLE category_hints (
    line_user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    pattern      TEXT NOT NULL,              -- ชื่อคู่ค้าที่ normalize แล้ว
    category     TEXT NOT NULL,
    hits         INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (line_user_id, pattern)
  );

  CREATE TABLE push_log (
    id           INTEGER PRIMARY KEY,
    line_user_id TEXT NOT NULL,
    kind         TEXT NOT NULL,
    sent_at      TEXT NOT NULL
  );
  CREATE INDEX push_log_time ON push_log (sent_at);
  `,
  // --- migration 2: งบประมาณ + การตั้งค่าแจ้งเตือน ---
  `
  CREATE TABLE budgets (
    line_user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    category     TEXT NOT NULL DEFAULT '*',   -- '*' = งบรวมทั้งเดือน
    limit_cents  INTEGER NOT NULL,
    PRIMARY KEY (line_user_id, category)
  );

  CREATE TABLE prefs (
    line_user_id  TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    key           TEXT NOT NULL,
    value         TEXT,
    PRIMARY KEY (line_user_id, key)
  );

  -- กันแจ้งเตือนซ้ำเรื่องเดิมในรอบเดียวกัน (เช่น งบเกินเดือนนี้ เตือนครั้งเดียวพอ)
  CREATE TABLE alert_log (
    line_user_id TEXT NOT NULL,
    kind         TEXT NOT NULL,   -- budget:<cat> / weekly / recurring:<pattern>
    period       TEXT NOT NULL,   -- '2026-08' หรือ '2026-W32'
    sent_at      TEXT NOT NULL,
    PRIMARY KEY (line_user_id, kind, period)
  );
  `,
  // --- migration 3: ลิงก์ดาวน์โหลด CSV ชั่วคราว ---
  // LINE ส่งไฟล์ให้ผู้ใช้ไม่ได้ (ไม่มี message type สำหรับไฟล์) → ต้องให้ลิงก์
  // ไฟล์มีข้อมูลการเงินจริง ลิงก์จึงต้อง **เดาไม่ได้ + หมดอายุ + ผูกกับผู้ใช้คนเดียว**
  `
  CREATE TABLE export_tokens (
    token        TEXT PRIMARY KEY,          -- สุ่ม 32 ไบต์ (ไม่ใช่ id ที่เดาได้)
    line_user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    expires_at   TEXT NOT NULL,
    used_at      TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX export_tokens_exp ON export_tokens (expires_at);
  `,
  // --- migration 4: ล้างแถว slips ที่กำพร้า ---
  //
  // `deleteTxn()` เดิมเป็น soft delete อย่างเดียว (txns.status='rejected') ไม่ได้แตะ slips
  // แถวที่ค้างไว้มี UNIQUE index อยู่บน (line_user_id, image_sha256) และ (line_user_id, ref)
  // ผลคือสลิปที่ผู้ใช้ลบไปแล้ว **ส่งเข้ามาใหม่ไม่ได้อีกเลย** — เจอจริงจากผู้ใช้
  //
  // แก้ที่ deleteTxn() แล้วช่วยได้แค่การลบครั้งต่อ ๆ ไป ของเก่าที่ค้างอยู่ใน DB
  // ยังบล็อกเหมือนเดิม และคราวนี้จะพังที่ constraint (ผู้ใช้เห็นแค่ "เกิดข้อผิดพลาด")
  // แทนที่จะตอบว่าซ้ำ — จึงต้องล้างย้อนหลังด้วย
  `
  DELETE FROM slips WHERE txn_id IS NULL
     OR txn_id NOT IN (SELECT id FROM txns WHERE status != 'rejected');
  `,
  // --- migration 5: คำขอสิทธิ์ใช้งาน (แอดมินอนุมัติในแชทได้) ---
  //
  // เดิม whitelist อยู่ใน .env อย่างเดียว เพิ่มคนทีต้องแก้ไฟล์ + `up -d` ใหม่ทุกครั้ง
  // ตารางนี้ทำให้อนุมัติจากในแชทได้ทันที ไม่ต้องแตะเซิร์ฟเวอร์
  //
  // **ไม่มี FK ไป users โดยตั้งใจ** — คนที่ยังไม่ได้รับอนุมัติต้องไม่มีแถวใน users
  // (whitelist กั้นก่อน ensureUser) ถ้าผูก FK ไว้จะเพิ่มคำขอไม่ได้เลย
  `
  CREATE TABLE access (
    line_user_id TEXT PRIMARY KEY,
    status       TEXT NOT NULL,      -- pending | approved | rejected
    requested_at TEXT,
    decided_at   TEXT,
    decided_by   TEXT
  );
  CREATE INDEX access_status ON access (status);
  `,
  // --- migration 6: เก็บชื่อผู้ขอไว้ในคำขอ ---
  //
  // แอดมินเห็นแค่ ID ตัดท้าย 8 ตัว ตัดสินใจไม่ได้ว่าเป็นใคร — คนแปลกหน้ากับเพื่อน
  // หน้าตาเหมือนกันหมด เก็บชื่อที่ดึงจาก LINE ตอนกดขอไว้เลย
  // (ไม่เก็บใน users เพราะคนที่ยังไม่ได้รับอนุมัติต้องไม่มีแถวใน users)
  `
  ALTER TABLE access ADD COLUMN display_name TEXT;
  `,
  // --- migration 7: กระจกสะท้อนลง Google Sheet ของผู้ใช้เอง ---
  //
  // **SQLite ยังเป็นแหล่งจริงเสมอ ชีตเป็นสำเนาทางเดียว** — ความถูกต้องของระบบนี้
  // อยู่ใน constraint ของ DB (UNIQUE กันสลิปซ้ำ, CASCADE ตอนลบตาม PDPA, สตางค์เป็น
  // จำนวนเต็ม) ซึ่ง Sheets ไม่มีสักอย่าง และผู้ใช้แก้เซลล์เองได้ตลอดเวลา
  //
  // **ทำไมต้องมี outbox ไม่เขียนตรง** — node:sqlite เป็น API แบบ synchronous ทั้งไฟล์
  // ใส่ await ลงไปใน ledger.js ต้องแก้ signature ทุกฟังก์ชันแล้วเทสทั้งชุดพัง
  // และ Sheets API ตอบ ~300-600 ms ซึ่งจะทำให้ webhook ที่ตอบใน 3 ms ช้าจน LINE retry
  // จดใบสั่งงานลงตาราง (sync, เร็ว) แล้วให้ worker ตามไปทำ = ได้ retry กับการรวม
  // เป็น batch มาฟรี และเน็ตล่มก็ไม่มีอะไรหาย
  //
  // ⚠️ `sheet_outbox` **ห้ามมี FK ไป users** — "ลบข้อมูลของฉัน" ลบแถวใน users
  // ถ้าผูก FK ไว้ CASCADE จะลบใบสั่ง 'wipe' ทิ้งไปพร้อมกัน แล้วข้อมูลจะค้างอยู่บนชีต
  // ตลอดไปทั้งที่ผู้ใช้สั่งลบแล้ว (ผิด PDPA ในแบบที่ไม่มีใครเห็น)
  `
  CREATE TABLE sheet_links (
    line_user_id   TEXT PRIMARY KEY REFERENCES users ON DELETE CASCADE,
    spreadsheet_id TEXT NOT NULL,
    tab            TEXT,                    -- NULL = ยังไม่รู้ชื่อแท็บ (เติมตอน sync ครั้งแรก)
    linked_at      TEXT NOT NULL,
    last_sync_at   TEXT,
    last_error     TEXT
  );

  CREATE TABLE sheet_outbox (
    id           INTEGER PRIMARY KEY,
    line_user_id TEXT NOT NULL,
    op           TEXT NOT NULL CHECK (op IN ('upsert','delete','wipe')),
    txn_id       INTEGER,                   -- NULL สำหรับ wipe
    -- ปกติไม่ต้องเก็บค่า (ตอน sync ค่อยอ่านค่าล่าสุดจาก txns เอา → แก้ 3 ครั้งติดกัน
    -- ก็ยิงครั้งเดียวได้ค่าล่าสุด) **ยกเว้น wipe** ซึ่งเกิดตอนที่แถวใน sheet_links
    -- เพิ่งถูก CASCADE ลบไปพร้อม users แล้ว — ต้องพก spreadsheet_id ติดใบสั่งมาเอง
    payload      TEXT,
    tries        INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX sheet_outbox_user ON sheet_outbox (line_user_id, id);
  `,
];

export function open(path = process.env.DB_PATH || "data/slipingman.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  // WAL = อ่านกับเขียนพร้อมกันได้ (bot ตอบ webhook ขณะ worker เขียนอยู่)
  db.exec("PRAGMA journal_mode = WAL");
  // ต้องเปิดเอง ทุกครั้งที่เปิด connection — ไม่งั้น ON DELETE CASCADE ไม่ทำงาน
  // แล้ว "ลบข้อมูลของฉัน" จะเหลือ txns/slips ค้าง = ลบไม่จริง (ผิด PDPA)
  db.exec("PRAGMA foreign_keys = ON");

  const { user_version: v } = db.prepare("PRAGMA user_version").get();
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
  return db;
}

/**
 * "1,234.56" → 123456 (สตางค์)
 *
 * **ห้ามผ่าน float** — `parseFloat("0.1")*100` ได้ 10.000000000000002
 * พอรวมยอดหลายพันรายการจะเพี้ยนแบบหาที่มาไม่เจอ parser คืนเป็นสตริงอยู่แล้ว
 * จึงแยกส่วนจำนวนเต็มกับทศนิยมด้วย regex ตรง ๆ
 */
export function toCents(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/,/g, "").trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** 123456 → "1,234.56" */
export function fromCents(c) {
  if (c === null || c === undefined) return null;
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  const baht = Math.floor(a / 100).toLocaleString("en-US");
  return `${sign}${baht}.${String(a % 100).padStart(2, "0")}`;
}

export const nowIso = () => new Date().toISOString();

/** เขตเวลาที่ใช้ตัดสินว่า "วันนี้" คือวันไหน — ต้องตรงกับ notify.js */
export const TZ = "Asia/Bangkok";

/**
 * เวลาปัจจุบันแบบเวลาไทย `'YYYY-MM-DD HH:MM'` — รูปแบบเดียวกับ `txns.occurred_at`
 *
 * ⚠️ **ห้ามใช้ `toISOString()` ทำหน้าที่นี้** มันคืน UTC ซึ่งช้ากว่าไทย 7 ชม.
 * รายการที่พิมพ์ตอน 00:00–07:00 จะถูกลงเป็น "เมื่อวาน" และถ้าเป็นวันที่ 1 ของเดือน
 * ก็หลุดไปอยู่เดือนก่อน → หายจาก "สรุปเดือนนี้" ทั้งที่เพิ่งบันทึกไป
 * (`thisMonth()` / `thisWeek()` ใน notify.js ยึดเวลาไทย ทั้งสองฝั่งต้องใช้โซนเดียวกัน)
 *
 * `sv-SE` เพราะให้รูปแบบ `YYYY-MM-DD HH:MM:SS` มาตรงเลย ไม่ต้องประกอบเอง
 */
export const nowLocal = (tz = TZ) =>
  new Date().toLocaleString("sv-SE", { timeZone: tz }).slice(0, 16);
