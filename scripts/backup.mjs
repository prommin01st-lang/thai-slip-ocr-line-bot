#!/usr/bin/env node
// backup.mjs — สำรอง SQLite ให้ได้ภาพที่ครบและสอดคล้องกันจริง
//
//     node scripts/backup.mjs                 → data/backups/slipingman-YYYY-MM-DD.db (หมุนไฟล์ให้)
//     node scripts/backup.mjs /path/out.db    → ระบุปลายทางเอง (ไม่หมุนไฟล์)
//     node scripts/backup.mjs --keep 30       → เก็บย้อนหลัง 30 ไฟล์
//
// ⚠️ **ห้ามสำรองด้วยการคัดลอกไฟล์ `.db` เฉย ๆ** — DB เปิดโหมด WAL (db.js)
// ข้อมูลที่เพิ่งเขียนจะค้างอยู่ในไฟล์ `.db-wal` ซึ่งยังไม่ถูกรวมเข้าไฟล์หลัก
// `cp` / `cat` ไฟล์เดียวจึงได้ภาพเก่า **โดยไม่มีอะไรฟ้องเลย** ไฟล์ที่ได้เปิดได้ปกติ
// ตารางครบ แค่ข้อมูลขาดไปเงียบ ๆ — วัดจริงแล้วต่างกันจนถึงระดับ schema version
//
// การคัดลอกทั้ง 3 ไฟล์ (.db + -wal + -shm) ก็ยังไม่ปลอดภัย เพราะถ้าบอทเขียนอยู่
// ระหว่างที่คัดลอก จะได้ภาพครึ่ง ๆ กลาง ๆ ของคนละจังหวะ
//
// `VACUUM INTO` ให้ SQLite เขียนไฟล์ใหม่จากภาพ ณ จุดเดียวกันทั้งหมด ใช้ได้ขณะบอท
// ยังรันอยู่ ไม่ต้องหยุดบริการ และได้ไฟล์เดียวจบ ไม่มี -wal ห้อยท้าย
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";

const args = process.argv.slice(2);
const keepAt = args.indexOf("--keep");
const KEEP = keepAt >= 0 ? Number(args[keepAt + 1]) : 14;
const explicitDest = args.find((a) => !a.startsWith("--") && a !== String(KEEP));

const src = process.env.DB_PATH || "data/slipingman.db";
const dir = process.env.BACKUP_DIR || "data/backups";
// วันที่ตามเวลาไทย ไม่ใช่ UTC — ไม่งั้นสำรองตอนตี 1 จะได้ชื่อไฟล์เป็นเมื่อวาน
const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
const dest = explicitDest || join(dir, `slipingman-${day}.db`);

if (!existsSync(src)) {
  console.error(`ไม่พบฐานข้อมูล: ${src}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });

// VACUUM INTO ไม่ยอมเขียนทับ — สำรองซ้ำวันเดียวกันจึงต้องลบของเดิมก่อน
// (ตั้งใจให้ทับได้ ไม่งั้น cron ที่รันบ่อยกว่าวันละครั้งจะพังทุกครั้งหลังครั้งแรก)
if (existsSync(dest)) {
  if (explicitDest) {
    console.error(`มีไฟล์นี้อยู่แล้ว: ${dest} (ลบก่อน หรือใช้ชื่ออื่น)`);
    process.exit(1);
  }
  unlinkSync(dest);
}

const lit = (s) => `'${s.replace(/'/g, "''")}'`;   // SQL string literal ต้องอัญประกาศเดี่ยว
new DatabaseSync(src, { readOnly: true }).exec(`VACUUM INTO ${lit(dest)}`);

// ตรวจว่าไฟล์ที่ได้ "อ่านได้จริง" ไม่ใช่แค่มีอยู่ — สำรองที่เปิดไม่ออกแย่กว่าไม่มีสำรอง
// เพราะทำให้เข้าใจผิดว่ามีของสำรองอยู่จนถึงวันที่ต้องใช้จริง
const b = new DatabaseSync(dest, { readOnly: true });
const n = b.prepare("SELECT COUNT(*) n FROM txns").get().n;
const v = b.prepare("PRAGMA user_version").get().user_version;
const kb = Math.round(statSync(dest).size / 1024);
console.log(`สำรองแล้ว → ${dest}  (${n} ธุรกรรม · schema v${v} · ${kb} KB)`);

// หมุนไฟล์ — เก็บ KEEP ไฟล์ล่าสุด (เฉพาะโหมดชื่ออัตโนมัติ)
if (!explicitDest && KEEP > 0) {
  const old = readdirSync(dir)
    .filter((f) => /^slipingman-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()                       // ชื่อเป็น YYYY-MM-DD → เรียงตามตัวอักษร = เรียงตามเวลา
    .slice(0, -KEEP);
  for (const f of old) {
    unlinkSync(join(dir, f));
    console.log(`  ลบของเก่า: ${basename(f)}`);
  }
  if (old.length) console.log(`  เหลือ ${KEEP} ไฟล์ล่าสุด`);
}
