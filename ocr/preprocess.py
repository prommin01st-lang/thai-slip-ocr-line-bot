"""preprocess.py — เตรียมรูปก่อน OCR ให้ทนกับ "รูปถ่ายจริง" (มือถือ/สแกน).

ทำ (แบบ conservative เพื่อไม่กระทบรูปสแกนที่ดีอยู่แล้ว):
  - auto-orient ตาม EXIF (รูปมือถือแนวตั้ง/นอน)
  - RGBA/P → RGB (พื้นขาว)
  - downscale รูปใหญ่เกิน (กัน OOM ที่เคยเจอ)  / upscale รูปเล็กจิ๋ว (crop อ่านออกขึ้น)
  - split รูป "ยาวมาก" (ใบเสร็จยาว/หลายหน้าซ้อน) เป็นหน้าย่อยซ้อนเหลื่อม → OCR ทีละหน้า

คืน list ของ path (ปกติ 1; รูปยาว → หลายหน้า) ในโฟลเดอร์ out_dir ที่ผู้เรียกดูแลลบเอง.
pillow-only (มีใน venv แล้ว). ไม่ทำ deskew มุมเอียง (ต้องพึ่ง CV เพิ่ม — ดู ROADMAP).
"""
import os
from PIL import Image, ImageOps

MAX_DIM = int(os.environ.get("SLIP_OCR_MAX_DIM", "2500"))   # เกินนี้ = downscale (กัน OOM)
MIN_DIM = int(os.environ.get("SLIP_OCR_MIN_DIM", "400"))    # เล็กกว่านี้ = upscale
TALL_RATIO = float(os.environ.get("SLIP_OCR_TALL_RATIO", "2.8"))  # h/w เกินนี้ = split


def prepare(path: str, out_dir: str) -> list:
    """เตรียมรูป → list ของ path (พร้อม OCR). โยน exception ถ้าเปิดรูปไม่ได้."""
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)          # หมุนตาม metadata กล้อง
    if im.mode != "RGB":
        im = im.convert("RGB")

    w, h = im.size
    mx = max(w, h)
    if mx > MAX_DIM:                          # ใหญ่ไป → ย่อ (กัน OOM)
        s = MAX_DIM / mx
        im = im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    elif mx < MIN_DIM:                        # เล็กไป → ขยาย (crop อ่านออกขึ้น)
        s = MIN_DIM / mx
        im = im.resize((int(w * s), int(h * s)), Image.LANCZOS)

    w, h = im.size
    if h / w <= TALL_RATIO:                   # ปกติ → หน้าเดียว
        p = os.path.join(out_dir, "p0.png")
        im.save(p)
        return [p]

    # ยาวมาก → ตัดเป็นหน้าย่อยสูง ~ w*1.4 ซ้อนเหลื่อม 12% (กันตัดกลางบรรทัด)
    page_h = int(w * 1.4)
    overlap = int(page_h * 0.12)
    pages, y, i = [], 0, 0
    while y < h:
        box = (0, max(0, y - (overlap if i else 0)), w, min(h, y + page_h))
        p = os.path.join(out_dir, f"p{i}.png")
        im.crop(box).save(p)
        pages.append(p)
        y += page_h
        i += 1
    return pages


if __name__ == "__main__":
    import sys
    import tempfile
    src = sys.argv[1] if len(sys.argv) > 1 else "samples/slip.png"
    with tempfile.TemporaryDirectory() as d:
        ps = prepare(src, d)
        print(f"{src} → {len(ps)} หน้า")
        for p in ps:
            print(" ", p, Image.open(p).size)
