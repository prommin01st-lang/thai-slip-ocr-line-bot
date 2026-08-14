// handlers.js — ตรรกะตอบกลับแต่ละ event จาก LINE
//
// จังหวะที่สำคัญที่สุด: OCR ใช้เวลาหลายวินาทีและเข้าคิว → **ห้ามทำใน request ของ webhook**
// index.js ตอบ 200 ให้ LINE ทันทีแล้วค่อยเรียกที่นี่แบบ background.
//
// reply token ใช้ได้ครั้งเดียวและหมดอายุเร็ว — ถ้าคิวยาว token อาจตายก่อน OCR เสร็จ
// จึงใช้ "reply ก่อน ถ้าพังค่อย push" (push มีโควตาแค่ 300/เดือน เลยไม่ใช้เป็นค่าเริ่มต้น)
//
// **ทุกคำตอบเป็นการ์ด (Flex) ไม่ใช่ข้อความเปล่า** — ใช้ `card()` จาก flex.js
import { messagingApi } from "@line/bot-sdk";
import { config } from "./config.js";
import * as ocr from "./ocrClient.js";
import * as L from "./ledger.js";
import { enqueue, ahead } from "./queue.js";
import { take } from "./ratelimit.js";
import { collect } from "./batch.js";
import { resultMessage, errorMessage, card, askDirection, askPeriod, thaiMonth,
         summaryBubble, txnListBubble, categoryButtons, categoryPickerBubble,
         shiftMonth, sheetGuideMessage } from "./flex.js";
import { labelOf, isCategory } from "./categories.js";
import { parseSheetId } from "./sheets.js";
import { syncNow } from "./sheetSync.js";
import { parseBill, MAX_ROWS } from "./billText.js";
import * as pending from "./pending.js";
import { parseEntries } from "./nlu.js";
import { nowLocal } from "./db.js";
import { checkAlerts, thisMonth, thisWeek, quota } from "./notify.js";

const client = new messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken });
const blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: config.channelAccessToken });

const DIR_LABEL = { in: "รายรับ", out: "รายจ่าย", unknown: "ยังไม่ระบุ" };

// ---------- การ์ดที่ใช้ซ้ำ ----------

const helpCard = () => card({
  title: "SlipingMan", emoji: "🧾", tone: "info",
  text: "ส่งรูปสลิป ใบเสร็จ หรือใบเงินเดือนเข้ามาได้เลย (ทีละหลายใบก็ได้)\nหรือพิมพ์สั้น ๆ เช่น “กาแฟ 60”",
  rows: [
    { label: "จดรายจ่าย", value: "พิมพ์ “กาแฟ 60”" },
    { label: "หลายรายการ", value: "พิมพ์ “กาแฟ 60, ข้าว 50”" },
    { label: "จดรายรับ", value: "พิมพ์ “ได้เงินเดือน 30000”" },
    { label: "ส่งเป็นไฟล์", value: "PDF · CSV · TXT ก็อ่านให้ได้" },
    { label: "อย่างอื่น", value: "กดปุ่มด้านล่าง / เมนูล่างจอ" },
  ],
  actions: [
    { label: "📊 สรุปเดือนนี้", data: "act=summary", primary: true },
    { label: "🧾 รายการล่าสุด", data: "act=list" },
    { label: "⚙️ ตั้งค่า", data: "act=settings" },
  ],
  altText: "วิธีใช้ SlipingMan",
});

const consentCard = (lead) => card({
  title: "ขอความยินยอมก่อนเริ่ม", emoji: "🔒", tone: "info",
  text: (lead ? lead + "\n\n" : "") +
        "ระบบจะเก็บ: ยอดเงิน วันเวลา เลขอ้างอิง ชื่อคู่ค้า และเลขบัญชี 4 ตัวท้าย",
  rows: [
    { label: "ไม่เก็บ", value: "รูปสลิป (เก็บแค่ลายนิ้วมือไฟล์กันบันทึกซ้ำ)" },
    { label: "ลบได้", value: "ตลอดเวลา ด้วย “ลบข้อมูลของฉัน”" },
  ],
  actions: [{ label: "✅ ยินยอม เริ่มใช้งาน", text: "ยินยอม", primary: true }],
  altText: "ขอความยินยอมก่อนเก็บข้อมูล",
});

const notFoundCard = (id) => card({
  title: `ไม่พบรายการ #${id}`, emoji: "❓", tone: "warn",
  text: "อาจถูกลบไปแล้วครับ",
  actions: [{ label: "🧾 ดูรายการ", text: "รายการ" }],
});

/** แถวรายการในการ์ดสรุปชุด — โชว์ได้ 6 แถว ที่เหลือสรุปเป็นบรรทัดเดียว */
const BATCH_ROWS = 6;

/**
 * การ์ดสรุป "บันทึกหลายรายการทีเดียว"
 *
 * **ไม่ใส่ปุ่มจัดหมวดรายตัว** — 5 รายการ × 4 ปุ่ม = การ์ดยาวจนหาปุ่มจริงไม่เจอ
 * ให้ไปจัดที่หน้า "รายการ" ซึ่งมีปุ่มครบและกรองเฉพาะที่ยังไม่จัดหมวดได้อยู่แล้ว
 *
 * `skipped` = ท่อนที่คั่นมาแล้วแต่ตีความไม่ได้ — **ต้องบอกเสมอ** ผู้ใช้พิมพ์มา 5
 * แล้วบันทึกได้ 4 โดยไม่บอกว่าอันไหนหาย คือความผิดพลาดที่หาต้นเหตุไม่ได้เลย
 */
export function entriesCard(saved, skipped = []) {
  const sum = (dir) => saved.filter((s) => s.direction === dir)
    .reduce((a, s) => a + s.amountCents, 0);
  const inC = sum("in"), outC = sum("out");
  const shown = saved.slice(0, BATCH_ROWS);
  const rest = saved.length - shown.length;
  const uncategorised = saved.filter((s) => s.direction === "out").length > 0;

  return card({
    title: `บันทึก ${saved.length} รายการแล้ว`, emoji: "🧾", tone: "success",
    rows: [
      ...shown.map((s) => ({
        label: s.note || DIR_LABEL[s.direction],
        value: `${s.direction === "in" ? "+" : "−"}${L.fromCents(s.amountCents)}`,
      })),
      ...(rest > 0 ? [{ label: `และอีก ${rest} รายการ`, value: "" }] : []),
      ...(outC ? [{ label: "รวมรายจ่าย", value: L.fromCents(outC), strong: true }] : []),
      ...(inC ? [{ label: "รวมรายรับ", value: L.fromCents(inC), strong: true }] : []),
    ],
    notes: skipped.length
      ? [`ตีความไม่ได้ ไม่ได้บันทึก: ${skipped.map((s) => `“${s}”`).join(" · ")}`]
      : [],
    text: "ยังไม่ได้จัดหมวด — กดดูรายการแล้วเลือกหมวดได้ทีละรายการ",
    actions: [
      ...(uncategorised
        ? [{ label: "📂 จัดหมวดที่ค้าง", data: "act=list&c=-", primary: true }]
        : [{ label: "🧾 ดูรายการ", data: "act=list", primary: true }]),
      { label: "📊 ดูสรุป", data: "act=summary" },
    ],
    altText: `บันทึก ${saved.length} รายการ`,
  });
}

/**
 * การ์ดส่งออก CSV — LINE ส่งไฟล์ไม่ได้ จึงต้องให้ลิงก์ที่บอทเสิร์ฟเอง
 * ต้องมี PUBLIC_URL ไม่งั้นลิงก์จะเป็น localhost ซึ่งมือถือเปิดไม่ได้
 */
const exportCard = (userId) => {
  const { count } = L.exportCsv(userId);
  if (!count) {
    return card({ title: "ยังไม่มีข้อมูลให้ส่งออก", emoji: "📤", tone: "info",
                  text: "ส่งสลิปหรือพิมพ์รายการเข้ามาก่อนนะครับ" });
  }
  if (!config.publicUrl) {
    return card({
      title: "ยังส่งออกไม่ได้", emoji: "⚠️", tone: "warn",
      text: "ฟีเจอร์นี้ต้องมีโดเมนสาธารณะก่อน (LINE ส่งไฟล์ให้ไม่ได้ ต้องใช้ลิงก์ดาวน์โหลด)\n\n"
          + "ผู้ดูแลตั้ง PUBLIC_URL ใน .env แล้วปุ่มจะกลับมาเอง",
    });
  }
  const { token, ttlMin } = L.createExportToken(userId);
  return card({
    title: "ส่งออกเป็น CSV", emoji: "📤", tone: "success",
    rows: [{ label: "จำนวนรายการ", value: `${count} รายการ` },
           { label: "ลิงก์หมดอายุใน", value: `${ttlMin} นาที` }],
    text: "เปิดใน Google Sheets / Excel ได้เลย (รองรับภาษาไทย)",
    notes: ["ลิงก์ใช้ได้ครั้งเดียว — ถ้าโหลดไม่ทันกดขอใหม่ได้"],
    actions: [{ label: "⬇️ ดาวน์โหลด CSV", url: `${config.publicUrl}/export/${token}`, primary: true }],
    altText: `ส่งออก ${count} รายการเป็น CSV`,
  });
};

// ---------- Google Sheet ----------

/**
 * วิธีเชื่อมชีต — อีเมล service account ส่งเป็น**ข้อความธรรมดาใบแยก**เสมอ
 *
 * ตัวอักษรใน Flex คัดลอกไม่ได้ (ข้อจำกัดของ LINE) และอีเมลนี้ยาว 40+ ตัวอักษร
 * แบบพิมพ์ตามมือไม่ไหว — เหมือนกรณี LINE user ID ที่เจอมาแล้ว
 */
/** รูปมาสคอตต้องมี URL สาธารณะ — LINE ไปดึงเอง ฝัง base64 ไม่ได้ (ดู route /mascot) */
const mascot = (file) => (config.publicUrl ? `${config.publicUrl}/mascot/${file}` : null);

const sheetHelpCards = () => [
  sheetGuideMessage({ mascotUrl: mascot("Stand-1.png"), email: config.googleSaEmail }),
  { type: "text", text: config.googleSaEmail },
];

const sheetStatusCard = (userId) => {
  const link = L.sheetLink(userId);
  if (!link) return sheetHelpCards();
  const waiting = L.sheetQueueDepth(userId);
  const auto = L.sheetAuto(userId);
  return card({
    title: link.last_error ? "ชีตเชื่อมอยู่ แต่ sync ไม่ผ่าน" : "เชื่อมชีตอยู่",
    emoji: link.last_error ? "⚠️" : "📗",
    tone: link.last_error ? "warn" : waiting ? "info" : "success",
    rows: [
      { label: "อัปเดตชีต", value: auto ? "อัตโนมัติ" : "เมื่อกดปุ่มเท่านั้น" },
      { label: "รอส่งขึ้นชีต", value: waiting ? `${waiting} รายการ` : "ไม่มี", strong: waiting > 0 },
      { label: "ส่งล่าสุด", value: link.last_sync_at ? link.last_sync_at.slice(0, 16).replace("T", " ") : "ยังไม่เคย" },
      { label: "แท็บที่เขียน", value: link.tab || "(ยังไม่ได้เขียนครั้งแรก)" },
    ],
    // ต้องโชว์สาเหตุดิบจาก Google — เกือบทุกครั้งคือ "ยังไม่ได้แชร์ชีตให้อีเมลนี้"
    // ซึ่งผู้ใช้แก้เองได้ใน 10 วินาที ถ้ารู้ว่าต้องแก้อะไร
    notes: [
      ...(link.last_error ? [link.last_error] : []),
      ...(!auto && waiting ? ["รายการใหม่จะถูกเก็บไว้จนกว่าจะกดส่ง — ไม่หายไปไหน"] : []),
    ],
    actions: [
      { label: waiting ? `🔄 ส่งขึ้นชีตเลย (${waiting})` : "🔄 ส่งขึ้นชีตเลย",
        data: "act=sheetsync", primary: waiting > 0 },
      { label: "📄 เปิดชีต", url: `https://docs.google.com/spreadsheets/d/${link.spreadsheet_id}/edit`,
        primary: !waiting },
      { label: auto ? "⏸ ปิดอัปเดตอัตโนมัติ" : "▶️ เปิดอัปเดตอัตโนมัติ", data: "act=sheetauto" },
      { label: "🔌 เลิกเชื่อมชีต", data: "act=sheetoff" },
    ],
    altText: "สถานะการเชื่อม Google Sheet",
  });
};

const settingsCard = (userId) => {
  const weeklyOn = L.getPref(userId, "weekly") === "on";
  const bs = L.getBudgets(userId);
  const accts = L.getAccounts(userId);
  return card({
    title: "ตั้งค่า", emoji: "⚙️", tone: "neutral",
    rows: [
      { label: "สรุปรายสัปดาห์", value: weeklyOn ? "เปิด" : "ปิด" },
      { label: "งบที่ตั้งไว้", value: bs.length ? `${bs.length} รายการ` : "ยังไม่ได้ตั้ง" },
      // ต้องโชว์ — นี่คือสิ่งที่ระบบใช้ตัดสินว่าสลิปใบไหนรับ/จ่าย โดยไม่ถามอีก
      // ถ้าเรียนผิดไว้ ผู้ใช้ต้องเห็นได้ว่าผิดตรงไหน ไม่ใช่เดาว่าทำไมบอทตอบแปลก ๆ
      { label: "บัญชีที่จำไว้",
        value: accts.length
          ? accts.map((a) => a.name_hint || `••••${a.acct_tail}`).join(", ")
          : "ยังไม่ได้จำ (จะถามตอนส่งสลิปใบแรก)" },
      ...(config.sheetsEnabled ? [{
        label: "Google Sheet",
        value: !L.sheetLink(userId) ? "ยังไม่ได้เชื่อม"
          : L.sheetQueueDepth(userId) ? `รอส่ง ${L.sheetQueueDepth(userId)} รายการ`
          : L.sheetAuto(userId) ? "อัปเดตอัตโนมัติ" : "ส่งเมื่อกดปุ่ม",
      }] : []),
    ],
    actions: [
      { label: weeklyOn ? "🔕 ปิดสรุปรายสัปดาห์" : "🔔 เปิดสรุปรายสัปดาห์", data: "act=weekly" },
      ...(accts.length ? [{ label: "🔄 ลืมบัญชีที่จำไว้", data: "act=forgetacct" }] : []),
      // fillInText: เติม "งบ " ให้ ผู้ใช้พิมพ์ต่อแค่ตัวเลข
      { label: "📌 ตั้งงบรวม", fill: "งบ ", data: "act=prompt&kind=budget" },
      { label: "📌 ตั้งงบรายหมวด", fill: "งบ อาหาร ", data: "act=prompt&kind=budget" },
      // ไม่ตั้งคีย์ service account = ไม่โผล่เลย ดีกว่าโผล่แล้วกดไปเจอทางตัน
      ...(config.sheetsEnabled
        ? [{ label: L.sheetLink(userId) ? "📗 ชีตที่เชื่อมไว้" : "📗 เชื่อม Google Sheet",
             data: "act=sheet" }]
        : []),
      // ต้องเปิด EXPORT_CSV *และ* มี PUBLIC_URL ถึงจะโผล่
      // (ไม่มีโดเมนสาธารณะ ลิงก์ดาวน์โหลดก็เปิดไม่ได้อยู่ดี)
      ...(config.exportEnabled && config.publicUrl ? [{ label: "📤 ส่งออก CSV", data: "act=export" }] : []),
      { label: "🔒 ข้อมูลของฉัน", text: "ข้อมูลของฉัน" },
    ],
  });
};

