#!/usr/bin/env python3
"""richmenu_compose.py — ประกอบรูปเมนูจาก "ไอคอนทีละอัน" ให้เป็น 2500×1686 เป๊ะ ๆ

    python3 scripts/richmenu_compose.py

ทำไมต้องมีไฟล์นี้: เครื่องมือ AI วาดรูปส่วนใหญ่ให้เลือกอัตราส่วนได้แค่ชุดสำเร็จ
(1:1, 4:3, 16:9, 9:16, ...) ซึ่ง **ไม่มีอันไหนตรง 1.4828 ที่ rich menu ต้องการเลย**
ที่ใกล้สุดคือ 4:3 ซึ่งยังต้องครอปความสูงทิ้ง 10%

และต่อให้ครอปจนได้อัตราส่วนถูก ก็ยังเหลือปัญหาใหญ่กว่า — **เส้นแบ่งต้องตรงตาราง
833px พอดี** ครอปทีเดียวเส้นเลื่อนหมด กดปุ่มแล้วไปโดนช่องข้าง ๆ

ทางออก: ขอ AI วาดแค่ **ไอคอน 1:1 ทีละอัน** (ซึ่งเป็นอัตราส่วนที่มันทำได้ดีที่สุด)
แล้วให้สคริปต์นี้วางลงตาราง + เรนเดอร์ข้อความไทยเอง
  - ตารางตรงเป๊ะเพราะคำนวณจากตัวเลขเดียวกับ richmenu.mjs
  - ข้อความไทยไม่มีทางสะกดเพี้ยน (เคยเจอ "ถ่ายสลับ" แทน "ถ่ายสลิป" มาแล้ว)
  - คุมขนาดไฟล์ให้ไม่เกิน 1 MB ได้

วางไอคอนไว้ที่ assets/icons/ ตามชื่อนี้ (ขนาดเท่าไหร่ก็ได้ ไม่ต้องจัตุรัสเป๊ะ):

    tab1-1.png … tab1-6.png     หน้า "หลัก"
    tab2-1.png … tab2-6.png     หน้า "เพิ่มเติม"

**PNG พื้นโปร่ง (alpha) ดีที่สุด** — แต่ถ้าเครื่องมือทำพื้นโปร่งไม่ได้ก็ไม่เป็นไร
ขอแค่พื้นเป็น "สีเรียบสีเดียว" สคริปต์จะคีย์ออกให้เอง (ดู autokey)
หน้าไหนไอคอนไม่ครบ 6 อันจะถูกข้าม (ไม่เขียนทับของเดิม)

prompt สำเร็จรูปสำหรับสั่ง AI วาดไอคอน: assets/icons/PROMPT.md

ต้องมี pillow (ใช้ venv ไหนก็ได้ เช่น bench/.venv-ocr/bin/python)
"""
import os

from PIL import Image, ImageChops, ImageDraw

from richmenu_image import (ACCENT, ASSETS, BG, CELLS, CELLS_MORE, CH_TAB, CW, FG,  # noqa: F401
                            H, LINE, SUB, TAB_H, TAB_W, W, centered, check_glyphs,
                            draw_tabs, find_font)

ICONS = os.path.join(ASSETS, "icons")
MAX_BYTES = 1024 * 1024

# วงกลมพาสเทลหลังไอคอน — สีเดียวกับโทนการ์ด Flex ไล่ตามช่อง
# มีไว้ให้ไอคอนที่มาจากคนละไฟล์ดูเป็นชุดเดียวกัน แม้สไตล์จะไม่เหมือนกันเป๊ะ
HALOS = [(227, 243, 235), (232, 238, 246), (251, 240, 218),
         (248, 227, 227), (239, 235, 229), (237, 233, 246)]

ICON_BOX = 300          # ด้านของกรอบไอคอนในรูปสุดท้าย
HALO_R = 195            # รัศมีวงกลมพาสเทล

# ตำแหน่งแนวตั้งในช่อง (คูณกับความสูงช่อง) — จัดให้ไอคอน+หัวข้อ+คำอธิบาย
# เป็นก้อนเดียวที่อยู่กึ่งกลางช่องพอดี ไอคอนที่นี่ใหญ่กว่าของ richmenu_image.py
# ราวสองเท่า จึงใช้ระยะคนละชุดกัน
Y_ICON, Y_TITLE, Y_SUB = -0.135, 0.16, 0.285


def load_icon(page, idx):
    """หาไฟล์ไอคอน — รับได้ทั้ง .png และ .jpg"""
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        p = os.path.join(ICONS, f"tab{page}-{idx}{ext}")
        if os.path.exists(p):
            return p
    return None


