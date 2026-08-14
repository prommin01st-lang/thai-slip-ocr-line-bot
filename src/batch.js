// batch.js — รวม event ที่มาติด ๆ กันจากคนเดียวให้เป็น "ชุดเดียว"
//
// **ทำไมต้องมี** — LINE ส่งรูปหลายใบเป็น event แยกกันคนละใบ (บางทีคนละ webhook ด้วย)
// ถ้าตอบทีละใบ ผู้ใช้ที่เลือกรูป 5 ใบจากแกลเลอรีจะได้ข้อความ 10 ใบรัว ๆ
// (การ์ด "เข้าคิว" + การ์ดผล อย่างละ 5) และที่แย่กว่านั้นคือ reply token ของใบท้าย ๆ
// จะหมดอายุระหว่างรอ OCR → ตกไปใช้ push ซึ่งมีโควตาแค่ **300 ครั้ง/เดือนทั้งระบบ**
// ส่งรูปชุดเดียวเผาโควตาไป 4-5 ครั้ง
//
// รวมเป็นชุดแล้วตอบครั้งเดียว = ผู้ใช้เห็นสรุปใบเดียว และใช้โควตาเท่ากับส่งใบเดียว
//
// **ทำไมเป็น debounce ไม่ใช่ timer ตายตัว** — รูปแต่ละใบมาถึงห่างกันไม่แน่นอน
// (ขึ้นกับขนาดไฟล์และเน็ตของผู้ใช้) นับเวลาจากใบล่าสุดเสมอจึงตรงกับ "ส่งจบหรือยัง"
// มากกว่านับจากใบแรก
//
// เก็บในหน่วยความจำเหมือน ratelimit.js — 1 process 1 เครื่อง รีสตาร์ตแล้วลืมได้
// (worst case คือชุดที่ค้างอยู่ตอนรีสตาร์ตไม่ถูกตอบ ซึ่งผู้ใช้ส่งใหม่ได้)

/** เงียบครบเท่านี้ถือว่าผู้ใช้ส่งจบแล้ว — สั้นพอที่จะไม่รู้สึกว่าบอทอืด */
const WINDOW_MS = 1500;

/**
 * จำนวนสูงสุดต่อชุด — เกินนี้ flush ทันทีแล้วเริ่มชุดใหม่
 *
 * 10 ใบ ≈ 85 วิบน VPS 2 cores ซึ่งยาวพอตัวแล้ว ปล่อยให้ชุดโตกว่านี้แปลว่า
 * ผู้ใช้ต้องรอเงียบ ๆ เป็นนาที โดยไม่มีอะไรบอกว่าคืบหน้าแค่ไหน
 */
const MAX_ITEMS = 10;

const groups = new Map();   // userId → { items, timer, onFlush }

/**
 * เพิ่ม item เข้าชุดของผู้ใช้ — `onFlush(items)` จะถูกเรียก **ครั้งเดียวต่อชุด**
 *
 * `onFlush` ที่ส่งมาครั้งหลังจะแทนของเดิม (ใช้ closure ล่าสุดเสมอ) เพราะ handler
 * ต้องการ event ล่าสุดไว้ใช้ reply token ที่สดที่สุด
 */
export function collect(userId, item, onFlush, { windowMs = WINDOW_MS, max = MAX_ITEMS } = {}) {
  const key = userId ?? "-";
  let g = groups.get(key);
  if (!g) {
    g = { items: [], timer: null, onFlush };
    groups.set(key, g);
  }
  g.onFlush = onFlush;
  g.items.push(item);

  if (g.timer) clearTimeout(g.timer);

  if (g.items.length >= max) return flush(key);

  g.timer = setTimeout(() => flush(key), windowMs);
  // ชุดที่ค้างอยู่ต้องไม่กัน process ไม่ให้จบ (สำคัญตอนรันเทส)
  g.timer.unref?.();
  return null;
}

/**
 * ยิงชุดออกไปเดี๋ยวนี้ — คืน Promise ของ onFlush (หรือ null ถ้าไม่มีชุดค้าง)
 *
 * ลบออกจาก Map **ก่อน** เรียก onFlush เสมอ: ระหว่างที่ชุดนี้ทำงานอยู่ (นานหลายสิบวินาที)
 * รูปที่ผู้ใช้ส่งเข้ามาใหม่ต้องไปตั้งชุดใหม่ ไม่ใช่ต่อท้ายชุดที่กำลังวิ่ง
 */
export function flush(userId) {
  const key = userId ?? "-";
  const g = groups.get(key);
  if (!g) return null;
  if (g.timer) clearTimeout(g.timer);
  groups.delete(key);
  return g.onFlush(g.items);
}

/** จำนวนที่ค้างอยู่ในชุดของผู้ใช้ (ใช้ในเทส/ดีบัก) */
export const pending = (userId) => groups.get(userId ?? "-")?.items.length ?? 0;

/** ใช้ในเทสเท่านั้น */
export function _reset() {
  for (const g of groups.values()) if (g.timer) clearTimeout(g.timer);
  groups.clear();
}

export const LIMITS = { WINDOW_MS, MAX_ITEMS };
