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
import { resultMessage, errorMessage, card, askDirection, askPeriod, thaiMonth,
         summaryBubble, txnListBubble, categoryButtons, categoryPickerBubble,
         shiftMonth } from "./flex.js";
import { labelOf, isCategory } from "./categories.js";
import { parseEntry } from "./nlu.js";
import { nowLocal } from "./db.js";
import { checkAlerts, thisMonth, thisWeek, quota } from "./notify.js";

const client = new messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken });
const blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: config.channelAccessToken });

const DIR_LABEL = { in: "รายรับ", out: "รายจ่าย", unknown: "ยังไม่ระบุ" };

// ---------- การ์ดที่ใช้ซ้ำ ----------

const helpCard = () => card({
  title: "SlipingMan", emoji: "🧾", tone: "info",
  text: "ส่งรูปสลิป ใบเสร็จ หรือใบเงินเดือนเข้ามาได้เลย\nหรือพิมพ์สั้น ๆ เช่น “กาแฟ 60”",
  rows: [
    { label: "จดรายจ่าย", value: "พิมพ์ “กาแฟ 60”" },
    { label: "จดรายรับ", value: "พิมพ์ “ได้เงินเดือน 30000”" },
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
    ],
    actions: [
      { label: weeklyOn ? "🔕 ปิดสรุปรายสัปดาห์" : "🔔 เปิดสรุปรายสัปดาห์", data: "act=weekly" },
      ...(accts.length ? [{ label: "🔄 ลืมบัญชีที่จำไว้", data: "act=forgetacct" }] : []),
      // fillInText: เติม "งบ " ให้ ผู้ใช้พิมพ์ต่อแค่ตัวเลข
      { label: "📌 ตั้งงบรวม", fill: "งบ ", data: "act=prompt&kind=budget" },
      { label: "📌 ตั้งงบรายหมวด", fill: "งบ อาหาร ", data: "act=prompt&kind=budget" },
      // ต้องเปิด EXPORT_CSV *และ* มี PUBLIC_URL ถึงจะโผล่
      // (ไม่มีโดเมนสาธารณะ ลิงก์ดาวน์โหลดก็เปิดไม่ได้อยู่ดี)
      ...(config.exportEnabled && config.publicUrl ? [{ label: "📤 ส่งออก CSV", data: "act=export" }] : []),
      { label: "🔒 ข้อมูลของฉัน", text: "ข้อมูลของฉัน" },
    ],
  });
};

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

/** ดึงไฟล์รูปจาก LINE → Buffer */
async function downloadImage(message) {
  if (message.contentProvider?.type === "external") {
    const url = message.contentProvider.originalContentUrl;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`ดึงรูปจาก external provider ไม่ได้ (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  const stream = await blob.getMessageContent(message.id);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > config.maxImageBytes) {
      stream.destroy();
      throw new Error(`รูปใหญ่เกิน ${Math.round(config.maxImageBytes / 1024 / 1024)}MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

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

async function handleImage(event) {
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
  const dir = d === "in" || d === "out" ? d : null;
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
    return respond(event, ask ? [confirm, ask] : confirm);
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

  if (userId && !L.hasConsent(userId)) {
    L.ensureUser(userId);
    return respond(event, consentCard());
  }

  // --- บันทึกจากข้อความ: "กาแฟ 60" / "จ่ายค่าไฟ 850" / "ได้เงินเดือน 30000" ---
  const entry = parseEntry(text);
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
          notes: entry.guessed ? ["ไม่มีคำว่า “จ่าย/ได้” ในข้อความ — ผมเดาให้เป็นรายจ่าย"] : [],
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

  // --- whitelist ---
  //
  // ตรวจ **ก่อน** ensureUser() เพื่อไม่ให้คนนอกได้แถวใน DB ด้วยซ้ำ และก่อน rate limit
  // เพราะไม่มีเหตุผลจะจ่ายงานอะไรให้คนที่ไม่ได้รับอนุญาต
  //
  // ไม่มี userId ก็บล็อก (แชทกลุ่ม/ห้อง) — บอทส่วนตัวไม่ควรทำงานในกลุ่มอยู่แล้ว
  if (config.allowedUsers.size && !(userId && config.allowedUsers.has(userId))) {
    // log ID ที่ถูกปฏิเสธไว้เสมอ — ถ้าเจ้าของเผลอใส่ ID ผิดจนล็อกตัวเองออก
    // บรรทัดนี้คือทางเดียวที่จะรู้ว่า ID จริงคืออะไร (`docker compose logs bot`)
    console.warn(`[ปฏิเสธ] ไม่อยู่ใน ALLOWED_USERS: ${userId ?? "(ไม่มี userId — กลุ่ม/ห้อง)"}`);
    if (event.replyToken) {
      return respond(event, [
        card({
          title: "บอทส่วนตัว", emoji: "🔒", tone: "info",
          text: "ขออภัยครับ บอทตัวนี้เปิดให้เฉพาะผู้ใช้ที่กำหนดไว้เท่านั้น" +
                (userId ? "\n\nถ้าต้องการใช้งาน ส่งรหัสในข้อความถัดไปให้เจ้าของบอทครับ" : ""),
          altText: "บอทตัวนี้เปิดให้เฉพาะผู้ใช้ที่กำหนดไว้",
        }),
        // ส่ง ID เป็น **ข้อความธรรมดาใบแยก** ไม่ใช่ใส่ในการ์ด
        // ตัวอักษรใน Flex เลือก/คัดลอกไม่ได้ ผู้ใช้จึงต้องพิมพ์ตามทีละตัว 33 ตัว
        // ข้อความธรรมดากดค้าง → "คัดลอก" ได้ทั้งก้อน และในใบนี้มีแต่ ID ล้วน ๆ
        // จึงคัดลอกมาแล้ววางต่อท้าย ALLOWED_USERS ได้เลยโดยไม่ต้องตัดอะไรทิ้ง
        ...(userId ? [{ type: "text", text: userId }] : []),
      ]);
    }
    return;
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
  const kind = event.type === "message" && event.message?.type === "image" ? "image" : "msg";
  const rl = take(userId, kind);
  if (!rl.ok) {
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
  if (event.message.type === "text") return withAlerts(handleText);

  return respond(event, card({
    title: "รับเฉพาะรูปและข้อความ", emoji: "📸", tone: "info",
    text: "ส่งรูปสลิป หรือพิมพ์รายการเข้ามาได้เลยครับ",
    actions: [{ label: "❓ วิธีใช้", text: "ช่วยเหลือ" }],
  }));
}
