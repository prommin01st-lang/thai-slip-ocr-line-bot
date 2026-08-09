// features.test.js — ฟีเจอร์ที่เพิ่มรอบนี้: แก้/ลบรายการ · ทิศทางจาก quick reply · งบ · แจ้งเตือน
import assert from "node:assert/strict";
import { open, toCents, fromCents, nowLocal } from "../src/db.js";
import * as L from "../src/ledger.js";
import * as N from "../src/notify.js";
import { summaryBubble, txnListBubble, askDirection, txnActions, askPeriod, thaiMonth,
         categoryButtons } from "../src/flex.js";
import { summaryMessage } from "../src/handlers.js";
import { guessCategory, isCategory, labelOf } from "../src/categories.js";
import * as RL from "../src/ratelimit.js";

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
// แจ้งเตือนต้องเป็นการ์ด ไม่ใช่ข้อความล้วน — และ altText ต้องมีตัวเลขครบ
// เพราะนั่นคือสิ่งเดียวที่ผู้ใช้เห็นบน notification ล็อกสกรีน
assert.equal(sentA[0].type, "flex", "แจ้งเตือนงบต้องเป็นการ์ด");
assert.match(sentA[0].altText, /เกิน/, "altText ต้องบอกว่าเกินงบ");
assert.match(sentA[0].altText, /\d/, "altText ต้องมีตัวเลข ไม่ใช่บอกแค่ว่าเกิน");
validate(sentA[0].contents, "budgetAlert");
ok(`เตือนงบเกินได้: "${sentA[0].altText}"`);

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

// เลื่อนเดือนต้องไม่ตันที่เดือนว่าง — ผู้ใช้เจอจริง: กด "เดือนก่อน" ไปเจอเดือนว่าง
// แล้วการ์ดนั้นไม่มีปุ่ม ◀ ▶ ติดมาด้วย เลยเลื่อนต่อไม่ได้ ต้องพิมพ์เองถึงจะออกมาได้
const months = (m) => [...JSON.stringify(summaryMessage(Y, m))
  .matchAll(/act=sum&m=(\d{4}-\d{2})/g)].map((x) => x[1]);
assert.equal(months("month").length, 2, "การ์ดเดือนว่างต้องมีปุ่มเลื่อนทั้งก่อนและถัดไป");
let cur = monthTh[0].slice(0, 7);
for (let i = 0; i < 3; i++) {           // เลื่อนถอยหลัง 3 เดือนรวด ต้องไปต่อได้ทุกครั้ง
  const [prev] = months(cur);
  assert.ok(prev && prev < cur, `เลื่อนจาก ${cur} ต้องได้เดือนก่อนหน้า ไม่ใช่ตัน`);
  cur = prev;
}
assert.equal(months("week").length, 0, "สรุปสัปดาห์ไม่ควรมีปุ่มเลื่อนเดือน (คนละหน่วย)");
ok(`เลื่อนเดือนจากเดือนว่างได้เรื่อย ๆ ไม่ตัน (ถอยถึง ${cur})`);

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

// --- หมวดหมู่: เดาเอง → ผู้ใช้แก้ → จำไว้ → งบรายหมวดทำงาน ---
//
// ก่อนหน้านี้ทั้งเส้นนี้เป็นท่อว่าง: learnCategory() ไม่มีใครเรียก category_hints
// จึงว่างตลอด ทุก txn มี category = NULL งบรายหมวดที่ตั้งไว้ไม่มีวันเตือน
const C = "Ucat0000000000000000000000000001";
L.ensureUser(C, "C"); L.grantConsent(C);

// 1) พจนานุกรมเดาถูก และเลือก "คำที่ยาวที่สุด" ไม่ใช่คำแรกที่เจอ
assert.equal(guessCategory("กาแฟ"), "อาหาร");
assert.equal(guessCategory("ค่าแท็กซี่ไปทำงาน"), "เดินทาง");
assert.equal(guessCategory("ซื้อของ shopee"), "ช้อปปิ้ง");
assert.equal(guessCategory("จ่ายค่าไฟ"), "บิล");
assert.equal(guessCategory("ค่ายา"), "สุขภาพ");
// คำสั้นซ้อนในคำยาวคนละความหมาย — จุดที่ "เอาคำแรกที่เจอ" จะพัง
assert.equal(guessCategory("ค่าน้ำ"), "บิล", "‘ค่าน้ำ’ ต้องเป็นบิล ไม่ใช่อาหารเพราะมี ‘น้ำ’");
assert.equal(guessCategory("เติมน้ำมัน"), "เดินทาง", "‘น้ำมัน’ ต้องชนะ ‘น้ำ’");
assert.equal(guessCategory("น้ำเปล่า"), "อาหาร");
assert.equal(guessCategory("โอนให้แม่"), null, "ไม่รู้จักต้องคืน null ไม่ใช่เดามั่ว");
ok("พจนานุกรมเดาหมวดถูก + คำยาวชนะคำสั้นที่ซ้อนกัน");

