#!/usr/bin/env bash
# sync-ocr.sh — คัดลอกไฟล์ OCR/parser จาก ../slip-ocr-th มาไว้ใน ocr/
#
# ทำไมต้องคัดลอก: โปรเจกต์นี้ต้อง deploy ขึ้น VPS ได้ด้วยตัวเอง (git clone แล้ว
# docker compose up ได้เลย) แต่ไฟล์ OCR อยู่คนละ repo → vendor เข้ามาให้ครบ
#
# **ต้นทางคือ ../slip-ocr-th เสมอ** — แก้ที่นั่น แล้วรันสคริปต์นี้ อย่าแก้ใน ocr/ ตรง ๆ
# ไม่งั้นจะ drift แล้วผลที่วัดไว้ใน bench/FINDINGS.md จะไม่ตรงกับที่รันจริง
#
#   ./scripts/sync-ocr.sh          คัดลอก
#   ./scripts/sync-ocr.sh --check  แค่เช็คว่าตรงกับต้นทางไหม (ใช้ใน CI ได้)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${SLIP_OCR_DIR:-$HERE/../slip-ocr-th}"
DST="$HERE/ocr"

FILES=(
  serve_paddle.py      # HTTP API
  ocr_paddle.py        # เรียก PaddleOCR
  slip_parser.py       # สลิปโอน
  payslip_parser.py    # ใบเงินเดือน
  receipt_parser.py    # ใบเสร็จ
  doc_router.py        # จำแนกชนิดเอกสาร
  money_utils.py       # สกุลเงิน
  preprocess.py        # เตรียมรูป (pillow)
)

[[ -d "$SRC" ]] || { echo "!! ไม่พบต้นทาง $SRC (ตั้ง SLIP_OCR_DIR ได้)" >&2; exit 1; }
mkdir -p "$DST"

if [[ "${1:-}" == "--check" ]]; then
  fail=0
  for f in "${FILES[@]}"; do
    if ! diff -q "$SRC/$f" "$DST/$f" >/dev/null 2>&1; then
      echo "  ✗ $f ไม่ตรงกับต้นทาง"; fail=1
    fi
  done
  [[ $fail -eq 0 ]] && echo "  ✅ ocr/ ตรงกับ $SRC ทุกไฟล์" || {
    echo "  → รัน ./scripts/sync-ocr.sh เพื่ออัปเดต" >&2; exit 1; }
  exit 0
fi

for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || { echo "!! ไม่พบ $SRC/$f" >&2; exit 1; }
  cp "$SRC/$f" "$DST/$f"
  printf "  คัดลอก %-20s %s\n" "$f" "$(du -h "$DST/$f" | cut -f1)"
done
echo "✅ sync เสร็จ — ต้นทาง: $SRC"
