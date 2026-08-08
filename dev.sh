#!/usr/bin/env bash
# dev.sh — รัน SlipingMan ครบทั้งสายด้วยคำสั่งเดียว
#
#   OCR backend : ../slip-ocr-th/serve_paddle.py → http://localhost:8101  (CPU, ~720MB RAM)
#   LINE bot    : src/index.js             → http://localhost:3000/webhook
#   Tunnel      : tailscale funnel          → https://<node>.<tailnet>.ts.net/webhook
#
# ใช้งาน:
#   ./dev.sh              รันครบ + เปิด Tailscale Funnel (LINE ยิง webhook เข้าได้)
#   ./dev.sh --local      ไม่เปิด funnel — ทดสอบในเครื่องอย่างเดียว
#   ./dev.sh --no-ocr     ไม่สตาร์ท serve.py (สั่งรันเองไว้แล้ว หรืออยากเทสเฉพาะ bot)
#
# กด Ctrl+C ครั้งเดียว = ปิดทุกอย่าง (รวมถึงปิด funnel ให้ด้วย)
# OCR ใช้ CPU ล้วน (PaddleOCR ~720MB RAM, VRAM 0) → รันคู่กับการเทรนโมเดลอื่นได้

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OCR_DIR="$HERE/../slip-ocr-th"
PY="$HERE/bench/.venv-ocr/bin/python"   # venv ของ PaddleOCR (ไม่ต้องมี torch/GPU)
LOGS="$HERE/logs"
OCR_PORT=8101
BOT_PORT=3000

FUNNEL=1
START_OCR=1
for arg in "$@"; do
  case "$arg" in
    --local)  FUNNEL=0 ;;
    --no-ocr) START_OCR=0 ;;
    *) echo "!! ไม่รู้จักตัวเลือก: $arg" >&2; exit 1 ;;
  esac
done

# แต่ละตัวรันด้วย setsid → เป็นหัวของ process group ตัวเอง (pgid == pid)
# ต้อง kill ทั้งกลุ่มด้วย `kill -- -pid` ไม่งั้นลูกหลานค้างยึดพอร์ตไว้
CHILD_PGIDS=()
FUNNEL_ON=0

spawn() {  # spawn <logfile> <cmd...> — คืน pid (== pgid) ผ่านตัวแปร SPAWNED
  local log=$1; shift
  setsid "$@" >"$log" 2>&1 &
  SPAWNED=$!
  CHILD_PGIDS+=("$SPAWNED")
}

spawn_tty() {  # เหมือน spawn แต่ปล่อย output ออกหน้าจอ (ใช้กับตัวสตรีม log)
  setsid "$@" &
  SPAWNED=$!
  CHILD_PGIDS+=("$SPAWNED")
}

