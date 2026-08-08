"""
serve_paddle.py — HTTP API เดียวกับ serve.py แต่ใช้ PaddleOCR (CPU) แทน Unlimited-OCR (GPU)

**contract เหมือน serve.py เป๊ะ** → สลับได้โดยแก้แค่ OCR_ENDPOINT ฝั่งบอท ไม่ต้องแก้โค้ด

ทำไมมีตัวนี้ (วัดจริงใน SlipingMan-line-assistant/bench/FINDINGS.md):

              Unlimited-OCR (GPU)   PaddleOCR (CPU)
    เวลา/รูป   ~16-23 วิ             **~6 วิ**
    /parse     ~51 วิ (OCR 2 รอบ)    **~6 วิ (รอบเดียว)**
    VRAM       2.24 GB ค้างตลอด      **0**
    RAM        —                     ~720 MB
    ลง VPS 2c/3.8GB ได้ไหม  ไม่ได้    **ได้**

`/parse` ที่นี่เร็วกว่าเยอะเพราะ PaddleOCR มีโหมดเดียว — OCR รอบเดียวแล้ว classify
ต่างจาก serve.py ที่ต้อง OCR doc-mode เพื่อจำแนก แล้ว OCR free-mode ซ้ำเพื่ออ่านยอด

รัน:
    ./bench-venv/bin/python serve_paddle.py       # ต้องเป็น venv ที่มี paddleocr
    SLIP_OCR_PADDLE_PORT=8101 ... (default 8101 — คนละพอร์ตกับ serve.py จะได้รันคู่กันได้)

Auth:
    ตั้ง SLIP_OCR_TOKEN → ทุก request ต้องมี `X-Auth-Token` หรือ `Authorization: Bearer`
    ไม่ตั้ง → เปิดโล่ง (ใช้ได้เฉพาะ localhost; อย่าเปิดออกเน็ตแบบไม่มี token)
"""
import os
import json
import base64
import hmac
import tempfile
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ocr_paddle
from slip_parser import parse_slip
from payslip_parser import parse_payslip
from receipt_parser import parse_receipt
from doc_router import classify

HOST = os.environ.get("SLIP_OCR_HOST", "0.0.0.0")
PORT = int(os.environ.get("SLIP_OCR_PADDLE_PORT", "8101"))
MAX_OCR_SECONDS = int(os.environ.get("SLIP_OCR_MAX_SECONDS", "60"))   # CPU ~6 วิ → 60 เหลือเฟือ
TOKEN = os.environ.get("SLIP_OCR_TOKEN", "").strip()

# PaddleOCR ไม่ thread-safe → worker เดียว (เหมือน serve.py ที่ serialize GPU)
_EXEC = ThreadPoolExecutor(max_workers=1)

ROUTES = ["/parse", "/parse-batch", "/slip", "/payslip", "/receipt", "/ocr"]


class OcrTimeout(Exception):
    pass


def ocr_guarded(path: str) -> str:
    fut = _EXEC.submit(ocr_paddle.ocr_image, path)
    try:
        return fut.result(timeout=MAX_OCR_SECONDS)
    except FutureTimeout:
        raise OcrTimeout(f"OCR ใช้เวลาเกิน {MAX_OCR_SECONDS}s — ลองรูปที่เล็ก/ชัดขึ้น")


def _write_temp(raw: bytes) -> str:
    fd, path = tempfile.mkstemp(suffix=".img")
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
    return path


def _image_from_request(headers, body: bytes) -> str:
    ctype = (headers.get("Content-Type") or "").lower()
    if "application/json" in ctype:
        data = json.loads(body or b"{}")
        if data.get("path"):
            if not os.path.isfile(data["path"]):
                raise ValueError(f"ไม่พบไฟล์: {data['path']} (path ต้องอยู่ฝั่ง server)")
            return data["path"]
        if data.get("image_b64"):
            return _write_temp(base64.b64decode(data["image_b64"]))
        raise ValueError("json ต้องมี 'path' หรือ 'image_b64'")
    if not body:
        raise ValueError("ไม่มีข้อมูลรูป (ส่ง raw bytes หรือ json)")
    return _write_temp(body)


