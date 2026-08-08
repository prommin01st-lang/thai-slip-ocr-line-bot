#!/usr/bin/env python3
"""
bench_cpu_vlm.py — วัดว่า VLM เล็ก (Qwen2-VL-2B Q4_K_M) รันบน VPS ไม่มี GPU ไหวจริงไหม

รันบน **VPS** (stdlib ล้วน — ไม่ต้องมี torch/venv; pillow เป็นตัวเลือกเสริมไว้ย่อรูป):
    python3 bench_cpu_vlm.py --model qwen2vl-2b-q4km.gguf --mmproj mmproj-q8.gguf --images ./images

วัด 3 อย่างที่ตัดสินว่า "ไหวปะ":
  1) RAM จริง — peak RSS + swap ที่โดนใช้ (ตอบว่า OOM/thrash ไหม โดยไม่ต้องเดา)
  2) เวลาจริงต่อรูป — แยก prefill/generate และเทียบหลายความละเอียด
  3) คุณภาพ — ป้อนผลเข้า parser เดิม (stdlib ล้วน) แล้วเทียบกับ baseline.json ของ GPU

เมตริกความคล้ายใช้ตัวเดียวกับ slip-ocr-th/eval_base_vs_tuned.py (SequenceMatcher หลัง _norm)
จะได้เทียบข้ามการทดลองกันได้

ออก results.json + ตารางสรุป
"""
import os
import re
import sys
import json
import time
import shutil
import argparse
import platform
import subprocess
import threading
from difflib import SequenceMatcher

HERE = os.path.dirname(os.path.abspath(__file__))

# Qwen2-VL: 1 visual token ต่อ 28×28 พิกเซล (หลัง 2×2 merge) → ใช้ประมาณจำนวน token จากขนาดรูป
PIXELS_PER_TOKEN = 28 * 28


# ---------- เมตริก (ยกมาจาก eval_base_vs_tuned.py ให้เทียบกันได้) ----------
def _norm(s):
    return re.sub(r"[\s\.\,\:\-_/()<>|!\[\]]+", "",
                  re.sub(r"<\|[^|]*\|>|!\[\]\([^)]*\)", "", s or ""))


def char_sim(a, b):
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


# ---------- อ่านหน่วยความจำจาก /proc ----------
def _proc_status(pid):
    """คืน {"VmRSS": kB, ...} — key ไม่มี colon (split(":") ตัดออกให้แล้ว)"""
    try:
        with open(f"/proc/{pid}/status") as f:
            out = {}
            for line in f:
                if line.startswith(("VmRSS:", "VmHWM:", "VmSwap:")):
                    k, v = line.split(":", 1)
                    out[k] = int(v.strip().split()[0])  # kB
            return out
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return {}


def _meminfo():
    """คืน {"MemAvailable": kB, ...} — key ไม่มี colon"""
    out = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                if v.strip():
                    out[k] = int(v.strip().split()[0])  # kB
    except (FileNotFoundError, ValueError):
        pass
    return out


class MemSampler(threading.Thread):
    """เก็บ peak RSS/swap ของ process ระหว่างรัน (poll ทุก 100ms)"""

    def __init__(self, pid, interval=0.1):
        super().__init__(daemon=True)
        self.pid, self.interval = pid, interval
        self.peak_rss = self.peak_swap = self.peak_hwm = 0
        self._stop = threading.Event()

    def run(self):
        while not self._stop.is_set():
            st = _proc_status(self.pid)
            if not st:
                break
            self.peak_rss = max(self.peak_rss, st.get("VmRSS", 0))
            self.peak_hwm = max(self.peak_hwm, st.get("VmHWM", 0))
            self.peak_swap = max(self.peak_swap, st.get("VmSwap", 0))
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


# ---------- ย่อรูป (ต้องมี pillow; ไม่มีก็วัดเฉพาะขนาดเดิม) ----------
def resize_variants(path, max_pixels_list, outdir):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None
    os.makedirs(outdir, exist_ok=True)
    made = []
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        w, h = im.size
        for mp in max_pixels_list:
            if w * h <= mp:
                made.append((f"{mp//1000}k", path, w, h))   # เล็กอยู่แล้ว ใช้ไฟล์เดิม
                continue
            scale = (mp / (w * h)) ** 0.5
            nw, nh = max(28, int(w * scale)), max(28, int(h * scale))
            dst = os.path.join(outdir, f"{os.path.splitext(os.path.basename(path))[0]}_{mp//1000}k.png")
            im.resize((nw, nh), Image.LANCZOS).save(dst)
            made.append((f"{mp//1000}k", dst, nw, nh))
    return made


# ---------- รัน llama.cpp ----------
TIMING_RE = {
    "prefill_ms": re.compile(r"prompt eval time\s*=\s*([\d.]+)\s*ms"),
    "prefill_tokens": re.compile(r"prompt eval time.*?/\s*(\d+)\s*tokens"),
    "gen_ms": re.compile(r"(?<!prompt )eval time\s*=\s*([\d.]+)\s*ms"),
    "gen_tokens": re.compile(r"(?<!prompt )eval time.*?/\s*(\d+)\s*(?:runs|tokens)"),
    "encode_ms": re.compile(r"(?:image|encod\w*)[^\n]*?([\d.]+)\s*ms", re.I),
}


