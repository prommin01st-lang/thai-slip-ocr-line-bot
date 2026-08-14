// billText.js — ไฟล์ข้อความ/CSV ที่เป็นรายการบิล → รายการรับ-จ่าย
//
// รองรับสองแบบที่คนส่งเข้ามาจริง:
//   1. **CSV/TSV** — statement ที่โหลดจากแอปธนาคาร, ไฟล์จากแอปจดรายจ่ายอื่น,
//      และไฟล์ที่ระบบนี้ export ออกไปเอง (นำกลับเข้ามาได้ = ย้ายเครื่อง/กู้คืนได้)
//   2. **บรรทัดละรายการ** — `.txt` ที่พิมพ์เอง เช่น "กาแฟ 60" คนละบรรทัด
//      ใช้ตัวตีความเดียวกับที่พิมพ์ในแชท (nlu.js) จะได้ไม่มีกฎสองชุดให้หลุดจากกัน
//
// stdlib ล้วนเหมือนที่เหลือทั้งโปรเจกต์ — ไม่ลง csv-parse/papaparse
//
// **ตัวเลขที่แปลงแล้วห้ามผ่าน float** ใช้ toCents ตัวเดียวกับทั้งระบบ
import { toCents } from "./db.js";
import { parseEntry } from "./nlu.js";
import { isCategory } from "./categories.js";

/** แถวสูงสุดที่ยอมอ่านต่อไฟล์ — เกินนี้ตัดแล้วบอกผู้ใช้ ไม่ตัดเงียบ */
export const MAX_ROWS = 500;

// ---------- CSV ----------

/**
 * แยกหนึ่งบรรทัด CSV โดยเคารพเครื่องหมายคำพูด
 *
 * จำเป็นเพราะฟิลด์ "รายละเอียด" ของ statement มีจุลภาคอยู่ข้างในเป็นเรื่องปกติ
 * (`"ร้านกาแฟ สาขา 2, ชั้น 3"`) และ CSV ที่เรา export เองก็ครอบด้วย `"` เมื่อจำเป็น
 * `""` ข้างในหมายถึงอัญประกาศตัวเดียว — ตามมาตรฐาน RFC 4180
 */