// 2) พิมพ์ในแชทแล้วได้หมวดติดมาเลย
const e1 = L.recordEntry(C, { direction: "out", amountCents: 6000, note: "กาแฟ" });
assert.equal(L.getTxn(C, e1.txnId).category, "อาหาร", "ต้องเดาหมวดให้ตั้งแต่ตอนบันทึก");
ok("พิมพ์ “กาแฟ 60” → ได้หมวด 🍜 อาหาร อัตโนมัติ");

// 3) ผู้ใช้กดแก้หมวด → ต้องจำไว้ ครั้งหน้าไม่ต้องกดอีก
assert.equal(L.setCategory(C, e1.txnId, "บันเทิง"), true);
assert.equal(L.getTxn(C, e1.txnId).category, "บันเทิง");
const e2 = L.recordEntry(C, { direction: "out", amountCents: 7000, note: "กาแฟ" });
assert.equal(L.getTxn(C, e2.txnId).category, "บันเทิง",
  "ที่ผู้ใช้เลือกเองต้องชนะพจนานุกรม และต้องจำข้ามรายการ");
ok("กดเลือกหมวดเอง → จำไว้ ครั้งหน้าจัดให้เองโดยไม่ต้องกด");

// 4) พอมีหมวดแล้ว งบรายหมวด + สรุปต้องทำงานจริง (เดิมเป็นไปไม่ได้เลย)
const sc = L.summary(C, ...monthTh);
assert.ok(sc.top_categories.some((c) => c.category === "บันเทิง"),
  "สรุป ‘ใช้มากสุด’ ต้องเห็นหมวดจริง ไม่ใช่ ‘ไม่ระบุ’");
L.setBudget(C, 10000, "บันเทิง");                 // งบ 100 บาท แต่ใช้ไป 130
const bs = L.budgetStatus(C, ...monthTh);
const bEnt = bs.find((b) => b.category === "บันเทิง");
assert.ok(bEnt, "งบรายหมวดต้องถูกตรวจ — เดิมไม่มีรายการไหนมี category เลยจึงไม่มีวันเจอ");
assert.equal(bEnt.used_cents, 13000);
assert.equal(bEnt.over, true, "ใช้ 130 จากงบ 100 → ต้องขึ้นว่าเกิน");
ok(`งบรายหมวดเตือนได้จริงแล้ว (ใช้ ${fromCents(bEnt.used_cents)} / งบ ${fromCents(bEnt.limit_cents)})`);

// งบต้องนับรายการที่ไม่มีวันที่ด้วย ไม่งั้นยอดในการ์ดงบจะไม่ตรงกับยอดในสรุป
const noDateSpend = L.recordSlip(C, slip({ date: null, time: null }),
  { imageSha256: "c-nodate", direction: "out" });
L.setCategory(C, noDateSpend.txnId, "บันเทิง");
assert.equal(L.budgetStatus(C, ...monthTh).find((b) => b.category === "บันเทิง").used_cents,
  13000 + 88800, "รายการที่อ่านวันที่ไม่ออกต้องถูกนับเข้างบด้วย");
ok("งบนับรายการที่ไม่มีวันที่ด้วย — ยอดงบตรงกับยอดสรุป");

// 5) ปุ่มเลือกหมวดต้องไม่โชว์หมวดที่เป็นอยู่แล้ว และ postback ต้องปลอมไม่ได้
const btns = JSON.stringify(categoryButtons(e1.txnId, "อาหาร"));
assert.ok(!/act=cat[^"]*c=%E0%B8%AD%E0%B8%B2%E0%B8%AB%E0%B8%B2%E0%B8%A3(&|")/.test(btns),
  "ไม่ควรมีปุ่มหมวดที่เป็นอยู่แล้ว");
assert.ok(/act=catpick/.test(btns), "ต้องมีปุ่ม ‘หมวดอื่น’ ไปเลือกที่เหลือ");
assert.equal(isCategory("อาหาร"), true);
assert.equal(isCategory("หมวดปลอม"), false, "ต้องปฏิเสธหมวดที่ไม่รู้จัก (postback ปลอมได้)");
ok("ปุ่มเลือกหมวดถูกต้อง + กันหมวดปลอมจาก postback");

// --- ลบแล้วส่งสลิปใบเดิมใหม่ต้องได้ (ผู้ใช้เจอจริง: ลบไปแล้วอัปใหม่ไม่ขึ้น) ---
//
// deleteTxn เป็น soft delete (status='rejected') แถวใน slips ก็ยังอยู่
// ถ้ากันซ้ำไม่กรอง rejected → รายการที่ลบไปแล้วบล็อกการอัปใหม่ตลอดไป
// เงินก้อนนั้นบันทึกไม่ได้อีกเลย แถมบอทตอบว่า "บันทึกไว้เรียบร้อยแล้ว" ซึ่งไม่จริง
const D = "Udup0000000000000000000000000001";
L.ensureUser(D, "D"); L.grantConsent(D);
const dupSlip = slip({ ref: "DUP123456789", amount: "70.00", date: "2026-08-08", time: "16:20" });

const d1 = L.recordSlip(D, dupSlip, { imageSha256: "dup-hash", direction: "out" });
assert.equal(d1.ok, true);

