// features.test.js — ฟีเจอร์ที่เพิ่มรอบนี้: แก้/ลบรายการ · ทิศทางจาก quick reply · งบ · แจ้งเตือน
import assert from "node:assert/strict";
import { open, toCents, fromCents, nowLocal } from "../src/db.js";
import * as L from "../src/ledger.js";
import * as N from "../src/notify.js";
import { summaryBubble, txnListBubble, askDirection, txnActions, askPeriod, thaiMonth }
  from "../src/flex.js";
import { summaryMessage } from "../src/handlers.js";

L.setDb(open(":memory:"));
const U = "Ufeat000000000000000000000000001";
let pass = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };

L.ensureUser(U, "P");
L.grantConsent(U);

const slip = (over = {}) => ({
  amount: "888.00", currency: "THB", date: "2026-01-26", time: "05:10",
  ref: "R" + Math.random().toString(36).slice(2, 12).toUpperCase(),
  from: "นายกสิกร รักไทย", to: "ร้านกาแฟ มุมสงบ", banks: ["kbank"],
  confidence: "high", warnings: [], ...over,
});

// --- 1) ทิศทางจาก quick reply + จำบัญชีไว้ใช้ครั้งหน้า ---
const r1 = L.recordSlip(U, slip(), { imageSha256: "f-h1" });
assert.equal(r1.direction, "unknown", "ยังไม่ลงทะเบียนบัญชี → ต้องเป็น unknown");
const conf = L.confirmDirection(U, r1.txnId, "out");
assert.equal(conf.ok, true);
assert.equal(conf.learned, true, "ต้องจำบัญชีจากฝั่ง from");
assert.equal(L.getTxn(U, r1.txnId).direction, "out");
ok("ตอบ quick reply → ตั้งทิศทาง + จำบัญชี");

// ใบถัดไปต้องเดาได้เองแล้ว
const r2 = L.recordSlip(U, slip({ time: "06:30" }), { imageSha256: "f-h2" });
assert.equal(r2.direction, "out", "ครั้งที่สองต้องเดาเองได้ ไม่ต้องถามซ้ำ");
ok("ใบถัดไปเดาทิศทางเองได้ (ไม่ถามซ้ำ)");

// --- 2) แก้ยอด ---
assert.equal(L.updateTxn(U, r2.txnId, { amountCents: toCents("123.45") }), true);
assert.equal(L.getTxn(U, r2.txnId).amount_cents, 12345);
ok("แก้ยอดรายการย้อนหลังได้");

// medium → แก้แล้วต้องเลิกเป็น pending
const r3 = L.recordSlip(U, slip({ time: "07:00", confidence: "medium" }), { imageSha256: "f-h3" });
assert.equal(L.getTxn(U, r3.txnId).status, "pending");
L.updateTxn(U, r3.txnId, { amountCents: 100 });
assert.equal(L.getTxn(U, r3.txnId).status, "confirmed", "แก้เอง = ยืนยันแล้ว");
ok("แก้รายการ pending → กลายเป็น confirmed");

// --- 3) ลบ = soft delete (สลิปเดิมยังส่งซ้ำไม่ได้ ป้องกันยอดเบิ้ล) ---
const before = L.summary(U, "2026-01-01", "2026-01-31").expense_cents;
assert.equal(L.deleteTxn(U, r3.txnId), true);
assert.equal(L.deleteTxn(U, r3.txnId), false, "ลบซ้ำต้องคืน false");
const after = L.summary(U, "2026-01-01", "2026-01-31").expense_cents;
assert.ok(after < before, "ลบแล้วยอดรวมต้องลด");
assert.equal(L.getTxn(U, r3.txnId).status, "rejected", "ต้องเป็น soft delete");
ok("ลบรายการ → หายจากยอดรวม แต่ slip ยังกันซ้ำอยู่");

assert.ok(L.recentTxns(U, 10).every((t) => t.id !== r3.txnId), "รายการที่ลบต้องไม่โผล่ในลิสต์");
ok("รายการที่ลบไม่โผล่ในรายการล่าสุด");

// --- 4) งบประมาณ ---
L.setBudget(U, toCents("1000.00"));                       // งบรวม 1,000
const st = L.budgetStatus(U, "2026-01-01", "2026-01-31", 0);
assert.equal(st.length, 1);
assert.equal(st[0].category, "*");
assert.ok(st[0].used_cents > 0);
ok(`งบรวม: ใช้ ${fromCents(st[0].used_cents)} / ${fromCents(st[0].limit_cents)}`);

