#!/usr/bin/env python3
"""richmenu_image.py — วาดรูปเมนูล่าง 2500×1686 (2 แถว × 3 ช่อง)

    python3 scripts/richmenu_image.py          # → assets/richmenu.png

ต้องมี pillow (ใช้ venv ไหนก็ได้ เช่น bench/.venv-ocr/bin/python)
ใช้ฟอนต์ Noto Sans Thai ที่มีในเครื่อง — ถ้าไม่มีจะ fallback เป็นฟอนต์ default
(อ่านออกน้อยลงแต่ไม่พัง)
"""
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 1686
CW, CH = W // 3, H // 2
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "richmenu.png")

BG = (247, 245, 242)
LINE = (226, 222, 216)
FG = (31, 31, 31)
SUB = (138, 138, 138)

# วาดไอคอนเองด้วยเส้น ไม่ใช้ emoji — ฟอนต์ไทย (Noto Sans Thai) ไม่มี glyph emoji
# ใส่ไปจะได้กล่องว่าง (tofu) ส่วน Noto Color Emoji เป็นฟอนต์บิตแมป ต้องพึ่ง embedded_color
# ซึ่งไม่การันตีบนทุกเครื่อง → วาดเองชัวร์กว่าและคุมสไตล์ได้
CELLS = [
    ("camera", "ถ่ายสลิป", "เปิดกล้อง"),
    ("image", "เลือกรูป", "จากคลังภาพ"),
    ("chart", "สรุป", "ยอดเดือนนี้"),
    ("list", "รายการ", "ดูและลบ"),
    ("target", "งบ", "ตั้งและเช็ค"),
    ("help", "ช่วยเหลือ", "คำสั่งทั้งหมด"),
]

# ⚠️ NotoSansThai-*.ttf เป็นฟอนต์ **subset เฉพาะไทย** — ไม่มี glyph ASCII อย่าง / ? · |
# ใส่ไปจะได้กล่องว่าง (ตรวจแล้ว: bbox ของ '/' '?' '·' '|' เท่ากันหมด = .notdef)
# → ข้อความในรูปนี้ใช้ได้แค่อักษรไทย ตัวเลข และ '-' เท่านั้น
FONT_DIRS = ["/usr/share/fonts/truetype/noto", "/usr/share/fonts/truetype"]
FONT_NAMES = ["NotoSansThai-Bold.ttf", "NotoSansThai-Regular.ttf",
              "NotoSansThaiUI-Bold.ttf", "NotoSansThaiUI-Regular.ttf"]


def find_font(size, bold=True):
    order = FONT_NAMES if bold else FONT_NAMES[1:] + FONT_NAMES[:1]
    for d in FONT_DIRS:
        for n in order:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    # หาแบบกว้างขึ้น: ไฟล์ไหนก็ได้ที่ชื่อมี Thai
    for d in FONT_DIRS:
        if not os.path.isdir(d):
            continue
        for n in sorted(os.listdir(d)):
            if "Thai" in n and n.endswith(".ttf"):
                return ImageFont.truetype(os.path.join(d, n), size)
    print("!! ไม่พบฟอนต์ไทย — ใช้ฟอนต์ default (ตัวหนังสืออาจอ่านยาก)")
    return ImageFont.load_default()


def centered(draw, text, font, cx, cy, fill):
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (r - l) / 2 - l, cy - (b - t) / 2 - t), text, font=font, fill=fill)


def icon(d, kind, cx, cy, s=78, w=9, fill=FG):
    """วาดไอคอนเส้นในกรอบ 2s × 2s รอบจุด (cx, cy)"""
    x0, y0, x1, y1 = cx - s, cy - s, cx + s, cy + s
    box = lambda a, b, c, e, r=18: d.rounded_rectangle([a, b, c, e], radius=r, outline=fill, width=w)

    if kind == "camera":
        box(x0, y0 + s * 0.28, x1, y1 - s * 0.12)
        # ปุ่มชัตเตอร์ด้านบน
        d.rounded_rectangle([cx - s * 0.34, y0, cx + s * 0.34, y0 + s * 0.34], radius=10,
                            outline=fill, width=w)
        d.ellipse([cx - s * 0.42, cy - s * 0.36, cx + s * 0.42, cy + s * 0.48], outline=fill, width=w)

    elif kind == "image":
        box(x0, y0 + s * 0.14, x1, y1 - s * 0.14)
        d.ellipse([x0 + s * 0.3, y0 + s * 0.44, x0 + s * 0.72, y0 + s * 0.86], outline=fill, width=w)
        # ภูเขา
        d.line([(x0 + s * 0.22, y1 - s * 0.34), (cx - s * 0.1, cy + s * 0.02),
                (cx + s * 0.3, y1 - s * 0.34)], fill=fill, width=w, joint="curve")
        d.line([(cx + s * 0.12, y1 - s * 0.34), (cx + s * 0.55, cy - s * 0.1),
                (x1 - s * 0.18, y1 - s * 0.34)], fill=fill, width=w, joint="curve")

    elif kind == "chart":
        for i, h in enumerate((0.42, 0.78, 0.58, 1.0)):
            bx = x0 + s * (0.18 + i * 0.5)
            d.rounded_rectangle([bx, y1 - 2 * s * h * 0.62, bx + s * 0.3, y1], radius=8,
                                outline=fill, width=w)

    elif kind == "list":
        for i in range(3):
            ly = y0 + s * (0.34 + i * 0.66)
            d.ellipse([x0, ly - w, x0 + 2 * w, ly + w], fill=fill)
            d.line([(x0 + s * 0.42, ly), (x1, ly)], fill=fill, width=w)

    elif kind == "target":
        for r in (s, s * 0.62, s * 0.24):
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=fill, width=w)

    elif kind == "help":
        d.ellipse([x0, y0, x1, y1], outline=fill, width=w)
        # ตะขอบน: เริ่มซ้าย → ขึ้นบน → ลงขวา (PIL องศาเดินตามเข็ม 0° = 3 นาฬิกา)
        d.arc([cx - s * 0.36, cy - s * 0.58, cx + s * 0.36, cy + s * 0.14], 180, 30, fill=fill, width=w)
        d.line([(cx + s * 0.26, cy - s * 0.02), (cx, cy + s * 0.24)], fill=fill, width=w)
        d.ellipse([cx - w, cy + s * 0.46, cx + w, cy + s * 0.46 + 2 * w], fill=fill)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    f_title = find_font(88, bold=True)
    f_sub = find_font(56, bold=False)

    for i, (kind, title, sub) in enumerate(CELLS):
        col, row = i % 3, i // 3
        x0, y0 = col * CW, row * CH
        cx, cy = x0 + CW / 2, y0 + CH / 2

        # เส้นแบ่งช่อง (ไม่วาดขอบนอกสุด — ให้ดูต่อเนื่องกับหน้าจอ)
        if col: d.line([(x0, y0), (x0, y0 + CH)], fill=LINE, width=4)
        if row: d.line([(x0, y0), (x0 + CW, y0)], fill=LINE, width=4)

        icon(d, kind, cx, cy - 150)
        centered(d, title, f_title, cx, cy + 40, FG)
        centered(d, sub, f_sub, cx, cy + 150, SUB)

    img.save(OUT, "PNG", optimize=True)
    size_kb = os.path.getsize(OUT) / 1024
    print(f"✅ เขียน {os.path.normpath(OUT)}  ({W}×{H}, {size_kb:.0f} KB)")
    if size_kb > 1024:
        print("!! LINE จำกัดรูป rich menu ไม่เกิน 1MB — ลองลดรายละเอียด")


if __name__ == "__main__":
    main()