// ยังไม่ลบ → ต้องกันซ้ำได้ทั้ง 3 ชั้น (ของเดิมต้องไม่พัง)
assert.equal(L.findDuplicate(D, { imageSha256: "dup-hash" })?.layer, "image");
assert.equal(L.findDuplicate(D, { ref: "DUP123456789" })?.layer, "ref");
assert.equal(L.findDuplicate(D, { parsed: dupSlip })?.layer, "fuzzy");
assert.equal(L.findDuplicate(D, { imageSha256: "dup-hash" }).txnId, d1.txnId,
  "ต้องบอกได้ว่าซ้ำกับรายการไหน ไม่ใช่แค่บอกว่าซ้ำ");
ok("กันซ้ำ 3 ชั้นยังทำงาน + บอกได้ว่าซ้ำกับรายการไหน");

// ลบแล้ว → ทั้ง 3 ชั้นต้องเลิกบล็อก
L.deleteTxn(D, d1.txnId);
assert.equal(L.findDuplicate(D, { imageSha256: "dup-hash" }), null, "ชั้น image ต้องเลิกบล็อก");
assert.equal(L.findDuplicate(D, { ref: "DUP123456789" }), null, "ชั้น ref ต้องเลิกบล็อก");
assert.equal(L.findDuplicate(D, { parsed: dupSlip }), null, "ชั้น fuzzy ต้องเลิกบล็อก");

const d2 = L.recordSlip(D, dupSlip, { imageSha256: "dup-hash", direction: "out" });
assert.equal(d2.ok, true, "ลบแล้วต้องส่งสลิปใบเดิมเข้ามาใหม่ได้");
assert.notEqual(d2.txnId, d1.txnId);
const sd = L.summary(D, ...monthTh);
assert.equal(sd.expense_cents, 7000, "ยอดต้องกลับมาครบ 70 บาท ไม่เบิ้ลเป็น 140");
ok("ลบแล้วอัปสลิปใบเดิมใหม่ได้ ยอดกลับมาครบและไม่เบิ้ล");

// อัปซ้ำอีกทีทั้งที่ยังไม่ลบ → ต้องกลับมาบล็อกเหมือนเดิม
assert.equal(L.findDuplicate(D, { imageSha256: "dup-hash" })?.txnId, d2.txnId,
  "รายการใหม่ต้องกันซ้ำต่อได้ตามปกติ");
ok("บันทึกใหม่แล้วกันซ้ำกลับมาทำงานเหมือนเดิม");

// --- ทิศทางที่ระบบเดาเองต้องแก้กลับได้ ---
//
// ระบบถาม "รับหรือจ่าย" แค่สลิปใบแรก แล้วจำบัญชีไว้เดาเองตลอด (ตั้งใจให้เป็นแบบนั้น)
// แต่ถ้าเรียนผิดตั้งแต่ใบแรก ใบต่อ ๆ ไปจะผิดหมดโดยไม่ถามอีกเลย
// เดิมการ์ดบันทึกมีปุ่ม รับ/จ่าย เฉพาะตอน direction='unknown' → เดาแล้วแก้ไม่ได้เลย
const A = "Uacct000000000000000000000000001";
L.ensureUser(A, "A"); L.grantConsent(A);
const meSlip = slip({ from: "นาย ทดสอบ ระบบ", to: "ร้านค้า ก" });

// ใบแรก: ไม่รู้จักบัญชีเลย → ต้องถาม
const a1 = L.recordSlip(A, meSlip, { imageSha256: "a-1" });
assert.equal(a1.direction, "unknown", "ใบแรกต้องถาม ไม่ใช่เดา");
L.confirmDirection(A, a1.txnId, "out");
assert.equal(L.getAccounts(A).length, 1, "ตอบแล้วต้องจำบัญชีไว้");

// ใบที่สอง: เดาเองได้ ไม่ถามซ้ำ — นี่คือพฤติกรรมที่ตั้งใจ
const a2 = L.recordSlip(A, slip({ from: "นาย ทดสอบ ระบบ", to: "ร้านค้า ข",
  amount: "123.00", time: "09:00" }), { imageSha256: "a-2" });
assert.equal(a2.direction, "out", "ใบที่สองต้องเดาเองได้ ไม่ต้องถามซ้ำ");
ok("ถามแค่สลิปใบแรก ใบต่อไปเดาเองจากบัญชีที่จำไว้");

// เดาผิดต้องกดกลับได้ — และ **ห้ามเรียนคู่ค้าเป็นบัญชีของผู้ใช้เพิ่ม**
// ถ้าเรียน ทั้งสองฝั่งของสลิปใบหน้าจะแมตช์ แล้วเดาแย่ลงทุกครั้งที่แก้ (ยิ่งแก้ยิ่งพัง)
const fix = L.confirmDirection(A, a2.txnId, "in");
assert.equal(fix.ok, true);
assert.equal(fix.corrected, true, "ต้องรู้ว่านี่คือการแก้ ไม่ใช่การตอบครั้งแรก");
assert.equal(fix.learned, false, "แก้คำตอบต้องไม่เรียนบัญชีใหม่");
assert.equal(L.getTxn(A, a2.txnId).direction, "in", "สลับทิศทางย้อนหลังได้");
assert.equal(L.getAccounts(A).length, 0,
  "ที่เคยเรียนจากสลิปใบนี้ผิด → ต้องถอนออก ไม่ใช่ปล่อยค้างไว้");
