#!/usr/bin/env bash
# setup_vps.sh — เตรียม VPS (ไม่มี GPU) ให้พร้อมรัน bench_cpu_vlm.py
#
#   1) ตรวจ RAM/ดิสก์ว่าพอไหม — บอกตั้งแต่ต้นดีกว่าไปตายตอนโหลดโมเดล
#   2) หา binary llama.cpp: ใช้ prebuilt ก่อน (เร็ว + ไม่เสี่ยง OOM ตอน compile)
#      ถ้าไม่ได้ค่อย build เอง ด้วย -j1 (2 cores/3.8GB compile แบบขนานมักโดน OOM killer)
#   3) โหลด GGUF จาก HuggingFace — **ถามรายชื่อไฟล์จริงจาก API ก่อน** ไม่เดาชื่อ
#      แล้วเลือก Q4_K_M + mmproj (เอา Q8_0 ก่อน F16 เพราะแรมน้อย)
#
# ใช้งาน:
#   ./setup_vps.sh
#   MODEL_REPO=bartowski/Qwen2-VL-2B-Instruct-GGUF ./setup_vps.sh    # เปลี่ยน repo
#   SKIP_MODEL=1 ./setup_vps.sh                                       # เอาแค่ llama.cpp

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HERE/llama"
MODEL_DIR="$HERE/models"
MODEL_REPO="${MODEL_REPO:-ggml-org/Qwen2-VL-2B-Instruct-GGUF}"
QUANT="${QUANT:-Q4_K_M}"

die() { echo "!! $1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "=== 1) ตรวจเครื่อง ==="
CORES=$(nproc)
MEM_AVAIL_MB=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
DISK_AVAIL_MB=$(df -Pm "$HERE" | awk 'NR==2{print $4}')
echo "    cores=$CORES  RAM ว่าง=${MEM_AVAIL_MB}MB  swap=${SWAP_MB}MB  ดิสก์ว่าง=${DISK_AVAIL_MB}MB"

[[ $DISK_AVAIL_MB -lt 4000 ]] && die "ดิสก์เหลือ < 4GB — ไม่พอสำหรับ binary + โมเดล"
if [[ $MEM_AVAIL_MB -lt 2200 ]]; then
  echo "    ⚠️  RAM ว่าง < 2.2GB — Q4_K_M + mmproj Q8 ก็อาจไม่พอ เตรียมเจอ swap"
fi

have python3 || die "ต้องมี python3 (ใช้พาร์ส JSON + รัน bench)"
have curl || die "ต้องมี curl"

echo
echo "=== 2) llama.cpp ==="
mkdir -p "$BIN_DIR"
CLI=""
for c in "$BIN_DIR/llama-mtmd-cli" "$(command -v llama-mtmd-cli 2>/dev/null || true)"; do
  [[ -n "$c" && -x "$c" ]] && { CLI="$c"; break; }
done

if [[ -n "$CLI" ]]; then
  echo "    มีอยู่แล้ว: $CLI"
else
  echo "    ลองหา prebuilt binary จาก GitHub releases..."
  # ⚠️ asset ของ Linux เป็น .tar.gz (ของ Windows ถึงจะเป็น .zip)
  # ตัวที่ต้องการคือ llama-bXXXXX-bin-ubuntu-x64.tar.gz — CPU ล้วน
  # ต้องคัด rocm/vulkan/sycl/openvino/arm/s390x ออก ไม่งั้นได้ build ที่ต้องมี runtime GPU
  ASSET=$(curl -sfL https://api.github.com/repos/ggml-org/llama.cpp/releases/latest \
    | grep -o 'https://[^"]*bin-ubuntu-x64\.tar\.gz' | head -1)

  if [[ -n "$ASSET" ]]; then
    echo "    ดาวน์โหลด: $(basename "$ASSET")"
    curl -fL# "$ASSET" -o /tmp/llama.tgz && tar xzf /tmp/llama.tgz -C "$BIN_DIR" && rm -f /tmp/llama.tgz
    # binary ต้องอยู่คู่กับ libllama.so/libggml*.so — อย่าคัดลอกออกมาเดี่ยว ๆ ใช้ path เดิม
    FOUND=$(find "$BIN_DIR" -type f -name "llama-mtmd-cli" | head -1)
    if [[ -n "$FOUND" ]]; then
      chmod +x "$FOUND" 2>/dev/null
      if LD_LIBRARY_PATH="$(dirname "$FOUND")" "$FOUND" --version >/dev/null 2>&1; then
        CLI="$FOUND"
        echo "    (ต้องตั้ง LD_LIBRARY_PATH=$(dirname "$FOUND") ตอนเรียกใช้)"
      fi
    fi
    [[ -z "$CLI" ]] && echo "    prebuilt ใช้ไม่ได้ (glibc อาจไม่ตรง) — จะ build เอง"
  else
    echo "    ไม่พบ asset ubuntu-x64 — จะ build เอง"
  fi
fi

