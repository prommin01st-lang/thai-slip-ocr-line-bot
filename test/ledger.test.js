// ledger.test.js — สัญญาของ data layer ที่พลาดไม่ได้
//
// 3 ข้อที่สำคัญที่สุด:
//   1. เงินต้องไม่เพี้ยน (integer สตางค์ ห้ามผ่าน float)
//   2. ไม่ยินยอม = ห้ามบันทึก / ลบแล้วต้องหมดจริง  ← PDPA
//   3. กันซ้ำต้องได้ทั้ง 3 ชั้น ไม่งั้นยอดเบิ้ล
import assert from "node:assert/strict";
import { open, toCents, fromCents } from "../src/db.js";
import * as L from "../src/ledger.js";

L.setDb(open(":memory:"));
const U = "Utest0000000000000000000000000001";
let pass = 0;
const ok = (msg) => { console.log(`  ✓ ${msg}`); pass++; };

// --- 1) เงิน: integer เท่านั้น ---
assert.equal(toCents("888.00"), 88800);
assert.equal(toCents("1,234.56"), 123456);
assert.equal(toCents("0.10"), 10);
assert.equal(toCents("45"), 4500);
assert.equal(toCents("abc"), null);
assert.equal(toCents(null), null);
// เคสคลาสสิกที่ float พัง: 0.1 + 0.2
assert.equal(toCents("0.10") + toCents("0.20"), toCents("0.30"));
assert.equal(fromCents(123456), "1,234.56");
assert.equal(fromCents(10), "0.10");
// ไป-กลับ 1000 ค่าแล้วต้องตรงเป๊ะ
for (let c = 1; c < 100000; c += 97) assert.equal(toCents(fromCents(c)), c);
ok("แปลงเงินไป-กลับไม่เพี้ยน (integer ล้วน)");

// --- 2) ยินยอมก่อนถึงบันทึกได้ ---
const slip = {
  amount: "888.00", currency: "THB", date: "2026-01-26", time: "05:10",
  ref: "123456789012345678", from: "นายกสิกร รักไทย", to: "ร้านกาแฟ มุมสงบ",
  banks: ["kbank"], confidence: "high", warnings: [],
};
L.ensureUser(U, "P");
assert.equal(L.hasConsent(U), false);
assert.equal(L.recordSlip(U, slip).reason, "no_consent");
ok("ยังไม่ยินยอม → ไม่บันทึก");

L.grantConsent(U);
assert.equal(L.hasConsent(U), true);
const r1 = L.recordSlip(U, slip, { imageSha256: "hash-aaa" });
assert.equal(r1.ok, true);
assert.equal(r1.amountCents, 88800);
assert.equal(r1.status, "confirmed");        // confidence high → confirmed
ok("ยินยอมแล้ว → บันทึกได้ (high → confirmed)");

// --- 3) กันซ้ำ 3 ชั้น ---
assert.equal(L.recordSlip(U, slip, { imageSha256: "hash-aaa" }).duplicate.layer, "image");
ok("กันซ้ำชั้น 1: ไฟล์เดียวกัน (sha256)");

assert.equal(L.recordSlip(U, slip, { imageSha256: "hash-bbb" }).duplicate.layer, "ref");
ok("กันซ้ำชั้น 2: ref เดียวกัน (คนละไฟล์)");

// ref อ่านไม่ออก + ไฟล์ต่าง → ต้องยังจับได้จากยอด+เวลา
const noRef = { ...slip, ref: null, time: "05:11" };   // ห่าง 1 นาที < 2 นาที
assert.equal(L.recordSlip(U, noRef, { imageSha256: "hash-ccc" }).duplicate.layer, "fuzzy");
ok("กันซ้ำชั้น 3: fuzzy (ยอด+เวลาใกล้กัน) — จำเป็นเพราะ ref อ่านถูก ~96%");

