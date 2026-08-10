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

console.log(`\nwhitelist.test: ${pass}/${pass} ผ่าน ✅`);