// ---------- สิทธิ์ใช้งาน ----------

/** เปิดโหมดจำกัดสิทธิ์อยู่หรือเปล่า — ไม่ตั้งอะไรเลย = เปิดให้ทุกคนเหมือนเดิม */
const isGated = () => config.adminUsers.size > 0 || config.allowedUsers.size > 0;
const isAdmin = (userId) => config.adminUsers.has(userId);
/** แอดมินและรายชื่อใน .env ใช้ได้เสมอ · ที่เหลือดูจากตาราง access */
const isAllowed = (userId) =>
  isAdmin(userId) || config.allowedUsers.has(userId) || L.accessStatus(userId) === "approved";

/**
 * "รหัสสำรอง" — การ์ดอธิบาย + ID เป็นข้อความธรรมดาให้คัดลอก
 *
 * โผล่ **หลังจากกดขอไปแล้วเท่านั้น** ไม่ใช่ตอนเจอกันครั้งแรก
 * คนที่เพิ่งแอดบอทไม่รู้จักคำว่า "LINE user ID" และไม่ควรต้องรู้ด้วย
 * เห็นตัวอักษร 33 ตัวโผล่มาลอย ๆ ตั้งแต่ข้อความแรกมีแต่ทำให้งงและดูเหมือนบอทพัง
 * พอกดขอแล้วค่อยให้ ตอนนั้นเขามีบริบทแล้วว่ามันคือรหัสไว้ส่งให้ผู้ดูแล
 */
const idFallback = (userId) => [
  card({
    title: "ถ้ารอนาน", emoji: "💬", tone: "neutral",
    text: "ส่งรหัสในข้อความถัดไปให้ผู้ดูแลโดยตรงได้ครับ (กดค้างที่ข้อความเพื่อคัดลอก)",
    altText: "ส่งรหัสให้ผู้ดูแลโดยตรงได้",
  }),
  { type: "text", text: userId },
];

/** การ์ดที่คนยังไม่มีสิทธิ์ได้รับ — เนื้อหาเปลี่ยนตามสถานะคำขอ */
function blockedCards(userId) {
  const st = L.accessStatus(userId);
  if (st === "pending") {
    return [
      card({
        title: "ส่งคำขอแล้ว", emoji: "⏳", tone: "info",
        text: "รอผู้ดูแลอนุมัติอยู่ครับ ได้ผลแล้วผมจะแจ้งกลับมาเอง",
        altText: "ส่งคำขอแล้ว รอผู้ดูแลอนุมัติ",
      }),
      ...idFallback(userId),
    ];
  }
  if (st === "rejected") {
    // ไม่ให้กดขอซ้ำ — ไม่งั้นแอดมินโดนสแปมและโควตา push หมด
    return card({
      title: "ไม่ได้รับสิทธิ์", emoji: "🔒", tone: "warn",
      text: "ผู้ดูแลยังไม่อนุมัติคำขอของคุณครับ ติดต่อผู้ดูแลโดยตรงได้",
      altText: "ไม่ได้รับสิทธิ์ใช้งาน",
    });
  }
  // เจอกันครั้งแรก — มีปุ่มเดียว ไม่มีศัพท์เทคนิค ไม่มีรหัสอะไรให้งง
  return card({
    title: "บอทนี้ต้องขออนุญาตก่อนใช้", emoji: "🔒", tone: "info",
    text: "ผมช่วยอ่านสลิปและจดรายรับ-รายจ่ายให้ครับ\n\n"
        + "กดปุ่มด้านล่างเพื่อขอใช้งาน เดี๋ยวผู้ดูแลกดอนุมัติให้ แล้วผมจะแจ้งกลับมา",
    actions: [{ label: "🙋 ขอใช้งาน", data: "act=req", primary: true }],
    altText: "บอทนี้ต้องขออนุญาตก่อนใช้ — กดขอใช้งานได้เลย",
  });
}

/** การ์ดแจ้งแอดมินว่ามีคนขอสิทธิ์ */
const requestCard = (userId, name = null) => card({
  title: "มีคนขอใช้งานบอท", emoji: "🙋", tone: "warn",
  rows: [
    // ชื่อมาก่อน ID เสมอ — แอดมินตัดสินจากชื่อ ไม่ใช่จากตัวอักษร 8 ตัวท้าย
    { label: "ชื่อใน LINE", value: name || "(ดึงชื่อไม่ได้)" },
    { label: "รหัส", value: `…${userId.slice(-8)}` },
  ],
  text: "อนุมัติแล้วเขาจะใช้บอทได้ทันที",
  actions: [
    [{ label: "✅ อนุมัติ", data: `act=acc&v=ok&u=${userId}`, primary: true },
     { label: "❌ ปฏิเสธ", data: `act=acc&v=no&u=${userId}` }],
  ],
  altText: `${name || "มีคน"} ขอใช้งานบอท`,
});

/** ชื่อใน LINE ของคนที่ยังไม่ได้เป็นผู้ใช้ — ล้มเหลวได้ ไม่ควรทำให้คำขอพัง */
async function displayNameOf(userId) {
  try {
    return (await client.getProfile(userId)).displayName ?? null;
  } catch (err) {
    console.warn(`[ดึงชื่อไม่ได้] ${userId}: ${err.message}`);
    return null;
  }
}

/**
 * คนนอกกดปุ่ม "ขอใช้งาน"
 *
 * push หาแอดมิน **เฉพาะตอนเป็นคำขอใหม่จริง ๆ** (requestAccess คืน true)
 * กดซ้ำไม่ push ซ้ำ ไม่งั้นคนเดียวเผาโควตา 300/เดือนหมดได้
 * โควตาหมดก็ยังบันทึกคำขอไว้ — แอดมินพิมพ์ "คำขอ" มาดูเองได้
 */
async function handleAccessRequest(event, userId) {
  const name = await displayNameOf(userId);
  const isNew = L.requestAccess(userId, name);
  if (isNew) {
    console.log(`[ขอสิทธิ์] ${name ?? "(ไม่มีชื่อ)"} ${userId}`);
    if (quota().left > 0) {
      for (const admin of config.adminUsers) {
        try { await pushTo(admin, requestCard(userId, name)); L.logPush(admin, "access"); }
        catch (err) { console.error(`[แจ้งแอดมินไม่ได้] ${err.message}`); }
      }
    } else {
      console.warn("[ขอสิทธิ์] โควตา push หมด — แอดมินต้องพิมพ์ “คำขอ” มาดูเอง");
    }
  }
  return respond(event, [
    card({
      title: isNew ? "ส่งคำขอแล้ว" : "ส่งคำขอไปก่อนหน้านี้แล้ว", emoji: "⏳", tone: "info",
      text: "รอผู้ดูแลอนุมัติครับ ได้ผลแล้วผมจะแจ้งกลับมาเอง",
      altText: "ส่งคำขอแล้ว รอผู้ดูแลอนุมัติ",
    }),
    ...idFallback(userId),
  ]);
}

// ---------- ส่งข้อความ ----------

/** ส่งข้อความกลับ: ลอง reply ก่อน (ฟรี) ถ้า token ตายแล้วค่อย push */
async function respond(event, messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  if (event.replyToken) {
    try {
      await client.replyMessage({ replyToken: event.replyToken, messages: list });
      return;
    } catch (err) {
      console.warn(`[reply ล้มเหลว → push แทน] ${err.message}`);
    }
  }
  const to = event.source?.userId;
  if (!to) {
    console.error("[ส่งไม่ได้] ไม่มี userId และ reply token ใช้ไม่ได้");
    return;
  }
  await client.pushMessage({ to, messages: list });
  try { L.logPush(to, "fallback"); } catch { /* DB ล่มไม่ควรทำให้ตอบไม่ได้ */ }
}

async function pushTo(userId, message) {
  if (!userId) return;
  await client.pushMessage({ to: userId, messages: [message] });
}

/**
 * ตรวจ/ส่งแจ้งเตือน โดย **ไม่ให้ error ของมันไปล้มการตอบผู้ใช้**
 *
 * ต้องเรียกใน finally เสมอ — ถ้าวางไว้หลัง `await respond(...)` เฉย ๆ แล้ว respond โยน error
 * (reply token หมดอายุ + push เต็มโควตา) บรรทัดนี้จะถูกข้ามเงียบ ๆ เจอมาแล้วตอนเทส
 */
async function notifyAfter(userId) {
  if (!userId) return;
  try {
    await checkAlerts(userId, (m) => pushTo(userId, m));
  } catch (err) {
    console.error(`[แจ้งเตือนล้มเหลว] ${err.message}`);
  }
}

/** แสดง "..." ให้ผู้ใช้รู้ว่ากำลังทำงาน — ใช้ได้เฉพาะแชท 1:1 (กลุ่มจะ error, ไม่เป็นไร) */
async function showLoading(userId, seconds = 15) {
  if (!userId) return;
  try {
    const s = Math.min(60, Math.max(5, Math.round(seconds / 5) * 5));  // LINE รับ 5–60 พหุคูณของ 5
    await client.showLoadingAnimation({ chatId: userId, loadingSeconds: s });
  } catch { /* กลุ่ม/ห้องแชทไม่รองรับ */ }
}

/**
 * ดึงเนื้อไฟล์จาก LINE → Buffer (ใช้ได้ทั้งรูปและไฟล์แนบ)
 *
 * เพดานขนาดต้องเช็ค**ระหว่างสตรีม** ไม่ใช่หลังโหลดจบ — ไฟล์ 300MB ที่ LINE ยอมให้ส่ง
 * จะกินหน่วยความจำจนคอนเทนเนอร์ (จำกัด 256MB) ตายก่อนที่เราจะได้ตรวจอะไร
 */
