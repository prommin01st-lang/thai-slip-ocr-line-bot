#!/usr/bin/env python3
"""
eval_dataset.py — วัด OCR+parser บนสลิปไทยจริง 332 ใบ (3 ธนาคาร)

**เฉลยมาจากชื่อไฟล์** — ตรวจด้วยตาแล้วว่าตรงกับสิ่งที่พิมพ์บนสลิปจริง:

    k-bank-slip/016139201304BQR04248.jpeg   → ref  = 016139201304BQR04248  (= "เลขที่รายการ")
    ttb-slip/Transfer_20260417_122336.jpg   → date = 2026-04-17, time = 12:23
    TruemoneySlip/invoice_2026-05-25_09.35.21.png → date = 2026-05-25, time = 09:35

ฟิลด์ที่ไม่มีเฉลย (amount ฯลฯ) วัดเป็น **coverage** = หาเจอกี่ % ไม่ใช่ความถูกต้อง
— แยกให้ชัดว่าอันไหน "พิสูจน์ว่าถูก" อันไหนแค่ "หาเจอ"

รัน (ต้องใช้ venv ที่มี paddleocr):
    .venv-ocr/bin/python eval_dataset.py --limit 20          # ลองน้อย ๆ ก่อน
    .venv-ocr/bin/python eval_dataset.py --workers 4         # เต็มชุด

🔒 ข้อมูลนี้เป็นสลิปจริง มีชื่อ/เลขบัญชี = PII
   ผลลัพธ์ **ไม่เก็บข้อความ OCR ดิบ** ลงไฟล์ เว้นแต่ใส่ --save-text เอง
"""
import os
import re
import sys
import json
import time
import argparse
from collections import defaultdict
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
SLIP_OCR = os.environ.get("SLIP_OCR_DIR", os.path.normpath(os.path.join(HERE, "..", "..", "slip-ocr-th")))
sys.path.insert(0, SLIP_OCR)

from slip_parser import parse_slip      # noqa: E402  (stdlib ล้วน — ไม่ต้องมี torch)
from doc_router import classify         # noqa: E402

DATASET = os.environ.get("DATASET_DIR", "/home/petanque/Work/Dataset")
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


# ---------- เฉลยจากชื่อไฟล์ ----------
_TTB = re.compile(r"^(?:Transfer|Topup|[A-Za-z]+)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\d{2}$")
_TRUEMONEY = re.compile(r"^invoice_(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})\.\d{2}$")
_KBANK_REF = re.compile(r"^[0-9A-Z]{15,25}$")


def truth_from_name(folder: str, stem: str):
    """ชื่อไฟล์ → เฉลย. คืน (dict, reliable)

    ความน่าเชื่อถือของเฉลยไม่เท่ากันในแต่ละโฟลเดอร์ — ตรวจด้วยตาแล้ว:

    - **k-bank: เชื่อได้** ชื่อไฟล์ = "เลขที่รายการ" ที่พิมพ์บนสลิปตรงตัวอักษรต่ออักษร
    - **ttb: เชื่อได้** `Transfer_20260417_122336` ตรงกับ "17 เม.ย. 69, 12:23 น." บนสลิป
    - **TrueMoney: เชื่อไม่ได้** ⚠️ ชื่อไฟล์คือเวลาที่เซฟไฟล์ ไม่ใช่เวลาทำรายการ
      พิสูจน์แล้ว: `invoice_2026-07-09_16.16.30` แต่สลิปเขียน "08 ก.ค. 2569 23:43:54"
      → ไม่เอามาคิดคะแนน (ถ้าเอามาคิด เราจะไปหักคะแนน parser ที่อ่านถูก)
    """
    if folder == "k-bank-slip":
        return ({"ref": stem}, True) if _KBANK_REF.match(stem) else ({}, False)
    m = _TTB.match(stem)
    if m:
        y, mo, d, hh, mm = m.groups()
        return {"date": f"{y}-{mo}-{d}", "time": f"{hh}:{mm}"}, True
    m = _TRUEMONEY.match(stem)
    if m:
        y, mo, d, hh, mm = m.groups()
        return {"date": f"{y}-{mo}-{d}", "time": f"{hh}:{mm}"}, False   # เวลาเซฟไฟล์
    return {}, False


def _same_ref(got, exp):
    """เทียบเลขอ้างอิงแบบไม่สน case/ตัวคั่น — OCR มักได้ตัวพิมพ์ต่างกันหรือมีช่องว่างแทรก"""
    norm = lambda s: re.sub(r"[^0-9A-Za-z]", "", str(s or "")).upper()
    return norm(got) == norm(exp) and norm(exp) != ""


# ---------- worker ----------
_ENGINE = None


def _init():
    """โหลดโมเดลใน worker (หลัง fork) — โหลดในแม่แล้ว fork จะพังหรือกินแรมซ้ำซ้อน"""
    global _ENGINE
    import ocr_paddle
    ocr_paddle.load_model()
    _ENGINE = ocr_paddle


