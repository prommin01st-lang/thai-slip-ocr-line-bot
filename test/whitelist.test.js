// whitelist.test.js — ALLOWED_USERS กั้นคนนอกได้จริงหรือเปล่า
//
// ต้องเป็นไฟล์แยก เพราะ config.js อ่าน process.env ตอน import ครั้งเดียว
// จะสลับโหมด "เปิด/ปิด" ในไฟล์เดียวกันไม่ได้ ต้องตั้ง env ก่อน import เท่านั้น
import assert from "node:assert/strict";
import { open } from "../src/db.js";
import * as L from "../src/ledger.js";

const ME = "Uwhitelist00000000000000000001";
const FRIEND = "Uwhitelist00000000000000000003";
const OUTSIDER = "Uwhitelist00000000000000000002";

process.env.LINE_CHANNEL_SECRET ||= "test-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN ||= "test-token";
// เว้นวรรครอบจุลภาคแบบที่คนพิมพ์จริง — ต้องรับได้
process.env.ALLOWED_USERS = `${ME}, ${FRIEND}`;
// แยก ADMIN_USERS ออกมา เพื่อให้มีเคส "มีสิทธิ์ใช้ แต่ไม่ใช่แอดมิน" (FRIEND)
// ถ้าไม่ตั้ง ADMIN_USERS จะถอยไปใช้ ALLOWED_USERS ทั้งก้อน ทุกคนก็เป็นแอดมินหมด
process.env.ADMIN_USERS = ME;

L.setDb(open(":memory:"));
const { handleEvent } = await import("../src/handlers.js");

let pass = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };

// token ปลอม → ส่งข้อความจริงไม่ได้ (401) ซึ่งไม่เกี่ยวกับสิ่งที่กำลังทดสอบ
// สนใจแค่ว่า "คนนอกไปถึง ensureUser ไหม" จึงกลืน error ตอนตอบทิ้ง
const fire = async (event) => { try { await handleEvent(event); } catch { /* ส่งไม่ออก */ } };
const msg = (userId, text = "ช่วยเหลือ") => ({
  type: "message", message: { type: "text", text }, source: { userId }, replyToken: null,
});

// คนนอกต้องถูกกั้น **ก่อนแตะ DB** — ไม่ใช่แค่ไม่ตอบ
// ถ้ามีแถวโผล่มา แปลว่าคนนอกทำให้ DB โตได้ แม้จะใช้งานอะไรไม่ได้ก็ตาม
await fire(msg(OUTSIDER));
assert.equal(L.getUser(OUTSIDER), null, "คนนอกต้องไม่ถูกสร้างแถวใน users");
ok("คนนอกถูกกั้นตั้งแต่ก่อนเขียน DB");

await fire(msg(ME));
assert.ok(L.getUser(ME), "คนใน whitelist ต้องใช้งานได้ตามปกติ");
ok("คนใน whitelist ใช้งานได้ปกติ");

// หลายคนพร้อมกัน + เว้นวรรครอบจุลภาค
await fire(msg(FRIEND));
assert.ok(L.getUser(FRIEND), "คนที่สองใน ALLOWED_USERS ก็ต้องใช้ได้");
ok("ใส่ได้หลายคน คั่นจุลภาค เว้นวรรคได้");

// คนนอกต้องได้ ID ของตัวเองกลับไป เพื่อส่งให้เจ้าของบอทขอสิทธิ์เอง
// ไม่งั้นการเพิ่มคนใหม่ต้องให้เจ้าของ ssh เข้าไปอ่าน log ทุกครั้ง
//
// ดักที่ fetch เพื่ออ่านสิ่งที่ถูกส่งออกจริง — token ในเทสเป็นของปลอม
// ถ้าไม่ดัก SDK จะโยน 401 ก่อนที่จะได้เห็นเนื้อข้อความ
const posted = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  posted.push(opts?.body ? JSON.parse(opts.body) : null);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
await handleEvent({ type: "message", message: { type: "text", text: "หวัดดี" },
                    source: { userId: OUTSIDER }, replyToken: "tok" });
globalThis.fetch = realFetch;

assert.equal(posted.length, 1, "ต้องตอบครั้งเดียว (reply เดียว หลายข้อความ)");
const msgs = posted[0].messages;
assert.equal(msgs.length, 2, "การ์ด + ข้อความ ID");
assert.equal(msgs[0].type, "flex");
assert.ok(JSON.stringify(msgs[0]).includes("บอทส่วนตัว"), "ใบแรกต้องเป็นการ์ดแจ้งเตือน");

// ใบที่สองต้องเป็น ID ล้วน ๆ — ตัวอักษรใน Flex คัดลอกไม่ได้
// และถ้ามีคำอธิบายปนมาด้วย กดคัดลอกแล้วจะได้ขยะติดมา ต้องมาตัดเองอีก
assert.equal(msgs[1].type, "text", "ใบที่สองต้องเป็นข้อความธรรมดา ไม่ใช่ Flex");
assert.equal(msgs[1].text, OUTSIDER, "ต้องเป็น ID ล้วน ๆ ไม่มีอะไรปน (คัดลอกแล้ววางได้เลย)");

const body = JSON.stringify(posted[0]);
assert.ok(!body.includes(ME) && !body.includes(FRIEND), "ห้ามหลุด ID ของคนอื่นออกไป");
ok("คนนอกได้ ID ล้วน ๆ เป็นข้อความธรรมดา คัดลอกได้ทันที");

