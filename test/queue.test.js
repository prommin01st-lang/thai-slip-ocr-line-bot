// queue.test.js — ตรวจสัญญาของคิว: รันทีละงาน, เรียงตามลำดับ, งานพังไม่ล้มทั้งคิว
//
// ข้อที่สำคัญที่สุดคือข้อ 3: ถ้า error ของงานหนึ่งหลุดออกไปที่ loop ใน drain()
// คิวจะตายเงียบ ๆ และผู้ใช้คนถัดไปจะรอตลอดกาล — ต้องมีเทสยืนยัน
import assert from "node:assert/strict";
import { enqueue, ahead, depth } from "../src/queue.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let concurrent = 0;
let maxConcurrent = 0;
const order = [];

function job(name, ms = 20) {
  return async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(ms);
    order.push(name);
    concurrent--;
    return name;
  };
}

// --- 1) รันทีละงาน + เรียงตามลำดับที่ต่อคิว ---
const results = await Promise.all([
  enqueue(job("a")),
  enqueue(job("b")),
  enqueue(job("c")),
]);
assert.equal(maxConcurrent, 1, `ต้องรันทีละงาน แต่รันพร้อมกันได้ ${maxConcurrent}`);
assert.deepEqual(order, ["a", "b", "c"], `ลำดับผิด: ${order}`);
assert.deepEqual(results, ["a", "b", "c"], "ผลลัพธ์ต้องคืนตรงกับงานของตัวเอง");
console.log("  ✓ รันทีละงานตามลำดับ FIFO");

// --- 2) ahead()/depth() รายงานถูก ---
assert.equal(ahead(), 0, "คิวว่างแล้ว ahead() ต้องเป็น 0");
const p1 = enqueue(job("x", 50));
const p2 = enqueue(job("y", 10));
await sleep(5); // ให้ x เริ่มรัน
assert.equal(depth(), 1, "y ควรยังรออยู่ → depth = 1");
assert.equal(ahead(), 2, "x กำลังรัน + y รออยู่ → ahead = 2");
await Promise.all([p1, p2]);
console.log("  ✓ ahead()/depth() นับถูก");

// --- 3) งานที่พัง reject เฉพาะตัวเอง และคิวยังเดินต่อ ---
order.length = 0;
const failing = enqueue(async () => {
  throw new Error("งานนี้พัง");
});
const after = enqueue(job("หลังจากพัง"));

await assert.rejects(failing, /งานนี้พัง/, "งานที่พังต้อง reject ด้วย error ของตัวเอง");
assert.equal(await after, "หลังจากพัง", "งานถัดไปต้องยังรันได้ (คิวไม่ตาย)");
console.log("  ✓ งานพัง → reject เฉพาะตัวเอง คิวเดินต่อได้");

// --- 4) คิวที่ว่างแล้วรับงานใหม่ได้ (drain รอบใหม่เริ่มเองได้) ---
assert.equal(ahead(), 0);
assert.equal(await enqueue(job("รอบใหม่")), "รอบใหม่", "ต่อคิวหลังคิวว่างต้องยังทำงาน");
console.log("  ✓ ต่อคิวใหม่หลังคิวว่างได้");

console.log("\nqueue.test: 4/4 ผ่าน ✅");
