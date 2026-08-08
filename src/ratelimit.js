// ratelimit.js — จำกัดอัตราต่อผู้ใช้ ด้วย token bucket ในหน่วยความจำ
//
// **ต่างจาก queue.js อย่างไร** — queue คุม *ความพร้อมกัน* (รันทีละงาน) แต่ไม่ได้คุม
// *อัตรา* คนเดียวยิงรูป 20 ใบยังเข้าคิวได้ครบแล้วยึดเครื่องไป ~3 นาที คนอื่นรอหมด
// และตัวผู้ยิงเองก็ได้ผลช้าจนไร้ประโยชน์ ที่นี่จึงปฏิเสธตั้งแต่ต้นทางแทน
//
// **ทำไมเก็บในหน่วยความจำ ไม่ลง DB** — เป็น prototype 1 เครื่อง 1 process
// รีสตาร์ตแล้วลืมหมดก็ยอมรับได้ (worst case คือใจดีเกินไปหนึ่งรอบ) แลกกับการที่
// ไม่ต้องเขียน DB ทุก event ซึ่งจะกลายเป็นคอขวดเสียเอง
// ถ้าวันหนึ่งรันหลาย process ต้องย้ายไปที่ที่แชร์กันได้ (Redis / ตาราง)

/**
 * `capacity` = จำนวนที่ยิงรัวติดกันได้ · `refillMs` = ได้คืน 1 สิทธิ์ทุกกี่มิลลิวินาที
 *
 * ตัวเลขมาจากของจริง: OCR ใบละ **~8.5 วิ บน 2 cores** (วัดแล้ว ดู bench/FINDINGS.md)
 * ให้ 1 ใบ/20 วิ = ใช้เครื่องราว 40% ของเวลา เหลือที่ให้คนอื่นและให้ระบบหายใจ
 * ส่วนข้อความเป็น rule ล้วน ~3 ms จึงปล่อยได้เยอะกว่ามาก
 */
const LIMITS = {
  image: { capacity: 3, refillMs: 20_000 },   // รัวได้ 3 ใบ แล้วได้คืนใบละ 20 วิ
  msg: { capacity: 20, refillMs: 3_000 },     // ข้อความ/ปุ่ม — เผื่อกดเร็ว ๆ ได้สบาย
};

const buckets = new Map();          // `${userId}:${kind}` → { tokens, at }

// ทิ้งถังที่เต็มและไม่ถูกแตะนานแล้ว — ไม่งั้น Map โตตามจำนวนผู้ใช้ไม่มีที่สิ้นสุด
const IDLE_MS = 10 * 60_000;
let lastSweep = 0;

function sweep(now) {
  if (now - lastSweep < IDLE_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (now - b.at > IDLE_MS) buckets.delete(k);
}

/**
 * ขอสิทธิ์ 1 ครั้ง → `{ ok }` ถ้าผ่าน, `{ ok: false, retryInSec }` ถ้าเกินโควตา
 *
 * `now` ฉีดเข้ามาได้เพื่อให้เทสไม่ต้องรอเวลาจริง
 */
export function take(userId, kind = "msg", now = Date.now()) {
  const cfg = LIMITS[kind] ?? LIMITS.msg;
  if (!userId) return { ok: true };            // ไม่มี userId (กลุ่ม/ห้อง) → ไม่จำกัด
  sweep(now);

  const key = `${userId}:${kind}`;
  const b = buckets.get(key) ?? { tokens: cfg.capacity, at: now };

  // เติมตามเวลาที่ผ่านไป — เก็บเป็นทศนิยมไว้ ไม่งั้นช่วงสั้น ๆ จะถูกปัดทิ้งจนไม่เคยเติมเลย
  b.tokens = Math.min(cfg.capacity, b.tokens + (now - b.at) / cfg.refillMs);
  b.at = now;

  if (b.tokens < 1) {
    buckets.set(key, b);
    return { ok: false, retryInSec: Math.ceil((1 - b.tokens) * cfg.refillMs / 1000) };
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return { ok: true, left: Math.floor(b.tokens) };
}

/** ใช้ในเทสเท่านั้น */
export function _reset() { buckets.clear(); lastSweep = 0; }
