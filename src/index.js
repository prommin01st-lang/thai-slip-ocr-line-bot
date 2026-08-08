// index.js — Express webhook server สำหรับ LINE Messaging API
//
// กฎเหล็ก: LINE คาดหวัง 200 กลับแทบจะทันที ถ้าช้าเกินมันจะ retry ส่ง event เดิมซ้ำ
// OCR ใช้ ~16 วิ/ใบ → ตอบ 200 ก่อน แล้วค่อยประมวลผลเบื้องหลัง (ไม่ await)
import express from "express";
import { middleware } from "@line/bot-sdk";
import { config } from "./config.js";
import { handleEvent } from "./handlers.js";
import * as ocr from "./ocrClient.js";
import { ahead } from "./queue.js";

const app = express();

// health ของตัว bot เอง (ไม่ใช่ของ OCR) — ใช้เช็คว่า tunnel ต่อถึงไหม
app.get("/health", async (_req, res) => {
  res.json({ status: "ok", queue: ahead(), ocr: await ocr.health() });
});

// middleware ของ SDK ตรวจ X-Line-Signature (HMAC-SHA256 ด้วย channel secret) และ parse body ให้
// ⚠️ ห้ามใส่ express.json() ก่อนหน้านี้ — มันจะกิน raw body ทำให้ตรวจลายเซ็นไม่ผ่าน
//
// รับทั้ง /webhook และ /line/webhook — path ที่ตั้งไว้ใน LINE Console เปลี่ยนได้ตามคนตั้ง
// ถ้าไม่ตรง LINE จะได้ 404 แล้ว "บอทเงียบ" โดยไม่มี error ให้เห็นฝั่งเรา (ดีบักยาก)
app.post(["/webhook", "/line/webhook"], middleware({ channelSecret: config.channelSecret }), (req, res) => {
  res.status(200).end(); // ← ack ทันที ก่อนทำงานจริง

  for (const event of req.body.events ?? []) {
    // log userId ให้เห็นชัด — หา "Your user ID" ใน Console ไม่เจอบ่อย (ล็อกอินด้วย
    // business account จะไม่มีช่องนั้น) เอาค่านี้ไปใส่ LINE_DESTINATION_USER_ID ได้เลย
    const uid = event.source?.userId;
    console.log(`[event] ${event.type}` +
      (event.message?.type ? `/${event.message.type}` : "") +
      (uid ? `  userId=${uid}` : "  (ไม่มี userId — group/room?)"));

    // ตั้งใจไม่ await — งานยาววิ่งต่อหลังจบ request แล้ว
    handleEvent(event).catch((err) =>
      console.error(`[event ${event.type} ล้มเหลว] ${err.stack || err.message}`),
    );
  }
});

// ลายเซ็นไม่ผ่าน → SDK โยน SignatureValidationFailed มาที่นี่
app.use((err, _req, res, _next) => {
  if (err.name === "SignatureValidationFailed" || err.name === "JSONParseError") {
    console.warn(`[ปฏิเสธ webhook] ${err.name}`);
    return res.status(401).json({ error: "invalid signature" });
  }
  console.error(`[server error] ${err.stack || err.message}`);
  res.status(500).json({ error: "internal" });
});

app.listen(config.port, async () => {
  console.log(`>> SlipingMan พร้อม → http://localhost:${config.port}/webhook`);
  const h = await ocr.health();
  console.log(
    h.ok
      ? `>> OCR backend พร้อม (${config.ocrEndpoint}) VRAM ${h.vram_gb} GB`
      : `!! OCR backend ยังไม่พร้อม (${config.ocrEndpoint}: ${h.error}) — สตาร์ท slip-ocr-th/serve.py`,
  );
});
