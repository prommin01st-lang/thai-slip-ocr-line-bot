#!/usr/bin/env python3
"""richmenu_image.py — วาดรูปเมนูล่าง 2500×1686

    python3 scripts/richmenu_image.py

เขียน 3 ไฟล์:
    assets/richmenu.png       โหมดหน้าเดียว 3×2 ช่องละ 833×843
    assets/richmenu-tab1.png  โหมดแท็บ หน้า "หลัก"      (แถบแท็บ 230 + ช่อง 833×728)
    assets/richmenu-tab2.png  โหมดแท็บ หน้า "เพิ่มเติม"

richmenu.mjs เข้าโหมดแท็บก็ต่อเมื่อมีรูป tab1 **และ** tab2 ครบ ทั้งสามไฟล์นี้เป็นแค่
ตัวสำรอง/ตัวอ้างอิง — ถ้ามีรูปที่ออกแบบเอง (richmenu-*-custom.*) จะถูกใช้ก่อน

ต้องมี pillow (ใช้ venv ไหนก็ได้ เช่น bench/.venv-ocr/bin/python)
ใช้ฟอนต์ Noto Sans Thai ที่มีในเครื่อง — ถ้าไม่มีจะ fallback เป็นฟอนต์ default
(อ่านออกน้อยลงแต่ไม่พัง)
"""
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 1686
CW, CH = W // 3, H // 2                 # โหมดหน้าเดียว
TAB_H, TAB_W = 230, W // 2              # แถบแท็บ
CH_TAB = (H - TAB_H) // 2               # 728 — ช่องเตี้ยลงเพราะเสียที่ให้แท็บ
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
OUT = os.path.join(ASSETS, "richmenu.png")

BG = (247, 245, 242)
TAB_OFF = (237, 233, 226)               # แท็บที่ไม่ได้เลือก — เข้มกว่าพื้นนิดเดียว
ACCENT = (46, 91, 125)                  # ฟ้าเข้มจากพาเลตต์ ใช้ขีดใต้แท็บที่เลือก
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

# หน้า 2 ของโหมดแท็บ — ลำดับต้องตรงกับ MORE_CELLS ใน richmenu.mjs
CELLS_MORE = [
    # "จันทร์ถึงวันนี้" ไม่ใช่ "7 วันล่าสุด" — thisWeek() ใน notify.js นับจากวันจันทร์
    # (และตัวเลขอารบิกใส่ในรูปนี้ไม่ได้อยู่ดี ดูหมายเหตุเรื่องฟอนต์ด้านล่าง)
    ("week", "สรุปสัปดาห์", "จันทร์ถึงวันนี้"),
    ("stack", "สรุปทั้งหมด", "ตั้งแต่เริ่มใช้"),
    ("out", "รายจ่าย", "เฉพาะขาออก"),
    ("gear", "ตั้งค่า", "เตือนและบัญชี"),
    ("shield", "ข้อมูลของฉัน", "ที่เก็บไว้"),
    ("trash", "ลบข้อมูล", "ถามยืนยันก่อน"),
]

# ⚠️ NotoSansThai-*.ttf เป็นฟอนต์ **subset เฉพาะไทย** — ไม่มี glyph ASCII เกือบทั้งหมด
# **รวมถึงตัวเลข 0-9 ด้วย** (เคยเขียนตรงนี้ว่าตัวเลขใช้ได้ ซึ่งผิด — "7 วันล่าสุด"
# ออกมาเป็นกล่องว่างหน้าข้อความ) เลข '๗' แบบไทยมี แต่ '7' ไม่มี ส่วน '-' มี
# → ใช้ได้แค่อักษรไทย เลขไทย และ '-'  ที่เหลือ check_glyphs() ด้านล่างจะฟ้องให้เอง
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


