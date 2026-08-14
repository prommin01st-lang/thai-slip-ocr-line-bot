// sheets.test.js — กระจกสะท้อนลง Google Sheet ของผู้ใช้
//
// ไม่ยิง Google จริง: ยัด access token ปลอมแล้วดัก `fetch` ดูว่ายิงอะไรออกไปบ้าง
// สิ่งที่ต้องคุมให้แน่นที่สุดคือ **"ลบข้อมูลของฉัน" ต้องล้างชีตด้วย** — ถ้าพลาด
// ข้อมูลการเงินจะค้างอยู่บน Google ตลอดไปโดยไม่มีอะไรในระบบรู้ว่ามันยังอยู่ (ผิด PDPA)
import assert from "node:assert/strict";
import { open } from "../src/db.js";
import * as L from "../src/ledger.js";
import * as S from "../src/sheets.js";
import { syncUser, syncNow, tick, buildDashboard, _reset as resetSync } from "../src/sheetSync.js";
import { dashboardValues } from "../src/dashboard.js";

L.setDb(open(":memory:"));
S._setToken("fake-token-for-test");

let pass = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };

const U = "Usheet00000000000000000000000001";
const SID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

// --- fetch ปลอม ---
let calls = [];
let sheetColumnA = [["id"]];          // สิ่งที่ "มีอยู่บนชีต" ตอนนี้ (คอลัมน์ A)
let sheetTabs = [{ title: "ชีต1", sheetId: 0 }];
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
  if (u.includes("fields=sheets.properties")) {
    return jsonRes({ sheets: sheetTabs.map((p) => ({ properties: p })) });
  }
  // spreadsheets:batchUpdate (สร้างแท็บ) — คนละเส้นกับ values:batchUpdate
  if (u.endsWith(":batchUpdate") && !u.includes("/values")) {
    return jsonRes({ replies: [{ addSheet: { properties: { title: "สรุป", sheetId: 99 } } }] });
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

// --- ชีตแผ่นเดียวห้ามถูกผูกโดยหลายคน ---
//
// ถ้าปล่อยให้ผูกซ้ำได้ แถวจะไม่ชนกัน (txns.id ไม่ซ้ำข้ามผู้ใช้) จนดูเหมือนใช้ได้
// แต่วันที่ใครสักคนกด "ลบข้อมูลของฉัน" values:clear จะล้าง A2:Z ทั้งแผ่น
// = รายการของอีกคนหายไปด้วยโดยไม่มีอะไรในระบบรู้
const U3 = "Usheet00000000000000000000000003";
L.ensureUser(U3, "คนที่สาม");
L.grantConsent(U3);
L.linkSheet(U3, "1SharedSheetIdAAAAAAAAAAAAAAAAAAAAAAAA");
assert.equal(L.sheetTakenBy("1SharedSheetIdAAAAAAAAAAAAAAAAAAAAAAAA", U2), U3,
  "ต้องบอกได้ว่าชีตนี้มีคนอื่นผูกอยู่");
assert.equal(L.sheetTakenBy("1SharedSheetIdAAAAAAAAAAAAAAAAAAAAAAAA", U3), null,
  "เจ้าของเดิมผูกชีตเดิมซ้ำได้ (เชื่อมใหม่ทับของตัวเอง)");
assert.equal(L.sheetTakenBy("1NobodyUsesThisIdBBBBBBBBBBBBBBBBBBBB", U2), null);
ok("ตรวจได้ว่าชีตถูกผูกโดยคนอื่นแล้ว — กันข้อมูลของคนอื่นถูกล้างทิ้ง");

// --- โหมด sync: ค่าเริ่มต้นคือกดเอง ---
resetSync();
const U4 = "Usheet00000000000000000000000004";
L.ensureUser(U4, "คนที่สี่");
L.grantConsent(U4);
L.linkSheet(U4, "1AutoModeSheetCCCCCCCCCCCCCCCCCCCCCCC");
L.clearSheetJobs(L.sheetJobs(U4).map((j) => j.id));
L.recordEntry(U4, { direction: "out", amountCents: 100, note: "รอกดส่ง" });

assert.equal(L.sheetAuto(U4), false, "ค่าเริ่มต้นต้องเป็นโหมดกดเอง");
assert.ok(L.sheetQueueDepth(U4) > 0, "ใบสั่งต้องถูกจดไว้ครบแม้ยังไม่ส่ง");
assert.ok(!L.sheetPendingUsers().some((u) => u.line_user_id === U4),
  "โหมดกดเอง → worker ต้องไม่หยิบไปทำ");

reset();
await tick();
assert.equal(calls.length, 0, "worker ต้องไม่ยิง API ให้คนที่ยังไม่เปิดอัตโนมัติ");
ok("โหมดกดเอง: จดใบสั่งไว้ครบ แต่ไม่ยิง API สักครั้ง");

// กดปุ่มส่งเอง → ยิงจริง
reset();
await syncNow(U4);
assert.ok(calls.length > 0, "กดปุ่มแล้วต้องยิงจริง");
assert.equal(L.sheetQueueDepth(U4), 0, "ส่งแล้วใบสั่งต้องหมด");
ok("กดปุ่มส่งเอง → ยิงทันทีไม่สนโหมด");

// เปิดอัตโนมัติ → worker หยิบไปทำเอง
L.setPref(U4, "sheet_auto", "on");
L.recordEntry(U4, { direction: "out", amountCents: 200, note: "อัตโนมัติ" });
assert.ok(L.sheetPendingUsers().some((u) => u.line_user_id === U4), "เปิดแล้ว worker ต้องเห็น");
reset();
await tick();
assert.equal(L.sheetQueueDepth(U4), 0, "worker ต้องส่งให้เอง");
ok("เปิดอัตโนมัติ → worker ส่งให้เองตามรอบ");

// --- wipe ต้องหลุดออกไปเสมอ แม้อยู่โหมดกดเอง (PDPA) ---
//
// จุดที่พลาดง่ายมาก: คนที่กด "ลบข้อมูลของฉัน" จะไม่มีปุ่มให้กดส่งอีกแล้ว
// เพราะแถวใน sheet_links ถูก CASCADE ลบไปพร้อม users — ถ้ารอผู้ใช้กด
// ข้อมูลจะค้างบน Google ตลอดไปทั้งที่เขาสั่งลบแล้ว
L.setPref(U4, "sheet_auto", "off");
L.recordEntry(U4, { direction: "out", amountCents: 300, note: "ก่อนลบ" });
L.deleteAllData(U4);
assert.ok(L.sheetPendingUsers().some((u) => u.line_user_id === U4),
  "ใบสั่ง wipe ต้องถูกหยิบไปทำแม้อยู่โหมดกดเอง");
reset();
await tick();
assert.ok(find((c) => c.url.includes(":clear")).length > 0, "ต้องล้างชีตจริง");
assert.equal(L.sheetQueueDepth(U4), 0);
ok("ลบข้อมูลของฉัน → ล้างชีตทันทีเสมอ ไม่รอผู้ใช้กดปุ่ม");

// --- 429 คือปัญหาชั่วคราว ห้ามนับเป็นความล้มเหลวถาวร ---
resetSync();
const U5 = "Usheet00000000000000000000000005";
L.ensureUser(U5, "คนที่ห้า");
L.grantConsent(U5);
L.linkSheet(U5, "1QuotaSheetDDDDDDDDDDDDDDDDDDDDDDDDDD");
L.setPref(U5, "sheet_auto", "on");
L.recordEntry(U5, { direction: "out", amountCents: 100, note: "ตัวที่จะชนโควตา" });
sheetColumnA = [["id"]];

failWith = { status: 429, message: "Quota exceeded for quota metric 'Write requests'" };
let r5 = await syncUser(U5);
assert.equal(r5.temporary, true, "429 ต้องถูกจัดเป็นปัญหาชั่วคราว");
assert.equal(L.sheetJobs(U5)[0].tries, 0,
  "ห้ามนับ tries — ไม่งั้นชนโควตา 5 รอบแล้วงานหยุดถาวรทั้งที่ปัญหาหายไปเอง");
// คิวถอยอยู่ในหน่วยความจำของ worker (ไม่ใช่ใน DB) — ต้องวัดที่ tick() ว่ายิงหรือไม่
reset();
await tick();
assert.equal(calls.length, 0, "ระหว่างถอย worker ต้องไม่ยิงซ้ำทันที");
ok("ชนโควตา 429 → ถอยห่างแล้วลองใหม่ ไม่นับเป็นความล้มเหลว");

// 403 คือสิทธิ์ผิด ลองใหม่ก็ไม่หาย → ต้องนับ tries ตามเดิม
failWith = { status: 403, message: "The caller does not have permission" };
await syncNow(U5);
assert.equal(L.sheetJobs(U5)[0].tries, 1, "403 ต้องนับ tries");
ok("403 (ไม่ได้แชร์สิทธิ์) → นับเป็นความล้มเหลวถาวรตามเดิม");

// แก้แล้วกดปุ่มเอง → ข้ามคิวถอยทันที
failWith = null;
const r5ok = await syncNow(U5);
assert.equal(r5ok.error, undefined, "กดปุ่มเองต้องยิงได้เลย ไม่ต้องรอ backoff หมดเวลา");
assert.equal(L.sheetQueueDepth(U5), 0);
ok("กดปุ่มเอง → ข้ามคิวถอยทันที (ผู้ใช้กำลังรอดูผลอยู่)");

// --- คอลัมน์เดือน (ฐานของแดชบอร์ดทั้งหน้า) ---
//
// ต้องตรงกับ DATE_OF ที่ SQL ใช้เป๊ะ ไม่งั้นยอดในแดชบอร์ดจะไม่ตรงกับการ์ด "สรุป"
// ของบอทเอง ซึ่งผู้ใช้เห็นทันทีและหาสาเหตุเองไม่ได้
assert.equal(L.SHEET_HEADERS[L.SHEET_HEADERS.length - 1], "เดือน", "คอลัมน์สุดท้ายต้องเป็นเดือน");
assert.equal(L.sheetMonth({ occurred_at: "2026-01-25 14:32" }), "2026-01");
assert.equal(L.sheetMonth({ created_at: "2026-01-31T20:00:00.000Z" }), "2026-02",
  "ไม่มี occurred_at → ใช้ created_at บวก 7 ชม. เหมือน DATE_OF (สิ้นเดือนตอนดึกต้องข้ามเดือน)");
assert.equal(L.sheetMonth({}), "");
const monthCell = L.sheetValues({
  id: 1, direction: "out", amount_cents: 6000, currency: "THB",
  occurred_at: "2026-03-05 10:00", source: "chat", status: "confirmed", created_at: "2026-03-05T03:00:00Z",
}).at(-1);
assert.equal(monthCell, "'2026-03",
  "ต้องมี ' นำหน้า ไม่งั้น Sheets ตีความ 2026-03 เป็นวันที่แล้วสูตรที่เทียบข้อความไม่เจอสักแถว");
ok("คอลัมน์เดือน: ตรงกับ DATE_OF ของ SQL และถูกบังคับให้เป็นข้อความ");

// --- แดชบอร์ด: เลขแถวในสูตรต้องชี้ตรงตำแหน่งจริง ---
//
// จุดที่พังง่ายและไม่มี error ให้เห็น — แทรกบรรทัดเดียวข้างบนแล้ว "คงเหลือ" จะชี้ผิดแถว
// ได้ตัวเลขที่ดูสมเหตุสมผลแต่ผิด ซึ่งแย่กว่าหน้าพังไปเลย
const dash = dashboardValues("รายการ");
const cellAt = (label) => {
  const i = dash.findIndex((r) => r[0] === label);
  return { row: i + 1, formula: dash[i]?.[1] ?? "" };
};
const inRow = cellAt("รายรับ"), outRow = cellAt("รายจ่าย"), net = cellAt("คงเหลือ");
assert.equal(net.formula, `=B${inRow.row}-B${outRow.row}`, "คงเหลือต้องลบจากแถวรายรับ/รายจ่ายจริง");
const inAll = cellAt("รายรับรวม"), outAll = cellAt("รายจ่ายรวม"), netAll = cellAt("คงเหลือสะสม");
assert.equal(netAll.formula, `=B${inAll.row}-B${outAll.row}`, "คงเหลือสะสมก็เช่นกัน");
ok("แดชบอร์ด: สูตรคงเหลืออ้างอิงแถวจริง ไม่ใช่เลขที่เขียนตายตัว");

// SPARKLINE ต้องครอบช่วง 12 เดือนพอดี ไม่กินหัวตารางและไม่ขาดแถวท้าย
const spark = dash.find((r) => r[0] === "กราฟรายจ่าย")[1];
const [, from, to] = /C(\d+):C(\d+)/.exec(spark);
assert.equal(Number(to) - Number(from) + 1, 12, "กราฟต้องครอบ 12 เดือนพอดี");
assert.equal(dash[Number(from) - 2][0], "เดือน", "แถวก่อนช่วงกราฟต้องเป็นหัวตาราง");
assert.ok(dash[Number(to) - 1][1].includes("EOMONTH(TODAY(),-0)"), "แถวสุดท้ายต้องเป็นเดือนปัจจุบัน");
ok("แดชบอร์ด: ช่วงกราฟตรงกับตาราง 12 เดือนพอดี");

// QUERY ต้องถูกแทนค่าเดือนแล้ว และไม่มีเซลล์ว่างชนิด null หลุดไปหา Sheets
const q = dash.at(-1)[0];
assert.ok(!q.includes("date_month"), "ต้องแทนค่าเดือนใน QUERY แล้ว");
assert.ok(q.includes('&TEXT(TODAY(),"yyyy-mm")&'), "ต้องต่อสตริงเดือนปัจจุบันเข้าไปในเงื่อนไข");
assert.ok(dash.every((r) => r.every((c) => c === "" || typeof c === "string")),
  "ทุกเซลล์ต้องเป็นสตริง — null ทำให้ Sheets API ปฏิเสธทั้งคำขอ");
ok("แดชบอร์ด: QUERY แทนค่าเดือนครบ และไม่มีเซลล์ว่างชนิดผิด");

// ชื่อแท็บที่มีอัญประกาศต้องถูก escape (ผู้ใช้ตั้งชื่อแท็บเองได้)
assert.ok(dashboardValues("ราย'การ")[4][1].includes("'ราย''การ'!"),
  "อัญประกาศในชื่อแท็บต้องถูกเขียนเป็นสองตัว ไม่งั้นสูตรพังทั้งหน้า");
ok("แดชบอร์ด: ชื่อแท็บแปลก ๆ ไม่ทำให้สูตรพัง");

// --- สร้างแท็บแดชบอร์ดผ่าน API ---
resetSync();
const U6 = "Usheet00000000000000000000000006";
L.ensureUser(U6, "คนที่หก");
L.grantConsent(U6);
L.linkSheet(U6, "1DashSheetEEEEEEEEEEEEEEEEEEEEEEEEEEE", "รายการ");
reset();
const d1 = await buildDashboard(U6);
assert.equal(d1.ok, true, `ต้องสร้างสำเร็จ (${d1.error})`);
assert.equal(d1.tab, "สรุป");
assert.ok(find((c) => c.body?.requests?.[0]?.addSheet).length === 1, "ต้องสร้างแท็บใหม่ 1 ครั้ง");
const written = find((c) => c.method === "PUT" && c.url.includes("/values/"))[0];
assert.ok(written, "ต้องเขียนสูตรลงแท็บ");
assert.match(decodeURIComponent(written.url), /'สรุป'!A1/, "ต้องเขียนเริ่มที่ A1 ของแท็บสรุป");
assert.ok(written.url.includes("USER_ENTERED"), "ต้องส่งแบบ USER_ENTERED ไม่งั้นสูตรกลายเป็นข้อความ");
ok("สร้างแท็บสรุป: addSheet แล้วเขียนสูตรลง A1 แบบ USER_ENTERED");

// รีเฟรชซ้ำ: ต้องล้างของเดิมก่อน ไม่ใช่สร้างแท็บซ้อน
sheetTabs = [{ title: "รายการ", sheetId: 0 }, { title: "สรุป", sheetId: 1 }];
reset();
const d2 = await buildDashboard(U6);
assert.equal(d2.ok, true);
assert.equal(find((c) => c.body?.requests?.[0]?.addSheet).length, 0, "มีแท็บอยู่แล้วห้ามสร้างซ้ำ");
assert.ok(find((c) => c.url.includes(":clear")).length === 1,
  "ต้องล้างก่อนเขียน ไม่งั้นตาราง QUERY ที่เคยยาวกว่าจะเหลือเศษค้าง");
ok("รีเฟรชแดชบอร์ด: ล้างของเดิมแล้วเขียนทับ ไม่สร้างแท็บซ้อน");

console.log(`\nsheets.test: ${pass}/${pass} ผ่าน ✅`);