export function splitCsvLine(line, delim = ",") {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * เดาตัวคั่นจากบรรทัดแรก ๆ — คืน null ถ้าไม่ใช่ตารางเลย
 *
 * ดูหลายบรรทัดไม่ใช่บรรทัดเดียว เพราะบรรทัดเดียวที่บังเอิญมีจุลภาค ("กาแฟ 60, ข้าว 50")
 * ไม่ได้แปลว่าเป็น CSV — ต้องจำนวนคอลัมน์คงที่ทั้งไฟล์ถึงจะใช่
 */
export function sniffDelimiter(lines) {
  const sample = lines.slice(0, 8).filter((l) => l.trim());
  if (sample.length < 2) return null;
  for (const d of ["\t", ",", ";", "|"]) {
    const counts = sample.map((l) => splitCsvLine(l, d).length);
    const width = mode(counts);
    // ไม่บังคับให้ทุกบรรทัดเท่ากันเป๊ะ — ไฟล์จริงมีแถวที่ตัวเลขใส่จุลภาคโดยไม่ครอบ
    // อัญประกาศ (`฿30,000.00`) ปนอยู่เสมอ ถ้าเข้มเกินจะตีทั้งไฟล์เป็นข้อความเปล่า
    // แล้วอ่านผิดทั้งก้อน — แถวที่คอลัมน์ไม่ตรงถูกคัดออกทีหลังใน parseTable
    if (width >= 2 && counts.filter((n) => n === width).length >= Math.ceil(sample.length * 0.7)) {
      return d;
    }
  }
  return null;
}

/** ค่าที่พบบ่อยที่สุด (เสมอกัน → ตัวมากกว่าชนะ เพราะตัวคั่นที่แยกได้ละเอียดกว่ามักถูกกว่า) */
function mode(nums) {
  const freq = new Map();
  for (const n of nums) freq.set(n, (freq.get(n) ?? 0) + 1);
  let best = 0, bestN = 0;
  for (const [n, c] of freq) if (c > bestN || (c === bestN && n > best)) { best = n; bestN = c; }
  return best;
}

// ป้ายหัวตารางที่พบจริงในไฟล์ไทย/อังกฤษ — เรียงจากจำเพาะไปกว้าง
const HEAD = {
  // debit/credit ต้องมาก่อน amount: statement ไทยหลายเจ้าแยกสองคอลัมน์
  // แล้วคอลัมน์ "จำนวนเงิน" จะไม่มีเลย
  debit: /^(ถอน|เงินออก|จ่าย|รายจ่าย|debit|withdrawal|withdraw|paid\s*out)/i,
  credit: /^(ฝาก|เงินเข้า|รับ|รายรับ|credit|deposit|paid\s*in)/i,
  amount: /(จำนวน|ยอด|amount|มูลค่า|value|total)/i,
  date: /(วันที่|วัน\/เวลา|date|วันเวลา|เวลา|time|datetime)/i,
  type: /^(ประเภท|ชนิด|ทิศทาง|type|direction|kind)/i,
  category: /(หมวด|category|ประเภทค่าใช้จ่าย)/i,
  status: /^(สถานะ|status)/i,
  // แยก note กับ party ออกจากกัน **โดยตั้งใจ** — CSV ที่ระบบนี้ export มีทั้งสองคอลัมน์
  // ถ้ารวมเป็นตัวเดียว "คู่ค้า" (มาก่อนในไฟล์) จะชิงตำแหน่งไป แล้วแถวที่กรอกแต่
  // "รายละเอียด" จะกลายเป็นรายการไม่มีชื่อตอนนำกลับเข้ามา
  note: /(รายละเอียด|คำอธิบาย|รายการ|บันทึก|description|detail|memo|note)/i,
  party: /(คู่ค้า|ผู้รับ|ผู้จ่าย|ร้าน|merchant|payee|counterparty)/i,
};

/** หัวตาราง → ดัชนีคอลัมน์ที่เราสนใจ (คอลัมน์ที่ไม่รู้จักถูกมองข้าม) */
export function mapColumns(header) {
  const col = {};
  header.forEach((h, i) => {
    const name = String(h ?? "").trim();
    if (!name) return;
    for (const key of ["debit", "credit", "type", "status", "category", "date", "amount", "note", "party"]) {
      if (col[key] === undefined && HEAD[key].test(name)) { col[key] = i; return; }
    }
  });
  return col;
}

/** บรรทัดนี้หน้าตาเหมือนหัวตารางไหม — หัวตารางต้องไม่มีตัวเลขที่ดูเป็นยอดเงิน */
const looksLikeHeader = (cells) =>
  cells.some((c) => /[ก-๙a-z]/i.test(c)) && !cells.some((c) => /^\(?-?[\d,]+\.?\d*\)?$/.test(c.trim()) && /\d/.test(c));

// ---------- ค่าในเซลล์ ----------

/**
 * ยอดเงินในเซลล์ → `{ cents, negative }` (null ถ้าไม่ใช่ตัวเลข)
 *
 * รับรูปแบบที่เจอจริงในไฟล์บัญชี: `1,234.56` · `-1,234.56` · `(1,234.56)` (วงเล็บ =
 * ติดลบตามธรรมเนียมบัญชี) · `1,234.56-` (เครื่องหมายท้าย แบบที่ระบบ COBOL เก่าคาย)
 * · `฿1,234.56` · `THB 1,234.56`
 */
export function parseAmountCell(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) s = `-${paren[1]}`;
  s = s.replace(/[฿$€]|thb|บาท/gi, "").trim();
  if (/-\s*$/.test(s)) s = `-${s.replace(/-\s*$/, "")}`;      // เครื่องหมายท้าย → ย้ายมาหน้า
  const neg = /^-/.test(s);
  s = s.replace(/^[+-]/, "").replace(/\s/g, "");
  if (!/^\d[\d,]*(\.\d{1,2})?$/.test(s)) return null;
  const cents = toCents(s.includes(".") ? s : `${s}.00`);
  if (cents === null || cents === 0) return null;
  return { cents, negative: neg };
}

/**
 * วันที่ในเซลล์ → `'YYYY-MM-DD'` หรือ `'YYYY-MM-DD HH:MM'` (null ถ้าอ่านไม่ออก)
 *
 * ⚠️ **พ.ศ. เป็นกับดักที่ต้องจัดการ** — ไฟล์จากแอปธนาคารไทยลงปีเป็น 2569 หรือ 69
 * ถ้าไม่แปลง รายการทั้งไฟล์จะไปโผล่ปี 2569 แล้วหายจากทุกสรุปโดยที่ผู้ใช้ไม่รู้ว่าทำไม
 *
 * รูปแบบวัน/เดือนตีความเป็น **วัน/เดือน/ปี** ตามที่ไทยใช้ ไม่ใช่เดือน/วัน/ปีแบบอเมริกัน
 * (ค่าที่ > 12 ช่วยยืนยันได้ ส่วนที่กำกวมยอมรับความเสี่ยงตามภูมิภาคที่บอทนี้ให้บริการ)
 */