def check_glyphs(font, texts):
    """ฟ้องตัวอักษรที่ฟอนต์ไม่มี — ไม่งั้นมันจะเงียบ ๆ กลายเป็นกล่องว่างในรูปที่ส่งขึ้น LINE

    เทียบ bbox กับ U+FFFF ซึ่งไม่มีในฟอนต์ไหนเลย จึงเป็น .notdef เสมอ
    """
    probe = Image.new("L", (10, 10))
    d = ImageDraw.Draw(probe)
    notdef = d.textbbox((0, 0), "￿", font=font)
    bad = sorted({c for t in texts for c in t
                  if not c.isspace() and d.textbbox((0, 0), c, font=font) == notdef})
    if bad:
        print(f"!! ฟอนต์ไม่มีตัวอักษร {bad} — จะกลายเป็นกล่องว่างในรูป แก้ข้อความก่อน")
    return bad


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

    elif kind == "week":                                    # ปฏิทิน 7 ช่อง
        box(x0, y0 + s * 0.22, x1, y1)
        d.line([(x0, y0 + s * 0.72), (x1, y0 + s * 0.72)], fill=fill, width=w)
        for hx in (cx - s * 0.5, cx + s * 0.5):             # ห่วงแขวนด้านบน
            d.line([(hx, y0), (hx, y0 + s * 0.42)], fill=fill, width=w)
        for i in range(4):                                  # เม็ดวัน
            dx = x0 + s * (0.34 + i * 0.46)
            d.ellipse([dx - w, cy + s * 0.24 - w, dx + w, cy + s * 0.24 + w], fill=fill)

    elif kind == "stack":                                   # ยอดสะสมทับกันเป็นชั้น
        for i, wid in enumerate((1.0, 0.74, 0.48)):
            ty = y1 - s * (0.28 + i * 0.62)
            d.rounded_rectangle([x0, ty - s * 0.24, x0 + 2 * s * wid, ty + s * 0.24],
                                radius=14, outline=fill, width=w)

    elif kind == "out":                                     # ลูกศรพุ่งออกจากกล่อง
        box(x0, y0 + s * 0.3, cx + s * 0.1, y1)
        d.line([(cx - s * 0.2, cy + s * 0.1), (x1, y0 + s * 0.16)], fill=fill, width=w)
        d.line([(x1 - s * 0.62, y0 + s * 0.16), (x1, y0 + s * 0.16)], fill=fill, width=w)
        d.line([(x1, y0 + s * 0.16), (x1, y0 + s * 0.78)], fill=fill, width=w)

    elif kind == "gear":
        # สไลเดอร์ ไม่ใช่เฟือง — เฟืองวาดด้วยวงกลม+ซี่ตรง ๆ แล้วออกมาเหมือน "ดวงอาทิตย์"
        # สไลเดอร์สื่อว่า "ปรับค่า" ได้ชัดกว่า และวาดด้วยเส้นล้วนได้สะอาดกว่ามาก
        for i, kx in enumerate((0.62, 0.3, 0.78)):
            ly = y0 + s * (0.4 + i * 0.8)
            d.line([(x0, ly), (x1, ly)], fill=fill, width=w)
            knob = x0 + 2 * s * kx
            d.ellipse([knob - s * 0.2, ly - s * 0.2, knob + s * 0.2, ly + s * 0.2],
                      outline=fill, width=w, fill=BG)

    elif kind == "shield":                                  # โล่ + เครื่องหมายถูก
        d.line([(cx, y0), (x1, y0 + s * 0.34), (x1 - s * 0.2, cy + s * 0.5), (cx, y1),
                (x0 + s * 0.2, cy + s * 0.5), (x0, y0 + s * 0.34), (cx, y0)],
               fill=fill, width=w, joint="curve")
        d.line([(cx - s * 0.36, cy), (cx - s * 0.08, cy + s * 0.3), (cx + s * 0.42, cy - s * 0.28)],
               fill=fill, width=w, joint="curve")

    elif kind == "trash":                                   # ถังขยะ
        d.line([(x0 + s * 0.1, y0 + s * 0.42), (x1 - s * 0.1, y0 + s * 0.42)], fill=fill, width=w)
        d.rounded_rectangle([cx - s * 0.32, y0 + s * 0.06, cx + s * 0.32, y0 + s * 0.42],
                            radius=8, outline=fill, width=w)
        d.rounded_rectangle([x0 + s * 0.28, y0 + s * 0.42, x1 - s * 0.28, y1], radius=16,
                            outline=fill, width=w)
        for dx in (-s * 0.24, 0, s * 0.24):
            d.line([(cx + dx, y0 + s * 0.76), (cx + dx, y1 - s * 0.3)], fill=fill, width=w)


