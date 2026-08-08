# SlipingMan — Roadmap

ระบบสแกนสลิปผ่าน LINE. แบ่งเป็น **Phase 0–5**. อัปเดต 2026-08-08.

**โครงที่ตกลง:** เครื่องบ้าน (RTX 2060) = backend · VPS (2c/3.8GB) = LINE bot · เชื่อมด้วย Tailscale

```
LINE ──HTTPS──► VPS ──Tailscale (ไม่ออกเน็ตสาธารณะ)──► เครื่องบ้าน
              (Node bot)                              (OCR + parser)
```

---

## ⚠️ ข้อค้นพบที่กระทบโครง — อ่านก่อน

จากที่วัดจริงใน `bench/FINDINGS.md`:

| engine | ที่รัน | เวลา/รูป | VRAM | RAM |
|---|---|---|---|---|
| Unlimited-OCR 3B (4-bit) | **ต้องมี GPU** | ~16 วิ | **2.24 GB ค้างตลอด** | — |
| **PaddleOCR + parser ที่แก้แล้ว** | **CPU เฉย ๆ** | **5.8 วิ** | **0** | 718 MB |

**PaddleOCR เร็วกว่า GPU pipeline เกือบ 3 เท่า และไม่กิน VRAM เลย** (บนสลิปโอน — ยังไม่ได้วัดชุดใหญ่)

ผลตามมา 2 ข้อ:

1. **การให้ backend ยึด VRAM 2.24GB ตลอดเวลา ชนกับงานเรียนของคุณเอง** — `CLAUDE.md` เขียนไว้เองว่า
   ต้องปิด `dev.sh` ก่อนเทรน และ `train.py` ของ slip-ocr-th peak 3.21GB จาก 6GB
   ถ้า OCR service เปิดค้าง จะเหลือ ~3.7GB ให้เทรน — คับมาก
2. **ถ้า PaddleOCR ดีพอจริง เครื่องบ้านแทบไม่ต้องใช้ GPU เลย** — จะรัน backend บนเครื่องบ้านก็ได้
   (แรงกว่า) แต่ไม่ต้องจอง VRAM

→ **Phase 0 จึงต้องตัดสินด้วยข้อมูลก่อนว่า engine ไหนเป็นตัวหลัก** ทั้ง roadmap ขึ้นกับคำตอบนี้

---

## Phase 0 — ปิดหนี้ + ตัดสินด้วยข้อมูล 🔴 *ต้องทำก่อนทุกอย่าง*

ตอนนี้มี **การแก้ที่ยังไม่ผ่าน eval** ค้างอยู่ ห้ามต่อยอดจนกว่าจะเคลียร์

- [ ] **รัน `eval_payslip.py` ยืนยันว่า parser ที่แก้ไม่ทำ 27/27 เดิมพัง**
      — แก้ `_labeled_val` ไปแตะ path ที่ eval ตัวนี้วัดตรง ๆ (ใช้ GPU สักครู่)
- [ ] **วัดชุดใหญ่: PaddleOCR vs Unlimited-OCR บน testset เดียวกัน**
      — `test_sroie.py` (50 ใบ) + `test_hf_dataset.py` (104 บรรทัดไทย)
      — 15/15 ปัจจุบันมาจากรูปแค่ **3 ใบ** และ 2 ใน 3 ใช้ปรับ parser เอง → เสี่ยง overfit
- [ ] **ตัดสิน**: engine หลัก / engine สำรอง / หรือใช้ทั้งคู่แบบ fallback chain
- [ ] commit การแก้ parser เข้า `slip-ocr-th` พร้อม release note

**เกณฑ์ผ่าน:** `eval_payslip.py` ≥ ของเดิม และมีตัวเลขเทียบ 2 engine บนชุดเดียวกัน

---

## Phase 1 — Backend รวมศูนย์บนเครื่องบ้าน

เป้าหมาย: HTTP service ตัวเดียวที่ bot คุยด้วย โดย **contract เดิมไม่เปลี่ยน**
(`POST /parse` → JSON) เพราะ `src/ocrClient.js` พูดภาษานี้อยู่แล้ว

- [ ] `ocr_paddle.py` — wrapper PaddleOCR ให้ interface เหมือน `ocr.ocr_image()`
      **ต้องจำ 2 กับดัก:** `enable_mkldnn=False` (argument เท่านั้น) และระบุ
      `text_recognition_model_name="th_PP-OCRv5_mobile_rec"` เมื่อ override det model
