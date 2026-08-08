#!/usr/bin/env bash
# quick_check.sh <รูปสลิป> — เช็คสั้นที่สุดว่า VPS รัน Qwen2-VL-2B ไหวไหม
#
# ไฟล์เดียวจบ ไม่ต้องโอนอะไรอื่น — scp ไฟล์นี้ + รูปสลิป 1 รูป ไปที่ VPS แล้วรัน
# ตอบแค่ 2 คำถาม: กินแรมเท่าไร (peak RSS) และ ใช้เวลากี่วินาที
# อยากได้ครบ (หลายความละเอียด + เทียบคุณภาพกับ GPU) ค่อยใช้ setup_vps.sh + bench_cpu_vlm.py
#
# โหลดครั้งแรก ~1.6GB — ครั้งต่อไปใช้ของเดิม

set -euo pipefail

IMG="${1:?ใช้: ./quick_check.sh <รูปสลิป.jpg>}"
[ -f "$IMG" ] || { echo "!! ไม่พบรูป: $IMG" >&2; exit 1; }
IMG="$(cd "$(dirname "$IMG")" && pwd)/$(basename "$IMG")"

D="${VLM_DIR:-$HOME/vlmtest}"
REPO="ggml-org/Qwen2-VL-2B-Instruct-GGUF"
M="Qwen2-VL-2B-Instruct-Q4_K_M.gguf"              # 940 MB
P="mmproj-Qwen2-VL-2B-Instruct-Q8_0.gguf"         # 677 MB — Q8 ไม่ใช่ F16 (F16 = 1270MB, แรมไม่พอ)
NPRED="${NPRED:-384}"
# THREADS=2 ใช้จำลองจำนวนคอร์ของ VPS ตอนทดสอบบนเครื่องแรง (ผลจะยังดีกว่าจริงเพราะคอร์เร็วกว่า)
THREADS="${THREADS:-$(nproc)}"

mkdir -p "$D"; cd "$D"

echo "── เครื่อง ──"
echo "cores: $(nproc)  (ใช้จริง -t $THREADS)"
free -m | awk 'NR==1||NR==2||NR==3'

# ---------- 1) llama.cpp (Linux = .tar.gz, CPU ล้วน) ----------
CLI="$(find "$D" -type f -name llama-mtmd-cli 2>/dev/null | head -1 || true)"
if [ -z "$CLI" ]; then
  U=$(curl -sfL https://api.github.com/repos/ggml-org/llama.cpp/releases/latest \
      | grep -o 'https://[^"]*bin-ubuntu-x64\.tar\.gz' | head -1)
  [ -n "$U" ] || { echo "!! หา prebuilt ไม่เจอ — ใช้ setup_vps.sh ที่ build เองแทน" >&2; exit 1; }
  echo "── โหลด $(basename "$U") ──"
  curl -fL# "$U" -o l.tgz && tar xzf l.tgz && rm -f l.tgz
  CLI="$(find "$D" -type f -name llama-mtmd-cli | head -1)"
  [ -n "$CLI" ] || { echo "!! แตกไฟล์แล้วไม่เจอ llama-mtmd-cli" >&2; exit 1; }
  chmod +x "$CLI"
fi
# binary ต้องเห็น libllama.so / libggml*.so ที่อยู่โฟลเดอร์เดียวกัน
export LD_LIBRARY_PATH="$(dirname "$CLI")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# ---------- 2) โมเดล ----------
for f in "$M" "$P"; do
  [ -s "$f" ] || { echo "── โหลด $f ──"; curl -fL# "https://huggingface.co/$REPO/resolve/main/$f" -o "$f"; }
done
echo "── น้ำหนักบนดิสก์: $(du -ch "$M" "$P" | tail -1 | cut -f1) ──"

# ---------- 3) รัน + วัด ----------
echo "── รัน (Ctrl+C ได้ตลอด ถ้ารู้สึกว่านานเกินรับได้) ──"
TIMER=""; command -v /usr/bin/time >/dev/null && TIMER="/usr/bin/time -v"
[ -n "$TIMER" ] || echo "   (ไม่มี /usr/bin/time → วัด peak RSS ไม่ได้; apt install time)"

set +e
$TIMER "$CLI" -m "$M" --mmproj "$P" --image "$IMG" \
  -p "Read all the text in this image exactly as it appears, preserving line breaks." \
  -n "$NPRED" -t "$THREADS" --temp 0 >out.txt 2>err.txt
RC=$?
set -e

echo
echo "════════ ข้อความที่อ่านได้ ════════"
cat out.txt
echo "════════ ตัวเลขที่ต้องดู ════════"
awk '/Maximum resident set size/ {printf "  peak RAM      : %.0f MB\n", $NF/1024}
     /Elapsed \(wall clock\)/    {printf "  เวลารวม        : %s\n", $NF}' err.txt
grep -oE 'prompt eval time =[^(]*' err.txt | sed 's/^/  prefill       : /' || true
grep -oE '^ *eval time =[^(]*'     err.txt | sed 's/^ */  generate      : /' || true
SWAP=$(free -m | awk '/^Swap/{print $3}')
echo "  swap ที่ใช้อยู่ : ${SWAP} MB"
echo "══════════════════════════════════"
[ "$RC" -ne 0 ] && {
  echo "!! จบด้วย exit $RC — 15 บรรทัดท้ายของ log:"; tail -15 err.txt
  [ "$RC" -eq 137 ] && echo "!! exit 137 = โดน SIGKILL — เกือบแน่นอนว่า OOM killer (แรมไม่พอ)"
}
echo
echo "ตีความ: swap ขึ้นเยอะ = แรมไม่พอจริง | เวลา > 60 วิ = reply token ของ LINE ตาย ต้องใช้ push"
exit 0
