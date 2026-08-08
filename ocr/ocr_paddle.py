"""
ocr_paddle.py — OCR ด้วย PaddleOCR บน CPU ให้ interface เหมือน `ocr.ocr_image()`

ทำไมมีตัวนี้ทั้งที่มี ocr.py (Unlimited-OCR 3B บน GPU) อยู่แล้ว — วัดแล้วใน
SlipingMan-line-assistant/bench/FINDINGS.md:

    Unlimited-OCR (GPU) : ~16-23 วิ/รูป · VRAM 2.24 GB ค้างตลอด
    PaddleOCR    (CPU)  : ~6 วิ/รูป    · VRAM 0 · RAM ~720 MB

เร็วกว่า ไม่แตะ GPU (คืน VRAM ให้เทรนโมเดลอื่น) และลงเครื่องเล็กอย่าง VPS ได้

⚠️ ต้องใช้ venv ที่มี paddlepaddle — **คนละตัวกับ .venv ของ slip-ocr-th**
   (.venv pin transformers==4.46.3 ไว้สำหรับ Unlimited-OCR)

--- กับดัก 2 อันที่เสียเวลาไปเยอะ อย่าเผลอแก้ออก ---

1) enable_mkldnn=False **จำเป็น** และส่งได้ทาง argument เท่านั้น
   ไม่ปิด → NotImplementedError: ConvertPirAttribute2RuntimeAttribute ... onednn_instruction.cc
   env FLAGS_use_mkldnn=0 / FLAGS_enable_pir_api=0 ไม่มีผล (ทดสอบแล้วทั้งคู่)

2) พอ override text_detection_model_name ต้องระบุ text_recognition_model_name ไทยด้วย
   ไม่งั้น PaddleOCR เลิก auto-เลือกจาก lang="th" แล้วถอยไปใช้ rec ตัว latin
   → ไทยออกมาเป็น "τəuιūuιν" แทน "โอนเงินสำเร็จ" **แต่ตัวเลขยังถูกหมด**
   → ถ้าดูแค่ยอดเงินจะไม่รู้เลยว่าตั้งค่าพลาด
"""
import os
import io

_OCR = None

# ตัดโมเดลเสริม 3 ตัว (doc_ori / unwarping / textline_ori) ออก → peak RSS 3,892 → ~720 MB
# สลิปจากมือถือตั้งตรงอยู่แล้ว และเราทำ EXIF auto-orient เองตอนโหลดรูป
_CONFIG = dict(
    lang="th",
    enable_mkldnn=False,
    text_detection_model_name=os.environ.get("PADDLE_DET", "PP-OCRv5_mobile_det"),
    text_recognition_model_name=os.environ.get("PADDLE_REC", "th_PP-OCRv5_mobile_rec"),
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
)


def load_model():
    """โหลดครั้งเดียวแล้ว cache ไว้ (โหลดใหม่ทุกครั้ง = ช้าขึ้น ~2 วิ/รูป)"""
    global _OCR
    if _OCR is None:
        from paddleocr import PaddleOCR
        _OCR = PaddleOCR(**_CONFIG)
    return _OCR


def _load_rgb(src):
    """path หรือ bytes → numpy RGB.

    ผ่าน PIL เสมอ เพราะ **LINE ส่ง .webp ได้** และ decoder บางตัวอ่านไม่ออก
    (llama.cpp คืนผลว่างใน 2 วินาที — เจอมาแล้ว) PIL อ่าน webp/heic-ish ได้กว้างกว่า
    """
    from PIL import Image, ImageOps
    import numpy as np
    im = Image.open(io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else src)
    im = ImageOps.exif_transpose(im).convert("RGB")   # รูปมือถือหมุนตาม EXIF
    return np.array(im)


def _lines(res):
    """ผลของ PaddleOCR → list[str]; รองรับทั้ง API 3.x (dict) และ 2.x (nested list)"""
    out = []
    for page in (res or []):
        if isinstance(page, dict):                    # 3.x: {"rec_texts": [...]}
            out.extend(page.get("rec_texts") or [])
            continue
        for line in (page or []):                     # 2.x: [[box, (text, conf)], ...]
            if isinstance(line, (list, tuple)) and len(line) >= 2:
                t = line[1]
                out.append(t[0] if isinstance(t, (list, tuple)) else str(t))
    return out


def ocr_image(image_file, prompt=None, preprocess=True, **_) -> str:
    """รูป (path หรือ bytes) → ข้อความ OCR (บรรทัดละ text box)

    รับ `prompt`/`preprocess` ไว้เฉย ๆ เพื่อให้ signature เข้ากันได้กับ `ocr.ocr_image()`
    — PaddleOCR ไม่มีโหมด prompt (ไม่ใช่ VLM) และทำ preprocess ในตัวอยู่แล้ว
    """
    ocr = load_model()
    img = _load_rgb(image_file)
    try:
        res = ocr.predict(img)      # API 3.x
    except AttributeError:
        res = ocr.ocr(img)          # API 2.x
    return "\n".join(_lines(res))


if __name__ == "__main__":
    import sys, time
    if len(sys.argv) < 2:
        sys.exit("ใช้: python ocr_paddle.py <รูป> [รูป...]")
    t0 = time.perf_counter()
    load_model()
    print(f">> โหลด engine {time.perf_counter()-t0:.1f}s")
    for p in sys.argv[1:]:
        t = time.perf_counter()
        txt = ocr_image(p)
        print(f"\n--- {os.path.basename(p)}  ({time.perf_counter()-t:.1f}s) ---")
        print(txt)