def run_once(cli, model, mmproj, image, prompt, threads, n_predict, timeout, extra):
    cmd = [cli, "-m", model, "--mmproj", mmproj, "--image", image,
           "-p", prompt, "-n", str(n_predict), "-t", str(threads), "--temp", "0"]
    cmd += extra

    mem_before = _meminfo()
    t0 = time.perf_counter()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            errors="replace")
    sampler = MemSampler(proc.pid)
    sampler.start()
    try:
        out, err = proc.communicate(timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        timed_out = True
    sampler.stop()
    wall = time.perf_counter() - t0
    mem_after = _meminfo()

    rec = {
        "wall_seconds": round(wall, 2),
        "timed_out": timed_out,
        "returncode": proc.returncode,
        "peak_rss_mb": round(max(sampler.peak_rss, sampler.peak_hwm) / 1024, 1),
        "peak_swap_mb": round(sampler.peak_swap / 1024, 1),
        "sys_swap_used_delta_mb": round(
            ((mem_before.get("SwapTotal", 0) - mem_before.get("SwapFree", 0))
             - (mem_after.get("SwapTotal", 0) - mem_after.get("SwapFree", 0))) / -1024, 1),
        "text": (out or "").strip(),
    }
    # returncode ติดลบ = โดนสัญญาณฆ่า; -9 (SIGKILL) บน VPS แรมน้อยมักคือ OOM killer
    # ⚠️ แต่ตอน timeout เรา proc.kill() เอง ซึ่งก็ส่ง SIGKILL เหมือนกัน — ต้องกันไว้
    #    ไม่งั้น "ช้าเกินไป" จะถูกรายงานเป็น "แรมไม่พอ" แล้วสรุปผิดคนละเรื่อง
    if proc.returncode and proc.returncode < 0 and not timed_out:
        rec["killed_by_signal"] = -proc.returncode
        rec["likely_oom"] = proc.returncode == -9

    for key, rx in TIMING_RE.items():
        m = rx.search(err or "")
        if m:
            rec[key] = float(m.group(1))
    rec["stderr_tail"] = "\n".join((err or "").splitlines()[-12:])
    return rec


def main():
    ap = argparse.ArgumentParser(description="วัด VLM เล็กบน CPU ว่ารันไหวไหม")
    ap.add_argument("--model", required=True, help="ไฟล์ GGUF ของ LLM (เช่น Q4_K_M)")
    ap.add_argument("--mmproj", required=True, help="ไฟล์ mmproj GGUF (แนะนำ Q8_0 บนเครื่องแรมน้อย)")
    ap.add_argument("--images", default=os.path.join(HERE, "images"), help="โฟลเดอร์รูปทดสอบ")
    ap.add_argument("--baseline", default=os.path.join(HERE, "baseline.json"),
                    help="ผลจาก gpu_baseline.py (ไม่มีก็ข้ามการเทียบคุณภาพ)")
    ap.add_argument("--cli", default=None, help="path ของ llama-mtmd-cli (default: หาใน PATH)")
    ap.add_argument("--sizes", default="0,1000000,600000,300000",
                    help="max pixels ที่จะทดสอบ คั่นด้วย comma (0 = ขนาดเดิม)")
    ap.add_argument("--prompt", default="Read all the text in this image exactly as it appears, "
                                        "preserving line breaks. Output only the text.")
    ap.add_argument("-t", "--threads", type=int, default=os.cpu_count() or 2)
    ap.add_argument("-n", "--n-predict", type=int, default=512)
    ap.add_argument("--timeout", type=int, default=900, help="วินาทีต่อรูป ก่อนยอมแพ้")
    ap.add_argument("--extra", nargs=argparse.REMAINDER, default=[],
                    help="แฟลกเพิ่มส่งต่อให้ llama-mtmd-cli (ใส่ท้ายสุด)")
    ap.add_argument("-o", "--output", default=os.path.join(HERE, "results.json"))
    args = ap.parse_args()

    cli = args.cli or shutil.which("llama-mtmd-cli") or shutil.which("llama-qwen2vl-cli")
    if not cli:
        sys.exit("!! ไม่พบ llama-mtmd-cli — รัน ./setup_vps.sh ก่อน หรือระบุด้วย --cli")
    for f in (args.model, args.mmproj):
        if not os.path.isfile(f):
            sys.exit(f"!! ไม่พบไฟล์: {f}")

    images = sorted(os.path.join(args.images, n) for n in os.listdir(args.images)
                    if n.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp"))) \
        if os.path.isdir(args.images) else []
    if not images:
        sys.exit(f"!! ไม่พบรูปใน {args.images}")

    baseline = {}
    if os.path.isfile(args.baseline):
        with open(args.baseline, encoding="utf-8") as f:
            baseline = json.load(f)
        print(f">> โหลด baseline ของ GPU: {len(baseline)} รูป")
    else:
        print(f">> ไม่มี {args.baseline} — จะวัดเฉพาะ RAM/ความเร็ว ไม่เทียบคุณภาพ")

    sizes = [int(s) for s in args.sizes.split(",") if s.strip()]
    mem = _meminfo()
    print(f">> เครื่อง: {platform.machine()} | {os.cpu_count()} cores | "
          f"RAM ว่าง {mem.get('MemAvailable', 0)/1024/1024:.1f} GB | "
          f"swap ว่าง {mem.get('SwapFree', 0)/1024/1024:.1f} GB")
    print(f">> โมเดล: {os.path.getsize(args.model)/1e6:.0f} MB + mmproj {os.path.getsize(args.mmproj)/1e6:.0f} MB "
          f"= {(os.path.getsize(args.model)+os.path.getsize(args.mmproj))/1e6:.0f} MB บนดิสก์")
    print(f">> threads={args.threads} n_predict={args.n_predict} timeout={args.timeout}s\n")

    results = []
    tmpdir = os.path.join(HERE, ".resized")
    for img in images:
        name = os.path.basename(img)
        variants = [("native", img, None, None)]
        scaled = [s for s in sizes if s > 0]
        if scaled:
            made = resize_variants(img, scaled, tmpdir)
            if made is None:
                print("   (ไม่มี pillow → วัดเฉพาะขนาดเดิม; ลง: pip3 install pillow)")
                sizes = [0]
            else:
                variants += made

        for label, path, w, h in variants:
            est = f"~{w*h//PIXELS_PER_TOKEN} tok" if w and h else "?"
            print(f"[{name} @ {label} {est}] ... ", end="", flush=True)
            rec = run_once(cli, args.model, args.mmproj, path, args.prompt,
                           args.threads, args.n_predict, args.timeout, args.extra)
            rec.update(image=name, variant=label, width=w, height=h,
                       est_visual_tokens=(w * h // PIXELS_PER_TOKEN) if w and h else None)

            base = baseline.get(name, {})
            if base.get("text"):
                rec["char_sim_vs_gpu"] = round(char_sim(base["text"], rec["text"]), 3)
                rec["gpu_seconds"] = base.get("seconds")
            results.append(rec)

            if rec.get("likely_oom"):
                print("❌ ถูกฆ่า (น่าจะ OOM)")
            elif rec["timed_out"]:
                print(f"⏱  เกิน {args.timeout}s")
            else:
                sim = rec.get("char_sim_vs_gpu")
                print(f"{rec['wall_seconds']:.0f}s  RSS {rec['peak_rss_mb']:.0f}MB"
                      + (f"  swap {rec['peak_swap_mb']:.0f}MB" if rec["peak_swap_mb"] > 1 else "")
                      + (f"  sim {sim:.2f}" if sim is not None else ""))

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump({"host": {"cores": os.cpu_count(), "machine": platform.machine(),
                            "mem_available_kb": mem.get("MemAvailable")},
                   "args": vars(args), "results": results}, f, ensure_ascii=False, indent=2)

    # ---------- สรุป ----------
    ok = [r for r in results if not r["timed_out"] and not r.get("likely_oom") and r["text"]]
    print("\n" + "=" * 74)
    print(f"{'รูป':<22}{'ขนาด':<8}{'วินาที':>8}{'RSS MB':>9}{'swap':>7}{'sim':>7}{'GPU s':>8}")
    print("-" * 74)
    for r in results:
        if r.get("likely_oom"):
            status = "OOM"
        elif r["timed_out"]:
            status = "timeout"
        else:
            status = f"{r['wall_seconds']:.0f}"
        sim = r.get("char_sim_vs_gpu")
        sim_s = f"{sim:.2f}" if sim is not None else "-"
        gpu = r.get("gpu_seconds")
        gpu_s = f"{gpu:.0f}" if gpu else "-"
        print(f"{r['image'][:21]:<22}{r['variant']:<8}{status:>8}{r['peak_rss_mb']:>9.0f}"
              f"{r['peak_swap_mb']:>7.0f}{sim_s:>7}{gpu_s:>8}")
    print("=" * 74)

    if ok:
        avg = sum(r["wall_seconds"] for r in ok) / len(ok)
        peak = max(r["peak_rss_mb"] for r in ok)
        sims = [r["char_sim_vs_gpu"] for r in ok if "char_sim_vs_gpu" in r]
        print(f"สำเร็จ {len(ok)}/{len(results)} | เฉลี่ย {avg:.0f}s/รูป | peak RSS สูงสุด {peak:.0f} MB")
        if sims:
            print(f"ความคล้ายกับ GPU เฉลี่ย {sum(sims)/len(sims):.2f} (1.00 = เหมือนกันเป๊ะ)")
        swapped = [r for r in results if r["peak_swap_mb"] > 50]
        if swapped:
            print(f"⚠️  {len(swapped)} รอบใช้ swap เกิน 50MB — แรมไม่พอจริง ตัวเลขเวลาเชื่อไม่ได้")
    else:
        print("ไม่มีรอบไหนสำเร็จเลย — ดู stderr_tail ใน results.json")
    print(f"\n>> เขียน {args.output}")


if __name__ == "__main__":
    main()