if [[ -z "$CLI" ]]; then
  have git && have cmake || die "ต้อง build เองแต่ไม่มี git/cmake — ลง: sudo apt install -y git cmake build-essential libcurl4-openssl-dev"
  SRC="$HERE/llama.cpp"
  [[ -d "$SRC" ]] || git clone --depth 1 https://github.com/ggml-org/llama.cpp "$SRC" || die "clone ไม่สำเร็จ"
  echo "    build ด้วย -j1 (2 cores/แรมน้อย compile ขนานมักโดน OOM killer) — ใช้เวลาสักพัก"
  cmake -S "$SRC" -B "$SRC/build" -DGGML_NATIVE=ON -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release \
    >/dev/null || die "cmake configure ไม่ผ่าน"
  cmake --build "$SRC/build" --target llama-mtmd-cli -j1 || die "build ไม่ผ่าน (ดู log ข้างบน; ถ้าโดน Killed = แรมไม่พอ ลองเพิ่ม swap)"
  CLI=$(find "$SRC/build" -type f -name llama-mtmd-cli | head -1)
  [[ -x "$CLI" ]] || die "build เสร็จแต่หา binary ไม่เจอ"
  ln -sf "$CLI" "$BIN_DIR/llama-mtmd-cli"
  CLI="$BIN_DIR/llama-mtmd-cli"
fi
echo "    ✅ $CLI"

if [[ "${SKIP_MODEL:-0}" == "1" ]]; then
  echo; echo ">> ข้ามการโหลดโมเดล (SKIP_MODEL=1)"; exit 0
fi

echo
echo "=== 3) โหลด GGUF จาก $MODEL_REPO ==="
mkdir -p "$MODEL_DIR"

# ถามรายชื่อไฟล์จริงจาก HF API — ชื่อไฟล์ใน repo ชุมชนเปลี่ยนบ่อย เดาแล้วพัง
FILES=$(curl -sfL "https://huggingface.co/api/models/${MODEL_REPO}?full=true" \
  | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
for s in d.get("siblings",[]):
    n=s.get("rfilename","")
    if n.endswith(".gguf"): print(n)
') || die "ถามรายชื่อไฟล์จาก HF ไม่ได้ — เช็คชื่อ repo: $MODEL_REPO"

[[ -z "$FILES" ]] && die "repo $MODEL_REPO ไม่มีไฟล์ .gguf เลย — เปิดดูที่ https://huggingface.co/$MODEL_REPO"

echo "    ไฟล์ .gguf ที่มีใน repo:"
echo "$FILES" | sed 's/^/      /'

pick() {  # pick <regex...> — คืนไฟล์แรกที่ match ตามลำดับ pattern ที่ให้มา
  local pat
  for pat in "$@"; do
    local hit
    hit=$(echo "$FILES" | grep -iE "$pat" | head -1)
    [[ -n "$hit" ]] && { echo "$hit"; return; }
  done
}

# mmproj: เอา Q8_0 ก่อน (ประหยัดแรม ~600MB เทียบ F16) แล้วค่อย fallback
MMPROJ_FILE="${MMPROJ_FILE:-$(pick 'mmproj.*q8' 'mmproj.*f16' 'mmproj')}"
MODEL_FILE="${MODEL_FILE:-$(pick "$QUANT" 'q4_k' 'q4')}"
# กัน pick หยิบ mmproj มาเป็นตัวโมเดล (บาง repo ตั้งชื่อชนกัน)
[[ "$MODEL_FILE" == "$MMPROJ_FILE" ]] && MODEL_FILE=$(echo "$FILES" | grep -ivE 'mmproj' | grep -iE "$QUANT|q4" | head -1)

[[ -n "$MODEL_FILE" ]] || die "หาไฟล์ควอนต์ $QUANT ไม่เจอ — ตั้งเองด้วย MODEL_FILE=..."
[[ -n "$MMPROJ_FILE" ]] || die "หาไฟล์ mmproj ไม่เจอ — repo นี้อาจไม่มี vision projector; ลอง repo อื่น"

echo "    เลือก: LLM=$MODEL_FILE"
echo "           mmproj=$MMPROJ_FILE"

for f in "$MODEL_FILE" "$MMPROJ_FILE"; do
  dst="$MODEL_DIR/$(basename "$f")"
  if [[ -s "$dst" ]]; then
    echo "    มีแล้ว: $(basename "$f") ($(du -h "$dst" | cut -f1))"
    continue
  fi
  echo "    ดาวน์โหลด $(basename "$f") ..."
  curl -fL# "https://huggingface.co/${MODEL_REPO}/resolve/main/${f}" -o "$dst.part" \
    || die "โหลด $f ไม่สำเร็จ"
  mv "$dst.part" "$dst"
done

M="$MODEL_DIR/$(basename "$MODEL_FILE")"
P="$MODEL_DIR/$(basename "$MMPROJ_FILE")"
TOTAL_MB=$(( ($(stat -c%s "$M") + $(stat -c%s "$P")) / 1048576 ))
echo
echo "    รวมน้ำหนักบนดิสก์: ${TOTAL_MB}MB (RAM ตอนรันจะมากกว่านี้ — bench จะวัดให้)"
[[ $TOTAL_MB -gt $((MEM_AVAIL_MB - 400)) ]] && \
  echo "    ⚠️  น้ำหนักโมเดลใกล้/เกิน RAM ว่าง — คาดว่าจะลง swap"

cat <<EOF

=================================================================
เตรียมเสร็จ ขั้นต่อไป:

  1) เอารูปทดสอบ + baseline.json จากเครื่องบ้านมาไว้ที่นี่:
       rsync -av <บ้าน>:'.../slip-ocr-th/Data/' $HERE/images/
       rsync -av <บ้าน>:'.../bench/baseline.json' $HERE/

  2) รัน bench (เริ่มจากรูปเดียวก่อน ดูว่ารอดไหม):
       python3 $HERE/bench_cpu_vlm.py \\
         --cli $CLI \\
         --model $M \\
         --mmproj $P \\
         --images $HERE/images \\
         --sizes 0,600000 --timeout 600
=================================================================
EOF
