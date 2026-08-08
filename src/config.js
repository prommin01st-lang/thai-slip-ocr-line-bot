// config.js — โหลด env + ตรวจว่าครบก่อนสตาร์ท (fail fast ดีกว่าไปพังตอน request แรก)
import "dotenv/config";

const missing = [];

function required(name) {
  const v = process.env[name];
  if (!v) missing.push(name);
  return v;
}

export const config = {
  // จาก LINE Developers Console → ช่อง Messaging API
  channelSecret: required("LINE_CHANNEL_SECRET"),
  channelAccessToken: required("LINE_CHANNEL_ACCESS_TOKEN"),

  port: Number(process.env.PORT || 3000),

  // URL สาธารณะของบอท (ngrok / โดเมนจริง) — ใช้ทำลิงก์ดาวน์โหลด CSV
  // ไม่ตั้ง = ปิดฟีเจอร์ส่งออก (บอกผู้ใช้ตรง ๆ ดีกว่าส่งลิงก์เสีย)
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/$/, ""),

  // slip-ocr-th/serve.py (GPU, :8100) หรือ serve_paddle.py (CPU, :8101)
  ocrEndpoint: (process.env.OCR_ENDPOINT || "http://localhost:8100").replace(/\/$/, ""),
  // ต้องตรงกับ SLIP_OCR_TOKEN ฝั่ง backend; ว่าง = backend เปิดโล่ง (โหมด dev บน localhost)
  ocrToken: (process.env.OCR_TOKEN || "").trim(),
  // ต้องมากกว่า SLIP_OCR_MAX_SECONDS ของ serve.py (default 150) เผื่อเวลาต่อคิว
  ocrTimeoutMs: Number(process.env.OCR_TIMEOUT_MS || 180_000),

  // LINE ส่งรูปได้สูงสุด 10MB อยู่แล้ว — กันไว้อีกชั้นกัน OOM ฝั่งเรา
  maxImageBytes: Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024),
};

if (missing.length) {
  console.error(`✗ ขาด env: ${missing.join(", ")}`);
  console.error("  คัดลอก .env.example เป็น .env แล้วเติมค่าจาก LINE Developers Console");
  process.exit(1);
}
