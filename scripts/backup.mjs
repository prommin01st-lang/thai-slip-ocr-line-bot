#!/usr/bin/env node
// backup.mjs — สำรอง SQLite ให้ได้ภาพที่ครบและสอดคล้องกันจริง
//
// ⚠️ **ห้ามสำรองด้วยการคัดลอกไฟล์ `.db` เฉย ๆ** — DB เปิดโหมด WAL อยู่ (db.js)
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
import { existsSync } from "node:fs";

const src = process.env.DB_PATH || "data/slipingman.db";
const dest = process.argv[2];

if (!dest) {
  console.error("ใช้: node scripts/backup.mjs <ไฟล์ปลายทาง.db>");
  process.exit(2);
}
if (!existsSync(src)) {
  console.error(`ไม่พบฐานข้อมูล: ${src}`);
  process.exit(1);
}
// VACUUM INTO ไม่ยอมเขียนทับ — กันเผลอทับไฟล์สำรองเก่า
if (existsSync(dest)) {
  console.error(`มีไฟล์นี้อยู่แล้ว: ${dest} (ลบก่อน หรือใช้ชื่ออื่น)`);
  process.exit(1);
}

// เป็น SQL string literal ไม่ใช่ชื่อคอลัมน์ → ต้องอัญประกาศเดี่ยว และ escape ด้วยการซ้ำตัว
const lit = `'${dest.replace(/'/g, "''")}'`;
const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO ${lit}`);

const b = new DatabaseSync(dest, { readOnly: true });
const n = b.prepare("SELECT COUNT(*) n FROM txns").get().n;
const v = b.prepare("PRAGMA user_version").get().user_version;
console.log(`สำรองแล้ว → ${dest}  (${n} ธุรกรรม · schema v${v})`);
