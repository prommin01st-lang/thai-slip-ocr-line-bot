// split.test.js — หารบิล ("หาร 1200 4" → คนละ 300)
//
// สองเรื่องที่ต้องคุมให้แน่นกว่าความสะดวก:
//   1. **ห้ามจับข้อความปกติมาหาร** — "ค่าอาหาร 250" มีคำว่า "หาร" อยู่ข้างใน
//      ถ้าหลุด ผู้ใช้จะพิมพ์รายจ่ายธรรมดาแล้วได้เครื่องคิดเลขกลับไปแทนที่จะได้บันทึก
//   2. **ยอดที่เก็บได้ต้องเท่ากับบิลเป๊ะ ๆ** — 1,000 ÷ 3 หารไม่ลงตัว ถ้าปัดมั่ว
//      เงินจะขาด/เกินโดยไม่มีใครรู้ว่าหายไปไหน
import assert from "node:assert/strict";
import { parseSplit, splitBill, splitLines, MAX_PEOPLE } from "../src/split.js";
import { fromCents } from "../src/db.js";
import { parseEntry } from "../src/nlu.js";

let pass = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };

// ==================== แกะข้อความ ====================

const p = (t) => parseSplit(t);

assert.deepEqual(
  { t: p("หาร 1200 4").totalCents, n: p("หาร 1200 4").people },
  { t: 120000, n: 4 }, "รูปแบบสั้นที่สุด");
ok('"หาร 1200 4" → 1,200 บาท 4 คน');

for (const t of ["หาร 1200 4 คน", "หาร 1,200 บาท 4 คน", "1200 หาร 4", "หาร1200 4คน",
                 "หารกัน 1200 4 คน", "split 1200 4", "แชร์ 1200 4 คน", "หาร 1200 4 ที่"]) {
  const r = p(t);
  assert.ok(r, `"${t}" ต้องอ่านออก`);
  assert.equal(r.totalCents, 120000, `"${t}" ยอดผิด`);
  assert.equal(r.people, 4, `"${t}" จำนวนคนผิด`);
}
ok("รูปแบบที่คนพิมพ์จริง 8 แบบ อ่านออกหมด");

{
  const r = p("หารค่าข้าว 1200 4 คน");
  assert.equal(r.note, "ค่าข้าว", `ชื่อรายการผิด: ${r.note}`);
  assert.equal(r.people, 4);
}
ok('"หารค่าข้าว …" → จำชื่อรายการ "ค่าข้าว" ไว้ใช้ตอนจดลงบัญชี');

{
  const r = p("หาร 1200 4 คน +10%");
  assert.equal(r.pct, 10, "เซอร์วิสชาร์จผิด");
  assert.equal(r.totalCents, 120000, "ยอดบิลต้องไม่ถูก % ฮุบไป");
  assert.equal(r.people, 4);
}
ok('"+10%" → เซอร์วิสชาร์จ ไม่ใช่ยอดหรือจำนวนคน');

{
  const r = p("หาร 1200 4 คน ทิป 100");
  assert.equal(r.tipCents, 10000, "ทิปผิด");
  assert.equal(r.totalCents, 120000);
  assert.equal(r.pct, 0, "ทิปเป็นบาทห้ามกลายเป็น %");
}
ok('"ทิป 100" → ทิปเป็นจำนวนเงิน');

{
  // ต้องตรวจ % ก่อนทิปเสมอ ไม่งั้น "ทิป 10%" กลายเป็นทิป 10 บาท (ผิดไป 10 เท่า)
  const r = p("หาร 1200 4 คน ทิป 10%");
  assert.equal(r.pct, 10, "ทิปเป็น % ต้องถูกอ่านเป็น %");
  assert.equal(r.tipCents, 0, "และต้องไม่ถูกนับซ้ำเป็นทิปเงินสด");
  assert.equal(r.pctLabel, "ทิป", 'ต้องขึ้นว่า "ทิป" ไม่ใช่ "เซอร์วิส"');
}
ok('"ทิป 10%" → คิดเป็น % และเรียกว่าทิป ไม่ใช่เซอร์วิสชาร์จ');

{
  const r = p("หาร 1,200.50 3 คน");
  assert.equal(r.totalCents, 120050, "ยอดมีจุลภาคกับสตางค์ต้องไม่เพี้ยน");
  assert.equal(r.people, 3);
}
ok("ยอดมีจุลภาคและสตางค์ → ไม่เพี้ยน");

