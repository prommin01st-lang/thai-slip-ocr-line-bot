# SlipingMan — LINE assistant อ่านสลิปไทย

ส่งรูป **สลิปโอนเงิน / ใบเสร็จ / ใบเงินเดือน** เข้า LINE → บอทตอบกลับเป็นการ์ดข้อมูลมีโครงสร้าง

โปรเจกต์นี้เป็น **ฝั่งหน้าบ้าน (LINE)** เท่านั้น — งาน OCR จริงยิงไปที่
[`../slip-ocr-th`](../slip-ocr-th) ซึ่งรัน `baidu/Unlimited-OCR` (3B VLM, 4-bit) บน RTX 2060 6GB

```
LINE app ──(รูป)──► LINE Platform
                         │ webhook POST  (ต้องตอบ 200 แทบทันที ไม่งั้น LINE retry)
                         ▼
              ┌────────────────────────────┐
              │ SlipingMan (Node/Express)   │  ← ไม่มี torch/ML dep ใด ๆ
              │  1. ตรวจ X-Line-Signature   │
              │  2. ตอบ 200 ทันที           │
              │  3. โยนเข้าคิวเบื้องหลัง    │
              └──────────┬─────────────────┘
                         │ POST /parse {"image_b64": ...}
                         ▼
              slip-ocr-th/serve_paddle.py :8101 ──► JSON
              (PaddleOCR/CPU ~2-6 วิ · ไม่กิน VRAM)
                         │
                         ▼
              Flex Message ──► reply token (ถ้าหมดอายุ → push)
```

## เริ่มใช้งาน

```bash
npm install
cp .env.example .env          # แล้วเติม LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN
npm test                      # เทสคิว + ตัวสร้าง Flex (ไม่ต้องมี GPU/โมเดล)
./dev.sh                      # รัน OCR backend + bot + Tailscale Funnel พร้อมกัน
```

`./dev.sh` จะพิมพ์ **Webhook URL** ออกมา — เอาไปวางใน
[LINE Developers Console](https://developers.line.biz/console/) → Messaging API → Webhook URL
แล้วกด **Verify** และเปิด **Use webhook**

> ปิด **Auto-reply messages** และ **Greeting messages** ใน LINE Official Account Manager ด้วย
> ไม่งั้นบอทจะตอบซ้อนกับข้อความอัตโนมัติของ LINE

### ตัวเลือกของ `dev.sh`

| คำสั่ง | ผล |
|---|---|
| `./dev.sh` | OCR + bot + funnel (เปิดสู่อินเทอร์เน็ต) |
| `./dev.sh --local` | ไม่เปิด funnel — เทสในเครื่องอย่างเดียว |
| `./dev.sh --no-ocr` | ไม่สตาร์ท `serve.py` (สั่งรันเองไว้แล้ว) |

Ctrl+C ครั้งเดียวปิดทุกอย่าง **รวมถึงปิด funnel ให้ด้วย** (ไม่ทิ้งพอร์ตเปิดค้างสู่สาธารณะ)

## คำสั่งที่บอทเข้าใจ

| ผู้ใช้ส่ง | บอททำ |
|---|---|
| รูปภาพ | OCR → ตอบการ์ดผลลัพธ์ (บอกลำดับคิวถ้ามีคนรอ) |
| `สถานะ` | เช็คว่า OCR backend พร้อมไหม + VRAM + ความยาวคิว |
| ข้อความอื่น | ข้อความช่วยเหลือ |

## ไฟล์

| ไฟล์ | หน้าที่ |
|---|---|
| `src/index.js` | Express + `middleware()` ตรวจลายเซ็น → **ตอบ 200 ก่อน** → ประมวลผลเบื้องหลัง |
| `src/handlers.js` | ตรรกะต่อ event: ดึงรูป, แสดง loading, reply→push fallback |
| `src/ocrClient.js` | เรียก `slip-ocr-th` (`/parse`, `/slip`, `/payslip`, `/receipt`, `/health`) |
| `src/queue.js` | คิว FIFO รันทีละงาน (GPU มีตัวเดียว) + บอกลำดับผู้ใช้ได้ |
| `src/flex.js` | JSON → Flex Message ภาษาไทย (แสดง `confidence` + `warnings`) |
| `src/config.js` | โหลด/ตรวจ env, fail fast |
| `test/` | เทสคิว + เทส Flex จาก **ผลจริงของ parser ฝั่ง Python** (`test/fixtures/`) |
| `.mcp.json` | ตั้งค่า `line-bot-mcp-server` ให้ Claude Code (ดูข้างล่าง) |

## ข้อจำกัดที่ออกแบบเผื่อไว้แล้ว

- **OCR ~16 วิ/ใบ และ GPU serialize** — LINE ต้องได้ 200 ใน ~1 วิ ไม่งั้นมันจะส่ง event ซ้ำ
  → ตอบ 200 ก่อนเสมอ (วัดจริงได้ **3ms**) แล้วค่อยทำงาน
- **reply token ใช้ได้ครั้งเดียวและหมดอายุเร็ว** — คิวยาวแล้ว token อาจตายก่อน OCR เสร็จ
  → ลอง `replyMessage` ก่อน (ไม่กินโควตา) พังแล้วค่อย `pushMessage`
- **`OCR_TIMEOUT_MS` ต้องมากกว่า `SLIP_OCR_MAX_SECONDS`** ของ `serve.py` (default 150 วิ)
  ไม่งั้นฝั่งเราจะตัดสายก่อนที่ backend จะได้ตอบ 504 พร้อมสาเหตุ
- **VRAM** — OCR ยึด ~2.2GB จาก 6GB ตลอดเวลาที่รัน **ปิด `dev.sh` ก่อนเทรนโมเดลอื่น**
- **venv แยกเด็ดขาด** — `slip-ocr-th` pin `transformers==4.46.3` แต่บอทตัวนี้เป็น Node
  ไม่มี Python dependency เลย จึงไม่มีทางชนกัน

## `line-bot-mcp-server` (เครื่องมือฝั่ง dev)

`.mcp.json` ต่อ [`@line/line-bot-mcp-server`](https://github.com/line/line-bot-mcp-server) ไว้ให้
Claude Code สั่งการ LINE OA ได้โดยตรง — **มันเป็น outbound-only (ส่งอย่างเดียว) รับ webhook ไม่ได้**
จึงไม่ได้ใช้แทน Express server แต่ใช้ตอนพัฒนา:

- `push_flex_message` — ยิงการ์ดทดสอบเข้า LINE ได้ทันที ไม่ต้องรอ OCR 16 วิ
- `create_rich_menu` — สร้างเมนูล่างของบอท
- `get_follower_ids` / `get_profile` — หา `userId` มาใส่ `LINE_DESTINATION_USER_ID`
- `get_message_quota` — เช็คโควตา push ที่เหลือ

`.mcp.json` อ่าน token จาก environment (ไม่ฝัง secret ลงไฟล์ที่ commit) — ตั้งก่อนเปิด Claude Code:

```bash
export $(grep -v '^#' .env | xargs)
claude
```
