// sheets.test.js — กระจกสะท้อนลง Google Sheet ของผู้ใช้
//
// ไม่ยิง Google จริง: ยัด access token ปลอมแล้วดัก `fetch` ดูว่ายิงอะไรออกไปบ้าง
// สิ่งที่ต้องคุมให้แน่นที่สุดคือ **"ลบข้อมูลของฉัน" ต้องล้างชีตด้วย** — ถ้าพลาด
// ข้อมูลการเงินจะค้างอยู่บน Google ตลอดไปโดยไม่มีอะไรในระบบรู้ว่ามันยังอยู่ (ผิด PDPA)
import assert from "node:assert/strict";
import { open } from "../src/db.js";
import * as L from "../src/ledger.js";
import * as S from "../src/sheets.js";
import { syncUser } from "../src/sheetSync.js";

L.setDb(open(":memory:"));
S._setToken("fake-token-for-test");

let pass = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };

const U = "Usheet00000000000000000000000001";
const SID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

// --- fetch ปลอม ---
let calls = [];
let sheetColumnA = [["id"]];          // สิ่งที่ "มีอยู่บนชีต" ตอนนี้ (คอลัมน์ A)
let failWith = null;                   // ตั้งเพื่อจำลอง error จาก Google

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method ?? "GET";
  calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });

  if (failWith) return jsonRes({ error: { message: failWith.message } }, failWith.status);
  if (u.includes("fields=sheets.properties.title")) {
    return jsonRes({ sheets: [{ properties: { title: "ชีต1" } }] });
  }
  if (method === "GET" && u.includes("/values/")) return jsonRes({ values: sheetColumnA });
  return jsonRes({});
};

const find = (pred) => calls.filter(pred);
const reset = () => { calls = []; };

// --- อ่านลิงก์ชีต ---
assert.equal(S.parseSheetId(`https://docs.google.com/spreadsheets/d/${SID}/edit#gid=0`), SID,
  "ต้องตัด /edit#gid=0 ที่คนก๊อปมาทั้งลิงก์ออก");
assert.equal(S.parseSheetId(SID), SID, "ใส่ ID เปล่า ๆ ก็ต้องได้");
assert.equal(S.parseSheetId("สวัสดีครับ"), null, "ข้อความธรรมดาต้องไม่ถูกมองเป็น ID");
assert.equal(S.parseSheetId(""), null, "ข้อความว่าง");
ok("อ่าน spreadsheet id ได้ทั้งจากลิงก์เต็มและ ID เปล่า");

// --- ยังไม่เชื่อมชีต = ไม่มีใบสั่งใด ๆ ---
L.ensureUser(U, "ทดสอบ");
L.grantConsent(U);
const before = L.recordEntry(U, { direction: "out", amountCents: 6000, note: "กาแฟ" });
assert.equal(L.sheetQueueDepth(U), 0, "ยังไม่เชื่อมชีต ห้ามมีใบสั่งค้าง");
ok("ไม่ได้เชื่อมชีต → ไม่จดใบสั่งเลย (ไม่กระทบคนที่ไม่ใช้ฟีเจอร์นี้)");

// --- เชื่อมชีต → ต้องคิวของเก่าย้อนหลังด้วย ---
const queued = L.linkSheet(U, SID);
assert.equal(queued, 1, "ต้องคิวรายการที่มีอยู่ก่อนแล้วไปเติมย้อนหลัง");
assert.equal(L.sheetQueueDepth(U), 1);
ok("เชื่อมชีต → คัดลอกของเก่าขึ้นไปด้วย ไม่ใช่เริ่มนับจากศูนย์");

// --- sync ครั้งแรก: เขียนหัวตาราง + ต่อท้ายแถวใหม่ ---
reset();
let r = await syncUser(U);
assert.equal(r.error, undefined, `sync ต้องผ่าน (${r.error})`);
assert.equal(r.added, 1, "รายการใหม่ต้องถูกต่อท้าย");
assert.equal(L.sheetQueueDepth(U), 0, "ทำเสร็จแล้วใบสั่งต้องถูกล้าง");
assert.equal(L.sheetLink(U).tab, "ชีต1", "ต้องจำชื่อแท็บแรกไว้ ไม่ต้องถามซ้ำทุกรอบ");