- [ ] `serve.py` รับพารามิเตอร์ `engine=paddle|vlm|auto`
      — `auto`: PaddleOCR ก่อน → ถ้า `confidence == "low"` หรือไม่ได้ amount ค่อยตก VLM
      — โหลด VLM **แบบ lazy** (ไม่แตะ GPU จนกว่าจะถูกเรียก) → ไม่จอง VRAM ตอนไม่ใช้
- [ ] **Auth** — ตอนนี้ `serve.py` เปิด `0.0.0.0` ไม่มี auth เลย (ROADMAP 4.1 ของ slip-ocr-th ก็ระบุไว้)
      อย่างน้อยต้องมี shared token header ก่อนให้เครื่องอื่นเรียก
- [ ] แปลงรูปขาเข้าให้เป็น RGB ก่อนเสมอ — **LINE ส่ง `.webp` ได้** (llama.cpp อ่านไม่ได้, PIL อ่านได้)

---

## Phase 2 — เชื่อมสองเครื่องด้วย Tailscale + deploy

Tailscale เป็นตัวรับส่งข้อมูลระหว่างสองเครื่อง — ได้ 4 อย่างฟรีโดยไม่ต้องตั้งอะไรเพิ่ม:
**เข้ารหัส (WireGuard) · ทะลุ NAT (ไม่ต้อง port forward) · ตัวตนของ node · ทราฟฟิกไม่ออกเน็ตสาธารณะ**

สถานะปัจจุบัน: tailnet `prommin01st-lang@` มี `petanque` (เครื่องบ้าน, `100.118.68.76`),
`msi`, `v2413` — **VPS ยังไม่อยู่ใน tailnet**

- [ ] VPS join tailnet: `tailscale up --ssh` (ใช้ auth key แบบ ephemeral/tagged จะดีกว่า login ด้วยมือ)
- [ ] **เปิด MagicDNS แล้วใช้ชื่อโฮสต์ ไม่ใช่ IP**
      `OCR_ENDPOINT=http://petanque:8100` — IP `100.x` เปลี่ยนได้ ชื่อโฮสต์นิ่งกว่า
- [ ] **`tailscale serve` ไม่ใช่ `funnel` สำหรับฝั่ง backend**
      `serve` = เปิดให้เฉพาะใน tailnet (ถูกต้องสำหรับ :8100) · `funnel` = เปิดสู่อินเทอร์เน็ต (ใช้กับ webhook เท่านั้น)
- [ ] **ACL ใน tailnet** — จำกัดให้เฉพาะ node ของ VPS เรียก `petanque:8100` ได้
      เป็นเกราะชั้นสองถัดจาก shared token ใน Phase 1 (ถ้า node อื่นโดนยึด ก็ยังเข้าไม่ได้)
- [ ] **ห้ามเปิดพอร์ต 8100 ที่ firewall สาธารณะ** — ให้ bind ที่ tailscale interface หรือปล่อย
      `0.0.0.0` แต่ปิดขาเข้าที่ ufw ยกเว้น `tailscale0`
- [ ] HTTPS สาธารณะฝั่ง LINE: Caddy + โดเมน (URL คงที่ แนะนำ) หรือ `tailscale funnel` บน VPS
- [ ] systemd unit ทั้งสองฝั่ง + `Restart=always`
- [ ] ทดสอบ **เคสเครื่องบ้านปิด** → บอทต้องตอบ "ระบบ OCR ไม่พร้อม" ไม่ใช่เงียบ
      (`ocrClient.js` โยน `OcrUnavailableError` อยู่แล้ว — ต้องเทสจริง)

**โบนัส:** `tailscale ssh` ทำให้ deploy/ดู log ข้ามเครื่องได้โดยไม่ต้องเปิดพอร์ต 22 สู่เน็ต
และ `tailscale file cp` ใช้ส่งไฟล์ eval/โมเดลข้ามเครื่องได้เลย ไม่ต้องตั้ง scp key

**ความเสี่ยงที่ต้องยอมรับ:** เครื่องบ้านเป็นโน้ตบุ๊กที่คุณใช้ทำงาน/เรียนอยู่ — ปิด/sleep/รีบูตเมื่อไรก็ได้
Tailscale ทะลุ NAT ให้ แต่ทะลุ "เครื่องปิดอยู่" ไม่ได้ → ดูข้อ 4.3

