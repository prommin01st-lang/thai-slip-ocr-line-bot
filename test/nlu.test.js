// nlu.test.js — ตีความข้อความแชทเป็นรายการรับ/จ่าย
//
// สิ่งที่สำคัญกว่าความแม่น: **ต้องไม่ตีความคำสั่งของบอทเป็นรายการ**
// ("สรุป" ที่มีเลขปนอยู่ ห้ามกลายเป็นรายจ่าย) และ **ไม่แน่ใจให้คืน null**
import assert from "node:assert/strict";
import { parseEntry } from "../src/nlu.js";
import { fromCents } from "../src/db.js";

let pass = 0;
function check(text, exp, why) {
  const got = parseEntry(text);
  if (exp === null) {
    assert.equal(got, null, `${why}: "${text}" ควรได้ null แต่ได้ ${JSON.stringify(got)}`);
    console.log(`  ✓ ${JSON.stringify(text).padEnd(26)} → null    | ${why}`);
  } else {
    assert.ok(got, `${why}: "${text}" ตีความไม่ได้`);
    assert.equal(got.direction, exp.direction, `${why}: ทิศทางผิด (${got.direction})`);
    assert.equal(got.amountCents, exp.amountCents,
      `${why}: ยอดผิด ได้ ${fromCents(got.amountCents)} ควรได้ ${fromCents(exp.amountCents)}`);
    if (exp.note !== undefined) assert.equal(got.note, exp.note, `${why}: note ผิด (${got.note})`);
    console.log(`  ✓ ${JSON.stringify(text).padEnd(26)} → ${got.direction.padEnd(3)} ` +
                `${fromCents(got.amountCents).padStart(10)} | ${why}`);
  }
  pass++;
}

// --- รายจ่าย ---
check("กาแฟ 60", { direction: "out", amountCents: 6000, note: "กาแฟ" }, "ไม่มีคำกริยา → เดาเป็นรายจ่าย");
check("จ่ายค่าไฟ 850", { direction: "out", amountCents: 85000 }, "คำว่า 'จ่าย'");
check("ซื้อข้าว 45 บาท", { direction: "out", amountCents: 4500, note: "ซื้อข้าว" }, "ตัดหน่วย 'บาท' ออก");
check("ค่าเน็ต 599.50", { direction: "out", amountCents: 59950 }, "ทศนิยม");
check("ชำระบัตรเครดิต 12,500", { direction: "out", amountCents: 1250000 }, "มีคอมมา");

// --- รายรับ ---
check("ได้เงินเดือน 30000", { direction: "in", amountCents: 3000000 }, "คำว่า 'เงินเดือน'");
check("รับ 500 จากน้อง", { direction: "in", amountCents: 50000 }, "คำว่า 'รับ'");
check("ขายได้ 1,200", { direction: "in", amountCents: 120000 }, "คำว่า 'ขายได้'");

// --- ต้องคืน null ---
check("สรุป", null, "คำสั่งบอท");
check("สรุปเดือนนี้", null, "คำสั่งบอท (มีคำต่อท้าย)");
check("ยินยอม", null, "คำสั่งยินยอม");
check("สวัสดีครับ", null, "ไม่มีตัวเลข");
check("", null, "ข้อความว่าง");
check("กาแฟ 0", null, "ยอด 0 ไม่ใช่รายการ");

// --- คำสั่งที่พิมพ์ไม่ครบ ต้องไม่กลายเป็นรายการ ---
// เคสจริง: กดปุ่ม "แก้ยอด" (เติม "แก้ 12 " ให้) แล้วกดส่งโดยไม่พิมพ์ยอด
// ถ้า NLU กลืนไป จะกลายเป็น "บันทึกรายจ่าย 12 บาท ชื่อ แก้" ซึ่งผิดและงงมาก
check("แก้ 12", null, "คำสั่งแก้ที่ไม่มียอด");
check("แก้ 12 250", null, "คำสั่งแก้เต็มรูปแบบ");
check("ลบ 3", null, "คำสั่งลบ");
check("งบ 20000", null, "คำสั่งตั้งงบ");
check("งบ อาหาร 5000", null, "คำสั่งตั้งงบรายหมวด");
check("สรุป 2026-05", null, "คำสั่งสรุปย้อนหลัง");
check("ลบข้อมูลของฉัน", null, "คำสั่งลบข้อมูล");

