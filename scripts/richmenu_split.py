#!/usr/bin/env python3
"""richmenu_split.py — ตัดแผ่นไอคอนรวมเป็นไฟล์ทีละอัน

    python3 scripts/richmenu_split.py sheet.png --page 2            # 2x3 → tab2-1..6
    python3 scripts/richmenu_split.py sheet.png --page both --grid 4x3   # → tab1-1..6 + tab2-1..6

ใช้ตอนสั่ง AI วาดไอคอนมาเป็น "แผ่นเดียวหลายอัน" แทนที่จะสั่งทีละอัน
ข้อดีคือสไตล์เข้าชุดกันแน่นอน เพราะเกิดจากการ generate ครั้งเดียว

**อัตราส่วนที่ทำให้ช่องเป็นจัตุรัสพอดี** (สำคัญ เพราะไอคอนจะได้ไม่ถูกบีบ):

    2 คอลัมน์ x 3 แถว  →  ขอรูปอัตราส่วน 2:3   (6 อัน = หนึ่งหน้า)
    4 คอลัมน์ x 3 แถว  →  ขอรูปอัตราส่วน 4:3   (12 อัน = ทั้งเมนู)
    3 คอลัมน์ x 2 แถว  →  ขอรูปอัตราส่วน 3:2   (แต่เครื่องมือส่วนใหญ่ไม่มีให้เลือก)

สคริปต์ไม่ได้เชื่อว่า AI จะวางไอคอนตรงกลางช่องเป๊ะ — หลังตัดจะ **คีย์พื้นออก
แล้วครอปตามขอบจริงของไอคอน** ช่องที่เยื้องไปนิดหน่อยจึงไม่มีผล
(richmenu_compose.py จัดกึ่งกลางให้อีกทีอยู่แล้ว)

ต้องมี pillow (ใช้ venv ไหนก็ได้ เช่น bench/.venv-ocr/bin/python)
"""
import argparse
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from richmenu_compose import ICONS, autokey  # noqa: E402

MARGIN = 0.04           # เว้นขอบรอบไอคอนหลังครอป (สัดส่วนของด้านที่ยาวกว่า)


def cut(sheet, cols, rows):
    """ตัดเป็น cols x rows ช่องเท่า ๆ กัน เรียงจากซ้ายไปขวา บนลงล่าง"""
    w, h = sheet.size
    for r in range(rows):
        for c in range(cols):
            yield sheet.crop((round(c * w / cols), round(r * h / rows),
                              round((c + 1) * w / cols), round((r + 1) * h / rows)))


def trim(cell):
    """คีย์พื้นออก แล้วครอปให้ชิดตัวไอคอนจริง — กันกรณี AI วางไม่ตรงกลางช่อง"""
    keyed = autokey(cell.convert("RGB"))
    if keyed is None:
        return cell.convert("RGBA")          # พื้นมีลวดลาย ครอปมั่วไม่ได้ ปล่อยตามเดิม
    box = keyed.getchannel("A").getbbox()
    if box is None:
        return keyed                          # ช่องว่างเปล่า
    pad = round(max(box[2] - box[0], box[3] - box[1]) * MARGIN)
    return keyed.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                       min(keyed.width, box[2] + pad), min(keyed.height, box[3] + pad)))


def main():
    ap = argparse.ArgumentParser(description="ตัดแผ่นไอคอนรวมเป็นไฟล์ทีละอัน")
    ap.add_argument("sheet", help="ไฟล์แผ่นรวม")
    ap.add_argument("--page", default="2", choices=["1", "2", "both"],
                    help="ตัดไปเป็นไอคอนของหน้าไหน (both = 12 ช่อง เรียง หน้า1 ก่อน)")
    ap.add_argument("--grid", default=None, help="เช่น 2x3 หรือ 4x3 (ปกติเดาจากจำนวนที่ต้องการ)")
    a = ap.parse_args()

    pages = ["1", "2"] if a.page == "both" else [a.page]
    need = 6 * len(pages)
    cols, rows = ([int(v) for v in a.grid.lower().split("x")] if a.grid
                  else ((4, 3) if need == 12 else (2, 3)))
    if cols * rows < need:
        print(f"!! ตาราง {cols}x{rows} = {cols * rows} ช่อง แต่ต้องการอย่างน้อย {need}")
        return 1
    # ช่องที่เกินไม่ทิ้ง — เซฟเป็น extra-N.png ไว้ใช้สลับตัวที่ไม่ถูกใจทีหลัง
    # (ตาราง 4x4 = 16 ช่อง ใช้จริง 12 เหลือ 4 พอดี)
    spare = cols * rows - need

    sheet = Image.open(a.sheet)
    ratio = sheet.width / sheet.height
    ideal = cols / rows
    print(f"แผ่น {sheet.width}x{sheet.height} (อัตราส่วน {ratio:.3f}) ตัด {cols}x{rows}")
    if abs(ratio - ideal) / ideal > 0.06:
        print(f"   !! ช่องจะไม่เป็นจัตุรัส — ตาราง {cols}x{rows} อยากได้รูปอัตราส่วน {ideal:.3f}")
        print("      ไอคอนยังใช้ได้ แต่ถ้าวาดใหม่ ขออัตราส่วนนั้นจะพอดีกว่า")

    os.makedirs(ICONS, exist_ok=True)
    for i, cell in enumerate(cut(sheet, cols, rows)):
        name = (f"tab{pages[i // 6]}-{i % 6 + 1}" if i < need else f"extra-{i - need + 1}")
        ic = trim(cell)
        ic.save(os.path.join(ICONS, name + ".png"))
        print(f"  {name}.png  {ic.width}x{ic.height}"
              f"{'' if ic.mode == 'RGBA' else '  (พื้นทึบ)'}")
    if spare:
        print(f"\n({spare} อันท้ายเป็นตัวสำรอง — เปลี่ยนชื่อทับ tabN-M.png ได้ถ้าชอบกว่า)")
    print("\nต่อด้วย: python3 scripts/richmenu_compose.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
