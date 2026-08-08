#!/usr/bin/env python3
"""
gpu_baseline.py — สร้าง "เส้นเทียบ" จาก pipeline GPU ที่ใช้งานอยู่จริง

รันบน **เครื่องบ้าน (RTX 2060)** ด้วย venv ของ slip-ocr-th:
    cd SlipingMan-line-assistant/bench
    ../../slip-ocr-th/.venv/bin/python gpu_baseline.py

ได้ baseline.json ที่เก็บ {ข้อความ OCR, ผล parse, เวลา} ของทุกรูป
→ เอาไปให้ bench_cpu_vlm.py บน VPS เทียบว่า CPU ทำได้ใกล้เคียงแค่ไหน

⚠️ นี่คือ "ผลของระบบปัจจุบัน" ไม่ใช่เฉลยที่มนุษย์ตรวจแล้ว
   ถ้า GPU อ่านผิด baseline ก็ผิดตาม — ใช้ตอบคำถาม "CPU ทำได้เท่าที่ใช้อยู่ไหม"
   ไม่ใช่ "CPU ถูกต้องไหม" (ใบเงินเดือนสังเคราะห์ใน dataset/payslips/ มีเฉลยจริงถ้าต้องการ)
"""
import os
import sys
import json
import time
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
SLIP_OCR = os.environ.get("SLIP_OCR_DIR", os.path.normpath(os.path.join(HERE, "..", "..", "slip-ocr-th")))
sys.path.insert(0, SLIP_OCR)

try:
    from ocr import ocr_image
    from slip_parser import parse_slip
    from payslip_parser import parse_payslip
    from receipt_parser import parse_receipt
    from doc_router import classify
except ImportError as e:
    sys.exit(f"!! import จาก {SLIP_OCR} ไม่ได้: {e}\n"
             f"   ต้องรันด้วย venv ของ slip-ocr-th: {SLIP_OCR}/.venv/bin/python")

PROMPT_FREE = "<image>\nFree OCR. "
IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")


def collect_images(dirs):
    out = []
    for d in dirs:
        d = d if os.path.isabs(d) else os.path.join(SLIP_OCR, d)
        if not os.path.isdir(d):
            print(f"   (ข้าม {d} — ไม่มีโฟลเดอร์นี้)")
            continue
        for name in sorted(os.listdir(d)):
            if name.lower().endswith(IMG_EXT):
                out.append(os.path.join(d, name))
    return out


def parse_by_type(text):
    """เดินตามตรรกะเดียวกับ serve.py `/parse` — classify แล้ว route"""
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


def main():
    ap = argparse.ArgumentParser(description="สร้าง baseline จาก GPU pipeline")
    ap.add_argument("--dirs", nargs="+", default=["Data", "samples"],
                    help="โฟลเดอร์รูป (relative ต่อ slip-ocr-th หรือ absolute)")
    ap.add_argument("-o", "--output", default=os.path.join(HERE, "baseline.json"))
    args = ap.parse_args()

    images = collect_images(args.dirs)
    if not images:
        sys.exit("!! ไม่พบรูปเลย")

    print(f">> พบ {len(images)} รูป — เริ่ม OCR ด้วย GPU (ครั้งแรกโหลดโมเดล ~11 วิ)\n")
    results = {}
    for i, path in enumerate(images, 1):
        name = os.path.basename(path)
        print(f"[{i}/{len(images)}] {name} ... ", end="", flush=True)
        t0 = time.perf_counter()
        try:
            text = ocr_image(path, prompt=PROMPT_FREE, preprocess=True)
            dt = time.perf_counter() - t0
            parsed = parse_by_type(text)
            results[name] = {
                "path": path,
                "seconds": round(dt, 2),
                "text": text,
                "parsed": parsed,
                "bytes": os.path.getsize(path),
            }
            amt = parsed.get("net_pay") or parsed.get("total") or parsed.get("amount")
            print(f"{dt:.1f}s  [{parsed['doc_type']}] ยอด={amt} conf={parsed.get('confidence')}")
        except Exception as e:
            results[name] = {"path": path, "error": str(e)}
            print(f"ล้มเหลว: {e}")

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    ok = [r for r in results.values() if "error" not in r]
    if ok:
        avg = sum(r["seconds"] for r in ok) / len(ok)
        print(f"\n>> สำเร็จ {len(ok)}/{len(results)} รูป | เฉลี่ย {avg:.1f}s/รูป (GPU)")
    print(f">> เขียน {args.output}")
    print(">> ขั้นต่อไป: คัดลอกไฟล์นี้ + โฟลเดอร์รูป ไปที่ VPS แล้วรัน bench_cpu_vlm.py")


if __name__ == "__main__":
    main()
