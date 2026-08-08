# SETUP — ของที่ต้องมีก่อนเริ่ม

แยกเป็น **ที่คุณต้องทำเอง** (credential / console — ผมทำแทนไม่ได้) กับ **ที่ผมทำให้ได้**

สถานะที่เช็คแล้ว 2026-08-08:

| | สถานะ |
|---|---|
| เครื่องบ้าน — node 22, `node_modules`, venv ของ slip-ocr-th | ✅ พร้อม |
| เครื่องบ้าน — Tailscale + **MagicDNS** | ✅ `petanque.taild13f28.ts.net` |
| เครื่องบ้าน — `.env` | ❌ ยังไม่มี |
| VPS — อยู่ใน tailnet | ❌ ยังไม่ join |
| LINE — secret/token ใน environment | ❌ ยังไม่ตั้ง |

---

## 1. LINE Developers Console — เอา 2 ค่า

https://developers.line.biz/console/ → เลือก channel ของคุณ

| ค่า | อยู่แท็บไหน |
|---|---|
| `LINE_CHANNEL_SECRET` | **Basic settings** → Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | **Messaging API** → Channel access token (long-lived) → กด Issue |

> token แบบ long-lived ไม่หมดอายุเอง แต่ถ้ากด Issue ใหม่ **ตัวเก่าจะใช้ไม่ได้ทันที** — ออกครั้งเดียวแล้วเก็บให้ดี

เอาไปใส่ `.env` (ไฟล์นี้ gitignore ไว้แล้ว):

```bash
cp .env.example .env    # แล้วเติม 2 ค่าข้างบน
```

## 2. LINE Official Account Manager — ปิด 2 อย่าง

https://manager.line.biz/ → ตั้งค่า → การตอบกลับ

- [ ] ปิด **Auto-reply messages**
- [ ] ปิด **Greeting messages**

> ไม่ปิด = ผู้ใช้ส่งสลิปมาแล้วจะได้ข้อความอัตโนมัติของ LINE ซ้อนกับคำตอบของบอท

(ส่วน **Use webhook** เปิดใน Developers Console ตอน Phase 3 หลังมี URL แล้ว)

## 3. Tailscale — สิ่งที่ต้องทำใน admin console

https://login.tailscale.com/admin/

### 3.1 Auth key สำหรับ VPS (Settings → Keys → Generate auth key)

ตั้งค่าที่แนะนำสำหรับเครื่อง server:

| ตัวเลือก | ค่า | ทำไม |
|---|---|---|
| Reusable | **ปิด** | ใช้ครั้งเดียวจบ ปลอดภัยกว่า |
| Ephemeral | **ปิด** | VPS อยู่ถาวร ไม่ใช่ container ชั่วคราว |
| Pre-approved | **เปิด** | join แล้วใช้ได้เลย ไม่ต้องมากดอนุมัติ |
| Tags | `tag:vps` | ให้ ACL อ้างถึงได้ + key ไม่ผูกกับ user คุณ |

### 3.2 ACL — จำกัดให้ VPS เรียกได้แค่พอร์ต OCR

⚠️ **ACL ปัจจุบันของ tailnet ใหม่คือ allow-all** การแก้ผิดอาจตัดขาดเครื่องอื่นของคุณ
(`msi`, `v2413`) — แก้แล้วกด **Preview** ก่อน Save เสมอ

```jsonc
{
  "tagOwners": { "tag:vps": ["autogroup:admin"] },

  "hosts": { "backend": "100.118.68.76" },   // เครื่องบ้าน petanque

  "acls": [
    // VPS เข้าถึง backend ได้พอร์ตเดียวเท่านั้น
    { "action": "accept", "src": ["tag:vps"], "dst": ["backend:8100"] },

    // เครื่องส่วนตัวของคุณเข้าได้ทุกอย่างตามเดิม (กันล็อกตัวเอง)
    { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] }
  ],

  // ต้องมีบรรทัดนี้ถ้าจะใช้ tailscale funnel เปิด HTTPS สาธารณะบน VPS
  "nodeAttrs": [ { "target": ["tag:vps"], "attr": ["funnel"] } ]
}
```

### 3.3 บน VPS

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --authkey tskey-auth-xxxxx --hostname slipingman-vps
tailscale status                     # ต้องเห็น petanque
curl -s http://petanque:8100/health  # ทดสอบ (ต้องสตาร์ท serve.py ฝั่งบ้านก่อน)
```

## 4. VPS — ของที่ต้องลง

```bash
sudo apt update
sudo apt install -y curl ca-certificates ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -   # node 22 (ต้อง >= 22)
sudo apt install -y nodejs

# ปิดขาเข้าทุกอย่างยกเว้น ssh + https; ทราฟฟิกจาก tailnet มาทาง tailscale0
sudo ufw allow 22/tcp && sudo ufw allow 443/tcp && sudo ufw allow in on tailscale0
sudo ufw enable
```

**ยังไม่ต้องลง Python/PaddleOCR บน VPS** — ทำเฉพาะถ้าจะทำ fallback ตอนเครื่องบ้านออฟไลน์ (Phase 4.3)

## 5. Token ของ backend เอง (Phase 1)

`slip-ocr-th/serve.py` **ตอนนี้ไม่มี auth เลย** ต้องเพิ่มก่อนให้เครื่องอื่นเรียก สร้าง token เอง:

```bash
openssl rand -hex 32     # เอาค่าที่ได้ใส่ทั้ง 2 เครื่อง
```

- เครื่องบ้าน: `SLIP_OCR_TOKEN=<ค่า>` (ให้ `serve.py` ตรวจ header)
- VPS: `OCR_TOKEN=<ค่าเดียวกัน>` ใน `.env` ของบอท

> อย่าวางค่า token/secret ลงในแชทหรือ commit — ใส่ `.env` อย่างเดียว

## 6. โดเมน (ตัวเลือก)

| ทางเลือก | ได้ URL | ต้องมีอะไร |
|---|---|---|
| **Tailscale Funnel** | `https://slipingman-vps.taild13f28.ts.net/webhook` | ไม่ต้องมีโดเมน — แค่เปิด `funnel` ใน ACL |
| **Caddy + โดเมนของคุณ** | `https://bot.yourdomain.com/webhook` | โดเมน + ชี้ A record มาที่ IP ของ VPS |

ทั้งคู่ได้ cert ที่ LINE ยอมรับ (LINE ไม่รับ self-signed) เริ่มด้วย Funnel ก่อนก็ได้ ย้ายทีหลังได้

---

## สรุป: 5 อย่างที่ต้องมีในมือก่อนเริ่ม Phase 1

1. `LINE_CHANNEL_SECRET`
2. `LINE_CHANNEL_ACCESS_TOKEN`
3. Tailscale **auth key** สำหรับ VPS
4. **SSH + sudo** บน VPS
5. สิทธิ์แก้ **ACL** ใน Tailscale admin

`LINE_DESTINATION_USER_ID` (ไว้ให้ Claude ยิง Flex ทดสอบผ่าน `line-bot-mcp-server`) เอาทีหลังได้ —
ได้จาก `get_follower_ids` หรือดูจาก event แรกที่เข้ามาใน log ของบอท

## ที่ผมทำให้ได้ทันทีเมื่อคุณมีของครบ

- เขียน `.env` ทั้งสองเครื่อง · เพิ่ม auth ใน `serve.py` · systemd unit + Caddyfile
- สคริปต์ join tailnet + ตรวจการเชื่อมต่อ · ปรับ `ocrClient.js` ให้ส่ง token
