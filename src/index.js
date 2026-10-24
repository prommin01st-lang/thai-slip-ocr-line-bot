import { Inbox } from "./inbox.js";
import { collectGarbage } from "./evidence.js";
import { privateRouter } from "./privateRoutes.js";
// index.js — Express webhook server สำหรับ LINE Messaging API
//
// กฎเหล็ก: LINE คาดหวัง 200 กลับแทบจะทันที ถ้าช้าเกินมันจะ retry ส่ง event เดิมซ้ำ
// OCR ใช้ ~16 วิ/ใบ → ตอบ 200 ก่อน แล้วค่อยประมวลผลเบื้องหลัง (ไม่ await)
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { middleware } from "@line/bot-sdk";
import { config } from "./config.js";
import { handleEvent, handleDurableImageBatch } from "./handlers.js";
import * as L from "./ledger.js";
import * as ocr from "./ocrClient.js";
import { ahead } from "./queue.js";
import * as sheetSync from "./sheetSync.js";

export const app = express();
const inbox = new Inbox(L.db(), handleEvent, {
  handleBatch: handleDurableImageBatch,
});
app.use(privateRouter);

// health ของตัว bot เอง (ไม่ใช่ของ OCR) — ใช้เช็คว่า tunnel ต่อถึงไหม
app.get("/health", async (_req, res) => {
  const jobs = L.db()
    .prepare(
      "SELECT status,count(*) AS count FROM event_inbox WHERE status IN ('queued','running','failed') GROUP BY status",
    )
    .all();
  const cleanup = L.db()
    .prepare("SELECT count(*) AS count FROM object_gc")
    .get().count;
  res.json({
    status: "ok",
    queue: ahead(),
    jobs,
    cleanup,
    ocr: await ocr.health(),
  });
});

/**
 * รูปมาสคอตสำหรับใส่ในการ์ด
 *
 * Flex ฝังรูปเป็น base64 ไม่ได้ — LINE ไปดึงจาก URL เองเสมอ จึงต้องมีที่เสิร์ฟ
 * เปิดเฉพาะโฟลเดอร์ assets/Mascot **ไม่ใช่ทั้ง assets/** เพราะในนั้นมีสเปก
 * กับไฟล์ต้นฉบับที่ไม่มีเหตุผลจะเปิดสู่อินเทอร์เน็ต
 *
 * ชื่อไฟล์ถูกจำกัดด้วย regex ไม่ให้มี `/` หรือ `.` ซ้อน — กัน path traversal
 * (`/mascot/..%2f..%2f.env`) express ถอด URL-encode ให้ก่อนถึง handler
 */
const MASCOT_DIR = fileURLToPath(new URL("../assets/Mascot/", import.meta.url));
app.get("/mascot/:file", (req, res) => {
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg)$/.test(req.params.file))
    return res.sendStatus(404);
  res.sendFile(
    join(MASCOT_DIR, req.params.file),
    {
      // LINE cache รูปไว้อยู่แล้ว ตั้งยาวไปเลย รูปมาสคอตไม่ได้เปลี่ยนบ่อย
      headers: {
        "Cache-Control": "public, max-age=604800",
        "X-Content-Type-Options": "nosniff",
      },
    },
    (err) => {
      if (err && !res.headersSent) res.sendStatus(404);
    },
  );
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
  if (!config.exportEnabled)
    return res.status(404).type("text/plain; charset=utf-8").send("ไม่พบ");

  const userId = L.consumeExportToken(req.params.token);
  if (!userId)
    return res
      .status(404)
      .type("text/plain; charset=utf-8")
      .send("ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว");

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
app.post(
  ["/webhook", "/line/webhook"],
  middleware({ channelSecret: config.channelSecret }),
  (req, res) => {
    try {
      inbox.accept(req.body.events ?? []);
      res.status(200).end();
      void inbox
        .drain()
        .catch(() => console.error("[inbox] processing unavailable"));
    } catch {
      res.status(503).json({ error: "queue unavailable" });
    }
  },
);

// ลายเซ็นไม่ผ่าน → SDK โยน SignatureValidationFailed มาที่นี่
app.use((err, _req, res, _next) => {
  if (
    err.name === "SignatureValidationFailed" ||
    err.name === "JSONParseError"
  ) {
    console.warn(`[ปฏิเสธ webhook] ${err.name}`);
    return res.status(401).json({ error: "invalid signature" });
  }
  console.error(`[server error] ${err.stack || err.message}`);
  res.status(500).json({ error: "internal" });
});

export function startServer() {
  const server = app.listen(config.port, async () => {
    void inbox.start();
    console.log(
      `>> SlipingMan พร้อม → http://localhost:${config.port}/webhook`,
    );
    // กระจก Google Sheet — ไม่ตั้งคีย์ service account ก็ไม่ต้องวิ่ง (คืน false)
    console.log(
      sheetSync.start()
        ? `>> sync Google Sheet ทุก ${Math.round(config.sheetSyncMs / 1000)} วิ (${config.googleSaEmail})`
        : ">> ไม่ได้เปิด Google Sheet (ไม่ได้ตั้ง GOOGLE_SA_EMAIL / GOOGLE_SA_KEY)",
    );
    const h = await ocr.health();
    console.log(
      h.ok
        ? `>> OCR backend พร้อม (${config.ocrEndpoint}) VRAM ${h.vram_gb} GB`
        : `!! OCR backend ยังไม่พร้อม (${config.ocrEndpoint}: ${h.error}) — สตาร์ท slip-ocr-th/serve.py`,
    );
  });

  let cleaning = false;
  const gcTimer = setInterval(async () => {
    if (!config.s3Bucket || cleaning) return;
    cleaning = true;
    try {
      await collectGarbage();
    } catch {
      console.error("[storage] cleanup retry pending");
    } finally {
      cleaning = false;
    }
  }, 30000);
  gcTimer.unref();
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      inbox.stop();
      clearInterval(gcTimer);
      server.close(() => process.exit(0));
      // In-flight events stay 'running' and are recovered on the next start.
      setTimeout(() => process.exit(0), 25000).unref();
    });

  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  startServer();
