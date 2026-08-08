# bench — VLM เล็กบน CPU ไหวจริงไหม?

ตอบคำถามเดียว: **รัน Qwen2-VL-2B (Q4_K_M) อ่านสลิปบน VPS 2 cores / 3.8GB ไม่มี GPU ได้จริงหรือเปล่า**

ไม่ตอบด้วยการคำนวณ — ตอบด้วยการวัด 3 อย่าง:

| วัดอะไร | ตอบคำถาม |
|---|---|
| peak RSS + swap ที่ใช้จริง | แรมพอไหม หรือจะโดน OOM killer / thrash |
| เวลาจริงต่อรูป (แยก encode / prefill / generate) | UX บน LINE จะเป็นยังไง — วินาที หรือ นาที |
| char-sim กับผล GPU + ฟิลด์ที่ parser ดึงได้ | อ่านแม่นพอใช้งานจริงไหม ไม่ใช่แค่ "รันได้" |

เมตริกความคล้ายใช้ตัวเดียวกับ `slip-ocr-th/eval_base_vs_tuned.py` (`SequenceMatcher` หลัง `_norm`)
→ เทียบข้ามการทดลองได้ ตรงกับหลักการของ repo ที่ว่า *"เชื่อ eval ไม่ใช่ vibe"*

## ขั้นตอน

### 1. บนเครื่องบ้าน (RTX 2060) — สร้างเส้นเทียบ

```bash
cd SlipingMan-line-assistant/bench
../../slip-ocr-th/.venv/bin/python gpu_baseline.py
```

OCR รูปใน `slip-ocr-th/Data/` + `samples/` ด้วย pipeline GPU ที่ใช้อยู่จริง → `baseline.json`

> ⚠️ นี่คือ **ผลของระบบปัจจุบัน ไม่ใช่เฉลยที่มนุษย์ตรวจ** — ใช้ตอบว่า "CPU ทำได้เท่าที่ใช้อยู่ไหม"
> ไม่ใช่ "CPU ถูกต้องไหม" (ถ้าอยากได้เฉลยจริง ใช้ `slip-ocr-th/dataset/payslips/*.json` ที่มี ground truth)

### 2. บน VPS — เตรียมของ

```bash
./setup_vps.sh
```

- ตรวจ RAM/ดิสก์ก่อน แล้วเตือนตั้งแต่ต้นถ้าไม่พอ
- หา `llama-mtmd-cli`: **ใช้ prebuilt ก่อน** ถ้าไม่ได้ค่อย build ด้วย `-j1`
  (compile ขนานบน 2 cores/3.8GB มักโดน OOM killer กลางทาง)
- โหลด GGUF โดย **ถามรายชื่อไฟล์จริงจาก HF API ก่อน ไม่เดาชื่อ** แล้วเลือก Q4_K_M + mmproj
  (เอา **Q8_0 ก่อน F16** — ประหยัดแรม ~600MB ซึ่งเป็นตัวตัดสินว่าจะรอดหรือไม่รอด)

ปรับได้ด้วย env: `MODEL_REPO=` `MODEL_FILE=` `MMPROJ_FILE=` `QUANT=` `SKIP_MODEL=1`

### 3. บน VPS — วัด

คัดลอกรูป + `baseline.json` มาก่อน:

```bash
rsync -av <บ้าน>:'.../slip-ocr-th/Data/' ./images/
rsync -av <บ้าน>:'.../bench/baseline.json' ./
```

**เริ่มจากรูปเดียวก่อนเสมอ** — ถ้าเครื่องจะตาย จะได้รู้ใน 5 นาที ไม่ใช่ชั่วโมง:

```bash
python3 bench_cpu_vlm.py \
  --cli ./llama/llama-mtmd-cli \
  --model ./models/<q4_k_m>.gguf \
  --mmproj ./models/<mmproj>.gguf \
  --images ./images --sizes 0,600000 --timeout 600
```

รอดแล้วค่อยเปิดครบ: `--sizes 0,1000000,600000,300000`

## อ่านผลยังไง

```
รูป                   ขนาด      วินาที   RSS MB   swap    sim   GPU s
slip.png              native       412     2680    140   0.71      16
slip.png              600k         168     2210      0   0.64      16
```

| เห็นอะไร | แปลว่า |
|---|---|
| `swap` > 50 MB | **แรมไม่พอจริง** — ตัวเลขเวลาในตารางเชื่อไม่ได้ (thrash) |
| `OOM` | โดน OOM killer — ต้องลด mmproj เป็น Q8/ย่อรูป/เพิ่มแรม |
| `timeout` | ช้าเกิน `--timeout` (คนละเรื่องกับ OOM — script แยกให้แล้ว) |
| `sim` ต่ำลงมากเมื่อย่อรูป | ย่อแล้วอ่านไม่ออก → ทางลัดเร่งความเร็วนี้ใช้ไม่ได้ |
| `วินาที` > 60 | reply token ของ LINE ตายแน่ ต้อง push อย่างเดียว (กินโควตารายเดือน) |

`results.json` เก็บดิบครบ — รวม `stderr_tail` ไว้ดูตอนพัง

## หมายเหตุ

- **pillow เป็นตัวเลือกเสริม** — ไม่มีก็รันได้ แต่จะวัดได้เฉพาะขนาดเดิม (`pip3 install pillow`)
- จำนวน visual token ของ Qwen2-VL ≈ `(กว้าง/28) × (สูง/28)` — script ประมาณให้ในบรรทัดที่รัน
  สลิปมือถือ 1080×2400 ≈ **3,270 tokens** ซึ่งคือต้นเหตุหลักที่ prefill นาน
- ถ้าอยากลองให้ VLM พ่น JSON ตรง ๆ แทนอ่านข้อความดิบ ใช้ `--prompt` เปลี่ยนได้
  (แต่ `sim` จะเทียบกับ baseline ไม่ได้แล้ว เพราะคนละรูปแบบผลลัพธ์)