def autokey(rgb, tol=26):
    """ไอคอนพื้นทึบ → คีย์สีพื้นออกเป็น alpha ให้อัตโนมัติ

    เครื่องมือ AI วาดรูปหลายตัวส่งออก PNG พื้นโปร่งไม่ได้ ได้พื้นทึบมาแทน
    วางทับตรง ๆ จะเห็นเป็นสี่เหลี่ยมกลางช่อง — คีย์ให้เองดีกว่าให้ไปแก้มือทีละอัน

    ทำเฉพาะตอนสี่มุมเป็นสีเดียวกันจริง ๆ ถ้ามุมไม่เหมือนกัน = พื้นมีลวดลาย
    เดามั่วแล้วจะกัดตัวไอคอนหาย เลยคืน None ให้ไปใช้แบบทึบตามเดิม
    """
    w, h = rgb.size
    corners = [rgb.getpixel(p) for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    for ch in range(3):
        vals = [c[ch] for c in corners]
        if max(vals) - min(vals) > 12:
            return None
    bg = tuple(sum(c[ch] for c in corners) // 4 for ch in range(3))

    r, g, b = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).split()
    dist = ImageChops.lighter(ImageChops.lighter(r, g), b)
    alpha = dist.point(lambda v: 0 if v <= tol else min(255, (v - tol) * 12))
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def prep_icon(path):
    """โหลด + ย่อให้พอดีกรอบ คงอัตราส่วนเดิม (ไอคอนไม่จัตุรัสก็ไม่บิด)"""
    ic = Image.open(path)
    if ic.mode in ("RGBA", "LA", "P"):
        ic = ic.convert("RGBA")
        if ic.getchannel("A").getextrema()[0] == 255:      # มี alpha แต่ทึบหมด
            ic = autokey(ic.convert("RGB")) or ic
    else:
        ic = autokey(ic.convert("RGB")) or ic.convert("RGB")
    ic.thumbnail((ICON_BOX, ICON_BOX), Image.LANCZOS)
    return ic


def brings_own_background(ic):
    """ไอคอนมีพื้นหลังของตัวเองแล้วหรือยัง — ถ้ามี อย่าวาดวงพาสเทลซ้อนให้ซ้ำซ้อน

    (ไอคอนที่ตัดมาจากงานออกแบบมักติดวงกลมพาสเทลของตัวเองมาด้วย
    วาดวงของเราทับอีกชั้นจะกลายเป็นวงซ้อนวงคนละสี)
    """
    if ic.mode != "RGBA":
        return True                       # ทึบทั้งแผ่น = มีพื้นของตัวเองแน่นอน
    a = ic.getchannel("A")
    # histogram เร็วกว่าไล่ทีละพิกเซล และไม่ต้องพึ่ง API ที่ Pillow กำลังจะเลิกใช้
    return sum(a.histogram()[201:]) > 0.55 * ic.width * ic.height


def compose(page, cells, fonts, f_tab):
    paths = [load_icon(page, i + 1) for i in range(6)]
    missing = [i + 1 for i, p in enumerate(paths) if p is None]
    if missing:
        print(f"ข้ามหน้า {page} — ไม่มีไอคอน {['tab%d-%d' % (page, m) for m in missing]}")
        return None

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    draw_tabs(d, page - 1, f_tab)

    f_title, f_sub = fonts
    boxy = []
    for i, (_kind, title, sub) in enumerate(cells):
        col, row = i % 3, i // 3
        x0, y0 = col * CW, TAB_H + row * CH_TAB
        cx, cy = x0 + CW / 2, y0 + CH_TAB / 2
        if col: d.line([(x0, y0), (x0, y0 + CH_TAB)], fill=LINE, width=4)
        if row: d.line([(x0, y0), (x0 + CW, y0)], fill=LINE, width=4)

        ic = prep_icon(paths[i])
        iy = cy + CH_TAB * Y_ICON
        if not brings_own_background(ic):
            d.ellipse([cx - HALO_R, iy - HALO_R, cx + HALO_R, iy + HALO_R], fill=HALOS[i])
        if ic.mode != "RGBA":
            boxy.append(os.path.basename(paths[i]))
        img.paste(ic, (int(cx - ic.width / 2), int(iy - ic.height / 2)),
                  ic if ic.mode == "RGBA" else None)

        centered(d, title, f_title, cx, cy + CH_TAB * Y_TITLE, FG)
        centered(d, sub, f_sub, cx, cy + CH_TAB * Y_SUB, SUB)

    if boxy:
        print(f"   !! ไอคอนพื้นทึบ ไม่มี alpha จะเห็นเป็นสี่เหลี่ยม: {boxy}")
    return img


def save_under_limit(img, name):
    """PNG ก่อน ถ้าเกิน 1 MB ค่อยถอยไป JPEG — LINE รับไม่เกิน 1 MB"""
    png = os.path.join(ASSETS, name + ".png")
    img.save(png, "PNG", optimize=True)
    if os.path.getsize(png) <= MAX_BYTES:
        print(f"✅ {name}.png  ({W}×{H}, {os.path.getsize(png) / 1024:.0f} KB)")
        return
    os.remove(png)
    for q in (95, 92, 90, 88, 85):
        jpg = os.path.join(ASSETS, name + ".jpg")
        img.save(jpg, "JPEG", quality=q, subsampling=0, optimize=True, progressive=True)
        if os.path.getsize(jpg) <= MAX_BYTES:
            print(f"✅ {name}.jpg  ({W}×{H}, q={q}, {os.path.getsize(jpg) / 1024:.0f} KB)")
            return
    print(f"!! {name} ยังเกิน 1 MB แม้บีบสุดแล้ว — ลดรายละเอียดไอคอนลง")


def main():
    if not os.path.isdir(ICONS):
        print(f"!! ไม่มีโฟลเดอร์ {os.path.normpath(ICONS)}")
        print("   วางไอคอน tab1-1..6 / tab2-1..6 (PNG พื้นโปร่ง) ไว้ในนั้นก่อน")
        return

    fonts = (find_font(88, bold=True), find_font(56, bold=False))
    f_tab = find_font(72, bold=True)
    check_glyphs(fonts[0], [t for c in CELLS + CELLS_MORE for t in c[1:]] + ["หลัก", "เพิ่มเติม"])

    for page, cells in ((1, CELLS), (2, CELLS_MORE)):
        img = compose(page, cells, fonts, f_tab)
        if img is not None:
            save_under_limit(img, f"richmenu-tab{page}-custom")


if __name__ == "__main__":
    main()