// --- แต่คำที่ *ขึ้นต้นคล้าย* คำสั่ง ต้องยังเป็นรายการปกติ ---
// (`\b` ใช้กับไทยไม่ได้ — ต้อง lookahead ว่าตามด้วยเว้นวรรค/ตัวเลข/จบสตริง)
check("แก้วกาแฟ 60", { direction: "out", amountCents: 6000 }, "แก้ว ≠ คำสั่งแก้");
check("ลบมือ 20", { direction: "out", amountCents: 2000 }, "ลบมือ ≠ คำสั่งลบ");
check("งบประมาณโครงการ 500", { direction: "out", amountCents: 50000 }, "งบประมาณ ≠ คำสั่งงบ");

// --- ธงบอกว่าเดาเอา ---
assert.equal(parseEntry("กาแฟ 60").guessed, true, "ไม่มีคำกริยา ต้องติดธงว่าเดา");
assert.equal(parseEntry("จ่ายค่าไฟ 850").guessed, false, "มีคำกริยา ไม่ต้องติดธง");
console.log("  ✓ ติดธง guessed เมื่อไม่มีคำกริยา (ผู้เรียกเอาไปถามซ้ำได้)");
pass++;

// --- "ให้/โอนมา" ทิศทางกลับด้านตามลำดับคำ (ผู้ใช้เจอจริง: "พ่อให้เงิน 200" ขึ้นเป็นรายจ่าย) ---
//
// ภาษาไทยไม่มีรูปกริยาบอกทิศทาง ต่างกันแค่ว่ามีประธานนำหน้ากริยาไหม
// คู่ประโยคด้านล่างต่างกันแค่ลำดับคำล้วน ๆ แต่ความหมายตรงข้ามกัน
const dirOf = (t) => parseEntry(t)?.direction;
for (const [text, want] of [
  // มีประธานนำหน้า = คนอื่นให้เรา → รับ
  ["พ่อให้เงิน 200", "in"],
  ["แม่ให้ค่าขนม 500", "in"],          // มี "ค่า" (คำรายจ่าย) แต่อยู่หลัง "ให้"
  ["พ่อโอนให้ 200", "in"],             // "โอนให้" อยู่ใน OUT_WORDS — ต้องไม่ชนะ
  ["เพื่อนโอนมา 500", "in"],
  ["น้องส่งมา 300", "in"],
  ["แฟนให้มา 1000", "in"],
  // ไม่มีประธานนำหน้า = เราเป็นผู้ให้ → จ่าย
  ["ให้เงินพ่อ 200", "out"],
  ["ให้พ่อ 200", "out"],
  ["ให้ทิป 50", "out"],
  ["โอนให้พ่อ 200", "out"],
  ["ส่งมาให้พ่อ 300", "out"],
  // ประธานเป็นคำที่บอกว่าเราจ่ายอยู่แล้ว → จ่าย
  ["จ่ายให้พ่อ 200", "out"],
  ["ค่าขนมให้น้อง 50", "out"],
  ["โอนมาจ่ายค่าไฟ 500", "out"],
]) {
  assert.equal(dirOf(text), want, `“${text}” ควรเป็น ${want} (ได้ ${dirOf(text)})`);
}
console.log("  ✓ “พ่อให้เงิน”=รับ vs “ให้เงินพ่อ”=จ่าย — ตัดสินจากประธานนำหน้ากริยา");
pass++;

// เข้ากฎนี้ = มีสัญญาณจริง ไม่ใช่เดา → ไม่ต้องขึ้นหมายเหตุ "ผมเดาให้เป็นรายจ่าย"
assert.equal(parseEntry("พ่อให้เงิน 200").guessed, false, "เข้ากฎแล้วต้องไม่ติดธงว่าเดา");
assert.equal(parseEntry("ให้ทิป 50").guessed, true, "ไม่เข้ากฎ ยังต้องติดธงว่าเดา");
console.log("  ✓ เข้ากฎ ‘ประธาน+ให้’ แล้วไม่ติดธง guessed");
pass++;

console.log(`\nnlu.test: ${pass}/${pass} ผ่าน ✅`);
