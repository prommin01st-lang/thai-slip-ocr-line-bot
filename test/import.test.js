// import.test.js — อ่านไฟล์ข้อความ/CSV เป็นรายการ แล้วนำเข้าหลังผู้ใช้ยืนยัน
//
// สองอย่างที่ต้องคุมให้แน่นที่สุด:
//   1. **ห้ามเดาเลขผิด** — แถวที่โครงสร้างเพี้ยนต้องถูกข้ามแล้วรายงาน ไม่ใช่อ่านต่อ
//      แล้วได้ยอดมั่ว (ไฟล์บัญชีที่ยอดผิดหนึ่งแถวคือยอดรวมผิดทั้งเดือน)
//   2. **ห้ามบันทึกก่อนยืนยัน** — ไฟล์เดียวมีได้เป็นร้อยรายการ ส่งผิดไฟล์แล้วบันทึกทันที
//      เท่ากับกู้คืนไม่ได้
import assert from "node:assert/strict";
import { open } from "../src/db.js";
import * as L from "../src/ledger.js";
import { parseBill, parseAmountCell, parseDateCell, splitCsvLine, sniffDelimiter } from "../src/billText.js";
import * as pending from "../src/pending.js";

process.env.LINE_CHANNEL_SECRET ||= "test-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN ||= "test-token";

L.setDb(open(":memory:"));
const { handleEvent } = await import("../src/handlers.js");

// ไม่ยิง LINE จริง — เก็บสิ่งที่บอทพยายามส่งไว้ตรวจแทน
const sent = [];
globalThis.fetch = async (_url, opts = {}) => {
  if (opts?.body) { try { sent.push(JSON.parse(opts.body)); } catch { /* ไม่ใช่ JSON */ } }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
};
const lastSent = () => JSON.stringify(sent[sent.length - 1] ?? {});

let pass = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };

const U = "Uimport0000000000000000000000001";
L.ensureUser(U, "ทดสอบนำเข้า");
L.grantConsent(U);

const cents = (e) => e.amountCents;

// --- เซลล์: ยอดเงิน ---
assert.equal(parseAmountCell("1,234.56").cents, 123456);
assert.equal(parseAmountCell("-419.00").negative, true, "เครื่องหมายลบนำหน้า");
assert.equal(parseAmountCell("(250.00)").negative, true, "วงเล็บ = ติดลบตามธรรมเนียมบัญชี");
assert.equal(parseAmountCell("1,234.56-").negative, true, "เครื่องหมายท้าย (ไฟล์จากระบบเก่า)");
assert.equal(parseAmountCell("฿30000.00").cents, 3000000, "สัญลักษณ์สกุลเงิน");
assert.equal(parseAmountCell(""), null);
assert.equal(parseAmountCell("ยอดคงเหลือ"), null, "ข้อความล้วนต้องไม่กลายเป็นเลข");
assert.equal(parseAmountCell("0.00"), null, "ศูนย์ไม่ใช่รายการ");
ok("อ่านยอดเงินได้ทุกรูปแบบที่เจอในไฟล์บัญชีจริง");

// --- เซลล์: วันที่ (พ.ศ. คือกับดักหลัก) ---
assert.equal(parseDateCell("2026-01-25"), "2026-01-25");
assert.equal(parseDateCell("25/01/2026"), "2026-01-25", "ไทยใช้ วัน/เดือน/ปี");
assert.equal(parseDateCell("25/01/2569"), "2026-01-25", "พ.ศ. เต็ม → ค.ศ.");
assert.equal(parseDateCell("25/01/69"), "2026-01-25", "พ.ศ. สองหลัก → ค.ศ.");
assert.equal(parseDateCell("25 ม.ค. 2569"), "2026-01-25", "เดือนไทยแบบย่อ");
assert.equal(parseDateCell("25 มกราคม 2569"), "2026-01-25", "เดือนไทยเต็ม");
assert.equal(parseDateCell("2026-01-25 14:32"), "2026-01-25 14:32", "มีเวลาด้วย");
assert.equal(parseDateCell("ไม่ใช่วันที่"), null);
ok("อ่านวันที่ได้ทั้ง ค.ศ./พ.ศ./เดือนไทย — ปีไม่หลุดไป 2569");

