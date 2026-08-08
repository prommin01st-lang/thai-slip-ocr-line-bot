# TODO — SlipingMan

รวมทุกเฟสไว้ที่เดียว. รายละเอียดการออกแบบอยู่ใน [`ROADMAP.md`](ROADMAP.md) (Phase 0–5)
และ [`DESIGN-ledger.md`](DESIGN-ledger.md) (Phase 6–10). ผลวัดจริงอยู่ใน [`bench/FINDINGS.md`](bench/FINDINGS.md)

**สถานะ:** ✅ เสร็จ · 🔄 กำลังทำ · ⬜ ยังไม่เริ่ม · 🔴 บล็อกอยู่

---

## ✅ Phase −1 — ที่ทำไปแล้วในเซสชันนี้

- [x] โครงบอท: webhook + ตรวจลายเซ็น + ack 200 ใน 3ms + คิว FIFO + Flex + reply→push fallback
- [x] เทส: `queue.test.js` 4/4 · `flex.test.js` 4/4 (ใช้ผลจริงจาก parser ฝั่ง Python)
- [x] `.env` ครบ · ngrok static domain · **LINE webhook verify ผ่าน 200** · ได้ `userId` แล้ว
- [x] รับทั้ง `/webhook` และ `/line/webhook` (path ใน console ไม่ตรงกับโค้ด)
- [x] OCR backend (`serve.py`) รันได้ — แก้ `masked_scatter_` ด้วย `patch_model.py`
- [x] **วัด Qwen2-VL-2B บน CPU** → ไม่ผ่าน (2,710MB / 111 วิ / อ่านสลิปจริงไม่ออก)
- [x] **วัด PaddleOCR** → ผ่านขาด (718MB / 5.8 วิ / 15/15 ฟิลด์) + `ocr_paddle.py`
- [x] แก้ parser 6 จุด — `_DATE_TH` จุดหาย · `_find_parties_by_layout` · `_pairs_crossline`
      · `_labeled_val` ข้ามป้าย · `_REF` ข↔ย · `_REF_FALLBACK` ตัวอักษรปน · `_find_amount` hint ข้ามบรรทัด
- [x] `bench/eval_dataset.py` + วัดบนสลิปจริง 332 ใบ (k-bank 255 · ttb 70 · truemoney 7)

---

## 🔄 Phase 0 — ปิดหนี้

- [x] รัน `eval_dataset.py` บนสลิปจริง 332 ใบ — **ref 88% → 96%** (v3), รวม **379/395 = 96%**
- [x] **`eval_payslip.py` = 27/27 (100%)** ไม่มี regression ✅
      *(เจอบั๊กระหว่างทาง: กติกา gap เดิมตัดป้ายสองภาษา `เงินได้สุทธิ (Net Pay)` ทิ้ง — แก้เป็น `_LINE_BETWEEN`)*
- [x] แก้ `confidence` ที่ตันอยู่ที่ `medium` ทั้ง 332 ใบ → ตัดสินจาก **ยอด+วันที่** ไม่ใช่ "ห้ามมี warning เลย"
- [x] เทียบ 2 engine บนชุดเดียวกัน — **PaddleOCR ชนะทุกชุด** (ดู `bench/FINDINGS.md`)
      SROIE: amount 78% vs 50% · date 98% vs 67% | thai-ocr-eval: 58% vs 17%
- [ ] ⬜ ตัดสิน engine หลัก/สำรอง จากตัวเลข แล้ว commit การแก้ parser เข้า `slip-ocr-th` + release note

## ✅ Phase 1 — Backend รวมศูนย์

- [x] `serve_paddle.py` — contract เดียวกับ `serve.py` · **`/parse` เร็ว 5.7 วิ** (เทียบ serve.py 51 วิ)
- [x] **auth**: `SLIP_OCR_TOKEN` ทั้งสอง server (ใช้ `hmac.compare_digest`) · `/health` ไม่ต้อง auth
- [x] `ocrClient.js` ส่ง `X-Auth-Token` + `OcrAuthError` แยกจาก error ชั่วคราว
- [x] `ocr_paddle.py` แปลงรูปผ่าน PIL เสมอ → รองรับ `.webp` ที่ LINE ส่งมา
- [ ] ⬜ `serve.py` รับ `engine=paddle|vlm|auto` + โหลด VLM แบบ lazy (ยังไม่ทำ — คนละ process อยู่แล้ว)

## ⬜ Phase 2 — เชื่อมสองเครื่องด้วย Tailscale