const header = find((c) => c.body?.data?.[0]?.values?.[0]?.[0] === "id")[0];
assert.ok(header, "ต้องเขียนหัวตารางตอนเชื่อมครั้งแรก");
assert.deepEqual(header.body.data[0].values[0], L.SHEET_HEADERS, "หัวตารางต้องตรงกับคอลัมน์ CSV");
const appended = find((c) => c.url.includes(":append"))[0];
assert.equal(String(appended.body.values[0][0]), String(before.txnId), "คอลัมน์ A ต้องเป็นรหัสรายการ");
assert.equal(appended.body.values[0][3], "60.00", "ยอดต้องไม่มีคอมมา (Sheets จะได้อ่านเป็นตัวเลข)");
assert.ok(appended.url.includes("valueInputOption=USER_ENTERED"),
  "ต้องให้ Sheets ตีความชนิดเอง ไม่งั้นตัวเลขกลายเป็นข้อความ เอาไปทำสูตรต่อไม่ได้");
ok("sync ครั้งแรก → เขียนหัวตาราง + ต่อท้ายแถว พร้อมรหัสรายการในคอลัมน์ A");

// --- แถวที่มีอยู่แล้วต้องถูก "เขียนทับ" ไม่ใช่ต่อท้ายซ้ำ ---
sheetColumnA = [["id"], [String(before.txnId)]];      // ตอนนี้ชีตมีแถวนั้นแล้ว (แถว 2)
reset();
L.setCategory(U, before.txnId, "อาหาร");
assert.equal(L.sheetQueueDepth(U), 1, "แก้หมวดต้องจดใบสั่ง");
r = await syncUser(U);
assert.equal(r.updated, 1, "ต้องเขียนทับแถวเดิม");
assert.equal(r.added, 0, "ห้ามต่อท้ายซ้ำ");
const upd = find((c) => c.url.includes("values:batchUpdate"))[0];
assert.match(upd.body.data[0].range, /A2$/, "ต้องเขียนลงแถวที่ 2 ตามที่หาเจอในคอลัมน์ A");
assert.ok(upd.body.data[0].values[0].includes("อาหาร"), "ค่าที่เขียนต้องเป็นค่าล่าสุด");
ok("แก้รายการเดิม → เขียนทับแถวเดิม ไม่เกิดแถวซ้ำ");

// --- แก้รัว ๆ หลายครั้ง = ใบสั่งใบเดียว (ใบล่าสุดชนะ) ---
L.updateTxn(U, before.txnId, { amountCents: 7000 });
L.updateTxn(U, before.txnId, { amountCents: 8000 });
L.setCategory(U, before.txnId, "เดินทาง");
assert.equal(L.sheetQueueDepth(U), 1, "แก้ 3 ครั้งติดกันต้องเหลือใบสั่งใบเดียว");
reset();
r = await syncUser(U);
assert.ok(find((c) => c.url.includes("values:batchUpdate"))[0].body.data[0].values[0].includes("80.00"),
  "ค่าที่ขึ้นชีตต้องเป็นค่าล่าสุด ไม่ใช่ค่าตอนจดใบสั่งใบแรก");
ok("แก้หลายครั้งรัว ๆ → ยิงครั้งเดียวด้วยค่าล่าสุด");

// --- ลบรายการ → เขียนทับว่า "ลบแล้ว" (soft delete เหมือนใน DB) ---
reset();
L.deleteTxn(U, before.txnId);
r = await syncUser(U);
const del = find((c) => c.url.includes("values:batchUpdate"))[0];
assert.ok(del.body.data[0].values[0].includes("ลบแล้ว"),
  "แถวบนชีตต้องบอกว่าถูกลบ ไม่ใช่หายไปเฉย ๆ (ชีตเป็นของผู้ใช้ เขาควรเห็นประวัติ)");
ok("ลบรายการ → แถวบนชีตขึ้นว่า “ลบแล้ว”");

// --- ลบรายการที่ไม่เคยขึ้นชีต → ไม่ต้องทำอะไร ---
sheetColumnA = [["id"]];
const ghost = L.recordEntry(U, { direction: "out", amountCents: 100, note: "ผี" });
L.deleteTxn(U, ghost.txnId);
reset();
r = await syncUser(U);
assert.equal(find((c) => c.url.includes(":append")).length, 0,
  "ห้ามเติมแถว “ลบแล้ว” ของรายการที่ไม่เคยอยู่บนชีต");
ok("ลบรายการที่ยังไม่เคยขึ้นชีต → ไม่ทำอะไร ไม่เพิ่มขยะ");