def _authorized(headers) -> bool:
    """ไม่ตั้ง TOKEN = เปิดโล่ง (โหมด dev บน localhost)"""
    if not TOKEN:
        return True
    got = (headers.get("X-Auth-Token")
           or (headers.get("Authorization") or "").removeprefix("Bearer ").strip())
    # compare_digest กัน timing attack — ราคาถูกมาก ไม่มีเหตุผลจะไม่ใช้
    return hmac.compare_digest(got, TOKEN)


def _parse_one(path: str) -> dict:
    """OCR **รอบเดียว** → จำแนกชนิด → parser ที่ถูก (ต่างจาก serve.py ที่ OCR 2 รอบ)"""
    text = ocr_guarded(path)
    kind = classify(text)
    if kind == "payslip":
        data = parse_payslip(text)
    elif kind == "receipt":
        data = parse_receipt(text)
    else:
        data = parse_slip(text)
    data.pop("raw", None)
    data["doc_type"] = kind
    return data


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict):
        payload = json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            # /health ไม่ต้อง auth — ใช้เช็คว่าเครื่องยังอยู่ไหม ไม่มีข้อมูลอะไรหลุด
            return self._send(200, {
                "status": "ok", "engine": "paddleocr", "vram_gb": 0,
                "loaded": ocr_paddle._OCR is not None, "auth": bool(TOKEN),
            })
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        route = self.path.rstrip("/")
        if route not in ROUTES:
            return self._send(404, {"error": "not found", "routes": ROUTES})
        if not _authorized(self.headers):
            return self._send(401, {"error": "unauthorized — ต้องมี X-Auth-Token"})

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        if route == "/parse-batch":
            return self._batch(body)

        tmp = None
        try:
            path = _image_from_request(self.headers, body)
            tmp = path if path.endswith(".img") else None
            if route == "/ocr":
                return self._send(200, {"text": ocr_guarded(path)})
            if route == "/parse":
                return self._send(200, _parse_one(path))
            parse = {"/slip": parse_slip, "/payslip": parse_payslip, "/receipt": parse_receipt}[route]
            data = parse(ocr_guarded(path))
            data.pop("raw", None)
            return self._send(200, data)
        except OcrTimeout as e:
            return self._send(504, {"error": str(e)})
        except Exception as e:
            return self._send(400, {"error": str(e)})
        finally:
            if tmp and os.path.exists(tmp):
                os.remove(tmp)

    def _batch(self, body):
        try:
            req = json.loads(body or b"{}")
        except ValueError:
            return self._send(400, {"error": "batch ต้องเป็น JSON"})
        items = [("path", p) for p in (req.get("paths") or [])] + \
                [("b64", b) for b in (req.get("images_b64") or [])]
        if not items:
            return self._send(400, {"error": "ต้องมี 'paths' หรือ 'images_b64' (array)"})

        results = []
        for i, (kind, val) in enumerate(items):
            tmp = None
            try:
                if kind == "path":
                    if not os.path.isfile(val):
                        raise ValueError(f"ไม่พบไฟล์: {val}")
                    path = val
                else:
                    path = _write_temp(base64.b64decode(val)); tmp = path
                results.append({"index": i, "ok": True, **_parse_one(path)})
            except Exception as e:
                results.append({"index": i, "ok": False, "error": str(e)})
            finally:
                if tmp and os.path.exists(tmp):
                    os.remove(tmp)
        return self._send(200, {"count": len(results), "results": results})

    def log_message(self, fmt, *args):
        print(f"[{self.command}] {self.path} - {args[1] if len(args) > 1 else ''}")


def main():
    print(">> โหลด PaddleOCR (CPU)...")
    ocr_paddle.load_model()
    print(f">> พร้อม! ฟังที่ http://localhost:{PORT} | auth: {'เปิด' if TOKEN else 'ปิด (dev)'}")
    if not TOKEN:
        print("   ⚠️ ไม่ได้ตั้ง SLIP_OCR_TOKEN — อย่าเปิดพอร์ตนี้ออกอินเทอร์เน็ต")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
