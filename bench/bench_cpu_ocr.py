#!/usr/bin/env python3
"""
bench_cpu_ocr.py — วัด OCR engine ที่รันบน CPU ได้ (tesseract / paddle / easyocr)
เทียบกับเฉลยจริงใน truth.json และกับ Qwen2-VL ที่วัดไปแล้วใน FINDINGS.md

ต่างจาก bench_cpu_vlm.py ตรงที่ engine พวกนี้เป็นไลบรารี Python (ไม่ใช่ subprocess)
→ วัด peak RSS ของ process ตัวเองด้วย resource.getrusage

รัน:
    .venv-ocr/bin/python bench_cpu_ocr.py --engine paddle
    .venv-ocr/bin/python bench_cpu_ocr.py --engine tesseract --threads 2
    .venv-ocr/bin/python bench_cpu_ocr.py --engine all

จำลอง VPS 2 cores:  OMP_NUM_THREADS=2 taskset -c 0,1 .venv-ocr/bin/python bench_cpu_ocr.py ...

สิ่งที่วัด: peak RSS, เวลา/รูป, และ **ฟิลด์ที่ parser ดึงได้ถูกกี่ตัว** (อันหลังคือตัวตัดสิน)
"""
import os
import sys
import json
import time
import argparse
import resource

HERE = os.path.dirname(os.path.abspath(__file__))
SLIP_OCR = os.environ.get("SLIP_OCR_DIR", os.path.normpath(os.path.join(HERE, "..", "..", "slip-ocr-th")))
sys.path.insert(0, SLIP_OCR)

# parser เป็น stdlib ล้วน (re/json/difflib) → import ได้โดยไม่ต้องมี torch ใน venv นี้
from slip_parser import parse_slip          # noqa: E402
from payslip_parser import parse_payslip    # noqa: E402
from doc_router import classify             # noqa: E402


def peak_rss_mb():
    """peak RSS ของ process นี้ (ru_maxrss บน Linux = kB)"""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def load_image_rgb(path):
    """คืน numpy array RGB — แปลง .webp ให้ด้วย (llama.cpp อ่าน webp ไม่ได้ แต่ PIL ได้)"""
    from PIL import Image, ImageOps
    import numpy as np
    with Image.open(path) as im:
        return np.array(ImageOps.exif_transpose(im).convert("RGB"))


# ---------- engines ----------
class Tesseract:
    name = "tesseract"

    def __init__(self, langs="tha+eng", **_):
        import pytesseract
        self.pt = pytesseract
        self.langs = langs
        # ล้มตั้งแต่ต้นถ้าไม่มี binary/ภาษาไทย ดีกว่าไปได้ผลว่างแล้วสรุปผิด
        avail = self.pt.get_languages(config="")
        for want in langs.split("+"):
            if want not in avail:
                raise RuntimeError(
                    f"tesseract ไม่มีภาษา '{want}' (มี: {sorted(avail)[:8]}...) — "
                    f"ลง: sudo apt install -y tesseract-ocr-{want}")

    def read(self, path):
        from PIL import Image
        return self.pt.image_to_string(Image.open(path), lang=self.langs)