cleanup() {
  trap - INT TERM EXIT
  [[ ${#CHILD_PGIDS[@]} -eq 0 && $FUNNEL_ON -eq 0 ]] && return
  echo ""
  echo ">> กำลังปิด..."
  # funnel เป็น config ของ tailscaled ไม่ใช่ process ลูก — ต้องสั่งปิดแยก
  if [[ $FUNNEL_ON -eq 1 ]]; then
    tailscale funnel --https=443 off >/dev/null 2>&1 && echo ">> ปิด funnel แล้ว (ไม่เปิดสู่อินเทอร์เน็ตอีก)"
  fi
  for pgid in "${CHILD_PGIDS[@]}"; do
    kill -- -"$pgid" 2>/dev/null
  done
  wait 2>/dev/null
  echo ">> ปิดเรียบร้อย"
}
trap cleanup INT TERM EXIT

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
die() { echo "!! $1" >&2; exit 1; }

mkdir -p "$LOGS"
cd "$HERE" || die "เข้า $HERE ไม่ได้"

# ---------- ตรวจของก่อนรัน ----------
[[ -d "$HERE/node_modules" ]] || die "ยังไม่ได้ลง dependency — รัน: npm install"
[[ -f "$HERE/.env" ]] || die "ไม่พบ .env — คัดลอกจาก .env.example แล้วเติม LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN"

port_busy "$BOT_PORT" && die "พอร์ต $BOT_PORT ถูกใช้อยู่แล้ว — ปิดก่อนแล้วค่อยรันใหม่"

if [[ $START_OCR -eq 1 ]]; then
  [[ -x "$PY" ]] || die "ไม่พบ venv ที่ $PY — สร้างด้วย: python3 -m venv bench/.venv-ocr && bench/.venv-ocr/bin/pip install paddlepaddle paddleocr"
  port_busy "$OCR_PORT" && die "พอร์ต $OCR_PORT ถูกใช้อยู่แล้ว (serve_paddle.py รันค้าง?) — ปิดก่อน หรือใช้ ./dev.sh --no-ocr"
fi

# ---------- 1) OCR backend ----------
OCR_PID=""
if [[ $START_OCR -eq 0 ]]; then
  echo ">> ข้ามการสตาร์ท OCR (--no-ocr)"
  port_busy "$OCR_PORT" || echo "!! เตือน: ไม่มีอะไรฟังที่ :$OCR_PORT — bot จะตอบว่า 'ระบบ OCR ยังไม่พร้อม'"
else
  echo ">> เริ่ม OCR backend — PaddleOCR/CPU (~3 วิ, ไม่กิน VRAM)..."
  # -u = ไม่ buffer stdout ไม่งั้น log ไม่โผล่ตอน redirect ลงไฟล์
  # cd เข้า OCR_DIR เพราะ serve.py import โมดูลข้างเคียง (ocr, slip_parser, ...)
  spawn "$LOGS/ocr.log" env -C "$OCR_DIR" "$PY" -u serve_paddle.py
  OCR_PID=$SPAWNED

  for _ in $(seq 1 120); do
    port_busy "$OCR_PORT" && break
    kill -0 "$OCR_PID" 2>/dev/null || { echo "!! OCR ตายระหว่างโหลด — 20 บรรทัดท้าย:"; tail -20 "$LOGS/ocr.log"; exit 1; }
    sleep 1
  done
  port_busy "$OCR_PORT" || die "OCR ไม่ขึ้นภายใน 120 วิ — ดู $LOGS/ocr.log"
  echo ">> OCR พร้อม → http://localhost:$OCR_PORT"
fi

# ---------- 2) LINE bot ----------
echo ">> เริ่ม LINE bot..."
spawn "$LOGS/bot.log" node "$HERE/src/index.js"
BOT_PID=$SPAWNED

for _ in $(seq 1 30); do
  port_busy "$BOT_PORT" && break
  kill -0 "$BOT_PID" 2>/dev/null || { echo "!! bot ตาย — 20 บรรทัดท้าย:"; tail -20 "$LOGS/bot.log"; exit 1; }
  sleep 1
done
port_busy "$BOT_PORT" || die "bot ไม่ขึ้นภายใน 30 วิ — ดู $LOGS/bot.log"

# ---------- 3) Tailscale Funnel ----------
WEBHOOK_URL="http://localhost:$BOT_PORT/webhook"
if [[ $FUNNEL -eq 1 ]]; then
  echo ">> เปิด Tailscale Funnel (เปิดพอร์ตนี้สู่อินเทอร์เน็ตสาธารณะ)..."
  if tailscale funnel --bg "$BOT_PORT" >"$LOGS/funnel.log" 2>&1; then
    FUNNEL_ON=1
    HOST=$(tailscale status --json 2>/dev/null | node -e \
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).Self.DNSName||"").replace(/\.$/,""))}catch{}})')
    [[ -n "$HOST" ]] && WEBHOOK_URL="https://$HOST/webhook"
  else
    echo "!! เปิด funnel ไม่สำเร็จ — ดู $LOGS/funnel.log"
    echo "   มักเป็นเพราะยังไม่ได้เปิดสิทธิ์ Funnel ใน ACL ของ tailnet"
    echo "   แก้ที่ https://login.tailscale.com/admin/acls → เพิ่ม nodeAttrs \"funnel\""
  fi
fi

echo ""
echo "=================================================="
echo "  Webhook URL (เอาไปใส่ LINE Developers Console):"
echo "  $WEBHOOK_URL"
echo ""
echo "  log: logs/   |   Ctrl+C เพื่อปิดทั้งหมด"
echo "=================================================="
echo ""

# ---------- สตรีม log พร้อม prefix ----------
[[ $START_OCR -eq 1 ]] && spawn_tty bash -c "tail -n 0 -f '$LOGS/ocr.log' | sed -u 's/^/[ocr] /'"
spawn_tty bash -c "tail -n 0 -f '$LOGS/bot.log' | sed -u 's/^/[bot] /'"

# รอจนกว่าตัวใดตัวหนึ่งจะตาย แล้วค่อยปิดทั้งหมด (ผ่าน trap EXIT)
while kill -0 "$BOT_PID" 2>/dev/null; do
  if [[ $START_OCR -eq 1 ]] && ! kill -0 "$OCR_PID" 2>/dev/null; then
    echo "!! OCR หยุดทำงาน — ดู logs/ocr.log"
    break
  fi
  sleep 2
done
