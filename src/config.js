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

  // รายชื่อ LINE user ID ที่อนุญาตให้ใช้บอท คั่นด้วยจุลภาค
  //
  // **ว่าง = เปิดให้ทุกคน** ซึ่งเป็นค่าเริ่มต้นโดยตั้งใจ — ถ้า default เป็นปิด
  // การ deploy ครั้งแรกจะล็อกเจ้าของออกทันทีก่อนที่จะทันรู้ ID ตัวเอง
  //
  // ข้อมูลของแต่ละคนแยกกันด้วย line_user_id อยู่แล้ว ตัวนี้กันเรื่องอื่น:
  // คิว OCR กับโควตา push 300/เดือน เป็นของส่วนกลาง คนนอกกินได้
  allowedUsers: new Set(
    (process.env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean)),

  // แอดมิน — อนุมัติคำขอของคนอื่นได้จากในแชท และใช้บอทได้เสมอ
  //
  // ไม่ตั้ง ADMIN_USERS จะถอยไปใช้ ALLOWED_USERS แทน เพราะคนที่ใส่ ID ตัวเอง
  // ไว้ใน .env คือเจ้าของเครื่องอยู่แล้ว — จะได้ไม่ต้องมาตั้งค่าซ้ำสองที่
  // แอดมินต้องมาจาก .env เท่านั้น **ห้ามตั้งจากในแชท** ไม่งั้นใครแฮ็กแชทได้ก็ตั้งตัวเองเป็นแอดมิน
  adminUsers: new Set(
    (process.env.ADMIN_USERS || process.env.ALLOWED_USERS || "")
      .split(",").map((s) => s.trim()).filter(Boolean)),

  // ส่งออก CSV — **ปิดไว้เป็นค่าเริ่มต้น** เปิดด้วย EXPORT_CSV=on
  //
  // แยกจาก PUBLIC_URL ตั้งใจ: PUBLIC_URL ถูกตั้งเพราะเหตุผลอื่นได้ (webhook, LIFF)
  // ถ้าผูกการมองเห็นปุ่มไว้กับมันอย่างเดียว วันหนึ่งปุ่มจะโผล่กลับมาเองโดยไม่มีใครสั่ง
  // โค้ดฝั่งหลัง (route, token, exportCsv) ยังอยู่ครบ — เปิดกลับได้ด้วยค่าใน .env
  exportEnabled: /^(1|true|on|yes)$/i.test(process.env.EXPORT_CSV || ""),

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
