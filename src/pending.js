// pending.js — ของที่รอผู้ใช้ "ยืนยัน" อยู่ (ตอนนี้ใช้กับการนำเข้าไฟล์)
//
// **ทำไมต้องรอยืนยัน** — ไฟล์ CSV หนึ่งใบมีได้เป็นร้อยรายการ และต่างจากสลิปตรงที่
// ไม่มีเลขอ้างอิงหรือ hash รูปให้กันซ้ำแบบเดิม ถ้าบันทึกทันทีแล้วผู้ใช้ส่งผิดไฟล์
// เขาต้องไล่ลบทีละรายการเป็นร้อยครั้ง ซึ่งในทางปฏิบัติคือกู้คืนไม่ได้
//
// **ทำไมเก็บในหน่วยความจำ ไม่ลง DB** — เป็นข้อมูลอายุ 10 นาทีที่ยังไม่ได้เป็นของจริง
// สักหน่อย รีสตาร์ตแล้วหายก็แค่ให้ผู้ใช้ส่งไฟล์ใหม่ (เหมือน ratelimit.js / batch.js)
// การเขียนลง DB จะทำให้ต้องมี migration + งานเก็บกวาดโดยไม่ได้อะไรกลับมา

const DEFAULT_TTL_MS = 10 * 60_000;

const box = new Map();   // userId → { data, expMs }

const alive = (e) => e && e.expMs > Date.now();

/** เก็บของรอยืนยัน — ของเดิมของผู้ใช้คนนั้นถูกแทนที่ (ส่งไฟล์ใหม่ = ยกเลิกอันเก่าโดยปริยาย) */
export function put(userId, data, ttlMs = DEFAULT_TTL_MS) {
  box.set(userId, { data, expMs: Date.now() + ttlMs });
  sweep();
  return data;
}

/** ดูโดยไม่เอาออก */
export function peek(userId) {
  const e = box.get(userId);
  return alive(e) ? e.data : null;
}

/** เอาออกมาใช้ — **ลบทิ้งทันที** กันกดยืนยันซ้ำแล้วบันทึกซ้ำสองรอบ */
export function take(userId) {
  const e = box.get(userId);
  box.delete(userId);
  return alive(e) ? e.data : null;
}

export function drop(userId) {
  return box.delete(userId);
}

/** ทิ้งของหมดอายุ — เรียกตอน put ก็พอ ไม่ต้องมี timer ค้างไว้ */
function sweep() {
  const now = Date.now();
  for (const [k, e] of box) if (e.expMs <= now) box.delete(k);
}

/** ใช้ในเทสเท่านั้น */
export function _reset() { box.clear(); }