L.setBudget(U, toCents("10.00"));                         // ตั้งใหม่ทับ → ต้องเกิน
assert.equal(L.budgetStatus(U, "2026-01-01", "2026-01-31")[0].over, true);
ok("ตั้งงบทับของเดิมได้ + ตรวจว่าเกินได้");

// --- 5) กันแจ้งเตือนซ้ำในรอบเดียวกัน ---
assert.equal(L.claimAlert(U, "budget:*:over", "2026-01"), true);
assert.equal(L.claimAlert(U, "budget:*:over", "2026-01"), false, "รอบเดิมต้องเตือนครั้งเดียว");
assert.equal(L.claimAlert(U, "budget:*:over", "2026-02"), true, "คนละเดือนต้องเตือนได้ใหม่");
ok("กันเตือนซ้ำเรื่องเดิมในรอบเดิม (แต่รอบใหม่เตือนได้)");

// --- 6) แจ้งเตือนงบเกิน ---
// งบตรวจ "เดือนปัจจุบัน" แต่รายการข้างบนลงวันที่ 2026-01 → ต้องสร้างรายการของเดือนนี้ก่อน
// (recordEntry ใช้เวลาปัจจุบันเสมอ)
const eNow = L.recordEntry(U, { direction: "out", amountCents: toCents("500.00"), note: "ทดสอบงบ" });
L.updateTxn(U, eNow.txnId, { category: "อาหาร" });   // ผูกหมวด เพื่อทดสอบงบรายหมวดด้วย
L.setBudget(U, toCents("100.00"));            // งบรวม 100 แต่ใช้ไป 500 → ต้องเตือนว่าเกิน

const sentA = [];
const rA = await N.checkAlerts(U, (m) => { sentA.push(m); });
assert.equal(rA.sent, 1, `ควรเตือนงบเกิน 1 ข้อความ (ได้ ${JSON.stringify(rA)})`);
assert.match(sentA[0].text, /เกิน/, "ข้อความต้องบอกว่าเกินงบ");
ok(`เตือนงบเกินได้: "${sentA[0].text.split("\n")[0]}"`);

// เรียกซ้ำในเดือนเดิม ต้องไม่เตือนอีก
const rDup = await N.checkAlerts(U, () => { throw new Error("ไม่ควรถูกเรียก"); });
assert.equal(rDup.sent, 0, "เดือนเดิมต้องเตือนครั้งเดียว");
ok("เรียกซ้ำเดือนเดิม → ไม่เตือนซ้ำ");

// จำลองโควตาหมด — ต้องเก็บค่าไว้ก่อนวน ไม่งั้น left จะลดลงทุกรอบแล้ววนไม่ครบ
const toBurn = N.quota().left;
for (let i = 0; i < toBurn; i++) L.logPush(U, "test");
assert.equal(N.canPush(), false, "ใช้ครบโควตาแล้วต้องส่งไม่ได้");

L.setBudget(U, toCents("50.00"), "อาหาร");     // งบหมวดที่มียอดจริง → มีเรื่องให้เตือน
const sentB = [];
const rB = await N.checkAlerts(U, (m) => { sentB.push(m); });
assert.equal(sentB.length, 0, "โควตาหมดแล้วต้องไม่ push");
assert.equal(rB.skipped, "quota", `ควรบอกว่าข้ามเพราะโควตา (ได้ ${JSON.stringify(rB)})`);
ok("โควตาหมด → หยุดแจ้งเตือน ไม่ push ทะลุ");

