// index.js — Express webhook server สำหรับ LINE Messaging API
//
// กฎเหล็ก: LINE คาดหวัง 200 กลับแทบจะทันที ถ้าช้าเกินมันจะ retry ส่ง event เดิมซ้ำ
// OCR ใช้ ~16 วิ/ใบ → ตอบ 200 ก่อน แล้วค่อยประมวลผลเบื้องหลัง (ไม่ await)
import express from "express";
import { middleware } from "@line/bot-sdk";
import { config } from "./config.js";
import { handleEvent } from "./handlers.js";
import * as L from "./ledger.js";
import * as ocr from "./ocrClient.js";
import { ahead } from "./queue.js";

const app = express();

// health ของตัว bot เอง (ไม่ใช่ของ OCR) — ใช้เช็คว่า tunnel ต่อถึงไหม
app.get("/health", async (_req, res) => {
  res.json({ status: "ok", queue: ahead(), ocr: await ocr.health() });
});

/**
 * ดาวน์โหลด CSV — LINE ส่งไฟล์ให้ผู้ใช้ไม่ได้ ต้องให้ลิงก์มาโหลดเอง
 *
 * ลิงก์มีข้อมูลการเงินจริง จึงคุมไว้ 3 ชั้น:
 *   token สุ่ม 32 ไบต์ (เดาไม่ได้) · หมดอายุใน 15 นาที · ใช้ได้ครั้งเดียว
 * ตอบ 404 เหมือนกันหมดไม่ว่า token ผิด/หมดอายุ/ใช้ไปแล้ว — ไม่บอกใบ้ว่าอันไหนมีอยู่จริง
 */
app.get("/export/:token", (req, res) => {
  // ปิดฟีเจอร์แล้วต้องปิดทางนี้ด้วย — token ที่ออกไปก่อนหน้ายังไม่หมดอายุ
  // ซ่อนแค่ปุ่มไม่พอ ลิงก์เก่าในแชทยังกดโหลดได้อยู่
  if (!config.exportEnabled) return res.status(404).type("text/plain; charset=utf-8").send("ไม่พบ");

  const userId = L.consumeExportToken(req.params.token);
  if (!userId) return res.status(404).type("text/plain; charset=utf-8").send("ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว");

  const { csv, count } = L.exportCsv(userId);
  const name = `slipingman-${new Date().toISOString().slice(0, 10)}.csv`;
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
    // ห้าม cache — ไฟล์มี PII และลิงก์ใช้ได้ครั้งเดียวอยู่แล้ว
    "Cache-Control": "no-store, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  });
  console.log(`[export] ส่ง CSV ${count} แถว`);
  res.send(csv);
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