// --- CSV ที่มีจุลภาคในฟิลด์ ---
assert.deepEqual(splitCsvLine('a,"ร้าน, สาขา 2",30'), ["a", "ร้าน, สาขา 2", "30"]);
assert.deepEqual(splitCsvLine('x,"เขาว่า ""ดี"" นะ",1'), ["x", 'เขาว่า "ดี" นะ', "1"]);
assert.equal(sniffDelimiter(["กาแฟ 60, ข้าว 50"]), null, "บรรทัดเดียวไม่ใช่ตาราง");
ok("แยกฟิลด์ CSV โดยเคารพอัญประกาศ (รายละเอียดที่มีจุลภาคไม่แตก)");

// --- CSV ที่ระบบนี้ export ออกไปเอง ต้องนำกลับเข้ามาได้ ---
const roundTrip = parseBill(`﻿id,วันที่,ประเภท,จำนวน,สกุลเงิน,หมวดหมู่,คู่ค้า,รายละเอียด,ที่มา,สถานะ,เลขอ้างอิง,ธนาคาร
1,2026-01-25 14:32,รายจ่าย,1234.56,THB,อาหาร,ร้านกาแฟ,,สลิป,ยืนยันแล้ว,015202,kbank
2,2026-01-26 09:00,รายรับ,30000.00,THB,,,เงินเดือน,พิมพ์เอง,ยืนยันแล้ว,,
3,2026-01-27 10:00,รายจ่าย,500.00,THB,,,ลบไปแล้ว,สลิป,ลบแล้ว,,`);
assert.equal(roundTrip.format, "csv");
assert.equal(roundTrip.entries.length, 2, "แถวที่สถานะ 'ลบแล้ว' ต้องไม่ถูกนำกลับเข้ามา");
assert.deepEqual(roundTrip.entries.map((e) => e.direction), ["out", "in"]);
assert.equal(roundTrip.entries[0].category, "อาหาร", "หมวดจากไฟล์ต้องถูกใช้");
assert.equal(roundTrip.entries[0].occurredAt, "2026-01-25 14:32");
// "คู่ค้า" มาก่อน "รายละเอียด" ในไฟล์ ถ้า map รวมกันแถวที่ 2 จะกลายเป็นรายการไม่มีชื่อ
assert.equal(roundTrip.entries[1].note, "เงินเดือน", "แถวที่มีแต่รายละเอียด ต้องไม่เสียชื่อรายการ");
ok("CSV ที่ระบบ export เอง นำกลับเข้ามาได้ครบ (ย้ายเครื่อง/กู้คืนได้)");

// --- statement ไทย: debit/credit แยกคอลัมน์ + พ.ศ. ---
const stmt = parseBill(`วันที่,รายการ,ถอน,ฝาก,คงเหลือ
25/01/2569,ชำระค่าไฟฟ้า MEA,850.00,,12500.00
26/01/2569,โอนเข้าจากนายสมชาย,,5000.00,17500.00
27/01/2569,"ร้านกาแฟ สาขา 2, ชั้น 3",120.50,,17379.50`);
assert.deepEqual(stmt.entries.map((e) => e.direction), ["out", "in", "out"],
  "ช่องถอน = รายจ่าย · ช่องฝาก = รายรับ");
assert.deepEqual(stmt.entries.map(cents), [85000, 500000, 12050]);
assert.equal(stmt.entries[0].occurredAt, "2026-01-25", "พ.ศ. ในไฟล์ต้องถูกแปลง");
assert.equal(stmt.entries[2].note, "ร้านกาแฟ สาขา 2, ชั้น 3");
// คอลัมน์ "คงเหลือ" ต้องไม่ถูกอ่านเป็นยอดรายการ
assert.ok(!stmt.entries.some((e) => e.amountCents === 1250000), "ยอดคงเหลือห้ามกลายเป็นรายการ");
ok("statement ไทย (ถอน/ฝากแยกคอลัมน์) อ่านถูกทั้งทิศทางและยอด");