// --- 7) ช่วงเวลา ---
const [wf, wt] = N.thisWeek();
assert.match(wf, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(wf <= wt, "ต้นสัปดาห์ต้องไม่เกินวันนี้");
assert.match(N.weekKey(), /^\d{4}-W\d{2}$/);
ok(`ช่วงสัปดาห์นี้ ${wf} → ${wt} (${N.weekKey()})`);

// --- 8) Flex ต้องสร้างได้และไม่มี null ใน tree ---
function validate(node, path = "$") {
  assert.ok(node != null, `${path}: null ใน Flex tree`);
  if (node.type === "text") assert.ok(node.text?.length > 0, `${path}: text ว่าง`);
  for (const k of ["contents", "header", "body", "footer"]) {
    const c = node[k];
    if (!c) continue;
    Array.isArray(c) ? c.forEach((x, i) => validate(x, `${path}.${k}[${i}]`)) : validate(c, `${path}.${k}`);
  }
}
const sb = summaryBubble(L.summary(U, "2026-01-01", "2026-01-31"), fromCents);
assert.equal(sb.type, "flex"); validate(sb.contents, "summary");
assert.ok(sb.altText.length <= 400);
ok("สรุปเป็น Flex สร้างได้ ไม่มี null");

const lb = txnListBubble(L.recentTxns(U, 5), fromCents);
assert.equal(lb.type, "flex"); validate(lb.contents, "list");
ok("รายการล่าสุดเป็น Flex สร้างได้");

// ปุ่มต้องอยู่ **ใน footer ของการ์ด** ไม่ใช่ quick reply — ชิป quick reply หายเมื่อเลื่อนแชท
const footerActions = (msg) =>
  (msg.contents?.footer?.contents ?? []).filter((c) => c.type === "button").map((b) => b.action);

const qd = askDirection(1, "888.00");
assert.equal(qd.type, "flex", "askDirection ต้องเป็นการ์ด");
const qa = footerActions(qd);
assert.equal(qa.length, 3, `ต้องมี 3 ปุ่มใน footer (ได้ ${qa.length})`);
assert.ok(qa.every((a) => a.type === "postback" && a.data.includes("act=")));
assert.ok(qa.some((a) => a.data.includes("v=in")) && qa.some((a) => a.data.includes("v=out")),
  "ต้องมีทั้งปุ่มรับและจ่าย");
assert.equal(txnActions(1, "x").quickReply.items.length, 2);
ok(`ปุ่มรับ/จ่ายอยู่ในการ์ด (${qa.map((a) => a.label).join(" | ")})`);

// --- 9) รายการล่าสุดของคนอื่นต้องไม่ปน ---
const V = "Uother00000000000000000000000001";
L.ensureUser(V); L.grantConsent(V);
L.recordSlip(V, slip({ time: "09:00" }), { imageSha256: "v-h1" });
assert.ok(L.recentTxns(U, 50).every((t) => t.id !== L.recentTxns(V, 1)[0].id));
assert.equal(L.getTxn(U, L.recentTxns(V, 1)[0].id), null, "อ่านรายการของ user อื่นไม่ได้");
assert.equal(L.deleteTxn(U, L.recentTxns(V, 1)[0].id), false, "ลบรายการของ user อื่นไม่ได้");
ok("ข้อมูลแยกตามผู้ใช้ — อ่าน/ลบข้ามคนไม่ได้");

// --- 10) เลือกเดือนที่จะลงยอด (สลิปเก่าที่เพิ่งส่งเข้ามา) ---
// เคสจริงที่ผู้ใช้เจอ: ส่งสลิปลงวันที่เดือนก่อน แล้ว "สรุป" (เดือนนี้) ไม่มียอดนั้น
const P = "Uperiod00000000000000000000000001";
L.ensureUser(P); L.grantConsent(P);
const old = L.recordSlip(P, slip({ date: "2026-05-29", time: "15:00" }), { imageSha256: "p-h1" });
L.confirmDirection(P, old.txnId, "in");
const [mf, mt] = N.thisMonth();
assert.equal(L.summary(P, mf, mt).income_cents, 0, "สลิปเดือนก่อนต้องไม่อยู่ในสรุปเดือนนี้");
assert.equal(L.summary(P, mf, mt).outside_n, 1, "ต้องรายงานว่ามี 1 รายการนอกช่วง");
ok("สลิปเดือนก่อน → ไม่นับในสรุปเดือนนี้ แต่บอกว่ามีนอกช่วง");

// ผู้ใช้เลือก "ลงเดือนนี้"
L.setOccurredAt(P, old.txnId, new Date().toISOString().slice(0, 16).replace("T", " "));
assert.ok(L.summary(P, mf, mt).income_cents > 0, "ย้ายมาเดือนนี้แล้วต้องนับ");
assert.equal(L.summary(P, mf, mt).outside_n, 0);
ok("เลือก “ลงเดือนนี้” → ยอดเข้าสรุปเดือนนี้");

// ย้อนกลับ "ตามสลิป" ได้ (วันที่เดิมเก็บใน fields_json)
const back = L.slipOccurredAt(P, old.txnId);
assert.ok(back?.startsWith("2026-05-29"), `กู้วันที่บนสลิปไม่ได้ (ได้ ${back})`);
L.setOccurredAt(P, old.txnId, back);
assert.equal(L.summary(P, mf, mt).income_cents, 0);
ok("เลือก “ตามสลิป” → ย้อนกลับวันที่เดิมได้");

// การ์ดถามต้องมีปุ่ม 2 ตัวและ data ถูกรูปแบบ
const ap = askPeriod(old.txnId, "2026-05-29", mt);
assert.equal(ap.type, "flex");
const pa = (ap.contents?.footer?.contents ?? []).filter((c) => c.type === "button").map((b) => b.action);
assert.equal(pa.length, 2, `ต้องมี 2 ปุ่มใน footer (ได้ ${pa.length})`);
assert.ok(pa.every((a) => /act=period&id=\d+&v=(slip|now)/.test(a.data)));
assert.equal(thaiMonth("2026-05-29"), "พ.ค. 69");
ok(`การ์ดถามเดือนถูกต้อง (${pa.map((a) => a.label).join(" | ")})`);

// --- 11) ส่งออก CSV ---
const { csv, count } = L.exportCsv(U);
assert.ok(count > 0, "ต้องมีข้อมูลให้ส่งออก");
assert.equal(csv.charCodeAt(0), 0xFEFF, "ต้องขึ้นต้นด้วย BOM ไม่งั้น Excel อ่านไทยเพี้ยน");
const head = csv.replace(/^\uFEFF/, "").split("\r\n")[0];
assert.ok(head.startsWith("id,วันที่,ประเภท,จำนวน"), `หัวตารางผิด: ${head}`);
// รายการที่ลบ (rejected) ต้องไม่อยู่ในไฟล์
assert.ok(!csv.split("\r\n").some((l) => l.startsWith(`${r3.txnId},`)),
  "รายการที่ลบแล้วต้องไม่ถูกส่งออก");
ok(`ส่งออก CSV ได้ ${count} แถว (มี BOM, ไม่รวมรายการที่ลบ)`);

// escape ต้องถูก: คอมมา / อัญประกาศ / ขึ้นบรรทัดใหม่
const E = "Uesc00000000000000000000000000001";
L.ensureUser(E); L.grantConsent(E);
L.recordEntry(E, { direction: "out", amountCents: 100, note: 'ก, "ข"\nค' });
const line = L.exportCsv(E).csv.split("\r\n")[1];
assert.ok(line.includes('"ก, ""ข""'), `escape ผิด: ${line}`);
ok("escape CSV ถูกต้อง (คอมมา / อัญประกาศ / ขึ้นบรรทัด)");

// token: เดาไม่ได้ · ใช้ครั้งเดียว · ผูกกับผู้ใช้คนเดียว
const tk = L.createExportToken(U);
assert.ok(tk.token.length >= 40, "token ต้องยาวพอจะเดาไม่ได้");
assert.equal(L.consumeExportToken(tk.token), U, "ใช้ครั้งแรกต้องได้ userId");
assert.equal(L.consumeExportToken(tk.token), null, "ใช้ซ้ำต้องถูกปฏิเสธ");
assert.equal(L.consumeExportToken("ไม่มีอยู่จริง"), null);
assert.equal(L.consumeExportToken(null), null);
ok("token ส่งออก: สุ่ม · ใช้ครั้งเดียว · ปฏิเสธของปลอม");

// token ต้องหายไปด้วยเมื่อผู้ใช้ลบข้อมูล (PDPA)
const tk2 = L.createExportToken(E);
L.deleteAllData(E);
assert.equal(L.consumeExportToken(tk2.token), null, "ลบข้อมูลแล้ว token เดิมต้องใช้ไม่ได้");
ok("ลบข้อมูลผู้ใช้ → ลิงก์ส่งออกที่ค้างอยู่ใช้ไม่ได้ทันที");

// --- ยอดต้องไม่หายจากสรุป (ผู้ใช้แจ้งจริง: บอทตอบว่าบันทึกแล้ว แต่กดสรุปไม่เจอ) ---
//
// 3 ทางที่เงินเคยหายไปเงียบ ๆ:
//   ก. สลิปอ่านวันที่ไม่ออก → occurred_at = NULL → สรุปกรอง IS NOT NULL ทิ้ง
//   ข. สลิปลงวันที่เดือนก่อน → อยู่นอกช่วง แต่การ์ด "ไม่มีรายการ" ไม่ยอมบอก
//   ค. บันทึกช่วงตี 1 → occurred_at เป็น UTC = เมื่อวาน → หลุดออกนอกเดือน
const Z = "Uzero000000000000000000000000001";
L.ensureUser(Z, "Z"); L.grantConsent(Z);
const todayTh = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
const monthTh = [`${todayTh.slice(0, 7)}-01`, todayTh];

// ก. สลิปไม่มีวันที่บนใบ
const noDate = L.recordSlip(Z, slip({ date: null, time: null }), { imageSha256: "z-nodate" });
assert.equal(noDate.ok, true, "ต้องบันทึกได้แม้อ่านวันที่ไม่ออก");
assert.equal(L.getTxn(Z, noDate.txnId).occurred_at, null, "ตั้งใจให้ occurred_at เป็น NULL");

const sNo = L.summary(Z, ...monthTh);
assert.equal(sNo.expense_n + sNo.income_n + sNo.unknown_n, 1,
  "สลิปที่ไม่มีวันที่ต้องถูกนับในเดือนที่บันทึก ไม่ใช่หายไปเฉย ๆ");
assert.deepEqual(L.fullRange(Z), [todayTh, todayTh], "สรุปทั้งหมดต้องมองเห็นด้วย");
ok("สลิปที่อ่านวันที่ไม่ออกยังโผล่ในสรุป (ถอยไปใช้วันที่บันทึก)");

// ข. รายการนอกช่วง → การ์ดต้องบอก ไม่ใช่ตอบว่า "ยังไม่มีข้อมูล" เฉย ๆ
const Y = "Uout0000000000000000000000000001";
L.ensureUser(Y, "Y"); L.grantConsent(Y);
L.recordSlip(Y, slip({ date: "2026-05-29", time: "15:00" }), { imageSha256: "y-old" });
const sOut = L.summary(Y, ...monthTh);
assert.equal(sOut.expense_n + sOut.income_n + sOut.unknown_n, 0, "เดือนนี้ต้องว่างจริง");
assert.equal(sOut.outside_n, 1, "ต้องนับรายการนอกช่วงได้");

const cardOut = summaryMessage(Y, "month");
const flat = JSON.stringify(cardOut);
assert.ok(!/ยังไม่มีข้อมูลครับ/.test(flat) || /นอกช่วง/.test(flat),
  "ห้ามตอบแค่ 'ยังไม่มีข้อมูล' ทั้งที่มียอดอยู่นอกช่วง");
assert.ok(/นอกช่วงนี้/.test(flat), "ต้องบอกจำนวนรายการที่อยู่นอกช่วง");
assert.ok(/2026-05-29/.test(flat), "ต้องบอกช่วงวันที่ที่มีข้อมูลจริง");
assert.ok(/act=sum&r=all/.test(flat), "ต้องมีปุ่มไปสรุปทั้งหมด (ไม่ต้องให้ผู้ใช้พิมพ์เอง)");
ok("เดือนนี้ว่างแต่มียอดนอกช่วง → การ์ดบอก + มีปุ่มดูสรุปทั้งหมด");

// ปุ่มนั้นต้องพาไปเจอยอดจริง
// สลิปนี้ทิศทางเป็น 'unknown' (ยังไม่ได้ผูกบัญชี) — ยอดจึงไม่เข้า รับ/จ่าย
// แต่ **ต้องเห็นยอดที่ไหนสักแห่ง** ไม่ใช่การ์ดขึ้น 0.00 ทั้งใบเหมือนเงินหาย
assert.equal(L.summary(Y, ...L.fullRange(Y)).unknown_cents, 88800, "ต้องคิดยอดของ unknown ด้วย");
const cardAll = JSON.stringify(summaryMessage(Y, "all"));
assert.ok(/888\.00/.test(cardAll), "กดสรุปทั้งหมดแล้วต้องเห็นยอด 888.00 ที่ไหนสักแห่ง");
ok("ปุ่ม “ดูสรุปทั้งหมด” พาไปเจอยอดที่หาไม่เจอจริง (รวมยอด unknown)");

// ค. เวลาที่ใช้บันทึกต้องเป็นเวลาไทย ไม่ใช่ UTC
assert.equal(nowLocal().slice(0, 10), todayTh,
  "nowLocal() ต้องให้วันที่ตามเวลาไทย — ถ้าใช้ UTC ช่วงตี 1–7 จะลงเป็นเมื่อวาน");
assert.notEqual(nowLocal(), new Date().toISOString().slice(0, 16).replace("T", " "),
  "ต้องต่างจาก UTC จริง ๆ (ไทย +7)");
ok("บันทึกจากแชทใช้เวลาไทย ไม่ใช่ UTC");

console.log(`\nfeatures.test: ${pass}/${pass} ผ่าน ✅`);
