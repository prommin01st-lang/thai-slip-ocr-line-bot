// split.js — หารบิล ("หาร 1200 4" → คนละ 300)
//
//     "หาร 1200 4"                 → 1,200 ÷ 4 คน = คนละ 300.00
//     "หารค่าข้าว 1200 4 คน"        → เหมือนกัน แต่จำชื่อรายการ "ค่าข้าว" ไว้ด้วย
//     "หาร 1200 4 คน +10%"         → บวกเซอร์วิสชาร์จก่อนหาร
//     "หาร 1200 4 คน ทิป 100"      → บวกทิปก่อนหาร
//     "1200 หาร 4"                 → เขียนสลับกันก็ได้
//
// **rule ล้วนเหมือน nlu.js** — ไม่มีโมเดล ตอบทันที
//
// ⚠️ ทุกอย่างคิดเป็น "สตางค์จำนวนเต็ม" ห้ามผ่าน float แม้แต่ก้าวเดียว
//    1000 ÷ 3 ในโลก float = 333.33333… พอคูณกลับได้ 999.99 ซึ่งไม่ตรงกับบิลจริง
//    ที่นี่จึงหารแบบจำนวนเต็มแล้ว **บอกเศษที่เหลือออกไปตรง ๆ** ว่าใครต้องจ่ายเพิ่ม
import { toCents, fromCents } from "./db.js";

/** หารกันได้มากสุดกี่คน — กันพิมพ์เลขหลุด ("หาร 1200 2564" = ปี พ.ศ. ไม่ใช่จำนวนคน) */
export const MAX_PEOPLE = 100;

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;

/**
 * คำสั่งหารที่ชัดเจนพอจะยึดเป็นคำสั่งได้เลยแม้ยังไม่บอกจำนวนคน
 *
 * ⚠️ กับดักที่ต้องระวังที่สุด: คำว่า **"อาหาร"** มี "หาร" อยู่ข้างใน
 *    "ค่าอาหาร 250" ต้องเป็นรายจ่ายปกติ ห้ามกลายเป็นเครื่องคิดเลขหารบิล
 *    → lookbehind กันไว้ว่าห้ามมีอักษรไทยนำหน้า
 *
 * และอีกด้าน "หารายได้ 500" ก็ห้ามโดนจับเช่นกัน
 *    → หลัง "หาร" ต้องเป็นเว้นวรรค/ตัวเลข/จบ หรือคำที่ต่อกันได้จริงเท่านั้น
 *      ("หารค่าข้าว" "หารบิล" "หารกัน") — "หารายได้" จึงหลุดออกไปเพราะตามด้วย "า"
 */
const STRONG = /(?<![ก-๙])หาร(?:ค่า[ก-๙]*|บิล|กัน|เงิน)?(?=[\s\d+,]|$)|\bsplit\b/i;

/**
 * คำที่แปลว่าหารได้เหมือนกัน แต่ **เดี่ยว ๆ ยังชี้ชัดไม่พอ**
 *
 * "แบ่งจ่าย 500" กับ "เล่นแชร์ 1000" คือรายจ่ายธรรมดา ไม่ใช่การหารบิล
 * จึงรับเฉพาะตอนที่บอกจำนวนคนมาด้วย (ดูเงื่อนไขท้าย parseSplit)
 */
const WEAK = /แชร์|แบ่ง|เฉลี่ย/;

/** ใช้ลบคำสั่งออกจากข้อความก่อนไปหาตัวเลข — ต้องครอบทั้ง strong และ weak */
const TRIGGER_WORD = /(?<![ก-๙])หาร(?:บิล|กัน|เงิน)?|\bsplit\b|แชร์|แบ่ง|เฉลี่ย/gi;