// --- แถวที่โครงสร้างเพี้ยนต้องถูกข้าม ไม่ใช่เดาต่อ ---
//
// `฿30,000.00` ที่ไม่ได้ครอบอัญประกาศจะถูกหั่นเป็นสองช่อง ทำให้ช่องยอดเหลือ "฿30"
// ซึ่ง parse ได้เป็น 30 บาท — บันทึกเลขผิดเงียบ ๆ แย่กว่าไม่บันทึก
const broken = parseBill(`date,description,amount
2026-03-01,Netflix,-419.00
2026-03-03,Salary,฿30,000.00
2026-03-04,Rent,"฿12,000.00"`);
assert.deepEqual(broken.entries.map(cents), [41900, 1200000]);
assert.equal(broken.skipped.length, 1, "แถวที่คอลัมน์ไม่ตรงต้องถูกรายงาน");
assert.ok(broken.skipped[0].includes("Salary"), "ต้องบอกด้วยว่าแถวไหน");
assert.ok(!broken.entries.some((e) => e.amountCents === 3000), "ห้ามอ่าน ฿30 เป็นยอดจริง");
ok("แถวที่โครงสร้างเพี้ยน → ข้ามแล้วบอก ไม่เดาเลขมั่ว");

// --- ไฟล์บรรทัดละรายการ ---
const lines = parseBill(`กาแฟ 60
2026-01-15 ค่าไฟ 850
ได้เงินเดือน 30000
บรรทัดที่ไม่มีตัวเลข`);
assert.equal(lines.format, "lines");
assert.deepEqual(lines.entries.map(cents), [6000, 85000, 3000000]);
assert.equal(lines.entries[1].occurredAt, "2026-01-15",
  "วันที่นำหน้าต้องถูกดึงออก ไม่ใช่ถูกอ่านเป็นยอด");
assert.deepEqual(lines.skipped, ["บรรทัดที่ไม่มีตัวเลข"]);
ok("ไฟล์ .txt บรรทัดละรายการ — ใช้ตัวตีความเดียวกับที่พิมพ์ในแชท");

// --- เพดานจำนวนแถว ---
const huge = parseBill(["วันที่,รายละเอียด,จำนวน",
  ...Array.from({ length: 600 }, (_, i) => `2026-06-01,รายการที่ ${i + 1},${i + 1}.00`)].join("\n"));
assert.equal(huge.entries.length, 500, "อ่านได้ไม่เกิน MAX_ROWS");
assert.equal(huge.truncated, 100, "ส่วนที่ไม่ได้อ่านต้องถูกรายงาน ไม่ตัดเงียบ");
ok("ไฟล์ยาวเกินเพดาน → ตัดแล้วบอกจำนวนที่ไม่ได้อ่าน");

// --- ของรอยืนยัน ---
pending._reset();
pending.put(U, { entries: [1, 2, 3], filename: "a.csv" });
assert.equal(pending.peek(U).entries.length, 3, "peek ต้องไม่เอาของออก");
assert.ok(pending.take(U), "take ต้องได้ของ");
assert.equal(pending.take(U), null, "take ครั้งที่สองต้องว่าง — กันกดยืนยันซ้ำแล้วบันทึกสองรอบ");
pending.put(U, { entries: [1], filename: "b.csv" }, -1);   // หมดอายุไปแล้ว
assert.equal(pending.peek(U), null, "ของหมดอายุต้องหยิบไม่ได้");
ok("ของรอยืนยัน: หยิบได้ครั้งเดียว และหมดอายุเองตามเวลา");

// --- flow เต็ม: พรีวิว → ยืนยัน → เข้า DB ---
const { importPreviewCard } = await import("../src/handlers.js");
pending._reset();
const bill = parseBill(`วันที่,รายละเอียด,จำนวน
2026-05-01,ค่าน้ำ,320.00
2026-05-02,ค่าเน็ต,599.00`);
const preview = importPreviewCard(U, bill, "bill.csv");

const before = L.countTxns(U);
assert.equal(before, 0, "พรีวิวต้องยังไม่เขียน DB สักแถว");
assert.ok(JSON.stringify(preview).includes("ยังไม่ได้บันทึกอะไร"), "การ์ดต้องบอกให้ชัดว่ายังไม่บันทึก");
assert.ok(JSON.stringify(preview).includes("act=import"), "ต้องมีปุ่มยืนยัน");
ok("พรีวิวไฟล์ → ยังไม่เขียน DB จนกว่าจะกดยืนยัน");

