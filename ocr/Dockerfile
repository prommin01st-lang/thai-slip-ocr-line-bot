# OCR service — PaddleOCR บน CPU ล้วน (ไม่ต้องมี GPU)
#
# วัดจริงแล้ว: ~6 วิ/รูป · peak RSS ~720 MB · VRAM 0
# (เทียบ Unlimited-OCR 3B ที่ใช้ ~51 วิ + VRAM 2.24 GB และอ่านสลิปไทยพลาด)
FROM python:3.12-slim

# ของที่ต้องมี ไม่งั้น import พังตั้งแต่ต้น (เจอมาแล้วตอน build จริง):
#   libgomp1      → paddlepaddle: "libgomp.so.1: cannot open shared object file"
#   libgl1        → opencv (dependency ของ paddleocr): "libGL.so.1: ..."
#   libglib2.0-0  → opencv เช่นกัน
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ลง dependency ก่อนคัดลอกโค้ด → แก้โค้ดแล้ว build ใหม่ไม่ต้องโหลด paddle ใหม่
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# **โหลดโมเดลตอน build** (~215 MB) — ไม่งั้น container แรกที่รันจะไปโหลดจากเน็ต
# ทำให้ request แรกช้ามากและพังถ้า VPS ต่อเน็ตไม่ได้
RUN python -c "import ocr_paddle; ocr_paddle.load_model(); print('โหลดโมเดลลง image แล้ว')"

# รันด้วย user ธรรมดา ไม่ใช่ root
RUN useradd -m -u 10001 app && chown -R app:app /app /home/app
USER app

EXPOSE 8101
ENV PYTHONUNBUFFERED=1 SLIP_OCR_PADDLE_PORT=8101

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:8101/health || exit 1

CMD ["python", "serve_paddle.py"]