// follow ก็ต้องกั้น ไม่งั้นคนนอกแอดบอทแล้วยังได้การ์ดขอความยินยอม
await fire({ type: "follow", source: { userId: OUTSIDER }, replyToken: null });
assert.equal(L.getUser(OUTSIDER), null, "follow ของคนนอกต้องไม่สร้างแถว");
ok("คนนอกแอดบอท (follow) ก็ยังถูกกั้น");

// แชทกลุ่มไม่มี userId → ต้องกั้น บอทส่วนตัวไม่ควรทำงานในกลุ่ม
await fire({ type: "message", message: { type: "text", text: "สรุป" },
             source: { type: "group", groupId: "Gxxxx" }, replyToken: null });
ok("แชทกลุ่ม/ห้อง (ไม่มี userId) ถูกกั้น");

// รูปแพงที่สุด (OCR ~8.5 วิ) — ต้องไม่มีทางเข้าคิวได้เลย
const { depth } = await import("../src/queue.js");
await fire({ type: "message", message: { type: "image", id: "1" },
             source: { userId: OUTSIDER }, replyToken: null });
assert.equal(depth(), 0, "รูปจากคนนอกต้องไม่เข้าคิว OCR");
ok("รูปจากคนนอกไม่เข้าคิว OCR");

// --- ขอสิทธิ์ / แอดมินอนุมัติจากในแชท ---
//
// เดิมเพิ่มคนต้องแก้ .env แล้ว `up -d` ใหม่ทุกครั้ง ตาราง access ทำให้อนุมัติในแชทได้
const outbox = [];
globalThis.fetch = async (u, o) => {
  outbox.push({ url: String(u), body: o?.body ? JSON.parse(o.body) : null });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
/** ข้อความที่ถูกส่งออกตั้งแต่ครั้งก่อนที่เรียก แล้วล้างกล่อง */
const grab = () => outbox.splice(0);
const pushes = (list) => list.filter((s) => s.url.includes("/push"));

// 1) คนนอกกดขอสิทธิ์ → บันทึกคำขอ + แจ้งแอดมิน
grab();
await handleEvent({ type: "postback", postback: { data: "act=req" },
                    source: { userId: OUTSIDER }, replyToken: "t" });
let sent = grab();
assert.equal(L.accessStatus(OUTSIDER), "pending", "ต้องบันทึกคำขอเป็น pending");
assert.ok(sent.some((s) => s.url.includes("/push") && s.body?.to === ME),
  "ต้อง push แจ้งแอดมิน");
ok("คนนอกกดขอสิทธิ์ → บันทึกคำขอ + แจ้งแอดมิน");

// 2) กดขอซ้ำต้องไม่ push ซ้ำ — คนเดียวเผาโควตา 300/เดือนหมดได้
grab();
await handleEvent({ type: "postback", postback: { data: "act=req" },
                    source: { userId: OUTSIDER }, replyToken: "t" });
assert.equal(pushes(grab()).length, 0,
  "กดขอซ้ำต้องไม่ push แจ้งแอดมินอีก");
ok("กดขอซ้ำไม่ push ซ้ำ — ไม่เผาโควตา");

// 3) คนที่ไม่ใช่แอดมินยิง postback อนุมัติเองไม่ได้ ← ช่องโหว่ที่ร้ายที่สุด
await handleEvent({ type: "postback", postback: { data: `act=acc&v=ok&u=${OUTSIDER}` },
                    source: { userId: OUTSIDER }, replyToken: "t" });
assert.equal(L.accessStatus(OUTSIDER), "pending", "คนนอกอนุมัติตัวเองไม่ได้");
await handleEvent({ type: "postback", postback: { data: `act=acc&v=ok&u=${OUTSIDER}` },
                    source: { userId: FRIEND }, replyToken: "t" });
assert.equal(L.accessStatus(OUTSIDER), "pending", "คนที่มีสิทธิ์แต่ไม่ใช่แอดมินก็อนุมัติไม่ได้");
ok("อนุมัติได้เฉพาะแอดมิน — ยิง postback เองไม่ผ่าน");

// 4) แอดมินอนุมัติ → ใช้งานได้ทันที ไม่ต้อง restart
grab();
await handleEvent({ type: "postback", postback: { data: `act=acc&v=ok&u=${OUTSIDER}` },
                    source: { userId: ME }, replyToken: "t" });
sent = grab();
assert.equal(L.accessStatus(OUTSIDER), "approved");
assert.ok(sent.some((s) => s.url.includes("/push") && s.body?.to === OUTSIDER),
  "ต้องแจ้งผลกลับไปหาเจ้าตัว");
await fire(msg(OUTSIDER));
assert.ok(L.getUser(OUTSIDER), "อนุมัติแล้วต้องใช้งานได้ทันที");
ok("แอดมินอนุมัติ → ใช้ได้ทันที ไม่ต้องแก้ .env / restart");

// 5) ปฏิเสธแล้วขอใหม่ไม่ได้ — ไม่งั้นสแปมแอดมินได้ไม่รู้จบ
const SPAM = "Uwhitelist00000000000000000009";
L.requestAccess(SPAM);
L.decideAccess(SPAM, "rejected", ME);
grab();
await handleEvent({ type: "postback", postback: { data: "act=req" },
                    source: { userId: SPAM }, replyToken: "t" });
assert.equal(pushes(grab()).length, 0,
  "คนที่ถูกปฏิเสธกดขอใหม่ต้องไม่ไปกวนแอดมิน");
assert.equal(L.accessStatus(SPAM), "rejected", "สถานะต้องไม่ถูกรีเซ็ตกลับเป็น pending");
ok("ถูกปฏิเสธแล้วขอซ้ำไม่ได้ — กันสแปมแอดมิน");

console.log(`\nwhitelist.test: ${pass}/${pass} ผ่าน ✅`);