export function parseDateCell(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const time = /(\d{1,2}):(\d{2})/.exec(s);
  const hhmm = time ? `${time[1].padStart(2, "0")}:${time[2]}` : null;

  const beYear = (y) => {
    let n = Number(y);
    if (n < 100) n += n > 50 ? 2500 : 2000;      // 69 → 2569 · 26 → 2026
    return n >= 2400 ? n - 543 : n;              // พ.ศ. → ค.ศ.
  };
  const pack = (y, m, d) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return hhmm ? `${iso} ${hhmm}` : iso;
  };

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);                       // 2026-01-25
  if (m) return pack(beYear(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(s);               // 25/01/2026 · 25-01-69
  if (m) return pack(beYear(m[3]), Number(m[2]), Number(m[1]));

  // 25 ม.ค. 2569 / 25 มกราคม 2026
  const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
                       "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const THAI_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
                     "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  m = /^(\d{1,2})\s+([ก-๙.]+)\s+(\d{2,4})/.exec(s);
  if (m) {
    const idx = THAI_FULL.indexOf(m[2]) >= 0 ? THAI_FULL.indexOf(m[2]) : THAI_MONTHS.indexOf(m[2]);
    if (idx >= 0) return pack(beYear(m[3]), idx + 1, Number(m[1]));
  }
  return null;
}

const DIR_WORDS = {
  in: /^(รายรับ|รับ|เงินเข้า|เข้า|ฝาก|in|income|credit|deposit)/i,
  out: /^(รายจ่าย|จ่าย|เงินออก|ออก|ถอน|out|expense|debit|withdraw)/i,
};

// ---------- ตัวหลัก ----------

/**
 * ข้อความทั้งไฟล์ → `{ entries, skipped, format, truncated }`
 *
 * `entries` = `{ direction, amountCents, note, occurredAt, category }`
 * `skipped`  = บรรทัดที่อ่านไม่ออก (สูงสุด 5 ตัวอย่าง) — **ต้องรายงานเสมอ**
 *              ผู้ใช้นำเข้า 100 บรรทัดแล้วได้ 97 โดยไม่บอกว่าอันไหนหาย คือปัญหาที่หาเองไม่ได้
 */
export function parseBill(text) {
  const raw = String(text ?? "").replace(/^﻿/, "");    // ตัด BOM (Excel ใส่มาเสมอ)
  const lines = raw.split(/\r\n|\n|\r/).filter((l) => l.trim());
  if (!lines.length) return { entries: [], skipped: [], format: "empty", truncated: 0 };

  const delim = sniffDelimiter(lines);
  return delim ? parseTable(lines, delim) : parseLines(lines);
}

function parseTable(lines, delim) {
  const rows = lines.map((l) => splitCsvLine(l, delim));
  const hasHeader = looksLikeHeader(rows[0]);
  const col = hasHeader ? mapColumns(rows[0]) : {};
  let body = hasHeader ? rows.slice(1) : rows;

  const truncated = Math.max(0, body.length - MAX_ROWS);
  body = body.slice(0, MAX_ROWS);

  // ไม่มีหัวตาราง (หรือมีแต่ไม่มีคอลัมน์ยอดที่รู้จัก) → เดาว่าคอลัมน์ยอดคือคอลัมน์ที่
  // "เป็นตัวเลขได้ทุกแถว" และเลือกตัวขวาสุด ซึ่งเป็นตำแหน่งที่ไฟล์บัญชีใช้กันเกือบทั้งหมด
  if (col.amount === undefined && col.debit === undefined && col.credit === undefined) {
    const width = Math.max(...body.map((r) => r.length));
    for (let i = width - 1; i >= 0; i--) {
      const vals = body.map((r) => parseAmountCell(r[i]));
      if (vals.filter(Boolean).length >= Math.ceil(body.length * 0.8)) { col.amount = i; break; }
    }
    if (col.date === undefined) {
      for (let i = 0; i < width; i++) {
        if (i === col.amount) continue;
        const vals = body.map((r) => parseDateCell(r[i]));
        if (vals.filter(Boolean).length >= Math.ceil(body.length * 0.8)) { col.date = i; break; }
      }
    }
    if (col.note === undefined) {
      // คอลัมน์ข้อความที่ยาวที่สุดโดยเฉลี่ย = คำอธิบายรายการ
      let best = -1, bestLen = 0;
      for (let i = 0; i < width; i++) {
        if (i === col.amount || i === col.date) continue;
        const len = body.reduce((a, r) => a + String(r[i] ?? "").length, 0) / body.length;
        if (len > bestLen) { bestLen = len; best = i; }
      }
      if (best >= 0 && bestLen > 0) col.note = best;
    }
  }

  // จำนวนคอลัมน์ที่ถือว่า "ถูกต้อง" ของไฟล์นี้
  const expected = hasHeader ? rows[0].length : mode(body.map((r) => r.length));

  const entries = [], skipped = [];
  for (const r of body) {
    // ⚠️ แถวที่คอลัมน์ไม่ตรงต้อง **ข้ามแล้วรายงาน** ห้ามพยายามอ่านต่อ
    //
    // เคสจริง: `2026-03-03,Salary,฿30,000.00` ถูกหั่นเป็น 4 ช่อง ทำให้ช่องยอด
    // กลายเป็น "฿30" ซึ่ง parse ได้เป็น 30 บาท — บันทึกเลขผิดเงียบ ๆ แย่กว่าไม่บันทึก
    if (r.length !== expected) {
      skipped.push(r.join(delim === "\t" ? " " : delim).slice(0, 60));
      continue;
    }
    const cell = (k) => (col[k] === undefined ? "" : String(r[col[k]] ?? "").trim());

    // แถวที่ระบบเราเอง export ไปแล้วถูกลบ — นำกลับเข้ามาไม่ได้ ต้องข้าม
    if (/^(ลบแล้ว|rejected|deleted)$/i.test(cell("status"))) continue;

    let cents = null, direction = null;
    const deb = parseAmountCell(cell("debit"));
    const cre = parseAmountCell(cell("credit"));
    if (deb || cre) {
      // สองคอลัมน์แยก: ช่องไหนมีค่าคือทิศทางนั้น (statement ไทยเกือบทุกเจ้าเป็นแบบนี้)
      if (deb) { cents = deb.cents; direction = "out"; } else { cents = cre.cents; direction = "in"; }
    } else {
      const amt = parseAmountCell(cell("amount"));
      if (!amt) { skipped.push(r.join(delim === "\t" ? " " : delim).slice(0, 60)); continue; }
      cents = amt.cents;
      if (amt.negative) direction = "out";       // ติดลบชัดเจนกว่าคำบรรยายใด ๆ
    }

    if (!direction) {
      const t = cell("type");
      if (DIR_WORDS.in.test(t)) direction = "in";
      else if (DIR_WORDS.out.test(t)) direction = "out";
    }
    const note = cell("note") || cell("party") || null;
    if (!direction && note) direction = parseEntry(`${note} 1`)?.direction ?? null;
    if (!direction) direction = "out";           // ค่าเริ่มต้นเดียวกับตอนพิมพ์ในแชท

    const cat = cell("category");
    entries.push({
      direction,
      amountCents: cents,
      note,
      occurredAt: parseDateCell(cell("date")),
      category: isCategory(cat) ? cat : null,
    });
  }
  return { entries, skipped: skipped.slice(0, 5), format: "csv", truncated };
}

function parseLines(lines) {
  const truncated = Math.max(0, lines.length - MAX_ROWS);
  const entries = [], skipped = [];
  for (const line of lines.slice(0, MAX_ROWS)) {
    // "2026-01-25 กาแฟ 60" — ตัดวันที่นำหน้าออกก่อนให้ NLU ไม่งั้นปีจะถูกอ่านเป็นยอดเงิน
    const lead = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})(\s+\d{1,2}:\d{2})?\s+/.exec(line);
    const rest = lead ? line.slice(lead[0].length) : line;
    const e = parseEntry(rest);
    if (!e) { skipped.push(line.slice(0, 60)); continue; }
    entries.push({
      direction: e.direction,
      amountCents: e.amountCents,
      note: e.note,
      occurredAt: lead ? parseDateCell(lead[0].trim()) : null,
      category: null,
    });
  }
  return { entries, skipped: skipped.slice(0, 5), format: "lines", truncated };
}
