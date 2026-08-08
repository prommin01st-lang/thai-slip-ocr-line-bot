// ocrClient.js — คุยกับ slip-ocr-th/serve.py (:8100)
//
// ฝั่งนั้นโหลด Unlimited-OCR 4-bit ค้างไว้ ~2.2GB VRAM และ serialize GPU ด้วย worker เดียว
// → เรียกซ้อนกันได้ แต่มันจะเข้าคิวเอง. เราคุมคิวฝั่งเราอีกชั้น (queue.js) เพื่อบอกลำดับผู้ใช้ได้.
import { config } from "./config.js";

/** โยนเมื่อ OCR ตอบกลับมาช้าเกิน หรือ backend คืน 504 */
export class OcrTimeoutError extends Error {}
/** โยนเมื่อ backend ติดต่อไม่ได้เลย (ยังไม่ได้สตาร์ท serve.py) */
export class OcrUnavailableError extends Error {}
/** โยนเมื่อ token ไม่ตรงกับ backend — ตั้งค่าผิด ไม่ใช่ปัญหาชั่วคราว */
export class OcrAuthError extends Error {}

function headers() {
  const h = { "Content-Type": "application/json" };
  if (config.ocrToken) h["X-Auth-Token"] = config.ocrToken;
  return h;
}

async function post(path, body, timeoutMs) {
  let res;
  try {
    res = await fetch(`${config.ocrEndpoint}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new OcrTimeoutError(`OCR ไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วิ`);
    }
    throw new OcrUnavailableError(`ต่อ ${config.ocrEndpoint} ไม่ได้ — สตาร์ท slip-ocr-th/serve.py แล้วหรือยัง?`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`backend ตอบไม่ใช่ JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  // serve.py คืน 504 เมื่อ OCR วน generate เกิน SLIP_OCR_MAX_SECONDS
  if (res.status === 504) throw new OcrTimeoutError(data.error || "OCR timeout");
  // 401 = token ไม่ตรง — เป็นปัญหาการตั้งค่า ลองใหม่กี่ครั้งก็ไม่หาย ต้องแยกจาก error ชั่วคราว
  if (res.status === 401) {
    throw new OcrAuthError(
      "backend ปฏิเสธ token — ตรวจว่า OCR_TOKEN ตรงกับ SLIP_OCR_TOKEN ฝั่ง backend");
  }
  if (!res.ok) throw new Error(data.error || `backend ตอบ ${res.status}`);
  return data;
}

/**
 * รูป → JSON มีโครงสร้าง.
 * ใช้ `/parse` (auto-route): OCR ครั้งเดียว → doc_router.classify() → parser ที่ถูก
 * → ผู้ใช้ส่งสลิปโอน/ใบเงินเดือน/ใบเสร็จมาก็ได้ ไม่ต้องบอกล่วงหน้า.
 */
export function parseImage(buffer) {
  return post("/parse", { image_b64: buffer.toString("base64") }, config.ocrTimeoutMs);
}

/** บังคับชนิดเอกสาร (ผู้ใช้กดเลือกจาก quick reply) */
export function parseAs(buffer, docType) {
  const route = { transfer: "/slip", payslip: "/payslip", receipt: "/receipt" }[docType];
  if (!route) throw new Error(`ชนิดเอกสารไม่รู้จัก: ${docType}`);
  return post(route, { image_b64: buffer.toString("base64") }, config.ocrTimeoutMs);
}

/** เช็คว่า backend พร้อมไหม — ใช้ตอนสตาร์ทและตอนผู้ใช้พิมพ์ "สถานะ" */
export async function health() {
  try {
    const res = await fetch(`${config.ocrEndpoint}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, error: `ตอบ ${res.status}` };
    return { ok: true, ...(await res.json()) };
  } catch {
    return { ok: false, error: "ต่อไม่ได้" };
  }
}