- [ ] VPS join tailnet (auth key แบบ tagged `tag:vps`, pre-approved)
- [ ] `OCR_ENDPOINT=http://petanque:8100` — ใช้ MagicDNS ไม่ใช่ IP ดิบ
- [ ] ACL จำกัด `tag:vps` → `backend:8100` เท่านั้น (**กด Preview ก่อน Save** กันล็อกตัวเอง)
- [ ] ufw ปิดขาเข้าหมด ยกเว้น ssh/443 และ interface `tailscale0`
- [ ] HTTPS สาธารณะ: Caddy + โดเมน หรือ `tailscale funnel` (เลิกใช้ ngrok)
- [ ] systemd unit ทั้งสองฝั่ง + `Restart=always`
- [ ] ทดสอบเคสเครื่องบ้านปิด → บอทต้องตอบ "ระบบไม่พร้อม" ไม่ใช่เงียบ

## ⬜ Phase 3 — ใช้งานจริงกับ LINE

- [ ] ปิด **Greeting messages** ใน LINE OA Manager
- [ ] ปรับ Flex ด้วย `line-bot-mcp-server` (`push_flex_message` ทดสอบได้โดยไม่ต้องรอ OCR)
- [ ] แสดง `confidence`/`warnings` ให้ผู้ใช้เห็น · low → quick reply ให้ยืนยัน/แก้เอง
- [ ] `create_rich_menu` — ส่งสลิป / สรุป / ช่วยเหลือ
- [ ] ทดสอบรูปถ่ายจากมือถือจริง (เอียง/เงา/ความละเอียดสูง) ไม่ใช่แค่ screenshot

## ⬜ Phase 4 — Hardening

- [ ] rate limit ต่อผู้ใช้ต่อนาที · จำกัดขนาด/จำนวนรูป
- [ ] logging/metrics — latency, doc_type, success rate, engine (**ห้าม log ข้อความ OCR ดิบ = PII**)
- [ ] รับมือเครื่องบ้านออฟไลน์: PaddleOCR สำรองบน VPS (718MB ลงได้) หรือคิวไว้ push ทีหลัง
- [ ] queue + `GET /job/{id}` ถ้าต้องรองรับหลายคนพร้อมกัน

---

# ระบบบัญชี (จาก `DESIGN-ledger.md`)

## ✅ Phase 6 — เก็บข้อมูล

- [x] SQLite ผ่าน **`node:sqlite` ที่มากับ Node 22** — ไม่ต้องลง native module บน VPS
- [x] schema ครบ 6 ตาราง + migration ผ่าน `PRAGMA user_version`
- [x] **`amount_cents INTEGER`** + `toCents/fromCents` ที่ไม่ผ่าน float เลย (เทสไป-กลับ 1,000 ค่า)
- [x] consent flow · `ข้อมูลของฉัน` · `ลบข้อมูลของฉัน` → `ยืนยันลบ` (สองขั้น กันลบพลาด)
- [x] เก็บเลขบัญชีแค่ 4 ตัวท้าย · ไม่เก็บรูปสลิป (เก็บแค่ `sha256`)
- [x] **กันซ้ำ 3 ชั้น** — ชั้น `image_sha256` เช็ค**ก่อน** OCR จริง ๆ (ประหยัดทั้งรอบ)
- [x] `PRAGMA foreign_keys = ON` → `ลบข้อมูลของฉัน` ลบหมดทุกตารางจริง (มีเทสยืนยัน)
- [x] `test/ledger.test.js` 13/13 · `.gitignore` `data/` + `*.db`
- [ ] ⬜ สำรองข้อมูลอัตโนมัติ

## ✅ Phase 7 — รับ/จ่าย

- [x] `user_accounts` + `guessDirection()` จาก `from`/`to` (ชื่อ หรือ 4 ตัวท้าย) + `learnAccount()`
- [x] **บันทึกจากข้อความแชท** `src/nlu.js` — rule ล้วน ไม่มีโมเดล · `test/nlu.test.js` 15/15
      `"กาแฟ 60"`→out · `"จ่ายค่าไฟ 850"`→out · `"ได้เงินเดือน 30000"`→in · คำสั่งบอทคืน null