// เซอร์วิสชาร์จ/VAT/ทิปเป็น % — "+10%" "10 %" "บวก 10%" "เปอร์เซ็นต์"
const PCT = new RegExp(String.raw`(?:\+\s*|บวก\s*)?(\d{1,2}(?:\.\d{1,2})?)\s*(?:%|เปอร์เซ็น(?:ต์)?)`);
// "ทิป 10%" ต้องขึ้นว่าทิป ไม่ใช่เซอร์วิสชาร์จ — ต่างกันแค่ชื่อ แต่ผู้ใช้อ่านแล้วสะดุดทันที
const PCT_IS_TIP = new RegExp(String.raw`(?:ทิป|tip)\s*(?:\+\s*)?\d{1,2}(?:\.\d{1,2})?\s*(?:%|เปอร์เซ็น(?:ต์)?)`, "i");
// ทิปเป็นจำนวนเงิน — ต้องตรวจ **หลัง** PCT เสมอ ไม่งั้น "ทิป 10%" จะกลายเป็นทิป 10 บาท
const TIP = new RegExp(String.raw`(?:ทิป|tip)\s*(${NUM})`, "i");
// จำนวนคน — "4 คน" "4 ที่" "4 pax"
const PEOPLE = new RegExp(String.raw`(\d{1,3})\s*(?:คน|ที่|pax|ppl|people|persons?)`, "i");

/** คำที่เหลือค้างแล้วไม่ได้เป็นชื่อรายการ — ตัดออกตอนเดาชื่อรายการ */
const STOP = new Set(["คน", "กัน", "บาท", "฿", "thb", "หน่อย", "ครับ", "ค่ะ", "คับ", "ด้วย",
                      "ที", "ที่", "ละ", "คนละ", "เท่าไหร่", "เท่าไร", "หัวละ", "รวม", "ทั้งหมด",
                      "pax", "ppl", "people", "person", "persons", "tip", "ทิป"]);

/**
 * ข้อความ → `{ totalCents, people, pct, tipCents, note }` หรือ null ถ้าไม่ใช่คำสั่งหาร
 *
 * `totalCents` เป็น null ได้ (พิมพ์ "หาร" เฉย ๆ) และ `people` เป็น null ได้
 * (บอกยอดแต่ยังไม่บอกจำนวนคน) — ผู้เรียกมีหน้าที่ถามต่อ ไม่ใช่เดาให้
 */
export function parseSplit(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const strong = STRONG.test(raw);
  if (!strong && !WEAK.test(raw)) return null;

  let s = raw.replace(TRIGGER_WORD, " ");

  // ลำดับการแกะสำคัญ: % → ทิป → จำนวนคน → ที่เหลือคือยอดบิล
  // ถ้าสลับลำดับ ตัวเลขจะถูกตัวแรกที่เจอฮุบไปหมด
  let pct = 0, pctLabel = "เซอร์วิส";
  const pm = PCT.exec(s);
  if (pm) {
    pct = Number(pm[1]);
    if (PCT_IS_TIP.test(s)) pctLabel = "ทิป";
    s = s.replace(pm[0], " ");
  }

  let tipCents = 0;
  const tm = TIP.exec(s);
  if (tm) { tipCents = toCents(tm[1]) ?? 0; s = s.replace(tm[0], " "); }

  let people = null;
  const pe = PEOPLE.exec(s);
  if (pe) { people = Number(pe[1]); s = s.replace(pe[0], " "); }

  const nums = s.match(new RegExp(NUM, "g")) ?? [];
  let totalCents = null;
  if (nums.length) {
    totalCents = toCents(nums[0]);
    // ไม่ได้พิมพ์คำว่า "คน" → ตัวเลขตัวที่สองคือจำนวนคน ("หาร 1200 4")
    // แต่ต้องเป็นจำนวนเต็มเท่านั้น "หาร 1200 4.5" ไม่ใช่จำนวนคนแน่ ๆ
    if (people === null && nums.length >= 2 && !nums[1].includes(".")) {
      people = Number(nums[1].replace(/,/g, ""));
    }
  }

  const note = s
    .replace(new RegExp(NUM, "g"), " ")
    .replace(/บาท|฿|thb/gi, " ")
    .split(/[\s,.\-/=+:()]+/)
    .filter((w) => w && !STOP.has(w.toLowerCase()))
    .join(" ")
    .trim() || null;

  if (totalCents === null || totalCents <= 0) {
    // "หาร" เฉย ๆ ยังถือเป็นคำสั่ง — ผู้เรียกจะได้สอนวิธีพิมพ์ ไม่ใช่ตอบ "ไม่เข้าใจ"
    // แต่ "แบ่ง" เฉย ๆ ไม่ใช่ ปล่อยให้ตกไปทางอื่น
    return strong ? { totalCents: null, people: null, pct, pctLabel, tipCents, note } : null;
  }
  // คำอ่อนต้องมีจำนวนคนถึงจะนับเป็นคำสั่งหาร ไม่งั้น "แบ่งจ่าย 500" จะโดนจับไปด้วย
  if (!strong && people === null) return null;

  return { totalCents, people, pct, pctLabel, tipCents, note };
}