// --- ห้ามจับข้อความที่ไม่ใช่คำสั่งหาร ---
for (const t of ["ค่าอาหาร 250", "อาหารเช้า 60", "หารายได้ 500", "แบ่งจ่าย 500",
                 "เล่นแชร์ 1000", "กาแฟ 60"]) {
  assert.equal(p(t), null, `"${t}" ห้ามถูกจับเป็นคำสั่งหาร`);
}
ok('"ค่าอาหาร 250" · "หารายได้ 500" · "แบ่งจ่าย 500" → ไม่ใช่คำสั่งหาร');

// และอีกด้าน: nlu ต้องไม่แย่งคำสั่งหารไปทำเป็นรายการ
for (const t of ["หาร 1200 4", "หารค่าข้าว 1200 4 คน", "split 500 2"]) {
  assert.equal(parseEntry(t), null, `"${t}" ห้ามกลายเป็นรายการรับ/จ่าย`);
}
// แต่ข้อความปกติที่มี "หาร" อยู่ข้างในต้องยังบันทึกได้เหมือนเดิม
assert.equal(parseEntry("ค่าอาหาร 250")?.amountCents, 25000, '"ค่าอาหาร 250" ต้องยังเป็นรายจ่าย');
assert.equal(parseEntry("หารายได้ 500")?.amountCents, 50000, '"หารายได้ 500" ต้องยังบันทึกได้');
ok("nlu กับ split แบ่งเขตกันชัด ไม่แย่งข้อความกัน");

// --- บอกไม่ครบ ---
assert.deepEqual(
  { t: p("หาร").totalCents, n: p("หาร").people }, { t: null, n: null },
  '"หาร" เฉย ๆ ยังต้องนับเป็นคำสั่ง (เอาไว้สอนวิธีพิมพ์)');
assert.equal(p("หาร 1000").people, null, "บอกยอดแต่ไม่บอกคน → people ต้องเป็น null ไม่ใช่เดาให้");
assert.equal(p("แบ่ง"), null, '"แบ่ง" เดี่ยว ๆ ไม่ชัดพอ ห้ามนับเป็นคำสั่ง');
ok("บอกไม่ครบ → คืน null ในช่องนั้น ไม่เดาแทนผู้ใช้");

// ==================== คำนวณ ====================

{
  const r = splitBill({ totalCents: 120000, people: 4 });
  assert.equal(r.shareCents, 30000, "1,200 ÷ 4 = 300.00");
  assert.equal(r.oddCents, 0, "หารลงตัวต้องไม่มีเศษ");
}
ok("1,200 ÷ 4 คน = คนละ 300.00 ไม่มีเศษ");

{
  // หัวใจของทั้งไฟล์: หารไม่ลงตัวแล้วเงินต้องไม่หาย
  const r = splitBill({ totalCents: 100000, people: 3 });
  assert.equal(r.shareCents, 33333, "1,000 ÷ 3 = 333.33 (ปัดลงถึงสตางค์)");
  assert.equal(r.oddCents, 1, "เหลือ 1 สตางค์ → 1 คนจ่ายเพิ่ม");
  const collected = r.shareCents * r.people + r.oddCents;
  assert.equal(collected, r.grandCents, "ยอดที่เก็บได้ต้องเท่ากับบิลเป๊ะ ๆ");
}
ok("1,000 ÷ 3 คน → 333.33 + เศษ 1 สตางค์ · รวมกลับได้ 1,000.00 พอดี");

{
  // เศษต้องกระจายครบทุกกรณี ไม่ใช่แค่กรณีที่นึกออก
  for (let total = 1; total <= 400; total++) {
    for (let n = 1; n <= 9; n++) {
      const r = splitBill({ totalCents: total, people: n });
      assert.equal(r.shareCents * n + r.oddCents, total,
        `เงินหายที่ ${total} สตางค์ ÷ ${n} คน`);
      assert.ok(r.oddCents >= 0 && r.oddCents < n, `เศษเกินจำนวนคนที่ ${total}/${n}`);
    }
  }
}
ok("ไล่ครบ 3,600 คู่ (ยอด 1–400 สตางค์ × 1–9 คน) → ไม่มีเงินหายสักบาท");

