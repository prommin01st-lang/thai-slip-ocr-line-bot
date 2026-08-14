// batch.test.js — รวมรูปหลายใบที่มาติด ๆ กันให้เป็นชุดเดียว
//
// สิ่งที่ต้องคุมไว้ให้แน่น: **onFlush ต้องถูกเรียกครั้งเดียวต่อชุด**
// ถ้าหลุดเป็นสองครั้ง ผู้ใช้จะได้การ์ดสรุปซ้ำ และที่แย่กว่าคือรูปถูก OCR ซ้ำ
// (เสียเวลาเครื่องใบละ ~8.5 วิ) ทั้งที่ตัวกันซ้ำจะปัดตกอยู่ดี
import assert from "node:assert/strict";
import * as B from "../src/batch.js";
import * as RL from "../src/ratelimit.js";

let pass = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const U = "Ubatch00000000000000000000000001";

// --- รวมหลายใบเป็นชุดเดียว ---
B._reset();
let flushes = [];
for (const n of [1, 2, 3]) {
  B.collect(U, n, (items) => { flushes.push(items); }, { windowMs: 40 });
}
assert.equal(B.pending(U), 3, "ระหว่างรอ ทุกใบต้องอยู่ในชุดเดียวกัน");
await sleep(120);
assert.equal(flushes.length, 1, "onFlush ต้องถูกเรียกครั้งเดียว ไม่ใช่ใบละครั้ง");
assert.deepEqual(flushes[0], [1, 2, 3], "ต้องได้ครบทุกใบตามลำดับที่ส่งมา");
ok("รูป 3 ใบติดกัน → รวมเป็นชุดเดียว ตอบครั้งเดียว");

// --- ใบเดียวก็ยังทำงานเหมือนเดิม (แค่หน่วงตามหน้าต่างเวลา) ---
B._reset();
flushes = [];
B.collect(U, "solo", (items) => flushes.push(items), { windowMs: 30 });
await sleep(80);
assert.deepEqual(flushes, [["solo"]], "ใบเดียวต้องยังถูก flush ตามปกติ");
ok("ส่งใบเดียว → ยังทำงานเหมือนเดิม");

// --- นับเวลาใหม่จากใบล่าสุด (debounce) ---
//
// ต้องเป็นแบบนี้เพราะรูปแต่ละใบมาถึงห่างกันไม่แน่นอนตามขนาดไฟล์และเน็ตของผู้ใช้
// ถ้านับจากใบแรกตายตัว ชุดจะถูกตัดกลางคันตอนผู้ใช้เน็ตช้า
B._reset();
flushes = [];
B.collect(U, "a", (i) => flushes.push(i), { windowMs: 60 });
await sleep(40);
assert.equal(flushes.length, 0, "ยังไม่ครบหน้าต่างเวลา ต้องยังไม่ flush");
B.collect(U, "b", (i) => flushes.push(i), { windowMs: 60 });
await sleep(40);
assert.equal(flushes.length, 0, "ใบใหม่เข้ามาต้องเลื่อนเวลาออกไป ไม่ใช่ flush ตามนาฬิกาเดิม");
await sleep(60);
assert.deepEqual(flushes, [["a", "b"]], "เงียบครบแล้วค่อย flush ทั้งชุด");
ok("นับเวลาใหม่ทุกครั้งที่มีใบเข้ามา (ไม่ตัดชุดกลางคัน)");

// --- ชุดเต็มเพดาน → ยิงทันที ไม่รอ ---
B._reset();
flushes = [];
for (let i = 0; i < 4; i++) {
  B.collect(U, i, (items) => flushes.push(items.length), { windowMs: 5000, max: 3 });
}
assert.deepEqual(flushes, [3], "ครบ 3 ใบต้อง flush ทันทีโดยไม่รอ timer");
assert.equal(B.pending(U), 1, "ใบที่เกินต้องไปเริ่มชุดใหม่ ไม่ใช่ตกหล่น");
ok("ชุดเต็มเพดาน → ยิงทันที ส่วนที่เกินไปตั้งชุดใหม่");

// --- แยกชุดตามผู้ใช้ ---
B._reset();
flushes = [];
B.collect("Ua", "a", (i) => flushes.push(`a:${i.length}`), { windowMs: 30 });
B.collect("Ub", "b", (i) => flushes.push(`b:${i.length}`), { windowMs: 30 });
await sleep(80);
assert.deepEqual(flushes.sort(), ["a:1", "b:1"], "รูปของคนละคนต้องไม่ปนกัน");
ok("แยกชุดรายคน — รูปของคนอื่นไม่ปนเข้าชุดเรา");

// --- ชุดที่กำลังทำงานอยู่ต้องไม่ถูกใบใหม่แทรก ---
//
// flush ลบชุดออกจากตารางก่อนเรียก onFlush เสมอ ระหว่างที่ OCR วิ่งอยู่หลายสิบวินาที
// รูปที่ส่งเข้ามาใหม่ต้องไปตั้งชุดใหม่ ไม่ใช่ต่อท้ายชุดที่กำลังวิ่ง (ซึ่งจะไม่มีใครมาอ่าน)
B._reset();
const seen = [];
B.collect(U, 1, (items) => {
  seen.push([...items]);
  B.collect(U, 99, (later) => seen.push([...later]), { windowMs: 20 });
}, { windowMs: 20 });
await sleep(120);
assert.deepEqual(seen, [[1], [99]], "ใบที่เข้ามาระหว่างชุดเดิมทำงานต้องได้ชุดใหม่ของตัวเอง");
ok("ใบที่มาระหว่างชุดเดิมกำลังทำงาน → ตั้งชุดใหม่ ไม่ตกหล่น");

// --- เพดาน rate limit ต้องเท่ากับขนาดชุดสูงสุด ---
//
// ถ้า ratelimit ต่ำกว่า MAX_ITEMS ผู้ใช้จะส่งรูปเต็มชุดไม่ได้เลย — ใบท้าย ๆ
// ถูกปฏิเสธก่อนถึง batch ด้วยซ้ำ ทั้งที่ในสายตาเขาคือการส่งครั้งเดียว
RL._reset();
const T0 = 5_000_000;
for (let i = 1; i <= B.LIMITS.MAX_ITEMS; i++) {
  assert.equal(RL.take(U, "image", T0).ok, true, `ใบที่ ${i} ในชุดเต็มต้องผ่าน`);
}
ok(`rate limit รับชุดเต็ม ${B.LIMITS.MAX_ITEMS} ใบได้พอดี`);

console.log(`\nbatch.test: ${pass}/${pass} ผ่าน ✅`);