// --- Google ปฏิเสธ (403 = ยังไม่ได้แชร์ชีต) ---
L.recordEntry(U, { direction: "out", amountCents: 500, note: "ทดสอบ error" });
failWith = { status: 403, message: "The caller does not have permission" };
reset();
r = await syncUser(U);
assert.ok(r.error, "ต้องรายงาน error ออกมา");
assert.ok(L.sheetQueueDepth(U) > 0, "ยิงไม่สำเร็จ ใบสั่งต้องค้างไว้ลองใหม่ ไม่ใช่ทิ้ง");
assert.match(L.sheetLink(U).last_error, /permission/, "ต้องเก็บสาเหตุไว้ให้ผู้ใช้เห็นในคำสั่ง “ชีต”");
ok("Google ปฏิเสธ → ใบสั่งค้างไว้ + เก็บสาเหตุไว้บอกผู้ใช้");

failWith = null;
reset();
r = await syncUser(U);
assert.equal(L.sheetQueueDepth(U), 0, "แก้สิทธิ์แล้วต้อง sync ตามได้เอง");
assert.equal(L.sheetLink(U).last_error, null, "หายแล้วต้องล้าง error เก่าทิ้ง");
ok("แชร์สิทธิ์แล้ว → งานที่ค้างตามขึ้นเองครบ");

// --- ลบข้อมูลของฉัน → ต้องล้างชีตด้วย (PDPA) ---
//
// จุดที่พลาดง่ายที่สุดทั้งฟีเจอร์: `sheet_links` มี FK ไป users จึงถูก CASCADE ลบ
// พร้อมกัน ถ้าใบสั่ง wipe ไม่ได้พก spreadsheet_id ติดตัวมา จะไม่มีทางรู้ว่าต้องไปล้างชีตไหน
reset();
const counts = L.deleteAllData(U);
assert.ok(counts.txns > 0, "ต้องมีข้อมูลอยู่ก่อนลบ");
assert.equal(L.sheetLink(U), null, "sheet_links ถูก CASCADE ลบไปแล้ว");
const jobs = L.sheetJobs(U);
assert.equal(jobs.length, 1, "ต้องเหลือใบสั่งเดียวคือ wipe");
assert.equal(jobs[0].op, "wipe");
assert.equal(JSON.parse(jobs[0].payload).spreadsheetId, SID,
  "ใบสั่ง wipe ต้องพก spreadsheet_id มาเอง เพราะ sheet_links ถูกลบไปพร้อม users แล้ว");

r = await syncUser(U);
assert.equal(r.wiped, true, "ต้อง wipe สำเร็จ");
const cleared = find((c) => c.url.includes(":clear"))[0];
assert.ok(cleared, "ต้องเรียก values:clear จริง");
assert.match(decodeURIComponent(cleared.url), /A2:Z/, "ล้างข้อมูลแต่เก็บหัวตารางไว้");
assert.equal(L.sheetQueueDepth(U), 0, "ล้างแล้วใบสั่งต้องหมด");
ok("ลบข้อมูลของฉัน → ล้างข้อมูลบนชีตด้วย (รอดจาก CASCADE)");

// --- เลิกเชื่อม → ใบสั่งที่ค้างต้องหายไปด้วย ---
const U2 = "Usheet00000000000000000000000002";
L.ensureUser(U2, "คนที่สอง");
L.grantConsent(U2);
L.linkSheet(U2, SID);
L.recordEntry(U2, { direction: "out", amountCents: 100, note: "ค้างไว้" });
assert.ok(L.sheetQueueDepth(U2) > 0);
L.unlinkSheet(U2);
assert.equal(L.sheetQueueDepth(U2), 0,
  "เลิกเชื่อมแล้วต้องไม่มีใบสั่งค้าง ไม่งั้น worker จะยิงต่อไปยังชีตที่ผู้ใช้ตัดขาดแล้ว");
assert.equal(L.sheetLink(U2), null);
ok("เลิกเชื่อมชีต → หยุดยิงทันที ใบสั่งที่ค้างถูกล้าง");

// --- ชื่อแท็บภาษาไทย/มีช่องว่าง ต้องถูก quote ให้ถูกต้อง ---
L.linkSheet(U2, SID, "รายการ ปี 2026");
L.recordEntry(U2, { direction: "in", amountCents: 100, note: "ทดสอบแท็บ" });
reset();
await syncUser(U2);
const ranged = find((c) => c.url.includes(":append"))[0];
assert.match(decodeURIComponent(ranged.url), /'รายการ ปี 2026'!A:A/,
  "ชื่อแท็บที่มีช่องว่างต้องถูกครอบด้วยอัญประกาศเดี่ยว ไม่งั้น Sheets ตีความช่วงผิด");
ok("ชื่อแท็บภาษาไทยและมีช่องว่าง ใช้งานได้");

console.log(`\nsheets.test: ${pass}/${pass} ผ่าน ✅`);