{
  const r = splitBill({ totalCents: 120000, people: 4, pct: 10 });
  assert.equal(r.svcCents, 12000, "เซอร์วิส 10% ของ 1,200 = 120.00");
  assert.equal(r.grandCents, 132000, "รวมทั้งสิ้น 1,320.00");
  assert.equal(r.shareCents, 33000, "คนละ 330.00");
}
ok("บวกเซอร์วิส 10% ก่อนหาร → คนละ 330.00");

{
  // เซอร์วิสต้องคิดจากยอดบิลอย่างเดียว ไม่คิดทบกับทิป (ร้านคิดแบบนี้)
  const r = splitBill({ totalCents: 100000, people: 4, pct: 10, tipCents: 5000 });
  assert.equal(r.svcCents, 10000, "เซอร์วิสห้ามคิดทบทิป");
  assert.equal(r.grandCents, 115000);
  assert.equal(r.shareCents, 28750);
}
ok("เซอร์วิสคิดจากยอดบิลเท่านั้น ไม่ทบกับทิป");

{
  const r = splitBill({ totalCents: 100000, people: 3, roundUp: true });
  assert.equal(r.shareCents, 33400, "ปัดขึ้นเป็นบาท → คนละ 334.00");
  assert.equal(r.oddCents, 0, "โหมดปัดขึ้นต้องไม่มีเศษให้ใครจ่ายเพิ่ม");
  assert.equal(r.collectedCents, 100200, "เก็บได้ 1,002.00");
  assert.equal(r.surplusCents, 200, "เกินมา 2.00");
}
ok("โหมดปัดขึ้นเป็นบาท → คนละ 334.00 เก็บเกิน 2.00");

{
  // ปัดขึ้นตอนหารลงตัวพอดีต้องไม่ปัดเพิ่มขึ้นไปอีก
  const r = splitBill({ totalCents: 120000, people: 4, roundUp: true });
  assert.equal(r.shareCents, 30000, "ลงตัวอยู่แล้วห้ามปัดขึ้นอีก");
  assert.equal(r.surplusCents, 0);
}
ok("ปัดขึ้นตอนที่ลงตัวอยู่แล้ว → ไม่บวกเกินให้");

// --- จำนวนคนที่ใช้ไม่ได้ ---
assert.equal(splitBill({ totalCents: 100000, people: 0 }), null, "หารด้วย 0 ต้องคืน null ไม่ใช่ Infinity");
assert.equal(splitBill({ totalCents: 100000, people: -2 }), null, "คนติดลบ");
assert.equal(splitBill({ totalCents: 100000, people: 2.5 }), null, "คนเป็นทศนิยม");
assert.equal(splitBill({ totalCents: 100000, people: MAX_PEOPLE + 1 }), null, "เกินเพดาน");
assert.equal(splitBill({ totalCents: 0, people: 2 }), null, "ยอด 0");
ok(`หารด้วย 0 / ติดลบ / ทศนิยม / เกิน ${MAX_PEOPLE} คน → คืน null ไม่ระเบิด`);

// ==================== ข้อความที่ส่งกลับ ====================

{
  const r = splitBill({ totalCents: 100000, people: 3 });
  const txt = splitLines(r, "ค่าข้าว");
  assert.match(txt, /ค่าข้าว 1,000\.00 บาท/, "ต้องมียอดบิลเต็ม");
  assert.match(txt, /คนละ 333\.33 บาท/, "ต้องมียอดต่อคน");
  assert.match(txt, /333\.34/, "ต้องบอกด้วยว่าใครจ่ายเศษ ไม่งั้นเก็บเงินไม่ครบ");
}
ok("ข้อความคัดลอกได้ บอกครบทั้งยอดบิล ยอดต่อคน และเศษ");

{
  const r = splitBill({ totalCents: 120000, people: 4, pct: 10, tipCents: 5000 });
  const txt = splitLines(r, null);
  assert.match(txt, /เซอร์วิส 10%/);
  assert.match(txt, /ทิป 50\.00/);
  assert.match(txt, /รวมทั้งสิ้น 1,370\.00 บาท/);
  assert.equal(fromCents(r.shareCents), "342.50");
}
ok("มีทั้งเซอร์วิสและทิป → แจกแจงครบทุกบรรทัด");

console.log(`\nsplit.test: ${pass}/${pass} ผ่าน ✅`);