ok("เดาผิดแล้วสลับกลับได้ + ถอนบัญชีที่เรียนผิดออก ไม่เรียนคู่ค้าเพิ่ม");

// ล้างเองทั้งหมดก็ต้องได้ ไม่ใช่ต้องลบข้อมูลทิ้งทั้งบัญชี
L.confirmDirection(A, a2.txnId, "out");        // ตอบใหม่ให้มีบัญชีจำไว้อีกรอบ
assert.equal(L.getAccounts(A).length, 0, "แก้ซ้ำก็ยังต้องไม่เรียนเพิ่ม");
L.recordSlip(A, slip({ from: "นาย ทดสอบ ระบบ", to: "ร้านค้า ง", amount: "77.00", time: "13:00" }),
  { imageSha256: "a-4" });
const a4 = L.recentTxns(A, 1)[0];
L.confirmDirection(A, a4.id, "out");            // ใบนี้ระบบถามเพราะไม่รู้ → เรียนได้
const dirBefore = L.recentTxns(A, 50).map((t) => [t.id, t.direction]);
assert.equal(L.forgetAccounts(A), 1);
assert.equal(L.getAccounts(A).length, 0);
const a3 = L.recordSlip(A, slip({ from: "นาย ทดสอบ ระบบ", to: "ร้านค้า ค",
  amount: "456.00", time: "11:00" }), { imageSha256: "a-3" });
assert.equal(a3.direction, "unknown", "ลืมบัญชีแล้วต้องกลับมาถามใหม่");
for (const [id, dir] of dirBefore) {
  assert.equal(L.getTxn(A, id).direction, dir, `รายการ #${id} ที่บันทึกไปแล้วต้องไม่เปลี่ยน`);
}
ok("ลืมบัญชีที่จำไว้ได้ → กลับมาถามใหม่ โดยของเก่าไม่กระทบ");

// --- แจ้งเตือนงบต้องยิงตอนที่ยอด "ข้ามเส้น" จริง ๆ ไม่ใช่เฉพาะตอนบันทึกรายการ ---
//
// ผู้ใช้เจอจริง: ใช้ไป 937 จากงบ 1,000 (94%) แล้วไม่มีอะไรเกิดขึ้นเลย
// เพราะ notifyAfter() ถูกเรียกแค่หลังบันทึกสลิป/พิมพ์รายการ แต่จังหวะที่ข้ามเส้น
// คือตอน "ตั้งงบ" (ใช้ไปแล้ว 94% ค่อยตั้งงบ) และตอน "กดเลือกหมวด"
// (รายการเพิ่งเข้างบหมวดนั้นตอนนั้นเอง) — ทั้งสองทางเดิมเงียบสนิท
const B = "Ubudg000000000000000000000000001";
L.ensureUser(B, "B"); L.grantConsent(B);
const [bf, bt] = N.thisMonth();
// โควตา push เป็นของ **ทั้งแชนแนล** ไม่ใช่รายคน — เทสข้อ 6 ข้างบนเผาจนหมดไปแล้ว
// ถ้าไม่ล้าง เทสนี้จะได้ skipped:"quota" แล้วเข้าใจผิดว่าแจ้งเตือนพัง
L.db().prepare("DELETE FROM push_log").run();

// ใช้เงินก่อน แล้วค่อยตั้งงบ — ลำดับเดียวกับที่ผู้ใช้ทำ
const bx = L.recordEntry(B, { direction: "out", amountCents: 93700, note: "กาแฟ" });
assert.equal(L.getTxn(B, bx.txnId).category, "อาหาร");
assert.equal(L.budgetStatus(B, bf, bt).length, 0, "ยังไม่ตั้งงบ ต้องไม่มีอะไรให้เตือน");

L.setBudget(B, 100000, "อาหาร");                       // งบ 1,000 ใช้ไป 937 = 94%
const bstat = L.budgetStatus(B, bf, bt).find((s) => s.category === "อาหาร");
assert.ok(bstat, "94% ต้องเข้าเกณฑ์เตือน (warnAt = 80%)");
assert.equal(bstat.over, false, "94% ยังไม่เกิน — ต้องเป็นเตือนแบบ ‘ใกล้เต็ม’");
assert.equal(Math.round(bstat.ratio * 100), 94);