async function downloadContent(message, maxBytes = config.maxImageBytes, what = "รูป") {
  if (message.contentProvider?.type === "external") {
    const url = message.contentProvider.originalContentUrl;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`ดึง${what}จาก external provider ไม่ได้ (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  const stream = await blob.getMessageContent(message.id);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new Error(`${what}ใหญ่เกิน ${Math.round(maxBytes / 1024 / 1024)}MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const downloadImage = (message) => downloadContent(message, config.maxImageBytes, "รูป");

/**
 * รายการอยู่คนละเดือนกับปัจจุบันไหม → คืนการ์ดถามว่าจะลงเดือนไหน (ไม่งั้น null)
 *
 * เคสนี้เจอบ่อยมาก: ผู้ใช้เพิ่งส่งสลิปเก่าเข้ามาวันนี้ ระบบลงตามวันที่บนใบ (ถูกในแง่บัญชี)
 * แต่ผู้ใช้คาดว่าจะเห็นใน "สรุป" ของเดือนนี้ → ต้องถามให้ชัด ไม่ใช่เดาแทน
 */
function periodAskIfNeeded(userId, txnId) {
  const t = L.getTxn(userId, txnId);
  if (!t?.occurred_at) return null;
  const today = thisMonth()[1];
  if (t.occurred_at.slice(0, 7) === today.slice(0, 7)) return null;
  return askPeriod(txnId, t.occurred_at.slice(0, 10), today);
}

// ---------- รูปสลิป ----------

function savedCard(rec, amount, occurredAt, category = null) {
  if (rec.ok) {
    const pending = rec.status === "pending";
    // ต้องโชว์วันที่ที่ลงบัญชี — สลิปใช้วันที่บนใบ ซึ่งมักเป็นเดือนก่อน
    // ไม่บอกแล้วผู้ใช้จะงงว่าทำไม "สรุป" (เดือนนี้) ไม่มียอดนี้
    const rows = [
      occurredAt ? { label: "ลงวันที่", value: occurredAt } : null,
      category ? { label: "หมวด", value: labelOf(category) } : null,
    ];
    return card({
      title: pending ? "บันทึกไว้แล้ว — ช่วยตรวจยอด" : "บันทึกแล้ว",
      emoji: pending ? "📝" : "✅",
      tone: pending ? "warn" : "success",
      rows,
      big: amount, bigLabel: DIR_LABEL[rec.direction],
      notes: pending ? [`ยังไม่มั่นใจว่าอ่านยอดถูก — แก้ได้ด้วย “แก้ ${rec.txnId} <ยอด>”`] : [],
      actions: [
        ...(rec.direction === "unknown"
          ? [{ label: "💰 เป็นรายรับ", data: `act=dir&id=${rec.txnId}&v=in`, primary: true },
             { label: "💸 เป็นรายจ่าย", data: `act=dir&id=${rec.txnId}&v=out` }]
          // เดาเองต้องมีปุ่มกลับเสมอ — ระบบถามแค่สลิปใบแรกแล้วจำบัญชีไว้เดาเอง
          // ถ้าเดาผิดแล้วไม่มีปุ่มนี้ ผู้ใช้จะแก้ไม่ได้เลย ต้องลบทิ้งแล้วส่งใหม่อย่างเดียว
          : [{ label: rec.direction === "in" ? "🔁 ที่จริงเป็นรายจ่าย" : "🔁 ที่จริงเป็นรายรับ",
               data: `act=dir&id=${rec.txnId}&v=${rec.direction === "in" ? "out" : "in"}` }]),
        // ทิศทางยังไม่รู้ = ยังไม่ควรถามเรื่องหมวด ถามทีละเรื่องพอ
        ...(rec.direction === "out" ? categoryButtons(rec.txnId, category) : []),
        { label: "🗑 ลบรายการนี้", data: `act=del&id=${rec.txnId}` },
        { label: "📊 ดูสรุป", data: "act=summary" },
      ],
      altText: `บันทึก${DIR_LABEL[rec.direction]} ${amount ?? ""}`,
    });
  }
  const M = {
    no_consent: ["ยังไม่ได้บันทึก", "info", "ต้องให้ความยินยอมก่อน — พิมพ์ “ยินยอม”"],
    low_confidence: ["ไม่ได้บันทึก", "warn", "อ่านยอดได้ไม่ชัดพอ ลองส่งรูปที่คมขึ้นครับ"],
    no_amount: ["ไม่ได้บันทึก", "warn", "หายอดเงินในรูปไม่เจอ"],
    duplicate: ["สลิปใบนี้บันทึกไปแล้ว", "info", "ไม่นับซ้ำให้นะครับ"],
  }[rec.reason] ?? ["ไม่ได้บันทึก", "warn", ""];
  return card({ title: M[0], emoji: "ℹ️", tone: M[1], text: M[2] });
}

async function handleSingleImage(event) {
  const userId = event.source?.userId;
  const consented = userId ? L.hasConsent(userId) : false;

  try {
    const buffer = await downloadImage(event.message);
    const hash = L.sha256(buffer);

    // เช็คซ้ำ **ก่อน** OCR — ไฟล์เดิมไม่ต้องอ่านใหม่ ประหยัดไปทั้งรอบ
    if (consented) {
      const dup = L.findDuplicate(userId, { imageSha256: hash });
      if (dup) {
        // ต้องบอกว่าซ้ำกับ "รายการไหน" ไม่ใช่แค่บอกว่าซ้ำ
        // ผู้ใช้จะได้ตรวจได้ว่ามันมีอยู่จริง และกดลบ/แก้ได้ทันทีถ้าไม่ใช่ที่คิด
        const t = dup.txnId ? L.getTxn(userId, dup.txnId) : null;
        return respond(event, card({
          title: "สลิปใบนี้เคยส่งมาแล้ว", emoji: "🔁", tone: "info",
          text: "บันทึกไว้เรียบร้อยแล้ว ไม่นับซ้ำให้นะครับ",
          rows: t ? [
            { label: "ตรงกับรายการ", value: `#${t.id}` },
            { label: "ยอด", value: `${L.fromCents(t.amount_cents)} บาท` },
            { label: "ลงวันที่", value: t.occurred_at ?? "ตามวันที่บันทึก" },
          ] : [],
          actions: [
            ...(t ? [{ label: `🗑 ลบรายการ #${t.id}`, data: `act=del&id=${t.id}` }] : []),
            { label: "🧾 ดูรายการล่าสุด", data: "act=list", primary: true },
          ],
        }));
      }
    }

    const waiting = ahead();
    if (waiting > 0) {
      await respond(event, card({
        title: "รับรูปแล้ว กำลังเข้าคิว", emoji: "📥", tone: "info",
        rows: [{ label: "งานที่รออยู่", value: `${waiting} ใบ` }],
        text: "เดี๋ยวส่งผลให้นะครับ",
      }));
      event.replyToken = null;      // ใช้ token ไปแล้ว ผลต้องไปทาง push
    }
    await showLoading(userId, Math.min(60, (waiting + 1) * 10));

    const result = await enqueue(() => ocr.parseImage(buffer));
    const messages = [resultMessage(result)];

    if (!consented) {
      messages.push(consentCard("อ่านผลให้แล้ว แต่ยังไม่ได้บันทึก"));
    } else {
      const rec = L.recordSlip(userId, result, { imageSha256: hash });
      // ยังไม่รู้ว่ารับหรือจ่าย → ถามด้วย quick reply (ต้องเป็นข้อความสุดท้าย ปุ่มถึงจะโผล่)
      if (rec.ok && rec.direction === "unknown") {
        // ถามทิศทางก่อน — เรื่องเดือนค่อยถามต่อหลังผู้ใช้ตอบ (quick reply โผล่ได้ทีละใบ)
        messages.push(askDirection(rec.txnId, result.amount));
      } else {
        messages.push(savedCard(rec, result.amount, L.occurredAt(result),
                                L.getTxn(userId, rec.txnId)?.category ?? null));
        const ask = rec.ok ? periodAskIfNeeded(userId, rec.txnId) : null;
        if (ask) messages.push(ask);
      }
    }

    // finally: แจ้งเตือนต้องรันแม้ respond จะพัง (ดูคอมเมนต์ที่ notifyAfter)
    try {
      await respond(event, messages);
    } finally {
      if (consented) await notifyAfter(userId);
    }
  } catch (err) {
    console.error(`[OCR ล้มเหลว] ${err.stack || err.message}`);
    let msg;
    if (err instanceof ocr.OcrAuthError) {
      msg = "ระบบตั้งค่าไม่ถูกต้อง (ยืนยันตัวตนกับ backend ไม่ผ่าน) — แจ้งผู้ดูแลด้วยครับ";
    } else if (err instanceof ocr.OcrUnavailableError) {
      msg = "ระบบอ่านสลิปยังไม่พร้อม ลองใหม่อีกสักครู่นะครับ";
    } else if (err instanceof ocr.OcrTimeoutError) {
      msg = "อ่านรูปนี้ไม่สำเร็จ (ใช้เวลานานเกินไป) ลองส่งรูปที่คมและเล็กลงดูครับ";
    } else {
      msg = err.message;
    }
    await respond(event, errorMessage(msg, [{ label: "❓ วิธีใช้", text: "ช่วยเหลือ" }]));
  }
}

// ---------- รูปสลิปหลายใบในชุดเดียว ----------

/**
 * ทุกรูปเข้าที่นี่ก่อน — เก็บเข้าชุดแล้วรอ ~1.5 วิว่ามีใบตามมาอีกไหม (ดู batch.js)
 *
 * ใบเดียวก็ยังไปทางเดิมทุกอย่าง ไม่มีอะไรเปลี่ยน — ต้นทุนคือหน่วงเพิ่ม 1.5 วิ
 * ซึ่งเทียบกับ OCR ~8.5 วิแล้วแทบไม่รู้สึก และแลกมากับการไม่เผาโควตา push
 */
function handleImage(event) {
  const userId = event.source?.userId;
  return collect(userId, event, (events) => runImageBatch(userId, events));
}

/** ชุดถูกยิงจาก timer → ไม่มีใครรับ error ต่อ ต้องจับเองให้หมดที่นี่ */
async function runImageBatch(userId, events) {
  try {
    if (events.length === 1) return await handleSingleImage(events[0]);
    return await handleImageBatch(userId, events);
  } catch (err) {
    console.error(`[ชุดสลิปล้มเหลว] ${err.stack || err.message}`);
  }
}

/** อ่านและบันทึกสลิปหนึ่งใบ → คืนผลให้ตัวเรียกไปสรุป (ไม่ตอบผู้ใช้เอง) */
async function processSlip(userId, event) {
  const buffer = await downloadImage(event.message);
  const hash = L.sha256(buffer);

  // เช็คซ้ำก่อน OCR — ประหยัดไปทั้งรอบเหมือนทางใบเดียว
  const dup = L.findDuplicate(userId, { imageSha256: hash });
  if (dup) return { kind: "dup" };

  const parsed = await enqueue(() => ocr.parseImage(buffer));
  const rec = L.recordSlip(userId, parsed, { imageSha256: hash });
  if (!rec.ok) return { kind: "skip", reason: rec.reason };
  return { kind: "saved", rec, parsed };
}

const SLIP_SKIP = {
  low_confidence: "อ่านยอดไม่ชัดพอ",
  no_amount: "หายอดเงินไม่เจอ",
  duplicate: "ซ้ำกับที่มีอยู่",
  no_consent: "ยังไม่ได้ให้ความยินยอม",
};

/**
 * หลายใบ → อ่านทีละใบ แล้วตอบ **การ์ดสรุปใบเดียว**
 *
 * ใช้ `respond()` กับ event ใบสุดท้าย: มันจะลอง reply (ฟรี) ก่อนเสมอ ถ้าอ่านนานเกิน
 * จน token ตายค่อยตกไป push — 5 ใบ ≈ 42 วิ ยังทันโควตา reply สบาย ๆ
 * เทียบกับเดิมที่ตอบทีละใบแล้วกิน push 4-5 ครั้งจาก 300 ครั้ง/เดือน
 *
 * ไม่ส่งการ์ด "รับแล้วกำลังอ่าน" นำหน้า เพราะจะเปลือง reply token ทิ้งไปเปล่า ๆ
 * ใช้ loading animation แทน (ฟรี ไม่นับโควตา) และต่ออายุทุกใบ
 */
async function handleImageBatch(userId, events) {
  const last = events[events.length - 1];

  if (!L.hasConsent(userId)) {
    return respond(last, consentCard(`ได้รับรูป ${events.length} ใบแล้ว แต่ยังบันทึกให้ไม่ได้`));
  }

  const saved = [], skipped = [];
  let dup = 0;

  for (const ev of events) {
    // ต่ออายุทุกใบ — LINE ตั้งได้ครั้งละไม่เกิน 60 วิ ชุดใหญ่จึงต้องต่อระหว่างทาง
    await showLoading(userId, 40);
    try {
      const r = await processSlip(userId, ev);
      if (r.kind === "dup") dup++;
      else if (r.kind === "skip") skipped.push(SLIP_SKIP[r.reason] ?? r.reason);
      else saved.push(r.rec);
    } catch (err) {
      console.error(`[สลิปในชุดล้มเหลว] ${err.stack || err.message}`);
      skipped.push(err instanceof ocr.OcrTimeoutError ? "ใช้เวลานานเกินไป" : "อ่านไม่สำเร็จ");
    }
  }

  try {
    await respond(last, batchSlipCard(userId, events.length, saved, skipped, dup));
  } finally {
    await notifyAfter(userId);
  }
}

/** นับซ้ำ ๆ ให้เป็น "เหตุผล ×N" — 5 ใบพังด้วยเหตุเดียวกันไม่ควรกิน 5 บรรทัด */
const tally = (list) => {
  const m = new Map();
  for (const s of list) m.set(s, (m.get(s) ?? 0) + 1);
  return [...m].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
};

export function batchSlipCard(userId, total, saved, skipped, dup) {
  const sum = (dir) => saved.filter((s) => s.direction === dir)
    .reduce((a, s) => a + s.amountCents, 0);
  const inC = sum("in"), outC = sum("out");
  const unknown = saved.filter((s) => s.direction === "unknown");
  const pending = saved.filter((s) => s.status === "pending");
  const ok = saved.length > 0;

  return card({
    title: ok ? `บันทึก ${saved.length} จาก ${total} ใบ` : `ไม่ได้บันทึกสักใบจาก ${total} ใบ`,
    emoji: ok ? "🧾" : "⚠️",
    tone: !ok ? "warn" : skipped.length || dup ? "info" : "success",
    rows: [
      ...(outC ? [{ label: "รวมรายจ่าย", value: L.fromCents(outC), strong: true }] : []),
      ...(inC ? [{ label: "รวมรายรับ", value: L.fromCents(inC), strong: true }] : []),
      ...(dup ? [{ label: "ซ้ำ ไม่นับให้", value: `${dup} ใบ` }] : []),
      ...(skipped.length ? [{ label: "อ่านไม่ผ่าน", value: `${skipped.length} ใบ` }] : []),
    ],
    // ต้องบอกเหตุผลรายใบเสมอ — "บันทึก 3 จาก 5" โดยไม่บอกว่าอีก 2 ใบเป็นอะไร
    // แปลว่าผู้ใช้ต้องไล่เทียบเองว่าใบไหนหาย ซึ่งทำไม่ได้จริงเมื่อส่งทีละหลายใบ
    notes: [
      ...tally(skipped),
      ...(unknown.length ? [`ยังไม่รู้ว่ารับหรือจ่าย ${unknown.length} ใบ`] : []),
      ...(pending.length ? [`ควรตรวจยอด ${pending.length} ใบ`] : []),
    ],
    actions: [
      ...(unknown.length
        ? [{ label: `💬 ระบุรับ/จ่าย (${unknown.length} ใบ)`,
             data: `act=askdir&id=${unknown[0].txnId}`, primary: true }]
        : []),
      ...(pending.length
        ? [{ label: `📝 ตรวจยอด ${pending.length} ใบ`, data: "act=list&s=pending",
             primary: !unknown.length }]
        : []),
      { label: "🧾 ดูรายการ", data: "act=list", primary: !unknown.length && !pending.length },
      { label: "📊 ดูสรุป", data: "act=summary" },
    ],
    altText: ok ? `บันทึกสลิป ${saved.length}/${total} ใบ` : `ไม่ได้บันทึกสลิป ${total} ใบ`,
  });
}

// ---------- ไฟล์แนบ (PDF / ข้อความ) ----------

const IS_PDF = /\.pdf$/i;
const IS_TEXT = /\.(txt|csv|tsv|text)$/i;

/**
 * ตัวอักษรไทยในไฟล์ที่ไม่ใช่ UTF-8
 *
 * ไฟล์ CSV ที่ export จาก Excel ภาษาไทยบนวินโดวส์ยังเป็น **windows-874 (TIS-620)**
 * อยู่มาก ถ้า decode เป็น UTF-8 ตรง ๆ จะได้ตัวยึกยือทั้งไฟล์ แล้ว parser จะอ่าน
 * ชื่อรายการไม่ออกทั้งก้อน (ตัวเลขยังถูก — เป็นความพังที่มองข้ามง่ายมาก)
 *
 * ตรวจด้วยจำนวนตัวแทนที่ (U+FFFD) ที่ decoder ใส่ให้เมื่อเจอไบต์ที่ไม่ใช่ UTF-8
 */
function decodeText(buf) {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > Math.max(2, utf8.length * 0.005)) {
    try {
      return new TextDecoder("windows-874").decode(buf);
    } catch { /* build ที่ ICU ไม่เต็มจะไม่มี codec นี้ — ถอยไปใช้ UTF-8 */ }
  }
  return utf8;
}

const unsupportedFileCard = (name) => card({
  title: "ยังอ่านไฟล์แบบนี้ไม่ได้", emoji: "📎", tone: "warn",
  rows: [{ label: "ไฟล์ที่ส่งมา", value: name || "(ไม่มีชื่อ)" }],
  text: "ตอนนี้รับได้แบบนี้ครับ",
  notes: [
    "PDF — สลิป/ใบเสร็จ/statement จากแอปธนาคาร",
    "CSV / TSV — ตารางรายการ (มีคอลัมน์วันที่ รายละเอียด จำนวน)",
    "TXT — บรรทัดละรายการ เช่น “กาแฟ 60”",
    "รูปภาพ — ส่งเป็นรูปได้เลย ไม่ต้องแนบเป็นไฟล์",
  ],
  altText: "ยังอ่านไฟล์ชนิดนี้ไม่ได้",
});

async function handleFile(event) {
  const userId = event.source?.userId;
  const name = event.message?.fileName ?? "";
  const size = Number(event.message?.fileSize ?? 0);

  if (!IS_PDF.test(name) && !IS_TEXT.test(name)) {
    return respond(event, unsupportedFileCard(name));
  }
  if (!L.hasConsent(userId)) {
    return respond(event, consentCard(`ได้รับไฟล์ “${name}” แล้ว แต่ยังบันทึกให้ไม่ได้`));
  }

  // LINE บอกขนาดมาใน event อยู่แล้ว → ปฏิเสธได้ตั้งแต่ก่อนโหลด ไม่เสียแบนด์วิดท์เปล่า
  const cap = IS_PDF.test(name) ? config.maxPdfBytes : config.maxTextBytes;
  if (size > cap) {
    return respond(event, card({
      title: "ไฟล์ใหญ่เกินไป", emoji: "📎", tone: "warn",
      rows: [{ label: "ขนาดไฟล์", value: `${(size / 1024 / 1024).toFixed(1)} MB` },
             { label: "รับได้ไม่เกิน", value: `${Math.round(cap / 1024 / 1024)} MB` }],
      text: "ลองแบ่งไฟล์ให้เล็กลงแล้วส่งใหม่ครับ",
    }));
  }

  try {
    return IS_PDF.test(name)
      ? await handlePdfFile(event, userId, name)
      : await handleTextFile(event, userId, name);
  } catch (err) {
    console.error(`[อ่านไฟล์ล้มเหลว] ${name}: ${err.stack || err.message}`);
    const msg = err instanceof ocr.OcrTimeoutError
      ? "ไฟล์นี้ใช้เวลาอ่านนานเกินไป ลองแบ่งเป็นไฟล์เล็กลงครับ"
      : err instanceof ocr.OcrUnavailableError
        ? "ระบบอ่านเอกสารยังไม่พร้อม ลองใหม่อีกสักครู่นะครับ"
        : err.message;
    return respond(event, errorMessage(msg, [{ label: "❓ วิธีใช้", text: "ช่วยเหลือ" }]));
  }
}

/**
 * PDF → อ่านทีละหน้า
 *
 * **ไม่รวมเข้าชุดเดียวกับรูป** โดยตั้งใจ — PDF หนึ่งไฟล์มีหลายหน้าอยู่แล้ว จึงมี
 * "การรวมผล" ในตัวและใช้การ์ดสรุปตัวเดียวกับสลิปหลายใบได้เลย ส่วนคนที่ส่ง PDF
 * ก็มักส่งทีละไฟล์ ไม่ใช่เลือกทีละ 5 ไฟล์แบบเลือกรูปจากแกลเลอรี
 *
 * hash กันซ้ำผูกกับ **หน้า** ไม่ใช่ไฟล์ (`<hash>#p2`) — statement เดิมที่โหลดใหม่
 * แล้วมีหน้าเพิ่ม จะได้บันทึกเฉพาะหน้าใหม่ ไม่ใช่ถูกปัดตกทั้งไฟล์
 */
async function handlePdfFile(event, userId, name) {
  await showLoading(userId, 40);
  const buffer = await downloadContent(event.message, config.maxPdfBytes, "PDF");
  const fileHash = L.sha256(buffer);
  const res = await enqueue(() => ocr.parsePdf(buffer));
  const pages = res.pages ?? [];

  const saved = [], skipped = [], leftover = [];
  let dup = 0;
  for (const p of pages) {
    const { text, page, source, ...doc } = p;
    const pageHash = `${fileHash}#p${page}`;
    if (L.findDuplicate(userId, { imageSha256: pageHash, ref: doc.ref })) { dup++; continue; }
    const rec = L.recordSlip(userId, doc, { imageSha256: pageHash });
    if (rec.ok) { saved.push(rec); continue; }
    skipped.push(SLIP_SKIP[rec.reason] ?? rec.reason);
    // อ่านเป็นสลิปไม่ออกแต่มีข้อความ = น่าจะเป็น statement (หลายรายการในหน้าเดียว)
    // ซึ่ง parser สลิปอ่านไม่ได้โดยธรรมชาติ — เก็บข้อความไว้ลองอีกทางแทนที่จะยอมแพ้
    if (text && rec.reason !== "duplicate") leftover.push(text);
  }

  const messages = [];
  if (saved.length || dup || !leftover.length) {
    messages.push(batchSlipCard(userId, pages.length, saved, skipped, dup));
  }
  if (leftover.length) {
    const bill = parseBill(leftover.join("\n"));
    if (bill.entries.length >= 2) {
      messages.push(importPreviewCard(userId, bill, `${name} (statement)`));
    } else if (!messages.length) {
      messages.push(card({
        title: "อ่านไฟล์นี้ไม่ออก", emoji: "📄", tone: "warn",
        rows: [{ label: "ไฟล์", value: name }, { label: "จำนวนหน้า", value: `${pages.length}` }],
        text: "อ่านข้อความได้ แต่จับรูปแบบรายการไม่ได้ครับ\n"
            + "ถ้าเป็นตารางรายการ ลองส่งเป็น CSV แทนจะแม่นกว่ามาก",
      }));
    }
  }
  try {
    return await respond(event, messages);
  } finally {
    await notifyAfter(userId);
  }
}

async function handleTextFile(event, userId, name) {
  const buffer = await downloadContent(event.message, config.maxTextBytes, "ไฟล์");
  const bill = parseBill(decodeText(buffer));

  if (!bill.entries.length) {
    return respond(event, card({
      title: "ไม่เจอรายการในไฟล์นี้", emoji: "📄", tone: "warn",
      rows: [{ label: "ไฟล์", value: name }],
      text: "ลองตรวจว่ามีคอลัมน์จำนวนเงินอยู่ไหมครับ",
      notes: [
        "CSV: ต้องมีคอลัมน์จำนวนเงิน (มีวันที่/รายละเอียดด้วยจะดีที่สุด)",
        "TXT: บรรทัดละรายการ เช่น “กาแฟ 60”",
        ...bill.skipped.map((s) => `อ่านไม่ออก: ${s}`),
      ],
    }));
  }
  return respond(event, importPreviewCard(userId, bill, name));
}

// ---------- นำเข้า: พรีวิว → ยืนยัน ----------

const IMPORT_PREVIEW_ROWS = 5;

/**
 * การ์ดพรีวิวก่อนนำเข้า — **ยังไม่เขียน DB สักแถว**
 *
 * ต่างจากสลิปตรงที่ไฟล์ข้อความไม่มีเลขอ้างอิงหรือ hash รูปให้กันซ้ำ และหนึ่งไฟล์
 * มีได้เป็นร้อยรายการ ถ้าบันทึกทันทีแล้วส่งผิดไฟล์ ผู้ใช้ต้องไล่ลบทีละรายการ
 * เป็นร้อยครั้ง ซึ่งเท่ากับกู้คืนไม่ได้จริง
 */
export function importPreviewCard(userId, bill, filename) {
  const { entries, skipped, format, truncated } = bill;
  pending.put(userId, { entries, filename });

  const sum = (dir) => entries.filter((e) => e.direction === dir)
    .reduce((a, e) => a + e.amountCents, 0);
  const inC = sum("in"), outC = sum("out");
  const dates = entries.map((e) => e.occurredAt).filter(Boolean).sort();

  return card({
    title: `พบ ${entries.length} รายการในไฟล์`, emoji: "📥", tone: "info",
    rows: [
      { label: "ไฟล์", value: filename },
      ...(dates.length
        ? [{ label: "ช่วงวันที่", value: dates[0].slice(0, 10) === dates[dates.length - 1].slice(0, 10)
            ? dates[0].slice(0, 10)
            : `${dates[0].slice(0, 10)} – ${dates[dates.length - 1].slice(0, 10)}` }]
        : [{ label: "วันที่", value: "ไม่มีในไฟล์ — จะลงเป็นวันที่นำเข้า" }]),
      ...(outC ? [{ label: "รวมรายจ่าย", value: L.fromCents(outC), strong: true }] : []),
      ...(inC ? [{ label: "รวมรายรับ", value: L.fromCents(inC), strong: true }] : []),
    ],
    text: entries.slice(0, IMPORT_PREVIEW_ROWS)
      .map((e) => `${e.direction === "in" ? "+" : "−"}${L.fromCents(e.amountCents)}  ${e.note ?? "(ไม่มีชื่อ)"}`)
      .join("\n") + (entries.length > IMPORT_PREVIEW_ROWS ? `\n… และอีก ${entries.length - IMPORT_PREVIEW_ROWS} รายการ` : ""),
    notes: [
      format === "csv" ? "อ่านเป็นตาราง (CSV)" : "อ่านแบบบรรทัดละรายการ",
      ...(truncated ? [`ไฟล์ยาวเกิน — อ่านแค่ ${MAX_ROWS} แถวแรก อีก ${truncated} แถวไม่ได้อ่าน`] : []),
      ...(skipped.length ? [`อ่านไม่ออก ${skipped.length} บรรทัด: ${skipped.map((s) => `“${s}”`).join(" · ")}`] : []),
      "ยังไม่ได้บันทึกอะไร — กดยืนยันก่อน",
    ],
    actions: [
      { label: `✅ บันทึกทั้ง ${entries.length} รายการ`, data: "act=import", primary: true },
      { label: "❌ ไม่เอา", data: "act=importx" },
    ],
    altText: `พบ ${entries.length} รายการในไฟล์ ${filename} — ยืนยันก่อนบันทึก`,
  });
}

/** entry จากไฟล์ → รูปแบบที่ findDuplicate เข้าใจ (ใช้ยอด+เวลาเทียบแบบ fuzzy) */
const asParsed = (e) => ({
  amount: L.fromCents(e.amountCents),
  date: e.occurredAt ? e.occurredAt.slice(0, 10) : null,
  time: e.occurredAt?.length > 10 ? e.occurredAt.slice(11, 16) : null,
});

async function runImport(event, userId) {
  const job = pending.take(userId);      // ดึงแล้วลบทันที — กดยืนยันซ้ำต้องไม่บันทึกสองรอบ
  if (!job) {
    return respond(event, card({
      title: "ไม่มีไฟล์ที่รอยืนยันแล้ว", emoji: "⌛", tone: "warn",
      text: "คำขอหมดอายุไปแล้ว (เก็บไว้ 10 นาที) ส่งไฟล์เข้ามาใหม่ได้เลยครับ",
    }));
  }

  let saved = 0, dup = 0, failed = 0;
  for (const e of job.entries) {
    // กันซ้ำเท่าที่ทำได้: ยอดตรงและเวลาห่างไม่เกิน 2 นาที = รายการเดิม
    // (ใช้ได้เฉพาะแถวที่มีวันที่ — ไฟล์ที่ไม่มีคอลัมน์วันที่จะกันซ้ำไม่ได้ ซึ่งบอกไว้บนการ์ดแล้ว)
    if (e.occurredAt && L.findDuplicate(userId, { parsed: asParsed(e) })) { dup++; continue; }
    const rec = L.recordEntry(userId, e, { occurredAt: e.occurredAt });
    if (!rec.ok) { failed++; continue; }
    saved++;
    // หมวดจากไฟล์ต้องมาก่อนที่ระบบเดาเอง — ผู้ใช้จัดมาแล้วในไฟล์ต้นทาง
    if (e.category) L.setCategory(userId, rec.txnId, e.category);
  }

  const left = L.countTxns(userId, { status: "pending" });
  return respond(event, card({
    title: saved ? `นำเข้า ${saved} รายการแล้ว` : "ไม่ได้นำเข้าอะไรเลย",
    emoji: saved ? "📥" : "⚠️", tone: saved ? "success" : "warn",
    rows: [
      { label: "ไฟล์", value: job.filename },
      { label: "บันทึกแล้ว", value: `${saved} รายการ`, strong: true },
      ...(dup ? [{ label: "ซ้ำกับที่มีอยู่", value: `${dup} รายการ` }] : []),
      ...(failed ? [{ label: "บันทึกไม่ได้", value: `${failed} รายการ` }] : []),
    ],
    text: dup ? "รายการที่ยอดและเวลาตรงกับของเดิมถูกข้ามให้ ไม่นับซ้ำ" : "",
    actions: [
      { label: "🧾 ดูรายการ", data: "act=list", primary: true },
      ...(left ? [{ label: `📝 ตรวจยอด ${left} รายการ`, data: "act=list&s=pending" }] : []),
      { label: "📊 ดูสรุป", data: "act=summary" },
    ],
    altText: `นำเข้า ${saved} รายการจาก ${job.filename}`,
  }));
}

// ---------- รายการ ----------

const LIST_LIMIT = 8;

/**
 * การ์ด "รายการ" พร้อมตัวกรอง — รับพารามิเตอร์เดียวกันทั้งจากปุ่มและจากข้อความ
 *   d = in|out           กรองรายรับ/รายจ่าย
 *   c = <ชื่อหมวด> | "-"  กรองหมวด ("-" = ยังไม่จัดหมวด)
 */
export function listMessage(userId, { d, c, s } = {}) {
  // ค่าจาก postback ผู้ใช้ปลอมได้ — รับเฉพาะที่รู้จัก ไม่งั้นตัวกรองที่ไม่มีจริง
  // จะให้ผลลัพธ์ว่างเปล่าแล้วดูเหมือนข้อมูลหาย
  // "unknown" ต้องกรองได้ด้วย — ส่งสลิปทีละหลายใบแล้วมีหลายใบที่ระบบเดาทิศทางไม่ออก
  // ถ้าหาไม่เจอเป็นกลุ่ม ผู้ใช้ต้องไล่กดทีละใบจากการ์ดเก่าที่เลื่อนหายไปแล้ว
  const dir = d === "in" || d === "out" || d === "unknown" ? d : null;
  const cat = c === "-" || isCategory(c) ? c : null;
  const pending = s === "pending";
  const f = { direction: dir, category: cat, status: pending ? "pending" : null };
  return txnListBubble(L.recentTxns(userId, LIST_LIMIT, f), L.fromCents,
                       { dir, cat, pending, total: L.countTxns(userId, f) });
}

/**
 * แปลง "รายการรายจ่าย" / "รายการ อาหาร" เป็นตัวกรอง
 * คืน null = คำที่ตามหลังไม่ใช่ตัวกรองที่รู้จัก → อย่าถือว่าเป็นคำสั่งรายการ
 * ปล่อยให้ตกไปให้ NLU จัดการ ไม่งั้นข้อความอย่าง "รายการนี้ผิด" จะถูกกลืน
 */
function listArgs(word) {
  if (!word) return {};
  if (/^(รายรับ|เข้า|in)$/i.test(word)) return { d: "in" };
  if (/^(รายจ่าย|ออก|out)$/i.test(word)) return { d: "out" };
  if (isCategory(word)) return { c: word };
  return null;
}

// ---------- สรุป ----------

// export เพื่อให้เทสเรียกตรงได้ — การ์ด "ไม่มีรายการ" เคยกลืนยอดที่อยู่นอกช่วงมาแล้ว
export function summaryMessage(userId, range = "month") {
  let from, to, title;
  // ปุ่มเลื่อนเดือนใช้ได้เฉพาะตอนดูเป็นรายเดือน — "สัปดาห์นี้"/"ทั้งหมด" เลื่อนเดือนไม่ได้
  const monthly = range === "month" || /^\d{4}-\d{2}$/.test(range);
  if (range === "week") {
    [from, to] = thisWeek(); title = "สรุปสัปดาห์นี้";
  } else if (range === "all") {
    const r = L.fullRange(userId);
    if (!r) { [from, to] = thisMonth(); } else { [from, to] = r; }
    title = "สรุปทั้งหมด";
  } else if (/^\d{4}-\d{2}$/.test(range)) {
    from = `${range}-01`;
    // วันสุดท้ายของเดือน: วันที่ 0 ของเดือนถัดไป
    const [y, mo] = range.split("-").map(Number);
    to = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    title = `สรุปเดือน ${range}`;
  } else {
    [from, to] = thisMonth(); title = "สรุปเดือนนี้";
  }
  const s = { ...L.summary(userId, from, to), title };
  if (!s.income_n && !s.expense_n && !s.unknown_n) {
    // ⚠️ ต้องบอกด้วยว่ามีรายการอยู่ "นอกช่วง" ไหม
    // เดิมการ์ดนี้ทิ้ง outside_n ไปเฉย ๆ ผู้ใช้จึงเห็นแค่ "ยังไม่มีข้อมูล"
    // ทั้งที่เพิ่งบันทึกยอดไปเมื่อครู่ → ดูเหมือนเงินหาย (ผู้ใช้แจ้งมาจริง)
    if (s.outside_n) {
      return card({
        title: monthly ? `${thaiMonth(from)} ยังไม่มีรายการ` : "ช่วงนี้ยังไม่มีรายการ",
        emoji: "📊", tone: "warn",
        text: `ช่วง ${from} – ${to} ไม่มีข้อมูล\nแต่ยอดของคุณไม่ได้หายไปไหนครับ`,
        rows: [
          { label: "มีอยู่นอกช่วงนี้", value: `${s.outside_n} รายการ` },
          ...(s.outside_oldest
            ? [{ label: "ช่วงที่มีข้อมูล", value: `${s.outside_oldest} – ${s.outside_newest}` }]
            : []),
        ],
        notes: ["สลิปจะลงวันที่ตามที่พิมพ์บนใบ ซึ่งอาจเป็นเดือนก่อน"],
        // ⚠️ ต้องมีปุ่มเลื่อนเดือนเหมือน summaryBubble ไม่งั้นพอเลื่อนไปเจอเดือนว่าง
        // จะตันอยู่ตรงนั้น เลื่อนต่อไม่ได้ ต้องพิมพ์ "สรุป YYYY-MM" เองถึงจะออกมาได้
        actions: [
          { label: "📚 ดูสรุปทั้งหมด", data: "act=sum&r=all", primary: true },
          ...(monthly ? [[
            { label: "◀ เดือนก่อน", data: `act=sum&m=${shiftMonth(from, -1)}` },
            { label: "เดือนถัดไป ▶", data: `act=sum&m=${shiftMonth(from, 1)}` },
          ]] : []),
          { label: "🧾 ดูรายการล่าสุด", data: "act=list" },
        ],
      });
    }
    return card({
      title: "ยังไม่มีรายการ", emoji: "📊", tone: "info",
      text: `ช่วง ${from} – ${to} ยังไม่มีข้อมูลครับ`,
      rows: [{ label: "เริ่มยังไง", value: "ส่งรูปสลิป หรือพิมพ์ “กาแฟ 60”" }],
    });
  }
  return summaryBubble(s, L.fromCents);
}

// ---------- postback (ปุ่มในการ์ด / quick reply) ----------

async function handlePostback(event) {
  const userId = event.source?.userId;
  const p = new URLSearchParams(event.postback?.data || "");
  const act = p.get("act");
  const id = Number(p.get("id"));

  // ปุ่มที่เติมข้อความให้ (fillInText) — ต้องตอบด้วย ไม่งั้นผู้ใช้เห็นแค่ช่องพิมพ์
  // มีข้อความค้างแล้วไม่รู้ว่าต้องทำอะไรต่อ (เจอมาแล้วตอนใช้จริง)
  if (act === "prompt") {
    const kind = p.get("kind");
    if (kind === "edit") {
      const t = L.getTxn(userId, id);
      return respond(event, card({
        title: `แก้ยอดรายการ #${id}`, emoji: "✏️", tone: "info",
        rows: t ? [{ label: "ยอดปัจจุบัน", value: `${L.fromCents(t.amount_cents)} บาท` }] : [],
        text: `ผมเติม “แก้ ${id} ” ไว้ในช่องพิมพ์ให้แล้ว\nพิมพ์ยอดใหม่ต่อท้าย แล้วกดส่งได้เลย\n\nเช่น “แก้ ${id} 250”`,
      }));
    }
    if (kind === "budget") {
      return respond(event, card({
        title: "ตั้งงบ", emoji: "📌", tone: "info",
        text: "ผมเติม “งบ ” ไว้ในช่องพิมพ์ให้แล้ว\nพิมพ์จำนวนเงินต่อท้าย แล้วกดส่ง\n\nเช่น “งบ 20000”",
      }));
    }
    return;
  }
  if (act === "noop") return;
  if (act === "summary") return respond(event, summaryMessage(userId));
  if (act === "sum") {
    const r = p.get("r") ?? p.get("m");             // r=all|week|month หรือ m=YYYY-MM
    return respond(event, summaryMessage(userId, r ?? "month"));
  }
  if (act === "askdir") {
    const t = L.getTxn(userId, id);
    if (!t) return respond(event, notFoundCard(id));
    return respond(event, askDirection(id, L.fromCents(t.amount_cents)));
  }
  // ปิดอยู่ = ทำเหมือนไม่มี action นี้ ไม่งั้นปุ่มเก่าในแชทที่เลื่อนขึ้นไปยังกดได้
  if (act === "export") {
    if (!config.exportEnabled) return;
    return respond(event, exportCard(userId));
  }
  if (act === "settings") return respond(event, settingsCard(userId));

  // --- Google Sheet ---
  if (act === "sheet" || act === "sheetsync" || act === "sheetoff" || act === "sheetauto") {
    if (!config.sheetsEnabled) return;      // ปิดอยู่ = ทำเหมือนไม่มีปุ่มนี้ (ปุ่มเก่าในแชทยังกดได้)
    if (act === "sheetauto") {
      if (!L.sheetLink(userId)) return respond(event, sheetHelpCards());
      const on = !L.sheetAuto(userId);
      L.setPref(userId, "sheet_auto", on ? "on" : "off");
      const waiting = L.sheetQueueDepth(userId);
      // เปิดอัตโนมัติทั้งที่มีของค้าง → ส่งให้เลย ไม่ต้องรอรอบถัดไป
      if (on && waiting) await syncNow(userId);
      return respond(event, card({
        title: on ? "เปิดอัปเดตอัตโนมัติแล้ว" : "ปิดอัปเดตอัตโนมัติแล้ว",
        emoji: on ? "▶️" : "⏸", tone: "success",
        text: on
          ? "ทุกรายการใหม่จะขึ้นชีตให้เองภายในไม่กี่วินาที"
          : "รายการใหม่จะถูกเก็บไว้ก่อน แล้วส่งขึ้นชีตทีเดียวตอนคุณกดปุ่ม\n"
            + "ไม่มีอะไรหาย และประหยัดโควตาเรียก Google ด้วย",
        rows: on && waiting ? [{ label: "ส่งของที่ค้างให้แล้ว", value: `${waiting} รายการ` }] : [],
        actions: [{ label: "📗 ดูสถานะชีต", data: "act=sheet", primary: true }],
      }));
    }
    if (act === "sheetoff") {
      const had = L.unlinkSheet(userId);
      return respond(event, card({
        title: had ? "เลิกเชื่อมชีตแล้ว" : "ยังไม่ได้เชื่อมชีตอยู่แล้ว",
        emoji: "🔌", tone: "neutral",
        // ต้องบอกให้ชัดว่าเราไม่ได้ลบอะไรบนชีตให้ — ผู้ใช้อาจเข้าใจว่า "เลิกเชื่อม"
        // แปลว่าข้อมูลบนนั้นหายไปด้วย แล้วปล่อยข้อมูลการเงินค้างอยู่โดยไม่รู้ตัว
        text: had ? "หยุดส่งข้อมูลขึ้นชีตแล้ว\nข้อมูลที่ขึ้นไปก่อนหน้ายังอยู่บนชีตของคุณ ลบเองได้เลย" : "",
        actions: [{ label: "⚙️ กลับไปตั้งค่า", data: "act=settings", primary: true }],
      }));
    }
    if (act === "sheetsync") {
      if (!L.sheetLink(userId)) return respond(event, sheetHelpCards());
      const r = await syncNow(userId);
      return respond(event, r.error
        ? card({ title: "sync ไม่ผ่าน", emoji: "⚠️", tone: "warn",
                 text: "ส่วนใหญ่เกิดจากยังไม่ได้แชร์ชีตให้อีเมลของระบบ (สิทธิ์ “ผู้แก้ไข”)",
                 notes: [r.error],
                 actions: [{ label: "🔄 ลองใหม่", data: "act=sheetsync", primary: true }] })
        : card({ title: "sync เรียบร้อย", emoji: "✅", tone: "success",
                 rows: [{ label: "เขียนทับ", value: `${r.updated ?? 0} แถว` },
                        { label: "เพิ่มใหม่", value: `${r.added ?? 0} แถว` }],
                 actions: [{ label: "📗 ดูสถานะชีต", data: "act=sheet", primary: true }] }));
    }
    return respond(event, sheetStatusCard(userId));
  }
  if (act === "forgetacct") {
    const n = L.forgetAccounts(userId);
    return respond(event, card({
      title: "ลืมบัญชีที่จำไว้แล้ว", emoji: "🔄", tone: "success",
      rows: [{ label: "ลบไป", value: `${n} บัญชี` }],
      text: "สลิปใบถัดไปผมจะถามใหม่ว่าคุณเป็นผู้โอนหรือผู้รับ\nรายการที่บันทึกไปแล้วไม่เปลี่ยน",
      actions: [{ label: "⚙️ กลับไปตั้งค่า", data: "act=settings", primary: true }],
    }));
  }
  if (act === "weekly") {
    const on = L.getPref(userId, "weekly") === "on";
    L.setPref(userId, "weekly", on ? "off" : "on");
    return respond(event, settingsCard(userId));
  }
  // --- แอดมินตัดสินคำขอ ---
  if (act === "acc") {
    // ⚠️ ต้องเช็คสิทธิ์ที่นี่ให้ได้ ไม่งั้นใครก็ยิง postback มาอนุมัติตัวเองได้
    // (ผู้ใช้ที่ได้รับอนุมัติแล้วก็ไม่มีสิทธิ์อนุมัติคนอื่น — แอดมินเท่านั้น)
    if (!isAdmin(userId)) return;
    const target = p.get("u");
    const okv = p.get("v") === "ok";
    if (!target || !L.decideAccess(target, okv ? "approved" : "rejected", userId)) {
      return respond(event, card({
        title: "ไม่พบคำขอนี้", emoji: "❓", tone: "warn",
        text: "อาจถูกตัดสินไปแล้ว หรือผู้ใช้ยกเลิกไป",
        actions: [{ label: "📋 ดูคำขอที่ค้าง", text: "คำขอ" }],
      }));
    }
    // แจ้งเจ้าตัว — ถ้าโควตาหมดก็ข้าม เขาจะรู้เองตอนทักบอทครั้งต่อไป
    if (quota().left > 0) {
      try {
        await pushTo(target, card({
          title: okv ? "ได้รับสิทธิ์แล้ว" : "ไม่ได้รับสิทธิ์",
          emoji: okv ? "🎉" : "🔒", tone: okv ? "success" : "warn",
          text: okv ? "เริ่มใช้งานได้เลยครับ ส่งรูปสลิปหรือพิมพ์ “ช่วยเหลือ” ดูวิธีใช้"
                    : "ผู้ดูแลไม่อนุมัติคำขอของคุณครับ",
          altText: okv ? "ได้รับสิทธิ์ใช้งานแล้ว" : "ไม่ได้รับสิทธิ์ใช้งาน",
        }));
        L.logPush(target, "access");
      } catch (err) { console.error(`[แจ้งผลไม่ได้] ${err.message}`); }
    }
    const left = L.accessList("pending").length;
    return respond(event, card({
      title: okv ? "อนุมัติแล้ว" : "ปฏิเสธแล้ว", emoji: okv ? "✅" : "🚫",
      tone: okv ? "success" : "neutral",
      rows: [{ label: "ผู้ใช้", value: L.accessName(target) || `…${target.slice(-8)}` },
             { label: "คำขอที่ค้าง", value: left ? `${left} รายการ` : "ไม่มีแล้ว" }],
      actions: left ? [{ label: "📋 ดูคำขอที่ค้าง", text: "คำขอ", primary: true }] : [],
    }));
  }

  if (act === "list") {
    return respond(event, listMessage(userId, { d: p.get("d"), c: p.get("c"), s: p.get("s") }));
  }
  if (act === "ok") {
    // ยืนยันว่ายอดที่ระบบอ่านมาถูก — เดิมพ้น pending ได้ทางเดียวคือ "แก้ยอด"
    // ซึ่งใช้ไม่ได้ถ้าเลขถูกอยู่แล้ว หมายเหตุบนการ์ดสรุปเลยค้างตลอดไป
    if (!L.confirmTxn(userId, id)) return respond(event, notFoundCard(id));
    const t = L.getTxn(userId, id);
    const left = L.countTxns(userId, { status: "pending" });
    return respond(event, card({
      title: "ยืนยันแล้ว", emoji: "✅", tone: "success",
      rows: [
        { label: "รายการ", value: `#${t.id}` },
        { label: "ยอด", value: `${L.fromCents(t.amount_cents)} บาท` },
        { label: "เหลือรอตรวจ", value: left ? `${left} รายการ` : "ไม่มีแล้ว" },
      ],
      text: left ? "ยังมีรายการที่ต้องตรวจอยู่" : "ตรวจครบทุกรายการแล้ว",
      actions: [
        left
          ? { label: "📝 ดูที่เหลือ", data: "act=list&s=pending", primary: true }
          : { label: "🧾 กลับไปรายการ", data: "act=list", primary: true },
        { label: "📊 ดูสรุป", data: "act=summary" },
      ],
    }));
  }
  // --- นำเข้าจากไฟล์ ---
  if (act === "import") return runImport(event, userId);
  if (act === "importx") {
    pending.drop(userId);
    return respond(event, card({
      title: "ยกเลิกการนำเข้าแล้ว", emoji: "👌", tone: "neutral",
      text: "ไม่ได้บันทึกอะไรลงไปครับ ส่งไฟล์ใหม่เข้ามาได้ตลอด",
    }));
  }

  if (act === "listcat") {
    return respond(event, categoryPickerBubble(L.categoryTotals(userId), L.fromCents));
  }

  // --- หมวดหมู่ ---
  if (act === "cat") {
    const c = p.get("c");
    // ค่ามาจาก postback ซึ่งผู้ใช้ปลอมได้ — ต้องอยู่ในรายการที่รู้จักเท่านั้น
    // ไม่งั้นจะมีหมวดแปลกปลอมโผล่ในสรุปและงบรายหมวดไปตลอด
    if (!isCategory(c)) return respond(event, notFoundCard(id));
    const was = L.getTxn(userId, id)?.category ?? null;
    if (!L.setCategory(userId, id, c)) return respond(event, notFoundCard(id));
    const t = L.getTxn(userId, id);
    return respond(event, card({
      title: was ? `เปลี่ยนหมวดเป็น ${labelOf(c)} แล้ว` : `จัดเป็นหมวด ${labelOf(c)} แล้ว`,
      emoji: "📂", tone: "success",
      rows: [
        { label: "รายการ", value: `#${t.id}` },
        { label: "ยอด", value: `${L.fromCents(t.amount_cents)} บาท` },
        // บอกของเดิมด้วยตอนเปลี่ยน — ผู้ใช้จะได้รู้ว่ากดถูกตัวและกดกลับได้ถ้าพลาด
        ...(was && was !== c ? [{ label: "จากเดิม", value: labelOf(was) }] : []),
      ],
      text: "จำไว้ให้แล้ว — รายการคล้ายกันครั้งหน้าผมจัดหมวดนี้ให้เอง",
      actions: [
        { label: "🧾 กลับไปรายการ", data: "act=list", primary: true },
        { label: "📌 ตั้งงบหมวดนี้", fill: `งบ ${c} `, data: "act=prompt&kind=budget" },
        { label: "📊 ดูสรุป", data: "act=summary" },
      ],
    }));
  }
  if (act === "catpick") {
    const t = L.getTxn(userId, id);
    if (!t) return respond(event, notFoundCard(id));
    return respond(event, card({
      title: t.category ? "เปลี่ยนหมวด" : "เลือกหมวด", emoji: "📂", tone: "info",
      rows: [
        { label: "รายการ", value: `#${t.id}` },
        { label: "ยอด", value: `${L.fromCents(t.amount_cents)} บาท` },
        ...(t.note || t.counterparty ? [{ label: "รายละเอียด", value: t.note || t.counterparty }] : []),
        ...(t.category ? [{ label: "หมวดตอนนี้", value: labelOf(t.category) }] : []),
      ],
      // { all: true } = โชว์ทุกหมวด เพราะเข้ามาถึงหน้านี้แปลว่าตั้งใจจะเลือกเองแล้ว
      // (หมวดที่เป็นอยู่ถูกตัดออกให้อัตโนมัติ กดซ้ำไม่มีประโยชน์)
      actions: [...categoryButtons(id, t.category, { all: true }),
                { label: "🧾 กลับไปรายการ", data: "act=list" }],
    }));
  }

  if (act === "skip") {
    return respond(event, card({
      title: "ไว้บอกทีหลังได้", emoji: "👌", tone: "neutral",
      text: "รายการนี้จะขึ้นว่า “ยังไม่ระบุ” จนกว่าจะบอกว่าเป็นรับหรือจ่าย",
      actions: [{ label: "🧾 ดูรายการ", text: "รายการ" }],
    }));
  }

  if (act === "dir") {
    const v = p.get("v");
    if (v !== "in" && v !== "out") return;
    const r = L.confirmDirection(userId, id, v);
    if (!r) return respond(event, notFoundCard(id));
    const t = L.getTxn(userId, id);
    const confirm = card({
      title: `บันทึกเป็น${DIR_LABEL[v]}แล้ว`, emoji: v === "in" ? "💰" : "💸", tone: "success",
      big: t ? L.fromCents(t.amount_cents) : undefined, bigLabel: t ? DIR_LABEL[v] : undefined,
      rows: [
        // ไม่มีวันที่บนใบ = ลงตามวันที่บันทึก ต้องบอก ไม่งั้นผู้ใช้หาไม่เจอในสรุป
        { label: "ลงวันที่", value: t?.occurred_at ?? "ตามวันที่บันทึก (อ่านวันที่บนสลิปไม่ออก)" },
        t?.category ? { label: "หมวด", value: labelOf(t.category) } : null,
      ],
      text: r.learned
        ? "จำบัญชีคุณไว้แล้ว ครั้งต่อไปไม่ต้องถามอีก\n(ถ้าเดาผิด กด “ตั้งค่า” แล้วลืมบัญชีที่จำไว้ได้)"
        : undefined,
      actions: [
        // ต้องกลับได้เสมอ — กดผิดปุ่มเดียวแล้วยอดไปอยู่ผิดฝั่งทั้งสรุปทั้งงบ
        { label: v === "in" ? "🔁 ที่จริงเป็นรายจ่าย" : "🔁 ที่จริงเป็นรายรับ",
          data: `act=dir&id=${id}&v=${v === "in" ? "out" : "in"}` },
        ...(v === "out" ? categoryButtons(id, t?.category) : []),
        { label: "📊 ดูสรุป", data: "act=summary" },
      ],
    });
    const ask = periodAskIfNeeded(userId, id);
    if (ask) return respond(event, [confirm, ask]);

    // ส่งมาหลายใบแล้วเดาทิศทางไม่ออกหลายใบ → ถามใบถัดไปต่อเลย
    // ไม่งั้นผู้ใช้ต้องกลับไปหาการ์ดสรุปที่เลื่อนขึ้นไปแล้วกดใหม่ทุกใบ
    const next = L.recentTxns(userId, 1, { direction: "unknown" })[0];
    if (next) return respond(event, [confirm, askDirection(next.id, L.fromCents(next.amount_cents))]);
    return respond(event, confirm);
  }

  if (act === "del") {
    if (!L.deleteTxn(userId, id)) return respond(event, notFoundCard(id));
    return respond(event, card({
      title: `ลบรายการ #${id} แล้ว`, emoji: "🗑", tone: "success",
      text: "เอาออกจากยอดรวมให้แล้วครับ",
      actions: [{ label: "📊 ดูสรุป", data: "act=summary" }],
    }));
  }

  if (act === "period") {
    const v = p.get("v");
    const t = L.getTxn(userId, id);
    if (!t) return respond(event, notFoundCard(id));
    let at;
    if (v === "now") {
      at = nowLocal();                    // เวลาไทย ไม่ใช่ UTC — ดู nowLocal() ใน db.js
    } else {
      at = L.slipOccurredAt(userId, id) ?? t.occurred_at;   // ย้อนกลับไปวันที่บนสลิป
    }
    L.setOccurredAt(userId, id, at);
    return respond(event, card({
      title: `ลงยอดไว้เดือน ${thaiMonth(at.slice(0, 10))} แล้ว`, emoji: "📅", tone: "success",
      rows: [{ label: "วันที่", value: at }],
      text: v === "now"
        ? "จะนับรวมใน “สรุป” ของเดือนนี้"
        : "ตรงตามวันที่บนสลิป — ดูได้ที่ “สรุปทั้งหมด”",
      actions: [{ label: "📊 สรุปเดือนนี้", data: "act=summary" },
                { label: "📅 สรุปทั้งหมด", text: "สรุปทั้งหมด" }],
    }));
  }

  if (act === "confirmwipe") {
    const c = L.deleteAllData(userId);
    return respond(event, card({
      title: "ลบข้อมูลเรียบร้อย", emoji: "🗑", tone: "success",
      rows: [{ label: "ธุรกรรม", value: `${c.txns}` }, { label: "สลิป", value: `${c.slips}` },
             { label: "บัญชี", value: `${c.accounts}` }],
      text: "ถ้าจะใช้งานอีก พิมพ์ “ยินยอม” ได้เลย",
    }));
  }
}

// ---------- ข้อความ ----------

async function handleText(event) {
  const text = (event.message.text || "").trim();
  const userId = event.source?.userId;

  // --- ความยินยอม (PDPA) ---
  if (/^(ยินยอม|ยอมรับ|ตกลง|consent|agree)$/i.test(text)) {
    L.grantConsent(userId);
    return respond(event, [
      card({ title: "เริ่มบันทึกให้แล้ว", emoji: "✅", tone: "success",
             text: "ขอบคุณครับ — ส่งสลิปหรือพิมพ์รายการเข้ามาได้เลย" }),
      helpCard(),
    ]);
  }
  if (/^ลบข้อมูลของฉัน$/.test(text)) {
    const c = L.countUserRows(userId);
    return respond(event, card({
      title: "ยืนยันลบข้อมูลทั้งหมด?", emoji: "⚠️", tone: "danger",
      text: "ลบแล้วกู้คืนไม่ได้",
      rows: [{ label: "ธุรกรรม", value: `${c.txns}` }, { label: "สลิป", value: `${c.slips}` },
             { label: "งบ", value: `${c.budgets}` }],
      actions: [{ label: "🗑 ยืนยันลบทั้งหมด", data: "act=confirmwipe", primary: true }],
    }));
  }
  if (/^ยืนยันลบ$/.test(text)) {
    const c = L.deleteAllData(userId);
    return respond(event, card({
      title: "ลบข้อมูลเรียบร้อย", emoji: "🗑", tone: "success",
      rows: [{ label: "ธุรกรรม", value: `${c.txns}` }, { label: "สลิป", value: `${c.slips}` }],
      text: "ถ้าจะใช้งานอีก พิมพ์ “ยินยอม” ได้เลย",
    }));
  }
  if (/^(ข้อมูลของฉัน|my data)$/i.test(text)) {
    const u = L.getUser(userId);
    if (!u?.consent_at) return respond(event, consentCard("ยังไม่ได้เก็บข้อมูลอะไรของคุณเลย"));
    const c = L.countUserRows(userId);
    return respond(event, [card({
      title: "ข้อมูลที่เก็บไว้", emoji: "🔒", tone: "info",
      rows: [
        { label: "ธุรกรรม", value: `${c.txns} รายการ` },
        { label: "สลิป", value: `${c.slips} ใบ (ไม่เก็บรูป)` },
        { label: "บัญชีที่จำไว้", value: `${c.accounts}` },
        { label: "หมวดที่จำไว้", value: `${c.hints}` },
        { label: "ให้ความยินยอม", value: u.consent_at.slice(0, 10) },
      ],
      // ID ของเจ้าตัวเป็นกุญแจที่ผูกข้อมูลทุกแถวเข้ากับคน จึงควรอยู่ในหน้า
      // "ข้อมูลที่เก็บไว้" ตามหลัก PDPA อยู่แล้ว และเป็นวิธีเดียวที่เจ้าของระบบ
      // จะรู้ ID ตัวเองไปใส่ ALLOWED_USERS โดยไม่ต้องเข้าไปงม log บนเซิร์ฟเวอร์
      // ตัวเลขจริงส่งเป็นข้อความธรรมดาใบถัดไป — ใน Flex คัดลอกไม่ได้
      text: "LINE ID ของคุณอยู่ในข้อความถัดไป (กดค้างเพื่อคัดลอก)",
      actions: [
        ...(config.exportEnabled && config.publicUrl ? [{ label: "📤 ส่งออก CSV", data: "act=export" }] : []),
        { label: "⚙️ ตั้งค่า", data: "act=settings" },
        { label: "🗑 ลบข้อมูลทั้งหมด", text: "ลบข้อมูลของฉัน" },
      ],
    }), { type: "text", text: userId }]);
  }

  // --- ดูยอด ---
  if (/^(สรุป|สรุปเดือนนี้|summary)$/i.test(text)) {
    if (!L.hasConsent(userId)) return respond(event, consentCard());
    return respond(event, summaryMessage(userId, "month"));
  }
  if (/^(สรุปทั้งหมด|สรุปย้อนหลัง|all)$/i.test(text)) {
    if (!L.hasConsent(userId)) return respond(event, consentCard());
    return respond(event, summaryMessage(userId, "all"));
  }
  {
    const mm = /^สรุป\s+(\d{4})-(\d{2})$/.exec(text);
    if (mm) {
      if (!L.hasConsent(userId)) return respond(event, consentCard());
      return respond(event, summaryMessage(userId, `${mm[1]}-${mm[2]}`));
    }
  }
  if (/^(สรุปสัปดาห์|สรุปอาทิตย์นี้)$/i.test(text)) {
    if (!L.hasConsent(userId)) return respond(event, consentCard());
    return respond(event, summaryMessage(userId, "week"));
  }
  // "รายการ" เฉย ๆ หรือ "รายการรายจ่าย" / "รายการ อาหาร" — พิมพ์กรองได้เลยไม่ต้องกดสองที
  const lm = /^(?:รายการ(?:ล่าสุด)?|list)\s*(\S*)$/i.exec(text);
  if (lm) {
    const a = listArgs(lm[1]);
    if (a) {
      if (!L.hasConsent(userId)) return respond(event, consentCard());
      return respond(event, listMessage(userId, a));
    }
  }

  // --- แก้ / ลบ ---
  if (/^ลบ\s*$/.test(text)) {
    return respond(event, card({
      title: "ลบรายการไหนครับ?", emoji: "🗑", tone: "warn",
      text: "กดปุ่ม “ลบ” ในรายการได้เลย ไม่ต้องพิมพ์เลขเอง",
      actions: [{ label: "🧾 ดูรายการล่าสุด", data: "act=list", primary: true }],
    }));
  }

  let m = /^ลบ\s+#?(\d+)$/.exec(text);
  if (m) {
    const id = Number(m[1]);
    if (!L.deleteTxn(userId, id)) return respond(event, notFoundCard(id));
    return respond(event, card({
      title: `ลบรายการ #${id} แล้ว`, emoji: "🗑", tone: "success",
      actions: [{ label: "🧾 ดูรายการ", text: "รายการ" }],
    }));
  }

  // "แก้ 12" (ไม่มียอด) — ต้องดักไว้ ไม่งั้นตกไป NLU แล้วสร้างรายการ 12 บาทชื่อ "แก้"
  m = /^แก้\s*#?(\d*)\s*$/.exec(text);
  if (m) {
    const id = m[1] ? Number(m[1]) : null;
    const t = id ? L.getTxn(userId, id) : null;
    return respond(event, card({
      title: id ? `แก้ยอดรายการ #${id}` : "แก้ยอดรายการ", emoji: "✏️", tone: "warn",
      rows: t ? [{ label: "ยอดปัจจุบัน", value: `${L.fromCents(t.amount_cents)} บาท` }] : [],
      text: id
        ? `ยังไม่ได้ใส่ยอดใหม่ครับ — พิมพ์ “แก้ ${id} 250” (แทน 250 ด้วยยอดที่ต้องการ)`
        : "พิมพ์แบบนี้ครับ: “แก้ <เลขรายการ> <ยอด>” เช่น “แก้ 12 250”",
      actions: [
        ...(id ? [{ label: `✏️ ใส่ยอดใหม่ให้ #${id}`, fill: `แก้ ${id} `,
                    data: `act=prompt&kind=edit&id=${id}`, primary: true }] : []),
        { label: "🧾 ดูรายการ", data: "act=list" },
      ],
    }));
  }

  m = /^แก้\s+#?(\d+)\s+([\d,]+(?:\.\d{1,2})?)$/.exec(text);
  if (m) {
    const id = Number(m[1]);
    const cents = L.toCents(m[2].includes(".") ? m[2] : `${m[2]}.00`);
    if (cents === null) return respond(event, errorMessage("อ่านยอดไม่ออกครับ"));
    if (!L.updateTxn(userId, id, { amountCents: cents })) return respond(event, notFoundCard(id));
    return respond(event, card({
      title: `แก้รายการ #${id} แล้ว`, emoji: "✏️", tone: "success",
      big: L.fromCents(cents), bigLabel: "ยอดใหม่",
      actions: [{ label: "🧾 ดูรายการ", text: "รายการ" }],
    }));
  }

  // --- งบประมาณ ---
  m = /^งบ(?:\s+(\S+?))?\s+([\d,]+(?:\.\d{1,2})?)$/.exec(text);
  if (m) {
    const cat = m[1] || "*";
    const cents = L.toCents(m[2].includes(".") ? m[2] : `${m[2]}.00`);
    if (cents === null) return respond(event, errorMessage("อ่านยอดไม่ออกครับ"));
    L.setBudget(userId, cents, cat);
    // บอกสถานะ ณ ตอนนี้เลย — ตั้งงบทั้งที่ใช้ไปแล้ว 94% แต่การ์ดตอบว่า
    // "จะเตือนเมื่อใช้ถึง 80%" เฉย ๆ ทำให้ผู้ใช้นั่งรอการเตือนที่ควรมาตั้งแต่วินาทีนั้น
    const [bf, bt] = thisMonth();
    const now = L.budgetStatus(userId, bf, bt, 0).find((s) => s.category === cat);
    const pct = now ? Math.round(now.ratio * 100) : 0;
    return respond(event, card({
      title: "ตั้งงบแล้ว", emoji: "📌",
      tone: now?.over ? "danger" : pct >= 80 ? "warn" : "success",
      big: L.fromCents(cents), bigLabel: cat === "*" ? "งบรวมทั้งเดือน" : `งบหมวด “${cat}”`,
      rows: now ? [{ label: "ใช้ไปแล้วเดือนนี้",
                     value: `${L.fromCents(now.used_cents)} บาท (${pct}%)`, strong: now.over }] : [],
      text: now?.over
        ? `เกินงบไปแล้ว ${L.fromCents(now.used_cents - cents)} บาทครับ`
        : pct >= 80
          ? `เหลืออีก ${L.fromCents(cents - now.used_cents)} บาท`
          : "จะเตือนเมื่อใช้ถึง 80% และตอนเกิน",
      actions: [{ label: "📌 ดูงบทั้งหมด", text: "งบ" },
                { label: "📊 ดูสรุป", data: "act=summary" }],
    }));
  }

  if (/^(งบ|budget)$/i.test(text)) {
    const bs = L.getBudgets(userId);
    if (!bs.length) {
      return respond(event, card({
        title: "ยังไม่ได้ตั้งงบ", emoji: "📌", tone: "info",
        text: "ตั้งงบแล้วผมจะเตือนเมื่อใช้ถึง 80% และตอนเกิน",
        actions: [{ label: "📌 ตั้งงบรวมทั้งเดือน", fill: "งบ ", data: "act=prompt&kind=budget", primary: true },
                  { label: "📌 ตั้งงบรายหมวด", fill: "งบ อาหาร ", data: "act=prompt&kind=budget" }],
      }));
    }
    const [from, to] = thisMonth();
    const st = L.budgetStatus(userId, from, to, 0);   // 0 = เอาทุกงบมาแสดง
    const worst = st.reduce((a, b) => (b.ratio > (a?.ratio ?? -1) ? b : a), null);
    return respond(event, card({
      // สีการ์ดต้องสะท้อนสถานะจริง — 94% ที่แสดงด้วยโทน info เดียวกับตอน 10%
      // ทำให้ผู้ใช้เลื่อนผ่านโดยไม่ทันสังเกต (เจอจริง: ตั้งใจดูว่าเกินยัง แต่ไม่เห็น)
      title: "งบเดือนนี้", emoji: "📌",
      tone: worst?.over ? "danger" : worst?.ratio >= 0.8 ? "warn" : "info",
      rows: bs.map((b) => {
        const s = st.find((x) => x.category === b.category);
        const pct = s ? Math.round(s.ratio * 100) : 0;
        return {
          label: b.category === "*" ? "รวมทั้งเดือน" : b.category,
          value: `${s ? L.fromCents(s.used_cents) : "0.00"} / ${L.fromCents(b.limit_cents)} (${pct}%)`,
          strong: s?.over,
        };
      }),
      notes: st.filter((s) => s.ratio >= 0.8).map((s) =>
        `${s.category === "*" ? "งบรวม" : s.category} ` +
        (s.over
          ? `เกินแล้ว ${L.fromCents(s.used_cents - s.limit_cents)} บาท`
          : `ใกล้เต็ม เหลืออีก ${L.fromCents(s.limit_cents - s.used_cents)} บาท`)),
      actions: [{ label: "📌 แก้งบรวม", fill: "งบ ", data: "act=prompt&kind=budget" },
                { label: "📊 ดูสรุป", data: "act=summary" }],
    }));
  }

  if (/^(เตือนรายสัปดาห์|สรุปรายสัปดาห์|weekly)$/i.test(text)) {
    const on = L.getPref(userId, "weekly") === "on";
    L.setPref(userId, "weekly", on ? "off" : "on");
    return respond(event, card({
      title: on ? "ปิดสรุปรายสัปดาห์แล้ว" : "เปิดสรุปรายสัปดาห์แล้ว",
      emoji: on ? "🔕" : "🔔", tone: on ? "neutral" : "success",
      text: on ? "พิมพ์ซ้ำเพื่อเปิดใหม่" : "จะส่งสรุปให้ทุกเช้าวันจันทร์ (พิมพ์ซ้ำเพื่อปิด)",
    }));
  }

  if (config.exportEnabled && /^(ส่งออก|export|csv)$/i.test(text)) {
    if (!L.hasConsent(userId)) return respond(event, consentCard());
    return respond(event, exportCard(userId));
  }
  // --- คำสั่งของแอดมิน ---
  // ทางถอยเวลาโควตา push หมดจนแจ้งเตือนไม่ออก — ดึงมาดูเองได้เสมอ
  if (isAdmin(userId) && /^(คำขอ|requests?)$/i.test(text)) {
    const pend = L.accessList("pending");
    if (!pend.length) {
      return respond(event, card({
        title: "ไม่มีคำขอค้าง", emoji: "✅", tone: "success",
        rows: [{ label: "ผู้ใช้ที่อนุมัติแล้ว", value: `${L.accessList("approved").length} คน` }],
        text: "คนที่ยังไม่มีสิทธิ์จะกดขอเข้ามาเอง แล้วผมจะแจ้งคุณทันที",
        actions: [{ label: "👥 ดูผู้ใช้ทั้งหมด", text: "ผู้ใช้" }],
      }));
    }
    return respond(event, pend.slice(0, 5).map((r) => requestCard(r.line_user_id, r.display_name)));
  }

  if (isAdmin(userId) && /^(ผู้ใช้|users?)$/i.test(text)) {
    const app = L.accessList("approved"), rej = L.accessList("rejected");
    return respond(event, card({
      title: "ผู้ใช้ที่มีสิทธิ์", emoji: "👥", tone: "info",
      rows: [
        { label: "จาก .env", value: `${config.adminUsers.size + config.allowedUsers.size} คน (แอดมิน/ถาวร)` },
        { label: "อนุมัติในแชท", value: `${app.length} คน` },
        { label: "ปฏิเสธไป", value: `${rej.length} คน` },
      ],
      // ถอนสิทธิ์ = ตั้งเป็น rejected ซึ่งทำได้จากปุ่มในการ์ดคำขอ
      // คนที่มาจาก .env ถอนจากในแชทไม่ได้ ต้องแก้ไฟล์ — ตั้งใจให้เป็นแบบนั้น
      notes: app.map((r) => `${r.display_name || "(ไม่มีชื่อ)"} · …${r.line_user_id.slice(-8)}`),
      text: app.length ? "" : "ยังไม่มีใครถูกอนุมัติจากในแชท",
      actions: [{ label: "📋 ดูคำขอที่ค้าง", text: "คำขอ" }],
      altText: `ผู้ใช้ที่มีสิทธิ์ ${app.length} คน`,
    }));
  }

  if (/^(ตั้งค่า|settings)$/i.test(text)) {
    if (!L.hasConsent(userId)) return respond(event, consentCard());
    return respond(event, settingsCard(userId));
  }
  if (/^(สถานะ|status|health)$/i.test(text)) {
    const h = await ocr.health();
    const q = quota();
    return respond(event, card({
      title: h.ok ? "ระบบพร้อมใช้งาน" : "ระบบอ่านสลิปไม่พร้อม",
      emoji: h.ok ? "✅" : "❌", tone: h.ok ? "success" : "danger",
      rows: [
        { label: "เครื่องอ่าน", value: h.ok ? (h.engine ?? "ocr") : (h.error ?? "-") },
        { label: "คิวตอนนี้", value: `${ahead()} งาน` },
        { label: "โควตาแจ้งเตือน", value: `เหลือ ${q.left}/${q.budget}` },
      ],
    }));
  }

  // --- Google Sheet ---
  //
  // ⚠️ ต้องดัก **ก่อน** NLU เสมอ — ลิงก์ชีตมีตัวเลขปนอยู่เต็มไปหมด
  // ("…/d/1AbC2…/edit#gid=0") ถ้าปล่อยตกไปถึง parseEntries จะกลายเป็น
  // "บันทึกรายจ่าย 1 บาท" ทันที ซึ่งเป็นบั๊กที่ผู้ใช้หาสาเหตุเองไม่ได้เลย
  if (config.sheetsEnabled) {
    if (/^(เลิกเชื่อมชีต|ยกเลิกชีต|unlink)$/i.test(text)) {
      const had = L.unlinkSheet(userId);
      return respond(event, card({
        title: had ? "เลิกเชื่อมชีตแล้ว" : "ยังไม่ได้เชื่อมชีตอยู่แล้ว", emoji: "🔌", tone: "neutral",
        text: had ? "ข้อมูลที่ขึ้นไปก่อนหน้ายังอยู่บนชีตของคุณ ลบเองได้เลย" : "",
      }));
    }
    if (/^(ชีต|เชื่อมชีต|sheets?|google ?sheets?)$/i.test(text)) {
      if (!L.hasConsent(userId)) return respond(event, consentCard());
      return respond(event, L.sheetLink(userId) ? sheetStatusCard(userId) : sheetHelpCards());
    }
    // รับทั้ง "เชื่อมชีต <ลิงก์>" และการวางลิงก์มาเฉย ๆ (คนส่วนใหญ่ทำอย่างหลัง)
    const asked = /^เชื่อมชีต\s+/i.test(text);
    const sid = (asked || /docs\.google\.com\/spreadsheets/.test(text))
      ? parseSheetId(text.replace(/^เชื่อมชีต\s+/i, ""))
      : null;
    if (sid) {
      if (!L.hasConsent(userId)) return respond(event, consentCard());
      // ⚠️ ชีตแผ่นเดียวห้ามถูกผูกโดยหลายคน
      //
      // "ลบข้อมูลของฉัน" ล้างชีตด้วย values:clear ทั้งช่วง A2:Z — ถ้าสองคนใช้แผ่นเดียวกัน
      // คนหนึ่งกดลบแล้วรายการของอีกคนหายไปด้วยโดยไม่มีอะไรในระบบรู้ว่าเกิดขึ้น
      // (แถวไม่ชนกันเพราะ txns.id ไม่ซ้ำข้ามผู้ใช้ มันจึง "ดูเหมือนใช้ได้" จนถึงวันนั้น)
      if (L.sheetTakenBy(sid, userId)) {
        return respond(event, card({
          title: "ชีตนี้มีคนใช้อยู่แล้ว", emoji: "🔒", tone: "warn",
          text: "ชีตหนึ่งแผ่นผูกได้กับคนเดียวครับ\n\n"
              + "สร้างชีตเปล่าขึ้นมาใหม่อีกไฟล์ แชร์ให้อีเมลเดิม แล้วส่งลิงก์ใหม่เข้ามาได้เลย",
          notes: ["ถ้าใช้แผ่นเดียวกัน เวลาใครสักคนสั่งลบข้อมูลตัวเอง รายการของอีกคนจะหายไปด้วย"],
          altText: "ชีตนี้มีผู้ใช้อื่นผูกไว้แล้ว",
        }));
      }
      const queued = L.linkSheet(userId, sid);
      const r = await syncNow(userId);      // ยิงทันที ผู้ใช้จะได้รู้ผลเดี๋ยวนี้ ไม่ต้องเดา
      if (r.error) {
        return respond(event, [card({
          title: "เชื่อมแล้ว แต่เขียนลงชีตไม่ได้", emoji: "⚠️", tone: "warn",
          text: "เกือบทุกครั้งเป็นเพราะยังไม่ได้แชร์ชีตให้อีเมลของระบบ\n"
              + "เปิดชีต → กด “แชร์” → วางอีเมลข้างล่าง → เลือก “ผู้แก้ไข”",
          notes: [r.error],
          actions: [{ label: "🔄 แชร์แล้ว ลองใหม่", data: "act=sheetsync", primary: true },
                    { label: "🔌 เลิกเชื่อม", data: "act=sheetoff" }],
        }), { type: "text", text: config.googleSaEmail }]);
      }
      return respond(event, card({
        title: "เชื่อมชีตเรียบร้อย", emoji: "📗", tone: "success",
        rows: [
          { label: "คัดลอกขึ้นชีต", value: `${queued} รายการ` },
          { label: "แท็บ", value: L.sheetLink(userId)?.tab ?? "-" },
        ],
        // ต้องบอกให้ชัดว่าเป็นโหมดกดเอง ไม่งั้นผู้ใช้จะรอชีตอัปเดตเองแล้วคิดว่าระบบพัง
        text: "ของเก่าเติมให้แล้ว ส่วนรายการใหม่จะถูกเก็บไว้ก่อน\nแล้วส่งขึ้นชีตทีเดียวตอนคุณกดปุ่ม “ส่งขึ้นชีตเลย”",
        notes: ["อยากให้ขึ้นเองทุกครั้ง เปิดอัปเดตอัตโนมัติได้ในหน้าสถานะชีต",
                "ชีตเป็นสำเนาทางเดียว — แก้ตัวเลขในชีตแล้วจะถูกเขียนทับ",
                "ลบข้อมูลของฉัน = ล้างข้อมูลบนชีตให้ด้วย"],
        actions: [
          { label: "📄 เปิดชีต", url: `https://docs.google.com/spreadsheets/d/${sid}/edit`, primary: true },
          { label: "📗 สถานะชีต", data: "act=sheet" },
        ],
        altText: `เชื่อม Google Sheet แล้ว — คัดลอก ${queued} รายการ`,
      }));
    }
  }

  if (userId && !L.hasConsent(userId)) {
    L.ensureUser(userId);
    return respond(event, consentCard());
  }

  // --- บันทึกจากข้อความ: "กาแฟ 60" / "จ่ายค่าไฟ 850" / "ได้เงินเดือน 30000" ---
  //
  // หลายรายการในข้อความเดียวได้ ถ้ามีตัวคั่นชัดเจน (ขึ้นบรรทัดใหม่ / จุลภาค / +)
  // ดูเหตุผลที่ไม่แยกจากช่องว่างเปล่า ๆ ที่ SPLIT ใน nlu.js
  const { entries, skipped, ambiguous } = parseEntries(text);

  if (entries.length > 1) {
    const saved = [];
    for (const e of entries) {
      const rec = L.recordEntry(userId, e);
      if (rec.ok) saved.push({ ...rec, note: e.note });
    }
    if (saved.length) {
      await respond(event, entriesCard(saved, skipped));
      return;
    }
  }

  const entry = entries[0] ?? null;
  if (entry) {
    const rec = L.recordEntry(userId, entry);
    if (rec.ok) {
      // ไม่ต้องเรียก notifyAfter ตรงนี้แล้ว — withAlerts ใน handleEvent ครอบให้ทั้ง handleText
      {
        const cat = L.getTxn(userId, rec.txnId)?.category ?? null;
        await respond(event, card({
          title: "บันทึกแล้ว", emoji: rec.direction === "in" ? "💰" : "💸", tone: "success",
          big: L.fromCents(rec.amountCents), bigLabel: DIR_LABEL[rec.direction],
          rows: [
            entry.note ? { label: "รายการ", value: entry.note } : null,
            cat ? { label: "หมวด", value: labelOf(cat) } : null,
          ],
          notes: [
            entry.guessed ? "ไม่มีคำว่า “จ่าย/ได้” ในข้อความ — ผมเดาให้เป็นรายจ่าย" : null,
            // มีตัวเลขหลายตัวแต่ไม่มีตัวคั่น → บันทึกรายการเดียวตามเดิม (เดาแยกเองอันตราย)
            // แต่ต้องบอกวิธี ไม่งั้นผู้ใช้ที่ตั้งใจพิมพ์หลายรายการจะไม่มีวันรู้ว่าทำได้
            ambiguous ? "ถ้าตั้งใจบันทึกหลายรายการ คั่นด้วยจุลภาค เช่น “กาแฟ 60, ข้าว 50”" : null,
          ].filter(Boolean),
          // เดาเอง → ให้ปุ่มแก้ทันที ดีกว่าบอกให้พิมพ์ใหม่
          actions: [
            ...(entry.guessed
              ? [{ label: "💰 เปลี่ยนเป็นรายรับ", data: `act=dir&id=${rec.txnId}&v=in`, primary: true },
                 { label: "💸 ยืนยันเป็นรายจ่าย", data: `act=dir&id=${rec.txnId}&v=out` }]
              : []),
            // รายรับไม่ต้องจัดหมวด — หมวดมีไว้คุมรายจ่าย (งบ/สรุปว่าใช้อะไรมากสุด)
            ...(rec.direction === "out" ? categoryButtons(rec.txnId, cat) : []),
            { label: "🗑 ลบรายการนี้", data: `act=del&id=${rec.txnId}` },
            { label: "📊 ดูสรุป", data: "act=summary" },
          ],
        }));
      }
      return;
    }
  }

  return respond(event, helpCard());
}

/** จุดเข้าเดียวจาก index.js — ทุก event ผ่านที่นี่ */
export async function handleEvent(event) {
  const userId = event.source?.userId;

  // --- ควบคุมสิทธิ์ใช้งาน ---
  //
  // ตรวจ **ก่อน** ensureUser() เพื่อไม่ให้คนนอกได้แถวใน DB ด้วยซ้ำ และก่อน rate limit
  // เพราะไม่มีเหตุผลจะจ่ายงานอะไรให้คนที่ไม่ได้รับอนุญาต
  //
  // ไม่ตั้งทั้ง ADMIN_USERS และ ALLOWED_USERS = เปิดให้ทุกคน (ค่าเริ่มต้นเดิม)
  if (isGated()) {
    // ไม่มี userId ก็บล็อก (แชทกลุ่ม/ห้อง) — บอทส่วนตัวไม่ควรทำงานในกลุ่มอยู่แล้ว
    if (!userId) {
      console.warn("[ปฏิเสธ] ไม่มี userId — กลุ่ม/ห้อง");
      return;
    }
    if (!isAllowed(userId)) {
      // log ID ที่ถูกปฏิเสธไว้เสมอ — ถ้าเจ้าของเผลอใส่ ID ผิดจนล็อกตัวเองออก
      // บรรทัดนี้คือทางเดียวที่จะรู้ว่า ID จริงคืออะไร (`docker compose logs bot`)
      console.warn(`[ปฏิเสธ] ไม่มีสิทธิ์: ${userId}`);
      // ปุ่ม "ขอสิทธิ์" ยังต้องกดได้ทั้งที่ยังไม่มีสิทธิ์ — ไม่งั้นวนไม่จบ
      if (event.type === "postback" && new URLSearchParams(event.postback?.data ?? "").get("act") === "req") {
        return handleAccessRequest(event, userId);
      }
      if (event.replyToken) return respond(event, blockedCards(userId));
      return;
    }
  }

  if (userId) {
    try { L.ensureUser(userId); } catch (e) { console.error(`[db] ${e.message}`); }
  }

  if (event.type === "follow") {
    return respond(event, [
      card({ title: "สวัสดีครับ", emoji: "👋", tone: "info",
             text: "ผมช่วยอ่านสลิปและจดรายรับ-รายจ่ายให้" }),
      consentCard(),
    ]);
  }
  // ตรวจแจ้งเตือน **หลังทุก postback และทุกข้อความ** ไม่ใช่เฉพาะตอนบันทึกรายการ
  //
  // เดิมเรียก notifyAfter() แค่ 2 จุด (หลังบันทึกสลิป / หลังพิมพ์รายการ) แต่จังหวะที่
  // ยอด "ข้ามเส้นงบ" จริง ๆ มักอยู่ที่อื่น — ตั้งงบทั้งที่ใช้ไป 94% แล้ว · กดเลือกหมวด
  // ให้รายการที่มีอยู่ (เพิ่งเข้างบหมวดนั้นตอนนี้เอง) · ยืนยันว่าเป็นรายจ่าย · แก้ยอด
  // ทุกกรณีเหล่านี้เดิมเงียบสนิท ผู้ใช้ตั้งงบแล้วรอเตือนซึ่งไม่มีวันมา
  //
  // ครอบไว้ที่นี่จุดเดียวแทนที่จะไปโรยตามแต่ละ handler — handler ใหม่ที่เพิ่มทีหลัง
  // จะได้ไม่ลืม และ claimAlert กันเตือนซ้ำอยู่แล้วจึงไม่เปลืองโควตา push
  const withAlerts = async (fn) => {
    try { return await fn(event); }
    finally { if (userId && L.hasConsent(userId)) await notifyAfter(userId); }
  };

  // จำกัดอัตราก่อนทำงานจริง — รูปแพงกว่าข้อความมาก (OCR ~8.5 วิ บน 2 cores)
  // ต้องปฏิเสธตั้งแต่ต้นทาง ไม่ใช่ปล่อยเข้าคิวแล้วให้ทุกคนรอ (queue.js คุมคนละเรื่อง)
  // ไฟล์แนบนับถังเดียวกับรูป — PDF หนึ่งไฟล์อาจต้อง OCR หลายหน้า แพงกว่ารูปใบเดียวอีก
  const heavy = event.type === "message" &&
    (event.message?.type === "image" || event.message?.type === "file");
  const kind = heavy ? "image" : "msg";
  const rl = take(userId, kind);
  if (!rl.ok) {
    // เพิ่งเตือนไปเมื่อกี้ → เงียบ (ดู `quiet` ใน ratelimit.js)
    // ส่งรูปเกินโควตาทีเดียวหลายใบไม่ควรได้การ์ดเตือนใบต่อใบ
    if (rl.quiet) return;
    // ตอบด้วย reply (ฟรี) ไม่ใช่ push — คนที่ยิงรัวไม่ควรกินโควตา 300/เดือนของทุกคน
    return respond(event, card({
      title: "ขอพักแป๊บนึงครับ", emoji: "🐢", tone: "warn",
      text: kind === "image"
        ? `อ่านสลิปใช้เวลาใบละหลายวินาที ส่งถี่เกินไปจะช้าทั้งระบบ\nลองใหม่ในอีก ${rl.retryInSec} วินาทีครับ`
        : `ส่งเร็วเกินไปหน่อยครับ ลองใหม่ในอีก ${rl.retryInSec} วินาที`,
      actions: [{ label: "📊 ดูสรุป", data: "act=summary" }],
    }));
  }

  if (event.type === "postback") return withAlerts(handlePostback);
  if (event.type !== "message") return;

  if (event.message.type === "image") return handleImage(event);
  if (event.message.type === "file") return withAlerts(handleFile);
  if (event.message.type === "text") return withAlerts(handleText);

  return respond(event, card({
    title: "ยังอ่านข้อความแบบนี้ไม่ได้", emoji: "📸", tone: "info",
    text: "ส่งรูปสลิป ไฟล์ PDF/CSV หรือพิมพ์รายการเข้ามาได้เลยครับ",
    actions: [{ label: "❓ วิธีใช้", text: "ช่วยเหลือ" }],
  }));
}