def draw_grid(d, cells, top, ch, fonts):
    """วาดตาราง 3×2 เริ่มที่ y = top ช่องสูง ch"""
    f_title, f_sub = fonts
    for i, (kind, title, sub) in enumerate(cells):
        col, row = i % 3, i // 3
        x0, y0 = col * CW, top + row * ch
        cx, cy = x0 + CW / 2, y0 + ch / 2

        # เส้นแบ่งช่อง (ไม่วาดขอบนอกสุด — ให้ดูต่อเนื่องกับหน้าจอ)
        if col: d.line([(x0, y0), (x0, y0 + ch)], fill=LINE, width=4)
        if row: d.line([(x0, y0), (x0 + CW, y0)], fill=LINE, width=4)

        icon(d, kind, cx, cy - ch * 0.19)
        centered(d, title, f_title, cx, cy + ch * 0.05, FG)
        centered(d, sub, f_sub, cx, cy + ch * 0.18, SUB)


def draw_tabs(d, active, font):
    """แถบแท็บด้านบน — แท็บที่เปิดอยู่พื้นสว่างกว่า + มีขีดใต้"""
    for i, name in enumerate(("หลัก", "เพิ่มเติม")):
        x0 = i * TAB_W
        on = i == active
        d.rectangle([x0, 0, x0 + TAB_W, TAB_H], fill=BG if on else TAB_OFF)
        centered(d, name, font, x0 + TAB_W / 2, TAB_H / 2 - 10, FG if on else SUB)
        if on:
            d.rounded_rectangle([x0 + TAB_W * 0.38, TAB_H - 18, x0 + TAB_W * 0.62, TAB_H - 8],
                                radius=5, fill=ACCENT)
    d.line([(TAB_W, 20), (TAB_W, TAB_H - 20)], fill=LINE, width=4)
    d.line([(0, TAB_H), (W, TAB_H)], fill=LINE, width=4)


def save(img, name):
    path = os.path.join(ASSETS, name)
    img.save(path, "PNG", optimize=True)
    kb = os.path.getsize(path) / 1024
    print(f"✅ {name}  ({W}×{H}, {kb:.0f} KB)")
    if kb > 1024:
        print("   !! เกิน 1 MB ที่ LINE รับ — ลองลดรายละเอียด หรือส่งออกเป็น JPEG")


def main():
    os.makedirs(ASSETS, exist_ok=True)
    fonts = (find_font(88, bold=True), find_font(56, bold=False))
    f_tab = find_font(72, bold=True)

    words = [t for c in CELLS + CELLS_MORE for t in c[1:]] + ["หลัก", "เพิ่มเติม"]
    check_glyphs(fonts[0], words)

    # 1) โหมดหน้าเดียว — ตัวสำรองสุดท้าย ยังใช้ตาราง 3×2 เต็มหน้าเหมือนเดิม
    img = Image.new("RGB", (W, H), BG)
    draw_grid(ImageDraw.Draw(img), CELLS, 0, CH, fonts)
    save(img, "richmenu.png")

    # 2) โหมดแท็บ — สองหน้า ต่างกันแค่แท็บที่ไฮไลต์กับเนื้อในตาราง
    for idx, (name, cells) in enumerate((("richmenu-tab1.png", CELLS),
                                         ("richmenu-tab2.png", CELLS_MORE))):
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        draw_tabs(d, idx, f_tab)
        draw_grid(d, cells, TAB_H, CH_TAB, fonts)
        save(img, name)


if __name__ == "__main__":
    main()
