# Deploy ขึ้น VPS

ทั้งระบบเป็น **CPU ล้วน ไม่ต้องมี GPU** — วัดจาก container จริง: RAM รวม **~340 MB** · image รวม **~2.6 GB**

```
LINE ──HTTPS──► Caddy (443) ──► bot :3000 ──(network ภายใน)──► ocr :8101
                                    │
                                    └── SQLite (docker volume)
```

## 1. เตรียม VPS

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER   # ออกจาก ssh แล้วเข้าใหม่
```

## 2. Clone + ตั้งค่า

```bash
git clone <repo> slipingman && cd slipingman
cp .env.example .env
nano .env        # เติม LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN
```

**สร้าง token ให้ backend ด้วย** (กัน OCR service ถูกเรียกมั่ว):

```bash
echo "OCR_TOKEN=$(openssl rand -hex 32)" >> .env
```

> 🔒 `.env` อยู่ใน `.gitignore` และ `.dockerignore` — ไม่มีทางหลุดเข้า git หรือ image

## 3. รัน

```bash
docker compose up -d --build     # ครั้งแรกนาน ~5-10 นาที (โหลด paddle + โมเดล)
docker compose ps
curl -s localhost:3000/health | jq
```

ควรได้ `{"status":"ok","ocr":{"ok":true,"engine":"paddleocr"}}`

## 4. เปิด HTTPS ให้ LINE ยิงเข้ามา

LINE ต้องการ **HTTPS + cert จาก CA ที่เชื่อถือได้** (self-signed ใช้ไม่ได้)

### ทางเลือก A — Caddy + โดเมนของคุณ (แนะนำ)

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile <<'EOF'
bot.example.com {
    reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy
```

Caddy ขอ cert จาก Let's Encrypt ให้อัตโนมัติ

### ทางเลือก B — Tailscale Funnel (ไม่ต้องมีโดเมน)

```bash
sudo tailscale up --authkey tskey-auth-xxxxx --hostname slipingman-vps
tailscale funnel --bg 3000
```

ได้ URL `https://slipingman-vps.<tailnet>.ts.net`

## 5. ตั้ง Webhook ใน LINE

[Developers Console](https://developers.line.biz/console/) → Messaging API → Webhook URL

```
https://<โดเมนของคุณ>/webhook
```

กด **Verify** แล้วเปิด **Use webhook**

> ปิด **Auto-reply** และ **Greeting messages** ใน [OA Manager](https://manager.line.biz/) ด้วย
> ไม่งั้นบอทจะตอบซ้อนกับข้อความอัตโนมัติของ LINE

## 6. Rich menu (ครั้งเดียว)

รันจากเครื่องที่มี Node + `.env` (ไม่ต้องทำใน container):

```bash
npm install
node scripts/richmenu.mjs create
```

## 7. สรุปรายสัปดาห์ (ตัวเลือก)

```bash
crontab -e
# ทุกเช้าวันจันทร์ 08:00 ไทย (= 01:00 UTC)
0 1 * * 1 cd /path/to/slipingman && docker compose exec -T bot node scripts/weekly.mjs >> /var/log/slipingman-weekly.log 2>&1
```

---

## ทรัพยากรที่ใช้จริง (วัดแล้ว)

วัดจาก container จริง (ไม่ใช่ประมาณการ):

| | RAM ตอนรัน | image |
|---|---|---|
| `ocr` (PaddleOCR) | **314 MB** | 2.27 GB |
| `bot` (Node) | **23 MB** | 296 MB |
| **รวม** | **~340 MB** | **~2.6 GB** |

บน VPS 3.8 GB RAM → เหลือเฟือ (`docker-compose.yml` จำกัด `ocr` ที่ 1.6 GB กันพลาด)

### ความเร็ว OCR ขึ้นกับจำนวน core ตรง ๆ

| cores | เวลา/รูป |
|---|---|
| 1.5 | 10.1 วิ |
| **2 (VPS ของคุณ)** | **~8.5 วิ** |
| 4 | 4.2 วิ |
| 8 | 2.2 วิ |

**ไม่ได้ตั้ง cpu limit ไว้** — ตั้งต่ำกว่าที่เครื่องมีคือทำให้ช้าลงเปล่า ๆ
ส่วน `bot` ใช้ CPU แค่ ~3ms ต่อ webhook ซึ่ง scheduler แบ่งให้ได้อยู่แล้ว

ถ้า VPS มีมากกว่า 2 cores ให้ตั้ง `OCR_THREADS` ใน `.env` ให้เท่าจำนวน core จริง

## คำสั่งที่ใช้บ่อย

```bash
docker compose logs -f bot          # ดู log
docker compose logs -f ocr
docker compose restart bot          # รีสตาร์ทหลังแก้ .env
docker compose up -d --build        # deploy โค้ดใหม่
docker compose exec bot node -e "..."   # เข้าไปรันคำสั่ง

# สำรอง DB (มีข้อมูลการเงินจริง — ควรทำสม่ำเสมอ)
docker compose exec -T bot cat /app/data/slipingman.db > backup-$(date +%F).db
```

## อัปเดตโค้ด OCR

ไฟล์ใน `ocr/` เป็นสำเนาจาก `slip-ocr-th` (ต้นทาง) — แก้ที่ต้นทางแล้วรัน:

```bash
./scripts/sync-ocr.sh          # คัดลอกมาใหม่
./scripts/sync-ocr.sh --check  # เช็คว่าตรงกันไหม
```

## ความปลอดภัย

- `ocr` **ไม่ publish พอร์ตออกนอกเครื่อง** — เข้าถึงได้เฉพาะจาก `bot` ผ่าน network ภายใน
- `bot` ผูกกับ `127.0.0.1:3000` — ต้องผ่าน reverse proxy เท่านั้น
- ทั้งสอง container รันด้วย user ธรรมดา ไม่ใช่ root
- ตั้ง `OCR_TOKEN` แล้ว `ocr` จะปฏิเสธ request ที่ไม่มี `X-Auth-Token`
- ตั้ง firewall: `sudo ufw allow 22,80,443/tcp && sudo ufw enable`

## ⚠️ PDPA

ระบบเก็บข้อมูลการเงินของบุคคลจริง (ยอด คู่ค้า เลขบัญชี 4 ตัวท้าย)

- ผู้ใช้ต้องกด **ยินยอม** ก่อนระบบถึงเริ่มบันทึก
- คำสั่ง `ลบข้อมูลของฉัน` ลบจริงทุกตาราง (มีเทสยืนยัน)
- **ไม่เก็บรูปสลิป** — เก็บแค่ `sha256` ไว้กันบันทึกซ้ำ
- ควรเข้ารหัสดิสก์ VPS และเก็บ backup ในที่ปลอดภัย