const fire = async (data) => {
  try {
    await handleEvent({ type: "postback", postback: { data }, source: { userId: U }, replyToken: "t" });
  } catch { /* ส่งข้อความออกไม่ได้ในเทส ไม่เกี่ยวกับสิ่งที่วัด */ }
};

await fire("act=import");
assert.equal(L.countTxns(U), 2, "กดยืนยันแล้วต้องบันทึกครบ");
const rows = L.recentTxns(U, 10);
assert.deepEqual(rows.map((r) => r.amount_cents).sort((a, b) => a - b), [32000, 59900]);
assert.equal(rows.find((r) => r.amount_cents === 32000).occurred_at, "2026-05-01",
  "วันที่จากไฟล์ต้องถูกใช้ ไม่ใช่วันที่นำเข้า");
ok("กดยืนยัน → บันทึกครบพร้อมวันที่จากไฟล์");

await fire("act=import");
assert.equal(L.countTxns(U), 2, "กดยืนยันซ้ำต้องไม่บันทึกซ้ำ (ของถูกหยิบออกไปแล้ว)");
ok("กดยืนยันซ้ำ → ไม่เกิดรายการซ้ำ");

// --- นำเข้าไฟล์เดิมอีกรอบ → ต้องข้ามของที่ซ้ำ ---
importPreviewCard(U, parseBill(`วันที่,รายละเอียด,จำนวน
2026-05-01,ค่าน้ำ,320.00
2026-05-03,ค่าโทรศัพท์,450.00`), "bill.csv");
await fire("act=import");
assert.equal(L.countTxns(U), 3, "แถวที่ซ้ำต้องถูกข้าม เหลือแต่รายการใหม่");
ok("ส่งไฟล์เดิมซ้ำ → ข้ามรายการที่ยอด+เวลาตรงกับของเดิม");

// --- ยกเลิก ---
importPreviewCard(U, parseBill("จำนวน\n999.00"), "x.csv");
await fire("act=importx");
assert.equal(pending.peek(U), null, "กดไม่เอา → ของรอยืนยันต้องถูกทิ้ง");
await fire("act=import");
assert.equal(L.countTxns(U), 3, "ยกเลิกแล้วกดยืนยันทีหลังต้องไม่บันทึกอะไร");
ok("กดไม่เอา → ทิ้งทันที กดยืนยันตามหลังก็ไม่มีผล");

// --- ไฟล์ที่รับไม่ได้ ต้องถูกปฏิเสธ **ก่อนโหลด** ---
//
// ทั้งสองเคสนี้ตัดสินจาก fileName/fileSize ที่ LINE ส่งมาใน event อยู่แล้ว
// ถ้าปล่อยให้โหลดก่อนค่อยตรวจ ไฟล์ 300MB (เพดานของ LINE) จะทำให้คอนเทนเนอร์
// ที่จำกัดหน่วยความจำไว้ 256MB ตายก่อนที่เราจะได้ตรวจอะไรเลย
const fireFile = async (fileName, fileSize) => {
  sent.length = 0;
  try {
    await handleEvent({
      type: "message",
      message: { type: "file", id: "f1", fileName, fileSize },
      source: { userId: U }, replyToken: "t",
    });
  } catch { /* ส่งข้อความออกไม่ได้ในเทส */ }
};

await fireFile("รายงาน.docx", 1000);
assert.ok(lastSent().includes("ยังอ่านไฟล์แบบนี้ไม่ได้"), "ไฟล์ชนิดที่ไม่รองรับต้องบอกให้ชัด");
assert.ok(lastSent().includes("CSV"), "ต้องบอกด้วยว่ารับอะไรได้บ้าง");
ok("ไฟล์ชนิดที่อ่านไม่ได้ → บอกว่ารับอะไรได้ แทนที่จะเงียบ");

await fireFile("statement.pdf", 50 * 1024 * 1024);
assert.ok(lastSent().includes("ไฟล์ใหญ่เกินไป"), "ไฟล์เกินเพดานต้องถูกปฏิเสธตั้งแต่ก่อนโหลด");
assert.ok(lastSent().includes("50.0 MB"), "ต้องบอกขนาดจริงที่ส่งมา");
ok("ไฟล์เกินเพดาน → ปฏิเสธก่อนโหลด ไม่กินหน่วยความจำ");

console.log(`\nimport.test: ${pass}/${pass} ผ่าน ✅`);