// ห่างเกิน 2 นาที = คนละรายการ ต้องบันทึกได้
const later = { ...slip, ref: "999999999999999999", time: "05:20" };
assert.equal(L.recordSlip(U, later, { imageSha256: "hash-ddd" }).ok, true);
ok("ห่างเกิน 2 นาที → ถือเป็นคนละรายการ (ไม่ over-block)");

// --- 4) ทิศทาง รับ/จ่าย ---
assert.equal(L.guessDirection(U, slip), "unknown");   // ยังไม่ลงทะเบียนบัญชี
L.learnAccount(U, "นายกสิกร รักไทย", "kbank");
assert.equal(L.guessDirection(U, slip), "out");       // ผู้ใช้เป็นผู้โอน
assert.equal(L.guessDirection(U, { ...slip, from: "คนอื่น", to: "นายกสิกร รักไทย" }), "in");
ok("ตัดสินทิศทางจากบัญชีที่ลงทะเบียน (unknown → out/in)");

assert.equal(L.acctTail("xxx-x-x8888-x"), "8888");
assert.equal(L.acctTail("ไม่มีเลข"), null);
ok("ดึง 4 ตัวท้ายบัญชี (เก็บแค่นี้พอ ไม่เก็บเลขเต็ม)");

// --- 5) confidence ต่ำ → ไม่บันทึก ---
assert.equal(
  L.recordSlip(U, { ...slip, ref: "A1", confidence: "low" }, { imageSha256: "h-low" }).reason,
  "low_confidence");
const med = L.recordSlip(U, { ...slip, ref: "B2", time: "06:30", confidence: "medium" },
                         { imageSha256: "h-med" });
assert.equal(med.status, "pending");
ok("low → ไม่บันทึก · medium → pending (ข้อมูลผิดที่เก็บเงียบ ๆ แย่กว่าไม่เก็บ)");

// --- 6) หมวดหมู่เรียนจากผู้ใช้ ---
L.learnCategory(U, "ร้านกาแฟ มุมสงบ", "อาหาร");
assert.equal(L.categoryFor(U, "ร้านกาแฟ มุมสงบ"), "อาหาร");
assert.equal(L.categoryFor(U, "ร้านกาแฟ  มุมสงบ"), "อาหาร");   // ช่องว่างต่างกันก็ยังเจอ
ok("จำหมวดหมู่จากคู่ค้าได้ (ไม่ต้องใช้โมเดล)");

// --- 7) สรุปยอด ---
const s = L.summary(U, "2026-01-01", "2026-01-31");
assert.equal(s.expense_cents > 0, true);
assert.equal(s.pending_n, 1);
ok(`สรุปยอดได้ (จ่าย ${fromCents(s.expense_cents)} · pending ${s.pending_n})`);

// --- 8) ลบข้อมูล ต้องหมดจริง (PDPA) ---
// เขียนข้อมูลให้ครบทุกตารางก่อน แล้วเช็คว่าลบหมดจริง
// (จงใจไม่ระบุชื่อคีย์เอง — ใช้ countUserRows เป็นตัวกำหนด เพิ่มตารางใหม่แล้วเทสจะจับได้เอง)
L.setBudget(U, 10000);
L.setPref(U, "weekly", "on");
L.claimAlert(U, "test", "2026-01");
L.logPush(U, "test");
const before = L.countUserRows(U);
for (const [k, v] of Object.entries(before)) assert.ok(v > 0, `ตาราง ${k} ต้องมีข้อมูลก่อนทดสอบลบ`);
L.deleteAllData(U);
const after = L.countUserRows(U);
const leftovers = Object.entries(after).filter(([, v]) => v > 0);
assert.equal(leftovers.length, 0,
  `ลบไม่หมด — เหลือ ${JSON.stringify(Object.fromEntries(leftovers))} ` +
  `(ตารางที่ไม่มี FK ต้องลบเองใน deleteAllData)`);
assert.equal(L.getUser(U), null);
ok("ลบข้อมูลผู้ใช้แล้วหมดจริงทุกตาราง (สิทธิ์ตาม PDPA)");

console.log(`\nledger.test: ${pass}/${pass} ผ่าน ✅`);