class Paddle:
    name = "paddle"

    def __init__(self, langs=None, threads=None, light=True, **_):
        from paddleocr import PaddleOCR
        # enable_mkldnn=False **จำเป็น**: oneDNN executor พังด้วย
        #   NotImplementedError: ConvertPirAttribute2RuntimeAttribute ... onednn_instruction.cc
        # (ส่งเป็น argument เท่านั้น — env FLAGS_use_mkldnn=0 ไม่มีผล)
        kw = {"lang": "th", "enable_mkldnn": False}
        if light:
            # ตัดของที่ไม่จำเป็นออกเพื่อให้ลงเครื่องแรมน้อย:
            #   mobile_det แทน server_det + ปิดโมเดลเสริม 3 ตัว (doc_ori / unwarping / textline_ori)
            #   สลิปจากมือถือมักตั้งตรงอยู่แล้ว — preprocess.py ฝั่ง slip-ocr-th ก็ทำ auto-orient ให้
            # ⚠️ ต้องระบุ recognition model ไทยด้วยเสมอ! พอ override ชื่อ det model
            #    PaddleOCR จะเลิก auto-เลือกจาก lang="th" แล้วถอยไปใช้ rec ตัว latin
            #    → อักษรไทยออกมาเป็น "τəuιūuιν" แทน "โอนเงินสำเร็จ" (ตัวเลขยังถูก จับสังเกตยาก)
            kw.update(text_detection_model_name="PP-OCRv5_mobile_det",
                      text_recognition_model_name="th_PP-OCRv5_mobile_rec",
                      use_doc_orientation_classify=False,
                      use_doc_unwarping=False,
                      use_textline_orientation=False)
        try:
            self.ocr = PaddleOCR(**kw)
        except (TypeError, ValueError) as e:
            print(f"   (config แบบ light ใช้ไม่ได้: {e} — ถอยไปใช้ค่า default)")
            self.ocr = PaddleOCR(lang="th", enable_mkldnn=False)

    def read(self, path):
        img = load_image_rgb(path)       # ผ่าน PIL → รองรับ webp
        try:
            res = self.ocr.predict(img)  # API ใหม่ (3.x)
        except AttributeError:
            res = self.ocr.ocr(img)      # API เก่า (2.x)
        return "\n".join(_paddle_lines(res))


def _paddle_lines(res):
    """ดึงข้อความออกจากผลของ PaddleOCR ซึ่งมี 2-3 รูปแบบตามเวอร์ชัน"""
    out = []
    for page in (res or []):
        if isinstance(page, dict):                       # 3.x: {"rec_texts": [...]}
            out.extend(page.get("rec_texts") or [])
            continue
        for line in (page or []):                        # 2.x: [[box, (text, conf)], ...]
            if isinstance(line, (list, tuple)) and len(line) >= 2:
                t = line[1]
                out.append(t[0] if isinstance(t, (list, tuple)) else str(t))
    return out


class EasyOCR:
    name = "easyocr"

    def __init__(self, **_):
        import easyocr
        self.reader = easyocr.Reader(["th", "en"], gpu=False, verbose=False)

    def read(self, path):
        return "\n".join(self.reader.readtext(load_image_rgb(path), detail=0, paragraph=True))


ENGINES = {"tesseract": Tesseract, "paddle": Paddle, "easyocr": EasyOCR}