---

## Phase 3 — ใช้งานจริงกับ LINE

- [ ] ตั้ง Webhook URL + Verify ใน LINE Developers Console
- [ ] **ปิด Auto-reply / Greeting** ใน LINE OA Manager (ไม่งั้นตอบซ้อน)
- [ ] ปรับหน้าตา Flex ด้วย `line-bot-mcp-server` (`push_flex_message` ยิงทดสอบได้ทันที ไม่ต้องรอ OCR)
- [ ] แสดง `confidence` / `warnings` ให้ผู้ใช้เห็น — **ค่าที่ไม่มั่นใจต้องบอก ไม่ใช่โชว์เป็นความจริง**
- [ ] low confidence → quick reply ให้ผู้ใช้ยืนยัน/แก้ยอดเอง
- [ ] `create_rich_menu` — เมนูล่าง (ส่งสลิป / ประวัติ / ช่วยเหลือ)
- [ ] ทดสอบรูปถ่ายจากมือถือจริง (เอียง/เงา/ความละเอียดสูง) ไม่ใช่แค่ screenshot

---

## Phase 4 — Hardening

- [ ] **4.1 Auth + rate limit** ทั้ง webhook และ backend
- [ ] **4.2 Logging/metrics** — latency, doc_type, success rate, engine ที่ใช้
      ⚠️ **PII**: สลิปจริงมีชื่อ/เลขบัญชี — **ห้าม log ข้อความ OCR ดิบลงไฟล์ถาวรโดยไม่ตั้งใจ**
      เก็บเฉพาะ metric หรือ hash
- [ ] **4.3 รับมือเครื่องบ้านออฟไลน์** — ทางเลือก:
      (ก) PaddleOCR รันบน VPS เป็น fallback (718MB พอดี — วัดแล้วว่าลงได้)
      (ข) คิวงานไว้แล้ว push ให้ทีหลังเมื่อเครื่องบ้านกลับมา
      (ค) แค่ตอบว่าไม่พร้อม (ง่ายสุด — ทำแล้ว)
- [ ] **4.4 Queue + `GET /job/{id}`** ถ้าจะรองรับผู้ใช้หลายคนพร้อมกัน
- [ ] จำกัดขนาด/จำนวนรูปต่อผู้ใช้ต่อนาที

---

## Phase 5 — วงจรปรับปรุงจากข้อมูลจริง

- [ ] ขยาย eval set จากสลิปจริงที่เจอ (**ต้องขออนุญาต + ปกปิด PII ก่อนเก็บ**)
- [ ] เพิ่ม pattern ต่อธนาคารใน `slip_parser.py` ตามที่เจอจริง (README ของ slip-ocr-th แนะนำไว้แบบนี้)
- [ ] ใช้ bounding box ของ PaddleOCR ทำ layout-aware parsing
      — จะแก้เคสตารางแบบ 2 มิติได้จริง (ตอนนี้ parser เป็น text-only จึงต้องใช้ heuristic LIFO)
- [ ] ทบทวนว่ายังต้องมี VLM ไหม ถ้า PaddleOCR ชนะทุกหมวด

---

## หลักการที่ยึด (สืบทอดจาก slip-ocr-th)

- **เชื่อ eval ไม่ใช่ vibe** — เซสชันนี้พิสูจน์แล้ว 2 รอบ: ตั้ง `--image-max-tokens` ต่ำกว่า 1024
  ทำให้สรุปผิดทั้งหมด และ recognition model ผิดภาษาก็ยังอ่านตัวเลขถูก (ถ้าดูแค่ยอดจะไม่รู้เลย)
- **แยก "OCR ผิด" vs "parser ผิด"** — เช็คว่าค่าอยู่ในข้อความ OCR ไหม ก่อนโทษ parser
  (ทำแบบนี้แล้วพบว่าเพดานอยู่ที่ parser ไม่ใช่ OCR → แก้ 9/15 → 15/15)
- **ทดสอบด้วยของจริง** — สลิปสังเคราะห์ผ่านไม่ได้แปลว่าสลิป K+ จริงจะผ่าน
- **VRAM 6GB คือทรัพยากรร่วม** — backend ที่จองค้างไว้ = เทรนโมเดลอื่นไม่ได้