const sentBudget = [];
const rBudget = await N.checkAlerts(B, (m) => { sentBudget.push(m); });
assert.equal(rBudget.sent, 1, `ต้องเตือน 1 ข้อความ (ได้ ${JSON.stringify(rBudget)})`);
assert.equal(sentBudget[0].type, "flex", "ต้องเป็นการ์ด");
assert.match(sentBudget[0].altText, /ใกล้เต็ม/, "ต้องบอกว่าใกล้เต็ม ไม่ใช่บอกว่าเกิน");
assert.match(sentBudget[0].altText, /937\.00 \/ 1,000\.00/, "ต้องบอกตัวเลขจริง");
assert.equal(sentBudget[0].contents.header.contents[0].text.includes("ใกล้เต็ม"), true);
ok(`เตือนตอนใกล้เต็ม (การ์ด): "${sentBudget[0].altText}"`);

// พอเกินจริง ต้องเตือนอีกครั้ง — คนละชนิดกับ 'ใกล้เต็ม' จึงไม่ถูกกันซ้ำ
L.recordEntry(B, { direction: "out", amountCents: 20000, note: "กาแฟ" });
const sentOver = [];
await N.checkAlerts(B, (m) => { sentOver.push(m); });
assert.equal(sentOver.length, 1, "ใกล้เต็มแล้วเกิน ต้องเตือนได้อีกครั้ง");
assert.match(sentOver[0].altText, /เกินแล้ว/);
assert.equal(sentOver[0].type, "flex");
ok(`เตือนซ้ำตอนเกินจริง (การ์ด): "${sentOver[0].altText}"`);

// แต่เรียกซ้ำสถานะเดิมต้องไม่ spam (โควตา push มีแค่ 300/เดือน)
const sentAgain = [];
await N.checkAlerts(B, (m) => { sentAgain.push(m); });
assert.equal(sentAgain.length, 0, "สถานะเดิมต้องไม่เตือนซ้ำ");
ok("สถานะเดิมไม่เตือนซ้ำ — ไม่เปลืองโควตา push");

// --- rate limit ต่อผู้ใช้ ---
//
// queue.js คุม "ความพร้อมกัน" แต่ไม่ได้คุม "อัตรา" — คนเดียวยิงรูป 20 ใบยังเข้าคิวได้ครบ
// แล้วยึด VPS 2 cores ไป ~3 นาที (OCR ใบละ ~8.5 วิ) ต้องปฏิเสธตั้งแต่ต้นทาง
const R = "Urate000000000000000000000000001";
RL._reset();
const T0 = 1_000_000;                      // ฉีดเวลาเอง ไม่ต้องรอจริง

// รูป: รัวได้ 3 ใบ ใบที่ 4 ต้องโดนกั้น
for (let i = 1; i <= 3; i++) {
  assert.equal(RL.take(R, "image", T0).ok, true, `ใบที่ ${i} ต้องผ่าน`);
}
const blocked = RL.take(R, "image", T0);
assert.equal(blocked.ok, false, "ใบที่ 4 ต้องโดนกั้น");
assert.ok(blocked.retryInSec > 0 && blocked.retryInSec <= 20,
  `ต้องบอกด้วยว่ารออีกกี่วินาที (ได้ ${blocked.retryInSec})`);
ok(`ยิงรูปรัว → ผ่าน 3 ใบ ใบที่ 4 ถูกกั้น (ลองใหม่ใน ${blocked.retryInSec} วิ)`);

// รอครบเวลาแล้วต้องได้คืนทีละใบ ไม่ใช่คืนเต็มถังทันที
assert.equal(RL.take(R, "image", T0 + 20_000).ok, true, "ผ่านไป 20 วิ ต้องได้คืน 1 ใบ");
assert.equal(RL.take(R, "image", T0 + 20_000).ok, false, "แต่ต้องได้คืนแค่ใบเดียว");
ok("สิทธิ์คืนทีละใบตามเวลา ไม่ใช่คืนเต็มถังพรวดเดียว");

// ข้อความถูกจำกัดคนละถังกับรูป — ส่งรูปเยอะไม่ควรทำให้พิมพ์ “สรุป” ไม่ได้
RL._reset();
for (let i = 0; i < 3; i++) RL.take(R, "image", T0);
assert.equal(RL.take(R, "image", T0).ok, false, "รูปเต็มโควตาแล้ว");
assert.equal(RL.take(R, "msg", T0).ok, true, "แต่ข้อความต้องยังส่งได้");
ok("รูปกับข้อความแยกถังกัน — ส่งรูปเยอะแล้วยังพิมพ์คำสั่งได้");

// แยกตามผู้ใช้ — คนหนึ่งยิงรัวต้องไม่ทำให้อีกคนใช้ไม่ได้
const R2 = "Urate000000000000000000000000002";
assert.equal(RL.take(R2, "image", T0).ok, true, "ผู้ใช้อีกคนต้องไม่ถูกกระทบ");
ok("จำกัดแยกรายคน ไม่ใช่โควตารวม");

// ไม่มี userId (กลุ่ม/ห้อง) → ไม่จำกัด ไม่งั้นจะบล็อกกันเองทั้งห้อง
for (let i = 0; i < 50; i++) assert.equal(RL.take(null, "image", T0).ok, true);
ok("ไม่มี userId → ไม่จำกัด (กลุ่ม/ห้องแชท)");