# ---------- ตรวจผล ----------
def grade(text, truth):
    """เทียบฟิลด์ที่ parser ดึงได้ กับเฉลย → (ผ่านกี่ข้อ, ทั้งหมด, รายละเอียด)"""
    kind = truth["kind"]
    data = parse_payslip(text) if kind == "payslip" else parse_slip(text)
    checks, detail = [], {}

    def chk(field, got, exp, contains=False):
        ok = bool(got) and (exp in str(got) if contains else str(got) == str(exp))
        checks.append(ok)
        detail[field] = {"got": got, "expected": exp, "ok": ok}

    if kind == "payslip":
        for f in ("net_pay", "gross_income", "total_deductions"):
            if truth.get(f):
                chk(f, data.get(f), truth[f])
    else:
        for f in ("amount", "date", "time", "ref"):
            if truth.get(f):
                chk(f, data.get(f), truth[f])
        if truth.get("from_contains"):
            chk("from", data.get("from"), truth["from_contains"], contains=True)
        if truth.get("to_contains"):
            chk("to", data.get("to"), truth["to_contains"], contains=True)

    return sum(checks), len(checks), detail, data, classify(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="paddle", choices=[*ENGINES, "all"])
    ap.add_argument("--truth", default=os.path.join(HERE, "truth.json"))
    ap.add_argument("--threads", type=int, default=None,
                    help="ตั้ง OMP/MKL threads (จำลอง VPS ใช้ 2)")
    ap.add_argument("--langs", default="tha+eng", help="เฉพาะ tesseract")
    ap.add_argument("-o", "--output", default=os.path.join(HERE, "results_ocr.json"))
    args = ap.parse_args()

    if args.threads:
        for v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
            os.environ[v] = str(args.threads)

    truths = {k: v for k, v in json.load(open(args.truth, encoding="utf-8")).items()
              if not k.startswith("_")}
    engines = list(ENGINES) if args.engine == "all" else [args.engine]

    all_results = {}
    for eng_name in engines:
        print(f"\n{'='*70}\n>> engine: {eng_name}  (threads={args.threads or 'default'})\n{'='*70}")
        t0 = time.perf_counter()
        try:
            eng = ENGINES[eng_name](langs=args.langs, threads=args.threads)
        except Exception as e:
            print(f"   ข้าม — โหลดไม่ได้: {e}")
            all_results[eng_name] = {"error": str(e)}
            continue
        load_s = time.perf_counter() - t0
        print(f"   โหลด engine {load_s:.1f}s | RSS หลังโหลด {peak_rss_mb():.0f} MB\n")

        rows, total_ok, total_n = [], 0, 0
        for name, truth in truths.items():
            path = os.path.join(SLIP_OCR, truth["path"])
            if not os.path.isfile(path):
                print(f"   (ข้าม {name} — ไม่พบไฟล์)")
                continue
            t1 = time.perf_counter()
            try:
                text = eng.read(path)
                err = None
            except Exception as e:
                text, err = "", f"{type(e).__name__}: {e}"
            dt = time.perf_counter() - t1

            if err:
                print(f"   {name[:28]:<30} ล้มเหลว: {err[:60]}")
                rows.append({"image": name, "error": err})
                continue

            ok, n, detail, parsed, kind = grade(text, truth)
            total_ok += ok
            total_n += n
            flag = "✅" if ok == n else ("🟡" if ok else "❌")
            print(f"   {name[:28]:<30} {dt:6.1f}s  ฟิลด์ถูก {ok}/{n} {flag}  [{kind}]")
            for f, d in detail.items():
                if not d["ok"]:
                    print(f"        ✗ {f:6}: ได้ {str(d['got'])[:28]!r} ควรได้ {d['expected']!r}")
            rows.append({"image": name, "seconds": round(dt, 2), "fields_ok": ok,
                         "fields_total": n, "doc_type": kind, "detail": detail, "text": text})

        secs = [r["seconds"] for r in rows if "seconds" in r]
        summary = {
            "load_seconds": round(load_s, 1),
            "peak_rss_mb": round(peak_rss_mb()),
            "avg_seconds": round(sum(secs) / len(secs), 1) if secs else None,
            "fields_ok": total_ok, "fields_total": total_n,
            "rows": rows,
        }
        all_results[eng_name] = summary
        print(f"\n   ── สรุป {eng_name}: ฟิลด์ถูก {total_ok}/{total_n} | "
              f"เฉลี่ย {summary['avg_seconds']}s/รูป | peak RSS {summary['peak_rss_mb']} MB")

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)
    print(f"\n>> เขียน {args.output}")

    print(f"\n{'engine':<12}{'ฟิลด์ถูก':>10}{'วิ/รูป':>9}{'peak RSS':>11}")
    print("-" * 42)
    for k, v in all_results.items():
        if "error" in v:
            print(f"{k:<12}{'ลงไม่ได้':>10}")
            continue
        score = f"{v['fields_ok']}/{v['fields_total']}"
        rss = f"{v['peak_rss_mb']} MB"
        print(f"{k:<12}{score:>10}{str(v['avg_seconds']):>9}{rss:>11}")
    print("\nเทียบ Qwen2-VL-2B บน CPU (จาก FINDINGS.md): ฟิลด์ถูก 6/12 | ~111s/รูป | 2710 MB")


if __name__ == "__main__":
    main()