/**
 * คำนวณยอดต่อคน — คืน null ถ้าจำนวนคนใช้ไม่ได้ (0, ติดลบ, เกิน MAX_PEOPLE)
 *
 * สองโหมด:
 *   ปกติ    — หารจริงถึงระดับสตางค์ เศษที่เหลือกระจายให้ `oddCents` คนจ่ายเพิ่มคนละ 1 สตางค์
 *             (ยอดรวมที่เก็บได้ = ยอดบิลเป๊ะ ๆ ไม่ขาดไม่เกิน)
 *   ปัดขึ้น — ปัดยอดต่อคนขึ้นเป็นจำนวนเต็มบาท เก็บง่ายกว่าในชีวิตจริง
 *             ส่วนที่เกินมา (`surplusCents`) เอาไว้เป็นทิปหรือคืนคนจ่ายบิล
 */
export function splitBill({ totalCents, people, pct = 0, pctLabel = "เซอร์วิส",
                            tipCents = 0, roundUp = false } = {}) {
  const n = Number(people);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PEOPLE) return null;
  if (!Number.isInteger(totalCents) || totalCents <= 0) return null;

  // เซอร์วิสชาร์จคิดจากยอดบิลเท่านั้น ไม่คิดทบกับทิป (ร้านคิดแบบนี้)
  const svcCents = Math.round((totalCents * pct) / 100);
  const grandCents = totalCents + svcCents + tipCents;

  if (roundUp) {
    const shareCents = Math.ceil(grandCents / n / 100) * 100;
    const collectedCents = shareCents * n;
    return {
      totalCents, pct, pctLabel, svcCents, tipCents, grandCents, people: n, roundUp: true,
      shareCents, oddCents: 0, collectedCents, surplusCents: collectedCents - grandCents,
    };
  }

  const shareCents = Math.floor(grandCents / n);
  const oddCents = grandCents - shareCents * n;   // 0 … n-1 คนที่ต้องจ่ายเพิ่ม 1 สตางค์
  return {
    totalCents, pct, pctLabel, svcCents, tipCents, grandCents, people: n, roundUp: false,
    shareCents, oddCents, collectedCents: grandCents, surplusCents: 0,
  };
}

/**
 * ข้อความสรุปแบบ **คัดลอกไปวางในกลุ่มได้เลย**
 *
 * ตั้งใจส่งเป็นข้อความธรรมดาไม่ใช่การ์ด — ตัวหนังสือใน Flex กดค้างคัดลอกไม่ได้
 * ซึ่งเป็นสิ่งเดียวที่คนอยากทำต่อหลังหารเสร็จ (ส่งให้เพื่อนในกลุ่ม)
 */
export function splitLines(r, note = null) {
  const out = [];
  out.push(`🧮 ${note ? note + " " : "บิล "}${fromCents(r.totalCents)} บาท`);
  if (r.svcCents) out.push(`+ ${r.pctLabel ?? "เซอร์วิส"} ${r.pct}% = ${fromCents(r.svcCents)}`);
  if (r.tipCents) out.push(`+ ทิป ${fromCents(r.tipCents)}`);
  if (r.svcCents || r.tipCents) out.push(`รวมทั้งสิ้น ${fromCents(r.grandCents)} บาท`);
  out.push(`หาร ${r.people} คน → คนละ ${fromCents(r.shareCents)} บาท`);
  if (r.oddCents) {
    out.push(`(${r.oddCents} คนจ่าย ${fromCents(r.shareCents + 1)} บาท เพราะหารไม่ลงตัว)`);
  }
  if (r.surplusCents) {
    out.push(`เก็บได้ ${fromCents(r.collectedCents)} บาท เหลือ ${fromCents(r.surplusCents)} บาท`);
  }
  return out.join("\n");
}