// --- แก้หมวดย้อนหลังจาก "รายการ" ---
//
// หมวดถูกเดาให้ตอนบันทึก ถ้าเดาผิดหรือยังไม่ได้จัด ต้องแก้จากรายการได้
// ไม่งั้นทางเดียวคือลบทิ้งแล้วบันทึกใหม่ ซึ่งเสียทั้งวันที่และเลขรายการเดิม
const E2 = "Ucatedit0000000000000000000001";
L.ensureUser(E2, "E"); L.grantConsent(E2);
const ce1 = L.recordEntry(E2, { direction: "out", amountCents: 12000, note: "กาแฟ" });
const ce2 = L.recordEntry(E2, { direction: "in", amountCents: 50000, note: "เงินเดือน" });
assert.equal(L.getTxn(E2, ce1.txnId).category, "อาหาร", "เดาหมวดให้ตอนบันทึก");

const listJson = JSON.stringify(txnListBubble(L.recentTxns(E2, 10), fromCents));
assert.ok(listJson.includes(`act=catpick&id=${ce1.txnId}`),
  "รายจ่ายต้องมีปุ่มเปลี่ยนหมวดในรายการ");
assert.ok(!listJson.includes(`act=catpick&id=${ce2.txnId}`),
  "รายรับไม่ควรมีปุ่มหมวด — หมวดมีไว้คุมรายจ่าย");
ok("รายการล่าสุดมีปุ่มแก้หมวด (เฉพาะรายจ่าย)");

// แก้แล้วต้องเปลี่ยนจริง และจำไว้ใช้ครั้งหน้า
assert.equal(L.setCategory(E2, ce1.txnId, "บันเทิง"), true);
assert.equal(L.getTxn(E2, ce1.txnId).category, "บันเทิง", "หมวดต้องเปลี่ยนจริง");
assert.equal(L.getTxn(E2, ce1.txnId).amount_cents, 12000, "ยอดต้องไม่ถูกแตะ");
const ce3 = L.recordEntry(E2, { direction: "out", amountCents: 8000, note: "กาแฟ" });
assert.equal(L.getTxn(E2, ce3.txnId).category, "บันเทิง", "ที่แก้ไว้ต้องถูกใช้กับรายการถัดไป");
ok("แก้หมวดย้อนหลัง → เปลี่ยนจริง ยอดไม่กระทบ และจำไว้ใช้ครั้งหน้า");

// ยังไม่มีหมวด → ปุ่มต้องเป็นสีเหลืองให้เห็นว่ายังค้าง
// ป้ายข้อความบอกไม่ได้แล้วเพราะปุ่มเหลือแต่ไอคอน สีจึงเป็นตัวเดียวที่สื่อ
const ce4 = L.recordEntry(E2, { direction: "out", amountCents: 9900, note: "อะไรก็ไม่รู้" });
assert.equal(L.getTxn(E2, ce4.txnId).category, null, "คำที่ไม่รู้จักต้องไม่เดามั่ว");
const chipBgOf = (txn) => {
  const b = txnListBubble([txn], fromCents).contents.body.contents
    .find((c) => c.type === "box").contents[1].contents[1].contents
    .find((x) => x.contents?.[0]?.text === "📂");
  return b?.backgroundColor;
};
assert.equal(chipBgOf(L.getTxn(E2, ce4.txnId)), "#FBF0DA", "ยังไม่มีหมวด → ปุ่มสีเหลือง");
assert.equal(chipBgOf(L.getTxn(E2, ce1.txnId)), "#F0EDE8", "มีหมวดแล้ว → ปุ่มสีปกติ");
ok("ปุ่มหมวดเป็นสีเหลืองเมื่อยังไม่ได้จัดหมวด");

// --- ปุ่มท้ายแถว + กรองรายการ ---
//
// ก่อนหน้านี้ปุ่มเป็น `button` มีป้ายข้อความ วาง 3 อันแล้วโดนตัดเหลือ "✏️ แ…" / "📂 เป…"
// เปลี่ยนเป็น box ไอคอนท้ายแถวแทน — ทุกแถวต้องมี 3 ช่องเท่ากันเพื่อให้ไอคอนตรงคอลัมน์
const F = "Ufilter00000000000000000000001";
L.ensureUser(F, "F"); L.grantConsent(F);
const f1 = L.recordEntry(F, { direction: "out", amountCents: 12000, note: "กาแฟ" });      // อาหาร
const f2 = L.recordEntry(F, { direction: "out", amountCents: 25000, note: "แท็กซี่" });   // เดินทาง
const f3 = L.recordEntry(F, { direction: "in", amountCents: 500000, note: "เงินเดือน" });
const f4 = L.recordEntry(F, { direction: "out", amountCents: 7700, note: "จิปาถะ" });     // ไม่มีหมวด