def _run_one(args):
    folder, path = args
    stem = os.path.splitext(os.path.basename(path))[0]
    truth, reliable = truth_from_name(folder, stem)
    t0 = time.perf_counter()
    try:
        text = _ENGINE.ocr_image(path)
        err = None
    except Exception as e:
        text, err = "", f"{type(e).__name__}: {e}"
    dt = time.perf_counter() - t0
    if err:
        return {"folder": folder, "file": stem, "error": err, "seconds": round(dt, 2)}

    d = parse_slip(text)
    d.pop("raw", None)
    # เฉลยที่เชื่อไม่ได้ → ไม่คิดคะแนน แต่ยังเก็บค่าที่อ่านได้ไว้ดู
    checks = {}
    if not reliable:
        truth = {}
    if "ref" in truth:
        checks["ref"] = _same_ref(d.get("ref"), truth["ref"])
    if "date" in truth:
        checks["date"] = d.get("date") == truth["date"]
    if "time" in truth:
        checks["time"] = d.get("time") == truth["time"]

    return {
        "folder": folder, "file": stem, "seconds": round(dt, 2),
        "doc_type": classify(text),
        "checks": checks,
        "truth": truth,
        "truth_reliable": reliable,
        "got": {k: d.get(k) for k in ("ref", "date", "time", "amount")},
        "found": {k: d.get(k) is not None for k in ("amount", "date", "time", "ref", "from", "to")},
        "confidence": d.get("confidence"),
        "n_lines": len(text.splitlines()),
        "text": text,          # ถูกตัดทิ้งก่อนเขียนไฟล์ เว้นแต่ --save-text
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=DATASET)
    ap.add_argument("--limit", type=int, default=0, help="สุ่มเอาโฟลเดอร์ละกี่ใบ (0 = ทั้งหมด)")
    ap.add_argument("--workers", type=int, default=1, help="จำนวน process (แต่ละตัวกิน RAM ~720MB)")
    ap.add_argument("--save-text", action="store_true", help="เก็บข้อความ OCR ดิบลงไฟล์ผล (มี PII!)")
    ap.add_argument("-o", "--output", default=os.path.join(HERE, "results_dataset.json"))
    args = ap.parse_args()

    jobs = []
    for folder in sorted(os.listdir(args.dataset)):
        fdir = os.path.join(args.dataset, folder)
        if not os.path.isdir(fdir):
            continue
        files = sorted(f for f in os.listdir(fdir) if f.lower().endswith(IMG_EXT))
        if args.limit:
            files = files[:args.limit]
        jobs += [(folder, os.path.join(fdir, f)) for f in files]

    print(f">> {len(jobs)} รูป | workers={args.workers}")
    print(">> เฉลยจากชื่อไฟล์: k-bank→ref, ttb/truemoney→date+time\n")

    t0 = time.perf_counter()
    if args.workers > 1:
        with Pool(args.workers, initializer=_init) as pool:
            rows = []
            for i, r in enumerate(pool.imap_unordered(_run_one, jobs), 1):
                rows.append(r)
                if i % 25 == 0 or i == len(jobs):
                    print(f"   {i}/{len(jobs)} ... {time.perf_counter()-t0:.0f}s")
    else:
        _init()
        rows = []
        for i, j in enumerate(jobs, 1):
            rows.append(_run_one(j))
            if i % 10 == 0 or i == len(jobs):
                print(f"   {i}/{len(jobs)} ... {time.perf_counter()-t0:.0f}s")
    wall = time.perf_counter() - t0

    # ---------- สรุป ----------
    by = defaultdict(list)
    for r in rows:
        by[r["folder"]].append(r)

    print(f"\n{'='*78}")
    print(f"{'โฟลเดอร์':<20}{'ใบ':>5}{'วิ/ใบ':>8}{'ฟิลด์ที่มีเฉลย':>16}{'เจอ amount':>13}{'พัง':>6}")
    print("-" * 78)
    grand_ok = grand_n = 0
    for folder, rs in sorted(by.items()):
        okc = sum(sum(r.get("checks", {}).values()) for r in rs)
        nc = sum(len(r.get("checks", {})) for r in rs)
        grand_ok += okc
        grand_n += nc
        errs = sum(1 for r in rs if r.get("error"))
        good = [r for r in rs if not r.get("error")]
        amt = sum(1 for r in good if r["found"]["amount"])
        secs = [r["seconds"] for r in rs if "seconds" in r]
        pct = f"{okc}/{nc} ({100*okc/nc:.0f}%)" if nc else "-"
        apct = f"{amt}/{len(good)} ({100*amt/max(1,len(good)):.0f}%)"
        print(f"{folder:<20}{len(rs):>5}{sum(secs)/max(1,len(secs)):>8.1f}{pct:>16}{apct:>13}{errs:>6}")
    print("-" * 78)
    if grand_n:
        print(f"{'รวม':<20}{len(rows):>5}{wall/max(1,len(rows)):>8.1f}"
              f"{f'{grand_ok}/{grand_n} ({100*grand_ok/grand_n:.0f}%)':>16}")
    print(f"{'='*78}")
    print(f"เวลารวม {wall:.0f}s")

    # แยกคะแนนต่อฟิลด์
    per = defaultdict(lambda: [0, 0])
    for r in rows:
        for k, v in r.get("checks", {}).items():
            per[k][1] += 1
            per[k][0] += bool(v)
    print("\nต่อฟิลด์ (เฉพาะที่มีเฉลย):")
    for k, (ok, n) in sorted(per.items()):
        print(f"   {k:6}: {ok}/{n} ({100*ok/n:.0f}%)")

    conf = defaultdict(int)
    for r in rows:
        if not r.get("error"):
            conf[r.get("confidence")] += 1
    print(f"\nconfidence ที่ parser ให้: {dict(conf)}")

    if not args.save_text:
        for r in rows:
            r.pop("text", None)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump({"wall_seconds": round(wall, 1), "rows": rows}, f, ensure_ascii=False, indent=2)
    print(f"\n>> เขียน {args.output}" + ("" if args.save_text else "  (ไม่เก็บข้อความ OCR — กัน PII)"))


if __name__ == "__main__":
    main()
