# ฟอร์มกรอกค่า — ต้องกรอกอะไร ที่ไฟล์ไหน

ติ๊ก `[x]` เมื่อทำเสร็จ

---

## A. กรอกลงไฟล์ `.env` (สร้างไว้ให้แล้ว รอเติมค่า)

📄 **ไฟล์:** `SlipingMan-line-assistant/.env` — gitignore ไว้แล้ว ใส่ค่าจริงได้

| ✔ | ตัวแปร | เอาจากไหน | หน้าตาค่า |
|---|---|---|---|
| [ ] | `LINE_CHANNEL_SECRET` | Developers Console → **Basic settings** → Channel secret | hex 32 ตัว |
| [ ] | `LINE_CHANNEL_ACCESS_TOKEN` | Developers Console → **Messaging API** → Channel access token (long-lived) → **Issue** | ยาว ~170 ตัว ลงท้าย `=` |
| [ ] | `OCR_ENDPOINT` | ไม่ต้องหา — เลือกตามที่รัน (ดูตารางล่าง) | URL |
| [ ] | `LINE_DESTINATION_USER_ID` | *ทีหลังก็ได้* — `get_follower_ids` หรือดูใน log ตอนคุณทักบอทครั้งแรก | `U` + hex 32 |

**`OCR_ENDPOINT` เลือกยังไง:**

| รันแบบไหน | ใส่ค่า |
|---|---|
| ทดสอบบนเครื่องบ้านเครื่องเดียว | `http://localhost:8100` ← ค่า default ตอนนี้ |
| บอทบน VPS ยิงข้ามมาเครื่องบ้าน | `http://petanque:8100` ← ชื่อ MagicDNS (อย่าใช้ IP ดิบ) |

**เช็คว่ากรอกครบไหม:**
```bash
npm start     # ขาดตัวไหนจะฟ้องชื่อตัวแปรนั้นแล้วหยุดทันที
```

---

## B. ตั้งใน console (ไม่ใช่ไฟล์)

### B1. LINE Official Account Manager — https://manager.line.biz/
ตั้งค่า → การตอบกลับ

| ✔ | ทำอะไร | ไม่ทำแล้วเป็นไง |
|---|---|---|
| [ ] | ปิด **Auto-reply messages** | LINE ตอบอัตโนมัติซ้อนกับบอท |
| [ ] | ปิด **Greeting messages** | ผู้ใช้ได้ข้อความทักทายซ้ำสองอัน |

### B2. LINE Developers Console — Messaging API
*(ทำหลังมี URL แล้ว = Phase 3)*

| ✔ | ทำอะไร |
|---|---|
| [ ] | ใส่ **Webhook URL** = `<โดเมนของคุณ>/webhook` แล้วกด **Verify** |
| [ ] | เปิด **Use webhook** |

### B3. Tailscale admin — https://login.tailscale.com/admin/
*(ทำตอน Phase 2 เมื่อจะเอา VPS เข้ามา)*

| ✔ | ทำอะไร |
|---|---|
| [ ] | Settings → Keys → **Generate auth key** (Reusable ปิด · Ephemeral ปิด · Pre-approved เปิด · Tag `tag:vps`) |
| [ ] | แก้ **ACL** ตามตัวอย่างใน `SETUP.md` §3.2 — **กด Preview ก่อน Save** |

> auth key ใช้บนบรรทัดคำสั่งครั้งเดียว ไม่ต้องเก็บลงไฟล์

---

## C. Webhook URL — เลือก 1 ใน 3

LINE ต้องการ **HTTPS + cert จาก CA ที่เชื่อถือได้** (self-signed ใช้ไม่ได้) ทั้ง 3 ทางผ่านหมด

| ทาง | URL | ต้องมีอะไร | URL คงที่? | เหมาะกับ |
|---|---|---|---|---|
| **Caddy + โดเมนคุณ** | `https://bot.yourdomain.com/webhook` | โดเมน + A record → IP ของ VPS | ✅ | production |
| **Tailscale Funnel** | `https://slipingman-vps.taild13f28.ts.net/webhook` | แค่เปิด `funnel` ใน ACL | ✅ | production ไม่มีโดเมน |
| **ngrok** | `https://xxxx.ngrok-free.app/webhook` | ngrok account | 🟡 ดูด้านล่าง | **dev บนเครื่องบ้าน** |

### ngrok ใช้ได้ไหม — ได้ แต่ดูให้ตรงงาน

**บน VPS: ไม่แนะนำ** — VPS มี public IP อยู่แล้ว การเอา ngrok มาคั่นคือเพิ่ม hop, เพิ่มบริการที่ต้องคอยรัน, และเพิ่มจุดที่พังได้อีกจุด โดยไม่ได้อะไรกลับมา

**บนเครื่องบ้าน: คุ้มมาก** — ทดสอบ LINE ครบวงจรได้โดยยังไม่ต้องแตะ VPS เลย
เครื่องบ้านมีทั้งบอทและ OCR อยู่แล้ว → `OCR_ENDPOINT=http://localhost:8100`

```bash
# เครื่องบ้าน — ยังไม่ได้ลง ngrok (เช็คแล้ว)
curl -sSL https://ngrok.com/downloads/linux | sh     # หรือ snap install ngrok
ngrok config add-authtoken <token จาก dashboard>
ngrok http 3000
```

ข้อควรรู้:
- **free tier ให้ static domain 1 อัน** — ผูกไว้จะได้ไม่ต้องแก้ Webhook URL ใน LINE ทุกครั้งที่รีสตาร์ท
  (ถ้าไม่ผูก URL จะสุ่มใหม่ทุกครั้ง = ต้องไปแก้ใน console ใหม่ทุกรอบ) เช็คใน dashboard ว่าบัญชีคุณมีไหม
- ปิด ngrok = บอทตายทันที ใช้เป็น production ไม่ได้
- ต้องเปิดคอมบ้านค้างไว้ตลอด

**เส้นทางที่ผมแนะนำ:** ngrok + เครื่องบ้าน (Phase 3 ทดสอบให้จบ) → ค่อยย้ายขึ้น VPS + Funnel/Caddy
ย้ายทีหลังแก้แค่ **Webhook URL ใน console** กับ `OCR_ENDPOINT` — ไม่ต้องแก้โค้ดเลย

---

## D. Phase 1 เท่านั้น — token ของ backend

`slip-ocr-th/serve.py` **ตอนนี้ไม่มี auth** ต้องเพิ่มก่อนเปิดให้เครื่องอื่นเรียก

| ✔ | ทำอะไร |
|---|---|
| [ ] | `openssl rand -hex 32` → ได้ค่ามา 1 ค่า |
| [ ] | เครื่องบ้าน: `SLIP_OCR_TOKEN=<ค่า>` |
| [ ] | VPS: `OCR_TOKEN=<ค่าเดียวกัน>` ใน `.env` |

⚠️ ค่านี้ยัง**ไม่มีในโค้ด** — ต้องแก้ `serve.py` + `ocrClient.js` ก่อน (งาน Phase 1)
อย่าวาง token/secret ลงในแชทหรือ commit

---

## สรุป — ถ้าจะเริ่มเร็วที่สุด ทำแค่ 3 อย่าง

1. กรอก `LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN` ลง `.env`
2. ปิด Auto-reply + Greeting ใน LINE OA Manager
3. `ngrok http 3000` บนเครื่องบ้าน → เอา URL ไปใส่ Webhook URL แล้ว Verify

เท่านี้ทดสอบบอทครบวงจรได้แล้ว — VPS/Tailscale/token ค่อยทำตอน Phase 2