const rowBoxes = (bubble) => bubble.contents.body.contents.filter((c) => c.type === "box");
const allRows = rowBoxes(txnListBubble(L.recentTxns(F, 10), fromCents));
assert.equal(allRows.length, 4, "ต้องเห็นครบ 4 รายการ");
for (const r of allRows) {
  assert.equal(r.contents[1].contents[1].contents.length, 3,
    "ทุกแถวต้องมีปุ่ม 3 ช่อง (เติม filler ถ้าใช้ไม่ครบ) ไอคอนจะได้ตรงคอลัมน์กัน");
}
// ไม่มี `button` ในตัวรายการอีกแล้ว — ป้ายที่ถูกตัดคือเหตุผลที่เปลี่ยน
assert.ok(!JSON.stringify(allRows).includes('"type":"button"'),
  "ปุ่มในแถวต้องเป็น box ไม่ใช่ button (button padding เยอะจนป้ายโดนตัด)");
ok("ปุ่มย้ายไปท้ายแถวเป็นไอคอน 3 ช่องเท่ากันทุกแถว");

assert.equal(L.recentTxns(F, 10, { direction: "out" }).length, 3, "กรองรายจ่ายได้ 3");
assert.equal(L.recentTxns(F, 10, { direction: "in" }).length, 1, "กรองรายรับได้ 1");
assert.equal(L.recentTxns(F, 10, { category: "อาหาร" })[0].id, f1.txnId, "กรองตามหมวดได้");
assert.equal(L.recentTxns(F, 10, { category: "-" })[0].id, f4.txnId, "กรอง ‘ยังไม่จัดหมวด’ ได้");
assert.equal(L.countTxns(F), 4, "นับทั้งหมดได้");
assert.equal(L.countTxns(F, { direction: "out" }), 3, "นับตามตัวกรองได้");
ok("กรองรายการตามรับ/จ่าย · ตามหมวด · เฉพาะที่ยังไม่จัดหมวด");

// ลบแล้วต้องหายจากทั้งรายการและตัวนับ — ไม่งั้นจะขึ้น "แสดง 3 จาก 4" ทั้งที่เหลือ 3
L.deleteTxn(F, f3.txnId);
assert.equal(L.countTxns(F), 3, "ลบแล้วตัวนับต้องลด");
assert.equal(L.countTxns(F, { direction: "in" }), 0, "รายรับที่ลบไปต้องไม่ถูกนับ");
ok("ตัวนับกับรายการใช้เงื่อนไขเดียวกัน — ลบแล้วตรงกันทั้งคู่");

// กรองแล้วไม่เจอ ≠ ยังไม่เคยบันทึกอะไร — ต้องมีทางถอยกลับเสมอ ไม่ใช่การ์ดสอนใช้งาน
const emptyFiltered = txnListBubble([], fromCents, { cat: "สุขภาพ" });
const ejson = JSON.stringify(emptyFiltered);
assert.ok(ejson.includes("ไม่พบรายการ"), "ต้องบอกว่าไม่พบ ไม่ใช่ ‘ยังไม่มีรายการ’");
assert.ok(ejson.includes('"act=list"'), "ต้องมีปุ่มถอยกลับไปดูทั้งหมด");
assert.ok(!ejson.includes("ส่งรูปสลิปเข้ามา"), "อย่าโชว์การ์ดสอนใช้งาน — ผู้ใช้มีข้อมูลอยู่แล้ว");
// ไม่ได้กรอง + ไม่มีข้อมูลจริง → อันนี้ค่อยสอนใช้งาน
assert.ok(JSON.stringify(txnListBubble([], fromCents)).includes("ยังไม่มีรายการ"),
  "ไม่มีข้อมูลจริง ๆ ต้องได้การ์ดเริ่มต้นใช้งาน");
ok("กรองแล้วว่าง ≠ ยังไม่มีข้อมูล — การ์ดคนละใบและมีทางถอยกลับ");

// การ์ดต้องบอกตรง ๆ ว่าที่เห็นเป็นแค่บางส่วน ไม่งั้นผู้ใช้นึกว่ามีเท่านี้
const capped = txnListBubble(L.recentTxns(F, 2), fromCents, { total: L.countTxns(F) });
assert.ok(JSON.stringify(capped).includes("แสดง 2 จาก 3 รายการ"),
  "แสดงไม่ครบต้องบอกจำนวนจริง");
assert.ok(!JSON.stringify(txnListBubble(L.recentTxns(F, 10), fromCents,
  { total: L.countTxns(F) })).includes("แสดง 3 จาก"), "ครบแล้วไม่ต้องบอก");
ok("บอกจำนวนจริงเมื่อการ์ดแสดงไม่ครบ");

// หัวการ์ดกับ altText ต้องบอกว่ากรองอะไรอยู่ — altText คือสิ่งเดียวที่เห็นบนหน้าจอล็อก
const filtered = txnListBubble(L.recentTxns(F, 10, { direction: "out" }), fromCents,
                               { dir: "out", total: 3 });
assert.ok(filtered.contents.header.contents[0].text.includes("รายจ่าย"), "หัวการ์ดต้องบอกตัวกรอง");
assert.ok(filtered.altText.includes("รายจ่าย"), "altText ต้องบอกตัวกรอง");
ok("หัวการ์ดและ altText บอกว่ากำลังกรองอะไรอยู่");