- [x] `confidence` → `high` = confirmed · `medium` = pending · `low` = ไม่บันทึก
- [x] ไม่มีคำกริยา → ติดธง `guessed` แล้วบอกผู้ใช้ว่าเดาให้ (แก้ได้)
- [x] **quick reply ถาม "คุณเป็นผู้โอนหรือผู้รับ"** เมื่อ `unknown` → ตอบแล้วจำบัญชี ครั้งต่อไปไม่ถามซ้ำ

## ✅ Phase 8 — สรุป & แก้ไข

- [x] `สรุป` / `สรุปสัปดาห์` → **Flex** (รับ/จ่าย/คงเหลือ + 3 หมวดสูงสุด + จำนวนที่ค้างตรวจ)
- [x] `รายการ` → Flex พร้อมปุ่มลบต่อแถว
- [x] **แก้/ลบรายการย้อนหลัง**: `ลบ 12` · `แก้ 12 250` · ปุ่มลบใน quick reply
      ลบใช้ **soft delete** (`status='rejected'`) — ถ้าลบจริง `slips.ref` จะหลุด unique
      แล้วส่งสลิปใบเดิมเข้ามาใหม่ได้ = ยอดเบิ้ล
- [x] **rich menu 6 ปุ่ม** — ถ่ายสลิป (เปิดกล้อง) · เลือกรูป · สรุป · รายการ · งบ · ช่วยเหลือ
      (`npm run richmenu create` — วาดรูปเองด้วย `scripts/richmenu_image.py`)
- [x] จัดหมวดอัตโนมัติจาก `category_hints`

## ✅ Phase 9 — แจ้งเตือน

- [x] **งบประมาณ**: `งบ 20000` (รวม) · `งบ อาหาร 5000` (รายหมวด) · `งบ` (ดูสถานะ)
- [x] **เตือนงบเกิน/ใกล้เต็ม** ที่ 80% และตอนเกิน — `alert_log` กันเตือนซ้ำในเดือนเดิม
- [x] **จับรายการประจำ** ที่เดือนนี้ยังไม่จ่าย (คู่ค้าเดิม ≥3 ครั้ง)
- [x] **สรุปรายสัปดาห์** — opt-in ด้วย `เตือนรายสัปดาห์` · `scripts/weekly.mjs` (ตั้ง cron เช้าวันจันทร์)
- [x] **ตัวนับโควตา push** (250 จาก 300) — เต็มแล้วหยุดส่งและ log บอก ไม่เงียบหาย
- [x] แจ้งเตือนรันใน `finally` — **ต้องทำงานแม้การตอบผู้ใช้จะล้มเหลว** (เจอบั๊กนี้ตอนเทสจริง)

## 🔄 Phase 10 — เชื่อมกับข้อมูลลูกค้า / ฉลาดขึ้น

- [x] **ส่งออก CSV** — ปุ่มในการ์ด → ลิงก์ชั่วคราว (สุ่ม/หมดอายุ 15 นาที/ใช้ครั้งเดียว)
      มี BOM ให้ Excel อ่านไทยได้ · เปิดใน Google Sheets ได้ตรง ๆ
- [ ] ⬜ sync เข้า Google Sheets อัตโนมัติ (ต้องทำ OAuth ต่อผู้ใช้ผ่าน LIFF ถึงจะไม่ผิด PDPA)

- [ ] ⬜ จับความผิดปกติ (ยอดต่อหมวดเทียบค่าเฉลี่ย 3 เดือน)
- [ ] ค้นย้อนหลังด้วยภาษาไทย → SQL (ยังไม่ต้องมี LLM)
- [ ] **วัดก่อนว่า rule พลาดกี่ %** ถ้าคุ้มค่อยเติม LLM — และต้องทำงานได้ถ้า LLM ล่ม

---

## หลักการที่ยึด

- **เชื่อ eval ไม่ใช่ vibe** — เซสชันนี้พลาด 3 ครั้งเพราะไม่วัด: ตั้ง `--image-max-tokens` ต่ำกว่าที่โมเดลรองรับ,
  recognition model ผิดภาษาแต่ตัวเลขยังถูก, และ **เฉลยจากชื่อไฟล์ TrueMoney ผิดเอง**
- **แยก "OCR ผิด" vs "parser ผิด"** — 31 ใบที่ `ref` พลาด กลายเป็นบั๊ก parser 22 ใบ
- **ข้อมูลผิดที่บันทึกเงียบ ๆ แย่กว่าไม่บันทึก** — low confidence ต้องถาม ไม่ใช่เดา
- **เงินใช้ integer เสมอ** — float ทำยอดรวมเพี้ยนแบบหาที่มาไม่เจอ