// --- "รายการรอตรวจ" ต้องหาเจอและปิดได้ ---
//
// pending = ระบบไม่มั่นใจตอนบันทึก (OCR อ่านไม่ชัด หรือเดาทิศทางเอง)
// เดิมการ์ดสรุปบอกแค่ "1 รายการรอตรวจยอด" แล้วจบ — ไม่รู้ว่ารายการไหน
// ไม่มีปุ่มพาไป และถ้ายอดถูกอยู่แล้วก็ไม่มีทางปิดสถานะเลย
const PU = "Upending0000000000000000000001";
L.ensureUser(PU, "P"); L.grantConsent(PU);
const pOld = L.recordEntry(PU, { direction: "out", amountCents: 5000, note: "กาแฟ", guessed: true },
                           { occurredAt: "2020-01-15 10:00" });
const pNow = L.recordEntry(PU, { direction: "out", amountCents: 7000, note: "ชานม", guessed: true });
const pOk = L.recordEntry(PU, { direction: "out", amountCents: 9000, note: "ข้าว" });
assert.equal(L.getTxn(PU, pNow.txnId).status, "pending", "เดาทิศทางเอง → pending");
assert.equal(L.getTxn(PU, pOk.txnId).status, "confirmed", "รู้ทิศทางชัด → confirmed");

// นับเฉพาะช่วงที่สรุปอยู่ — เดิมนับทั้งชีวิต ทำให้เตือนถึงรายการคนละเดือนที่กดไปก็ไม่เจอ
const [mFrom, mTo] = N.thisMonth();
assert.equal(L.summary(PU, mFrom, mTo).pending_n, 1, "เดือนนี้มีรอตรวจ 1 (ไม่รวมของปี 2020)");
assert.equal(L.summary(PU, "2020-01-01", "2020-01-31").pending_n, 1, "ย้อนไปดูเดือนนั้นก็เจอของมัน");
ok("นับรายการรอตรวจตามช่วงวันที่ของสรุป ไม่ใช่ทั้งชีวิต");

// การ์ดสรุปต้องมีปุ่มพาไปดู ไม่ใช่ข้อความลอย ๆ
const sumJson = JSON.stringify(summaryBubble({ ...L.summary(PU, mFrom, mTo), title: "x" }, fromCents));
assert.ok(sumJson.includes("act=list&s=pending"), "ต้องมีปุ่มพาไปดูรายการที่ต้องตรวจ");
assert.ok(sumJson.includes("ระบบไม่มั่นใจ"), "ต้องอธิบายว่ามันคืออะไร ไม่ใช่แค่ ‘รอตรวจยอด’");
ok("การ์ดสรุปอธิบายและมีปุ่มพาไปดูรายการที่ต้องตรวจ");

// กรองเฉพาะรอตรวจได้ และแถวนั้นต้องมีปุ่มยืนยัน
assert.equal(L.recentTxns(PU, 10, { status: "pending" }).length, 2, "กรองรอตรวจได้ทั้ง 2 ใบ");
assert.equal(L.countTxns(PU, { status: "pending" }), 2);
const pList = JSON.stringify(txnListBubble(L.recentTxns(PU, 10, { status: "pending" }), fromCents,
                                           { pending: true, total: 2 }));
assert.ok(pList.includes(`act=ok&id=${pNow.txnId}`), "แถวรอตรวจต้องมีปุ่ม ✅ ยืนยัน");
assert.ok(pList.includes("📝 รอตรวจ"), "ต้องติดป้ายให้เห็นว่าแถวไหนคือตัวที่เตือนถึง");
assert.ok(!JSON.stringify(txnListBubble([L.getTxn(PU, pOk.txnId)], fromCents)).includes("act=ok&id="),
  "แถวที่ยืนยันแล้วไม่ต้องมีปุ่มนี้");
ok("กรองเฉพาะรอตรวจได้ + แถวติดป้ายและมีปุ่มยืนยัน");

// ปิดสถานะได้โดยไม่ต้องแก้ยอด — นี่คือทางออกที่เดิมไม่มี
const amtBefore = L.getTxn(PU, pNow.txnId).amount_cents;
assert.equal(L.confirmTxn(PU, pNow.txnId), true, "ยืนยันได้");
assert.equal(L.getTxn(PU, pNow.txnId).status, "confirmed");
assert.equal(L.getTxn(PU, pNow.txnId).amount_cents, amtBefore, "ยอดต้องไม่ถูกแตะ");
assert.equal(L.confirmTxn(PU, pNow.txnId), false, "ยืนยันซ้ำต้องไม่นับเพิ่ม");
assert.equal(L.summary(PU, mFrom, mTo).pending_n, 0, "เตือนบนการ์ดสรุปต้องหายไป");
assert.ok(!JSON.stringify(summaryBubble({ ...L.summary(PU, mFrom, mTo), title: "x" }, fromCents))
  .includes("act=list&s=pending"), "ไม่เหลือรอตรวจแล้ว ปุ่มต้องหายด้วย");
ok("ยืนยันว่ายอดถูกได้โดยไม่ต้องแก้อะไร → เตือนหายจากการ์ดสรุป");

console.log(`\nfeatures.test: ${pass}/${pass} ผ่าน ✅`);
