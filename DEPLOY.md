# DEPLOY.md — คู่มือ deploy (เขียนสำหรับ AI agent)

เขียนให้ **agent อ่านแล้วทำตามได้เอง** ทุกขั้นมีคำสั่งตรวจผล + ผลลัพธ์ที่ควรได้
**ถ้าผลไม่ตรงที่เขียนไว้ ให้หยุดแล้วรายงาน อย่าเดาต่อ**

---

## 0. บริบท — สิ่งที่กำลัง deploy

LINE bot อ่านสลิปธนาคารไทย + สมุดบัญชีรายรับ-รายจ่าย · **CPU ล้วน ไม่ต้องมี GPU ไม่มี LLM**

```
LINE ──HTTPS──► reverse proxy (443) ──► bot :3000 ──compose network──► ocr :8101
                                            │
                                            └── SQLite ใน docker volume
```

| service | stack | RAM ที่วัดได้ | image |
|---|---|---|---|
| `bot` | Node 22 + Express 5 | 23 MB | 296 MB |
| `ocr` | Python 3.12 + PaddleOCR (CPU) | 235 MB | 2.27 GB |

**ตัวเลขอ้างอิงสำหรับตรวจว่า deploy ถูก** (วัดจริงมาแล้ว):
- OCR สลิป 1 ใบ: **~8.5 วิ บน 2 cores** · ~4.2 วิ บน 4 · ~2.2 วิ บน 8
- `bot` ตอบ webhook: **~3 ms**
- ถ้าช้ากว่านี้มาก → ดูข้อ 10.2

---

## 1. ⛔ สิ่งที่ agent ทำเองไม่ได้ — ต้องขอจากมนุษย์

**อย่าหาเอง อย่าเดา อย่าสร้างค่าขึ้นมาเอง** ถ้าไม่มีให้หยุดแล้วถาม

| ต้องการ | เอามาจากไหน |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE Developers Console → Basic settings |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Console → Messaging API → Issue |
| SSH เข้า VPS | เจ้าของระบบ |
| ทางออกสู่อินเทอร์เน็ต — เลือกอย่างใดอย่างหนึ่ง | **ngrok authtoken + โดเมนที่จองไว้** (ข้อ 7C ⭐) · โดเมน + DNS A record (7A) · Tailscale authkey (7B) |
| ตั้ง Webhook URL ใน LINE Console | ต้องกดในเบราว์เซอร์ |
| ปิด Auto-reply / Greeting ใน LINE OA Manager | ต้องกดในเบราว์เซอร์ |

> ⚠️ `LINE_CHANNEL_ACCESS_TOKEN` คุมบัญชี LINE OA ได้ทั้งหมด
> **ห้ามพิมพ์ค่าลง log / stdout / commit / ข้อความรายงาน** — เขียนลง `.env` อย่างเดียว

---

## 2. Preflight — ตรวจเครื่องก่อน

```bash
docker --version && docker compose version
nproc                                              # จำนวน core → ใช้ตั้ง OCR_THREADS
free -m | awk '/^Mem/{print $7" MB available"}'    # ต้อง > 1500
df -h / | awk 'NR==2{print $4" free"}'             # ต้อง > 5G
```

**เกณฑ์ผ่าน:** RAM ว่าง ≥ 1.5 GB · ดิสก์ว่าง ≥ 5 GB

ยังไม่มี docker (`Command 'docker' not found`):
```bash
curl -fsSL https://get.docker.com | sudo sh     # ได้ docker + compose v2 + buildx
sudo apt install -y git
sudo usermod -aG docker "$USER"
```

> ⚠️ **ห้ามใช้ `apt install docker.io docker-compose-plugin`** — `docker-compose-plugin`
> อยู่ในรีโปของ Docker เท่านั้น ไม่มีใน Ubuntu จะได้ `Unable to locate package`
> (ของ Ubuntu ชื่อ `docker-compose-v2`) สคริปต์ข้างบนเพิ่มรีโปให้เองจึงไม่มีปัญหานี้

**ต้อง logout/login ใหม่** ถึงจะได้สิทธิ์ group `docker` — ไม่งั้นทุกคำสั่งจะได้
`permission denied while trying to connect to the Docker daemon socket`
```bash
exit                                # แล้ว ssh กลับเข้ามาใหม่
docker --version && docker compose version    # ต้องได้เลขเวอร์ชันทั้งคู่
```

---

## 3. เอาโค้ดขึ้น VPS

**repo เป็น private** — VPS ต้องมีสิทธิ์อ่านก่อน เลือกวิธีใดวิธีหนึ่ง

### 3A. Deploy key (แนะนำ — ให้สิทธิ์อ่าน repo เดียว)

บน VPS:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/slipingman_deploy -N "" -C "slipingman-vps"
cat ~/.ssh/slipingman_deploy.pub        # คัดลอกค่านี้
cat >> ~/.ssh/config <<'EOF'
Host github-slipingman
  HostName github.com
  User git
  IdentityFile ~/.ssh/slipingman_deploy
  IdentitiesOnly yes
EOF
```

**ให้มนุษย์เอา public key ไปวางที่** repo → Settings → Deploy keys → Add deploy key
(ไม่ต้องติ๊ก "Allow write access")

แล้ว clone:
```bash
git clone git@github-slipingman:prommin01st-lang/thai-slip-ocr-line-bot.git slipingman
cd slipingman && git log --oneline -1
```

### 3B. rsync จากเครื่อง dev (ไม่ต้องยุ่งกับ key)

รันจากเครื่อง dev — **ต้องมี `--exclude` ครบ** ไม่งั้นจะพา `.env` ของ dev
และ DB ที่มีข้อมูลจริงขึ้นไปด้วย:
```bash
rsync -av --delete \
  --exclude '.env' --exclude 'data/' --exclude 'logs/' \
  --exclude 'node_modules/' --exclude 'bench/.venv-ocr/' --exclude '.git/' \
  ./ user@vps:~/slipingman/
```

### 3C. เปิด repo เป็น public แล้ว clone ตรง ๆ
ง่ายสุดแต่เปิดโค้ดสู่สาธารณะ — **ต้องให้เจ้าของระบบตัดสินใจเท่านั้น**

---

**สิ่งเดียวที่ไม่ได้มากับ repo คือ `.env`** — สร้างบน VPS ตามข้อ 4
(VPS ต้องต่อเน็ตได้ตอน build เพราะต้องโหลด npm / pip / โมเดล PaddleOCR)

---

## 4. ตั้งค่า `.env`

**`.env` ที่จำเป็นมีแค่ 4 บรรทัด** — ที่เหลือ compose เติมให้เอง
(`OCR_ENDPOINT`, `PORT`, `OCR_TIMEOUT_MS` ถูก override ใน `docker-compose.yml` อยู่แล้ว
ค่าใน `.env` ไม่มีผล — ตรวจได้ด้วย `docker compose config`)

```bash
cat > .env <<EOF
LINE_CHANNEL_SECRET=<ค่าจริงจากข้อ 1>
LINE_CHANNEL_ACCESS_TOKEN=<ค่าจริงจากข้อ 1>
OCR_TOKEN=$(openssl rand -hex 32)
OCR_THREADS=$(nproc)
EOF
chmod 600 .env
```

`PUBLIC_URL` เพิ่มทีหลังตอนมีโดเมนแล้ว (ข้อ 7)

**ตรวจว่าครบ** (ไม่พิมพ์ค่าออกมา แค่ดูว่าไม่ว่าง — ทุกอันต้องได้ `1`):
```bash
for k in LINE_CHANNEL_SECRET LINE_CHANNEL_ACCESS_TOKEN OCR_TOKEN; do
  printf '%s = %s\n' "$k" "$(grep -c "^$k=.\+" .env)"
done
```

ได้ `0` แปลว่ายังว่าง → กลับไปข้อ 1

> `PUBLIC_URL` **ยังไม่ต้องตั้ง** จนกว่าจะมีโดเมนจริง (ข้อ 7)
> ไม่ตั้ง = ปุ่มส่งออก CSV ถูกซ่อนไว้ ซึ่งถูกต้องแล้ว

---

## 5. Build + start

```bash
docker compose up -d --build
```

**ครั้งแรก 5–15 นาที** (โหลด paddlepaddle ~100 MB + โมเดล 215 MB เข้า image)

รอจน healthy:
```bash
for i in $(seq 1 90); do
  docker compose ps --format '{{.Service}}={{.Health}}' | grep -q 'bot=healthy' && break
  sleep 5
done
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
```

**ผลที่ควรได้:**
```
SERVICE   STATUS                   PORTS
bot       Up X seconds (healthy)   127.0.0.1:3000->3000/tcp
ocr       Up X seconds (healthy)   8101/tcp
```

จุดที่ต้องเช็คให้ดี:
- `ocr` = `8101/tcp` **เฉย ๆ ห้ามมี `0.0.0.0:` นำหน้า**
- `bot` = `127.0.0.1:3000` **ไม่ใช่ `0.0.0.0:3000`**

---

## 6. ตรวจว่าใช้งานได้จริง — ทำทุกข้อ

### 6.1 health
```bash
curl -s localhost:3000/health
```
ควรได้ `{"status":"ok","queue":0,"ocr":{"ok":true,"engine":"paddleocr","vram_gb":0,...}}`

`"ok":false` → ข้อ 10.3

### 6.2 `ocr` ต้องเข้าจากนอกไม่ได้
```bash
curl -s --max-time 3 localhost:8101/health >/dev/null && echo "FAIL: เปิดออกนอก" || echo "OK: ปิดอยู่"
```
ต้องได้ `OK: ปิดอยู่`

### 6.3 ลายเซ็น webhook
```bash
set -a; . ./.env; set +a
BODY='{"destination":"U1","events":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$LINE_CHANNEL_SECRET" -binary | base64)
echo "ถูก:  $(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/webhook -H 'Content-Type: application/json' -H "X-Line-Signature: $SIG" -d "$BODY")"
echo "ผิด: $(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/webhook -H 'Content-Type: application/json' -H 'X-Line-Signature: WRONG' -d "$BODY")"
```
ต้องได้ **`ถูก: 200`** และ **`ผิด: 401`** — ได้อย่างอื่นห้ามไปต่อ

### 6.4 OCR อ่านสลิปได้จริง
ต้องมีรูปสลิปสักใบ (ขอจากเจ้าของระบบ)
```bash
docker compose cp /path/to/slip.jpg ocr:/tmp/t.jpg
docker compose exec -T ocr python -c "
import time, ocr_paddle
ocr_paddle.load_model()
t=time.perf_counter(); txt=ocr_paddle.ocr_image('/tmp/t.jpg')
print(f'{time.perf_counter()-t:.1f} วิ, {len(txt.splitlines())} บรรทัด')
print(txt[:300])"
```
**ต้องได้ข้อความภาษาไทยที่อ่านออก** — ถ้าเป็นอักษรอื่น (อาหรับ/จีน/ละติน) → ข้อ 10.4

### 6.5 ข้อมูลรอดตอน restart
```bash
docker compose restart bot && sleep 8
curl -s localhost:3000/health | grep -q '"status":"ok"' && echo OK || echo FAIL
```

---

## 7. เปิดสู่อินเทอร์เน็ต

LINE ต้องการ **HTTPS + cert จาก CA ที่เชื่อถือได้** — self-signed ใช้ไม่ได้

**เลือกวิธีเดียว:**

| วิธี | ต้องมีโดเมน | ต้องเปิดพอร์ต 80/443 | เหมาะกับ |
|---|---|---|---|
| **7C. ngrok** ⭐ | ไม่ต้อง — ได้ `*.ngrok-free.dev` มาให้ | **ไม่ต้อง** | ไม่มีโดเมน / มี ngrok อยู่แล้ว |
| 7A. Caddy | ต้องมี + DNS A record | ต้อง | มีโดเมนของตัวเอง |
| 7B. Tailscale Funnel | ไม่ต้อง | ไม่ต้อง | ใช้ tailnet อยู่แล้ว |

> **ถ้าเจ้าของระบบไม่ได้ระบุว่ามีโดเมนจริง ให้ข้ามไปทำข้อ 7C**

### 7A. Caddy + โดเมนจริง

ต้องมี DNS A record ชี้มาที่ IP ของ VPS แล้ว
```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile <<'EOF'
bot.example.com {
    reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy && sleep 10
curl -s https://bot.example.com/health     # ต้องได้ JSON เดียวกับ 6.1
```

### 7B. Tailscale Funnel (ไม่มีโดเมน)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --authkey <tskey-auth-...> --hostname slipingman-vps
tailscale funnel --bg 3000
tailscale funnel status                    # จด URL ที่ได้
```
ต้องเปิดสิทธิ์ `funnel` ใน tailnet ACL ก่อน ไม่งั้นคำสั่งจะ error

### 7C. ngrok — ไม่ต้องมีโดเมน ไม่ต้องเปิดพอร์ต ⭐

ngrok เปิด outbound connection ออกไปเอง แล้วรับ traffic กลับผ่าน tunnel นั้น
→ **ไม่ต้อง forward port ไม่ต้องแตะ DNS และไม่ต้องเปิด 80/443 ที่ firewall เลย**

> ⛔ **ต้องขอจากเจ้าของระบบ:** ngrok authtoken + โดเมนถาวรที่จองไว้แล้ว
> (ดูได้ที่ dashboard.ngrok.com → Domains) **อย่าสร้างโดเมนสุ่มเอง** — โดเมนสุ่ม
> เปลี่ยนทุกครั้งที่ restart แล้ว Webhook URL ใน LINE จะเสียทันที

> ⚠️ **ngrok แผนฟรีรัน agent ได้ทีละ 1 ตัวเท่านั้น** และ 1 โดเมนจองได้ 1 tunnel
> ถ้ามี ngrok ตัวอื่นรันอยู่ (เช่นบนเครื่อง dev) **ต้องปิดก่อน** ไม่งั้น VPS จะจองโดเมนไม่ได้
> → error `ERR_NGROK_108` แปลว่ามีตัวอื่นค้างอยู่

**1) ติดตั้ง + ใส่ authtoken**
```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
  | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install -y ngrok

ngrok config add-authtoken <authtoken จากเจ้าของระบบ>
ngrok config check                         # ต้องได้ "Valid configuration file"
```

**2) ทำเป็น systemd service — ห้ามรันมือ**

รันมือแล้วปิด terminal = tunnel ตาย = **บอทเงียบโดยไม่มี error ให้เห็น**
service นี้จะสตาร์ทเองทุกครั้งที่ VPS reboot

```bash
NGROK_DOMAIN=<โดเมนที่จองไว้>.ngrok-free.dev      # ← แก้ตรงนี้

sudo tee /etc/systemd/system/ngrok-slipingman.service >/dev/null <<EOF
[Unit]
Description=ngrok tunnel -> SlipingMan bot
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
ExecStart=$(command -v ngrok) http --url=$NGROK_DOMAIN 3000 --log=stdout
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ngrok-slipingman
```

heredoc นี้ **ไม่ได้ครอบ `EOF` ด้วยเครื่องหมายคำพูด** โดยตั้งใจ — `$USER`
และ `$(command -v ngrok)` ต้องถูกแทนค่าตอนสร้างไฟล์ (systemd ต้องการ path เต็ม)

> ngrok เก่ากว่า v3.19 ไม่รู้จัก `--url=` ให้ใช้ `--domain=` แทน
> เช็คด้วย `ngrok version` — ถ้า service ขึ้น `unknown flag` นี่คือสาเหตุ

**3) ตรวจ**
```bash
systemctl is-active ngrok-slipingman        # ต้องได้ active
sleep 5
curl -s https://$NGROK_DOMAIN/health        # ต้องได้ JSON เดียวกับข้อ 6.1
```

ไม่ผ่าน → `journalctl -u ngrok-slipingman -n 30 --no-pager`

| ที่เห็นใน log | แปลว่า |
|---|---|
| `ERR_NGROK_108` | มี ngrok ตัวอื่นรันอยู่ที่อื่น — ปิดก่อน |
| `ERR_NGROK_105` | authtoken ผิด/ไม่มี → `ngrok config add-authtoken` ใหม่ |
| `failed to dial 127.0.0.1:3000` | `bot` ยังไม่ขึ้น → กลับไปข้อ 5 |

**4) จุดที่ต้องระวังตอน Verify**

ngrok แผนฟรีมีหน้าเตือน interstitial คั่นสำหรับ request ที่ดูเหมือนเบราว์เซอร์
webhook ของ LINE เป็น POST + JSON ซึ่ง**ควร**ผ่าน แต่ต้องพิสูจน์ด้วยข้อ 8 —
ถ้า `webhook/test` ได้ `statusCode:200` คือผ่านจริง
ถ้าได้ `statusCode:` แปลก ๆ ทั้งที่ `curl /health` ผ่าน ให้สงสัย interstitial ก่อน

### หลังได้ URL แล้ว
```bash
echo "PUBLIC_URL=https://<URL ที่ได้จาก 7A/7B/7C>" >> .env
docker compose restart bot                 # ปุ่มส่งออก CSV จะกลับมา
```

### firewall
```bash
# 7A (Caddy) — ต้องเปิด 80/443
sudo ufw allow 22,80,443/tcp && sudo ufw --force enable

# 7B / 7C (Tailscale / ngrok) — tunnel ต่อออกเอง เปิดแค่ ssh พอ
sudo ufw allow 22/tcp && sudo ufw --force enable

sudo ufw status                            # ต้องไม่มี 3000 / 8101 ไม่ว่าวิธีไหน
```

---

## 8. ⛔ ขั้นที่ต้องให้มนุษย์กดในเบราว์เซอร์

1. **LINE Developers Console** → Messaging API → Webhook URL = `https://<โดเมน>/webhook`
   → กด **Verify** → เปิด **Use webhook**
2. **LINE OA Manager** → ปิด **Auto-reply messages** และ **Greeting messages**
   (ไม่ปิด = บอทตอบซ้อนกับข้อความอัตโนมัติของ LINE)

**agent ตรวจผลได้เองด้วย API — ไม่ต้องเปิดเบราว์เซอร์:**
```bash
set -a; . ./.env; set +a
curl -s https://api.line.me/v2/bot/channel/webhook/endpoint \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN"
# ควรได้ {"endpoint":"https://.../webhook","active":true}

curl -s -X POST https://api.line.me/v2/bot/channel/webhook/test \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
# ควรได้ {"success":true,"statusCode":200,...}
```

| ผล | แปลว่า |
|---|---|
| `"success":false, statusCode:404` | path ไม่ตรง (บอทรับทั้ง `/webhook` และ `/line/webhook`) |
| `statusCode:0` หรือ timeout | reverse proxy / DNS / firewall มีปัญหา |
| `statusCode:502` | `bot` ไม่ตอบ — ดู `docker compose logs bot` |

---

## 9. Rich menu (ครั้งเดียว ตัวเลือก)

รันจากเครื่องที่มี Node + `.env`:
```bash
npm install
python3 scripts/richmenu_image.py      # ต้องมี pillow
node scripts/richmenu.mjs create
node scripts/richmenu.mjs list         # ยืนยันว่ามี default menu
```

---

## 10. อาการพังที่เคยเจอจริง

### 10.1 build ไม่ผ่าน — `libgomp.so.1: cannot open shared object file`
`paddlepaddle` ต้องใช้ OpenMP runtime ซึ่ง `python:3.12-slim` ไม่มีให้
`ocr/Dockerfile` ใส่ไว้แล้ว — ถ้ายังเจอ ให้เช็คว่าบรรทัด `apt-get install` มี
`libgomp1 libgl1 libglib2.0-0` ครบ

### 10.2 OCR ช้ากว่าตารางในข้อ 0 มาก
เวลาแปรผกผันกับจำนวน core เกือบเป๊ะ (1.5 core = 10.1 วิ · 2 = 8.5 · 4 = 4.2 · 8 = 2.2)
```bash
docker inspect $(docker compose ps -q ocr) --format '{{.HostConfig.NanoCpus}}'   # ต้องได้ 0
grep OCR_THREADS .env                                                            # ต้องเท่ากับ nproc
```
**อย่าใส่ `cpus:` limit ใน `docker-compose.yml`** — ตั้งต่ำกว่าที่เครื่องมีคือทำให้ช้าเปล่า ๆ

### 10.3 `health` บอก `"ocr":{"ok":false}`
```bash
docker compose logs --tail 40 ocr
docker compose exec -T bot sh -c 'wget -qO- http://ocr:8101/health || echo FAIL'
```
- `ocr` ยัง unhealthy → รอโหลดโมเดลเสร็จ (~30 วิแรก)
- `bot` เรียกแล้วได้ 401 → `OCR_TOKEN` ไม่ตรงกัน (ทั้งสอง service อ่านค่าเดียวกันจาก `.env`)

### 10.4 OCR อ่านได้แต่เป็นภาษาอื่น (อาหรับ/จีน/ละติน)
recognition model ผิดภาษา — `ocr/ocr_paddle.py` ต้องมี
`text_recognition_model_name="th_PP-OCRv5_mobile_rec"`

> ⚠️ **อาการนี้ตัวเลขยังถูก มีแต่ตัวหนังสือที่เพี้ยน** ถ้าตรวจแค่ยอดเงินจะไม่รู้ว่าพัง
> ต้องดูข้อความไทยด้วยทุกครั้ง

### 10.5 บอทเงียบ ไม่ตอบอะไรเลย
```bash
docker compose logs --tail 30 bot | grep '\[event\]'
```
- ไม่มี `[event]` เลย → LINE ยิงไม่ถึง (ข้อ 8)
- มี `[event]` แต่ไม่ตอบ → หา `[reply ล้มเหลว]` มักเป็น access token ผิด/หมดอายุ

### 10.6 พอร์ตชนตอน `up`
```bash
ss -ltnp | grep -E ':3000|:8101'
```
มีตัวอื่นยึดอยู่ → หยุดก่อน หรือแก้ `ports:` ใน compose

---

## 11. คำสั่งดูแลประจำ

### 11.1 อัปเดตโค้ดใหม่

```bash
cd ~/slipingman
git pull
docker compose up -d --build        # ⚠️ ต้องรัน — pull เฉย ๆ ไม่มีผล
git log --oneline -1 && curl -s localhost:3000/health
```

โค้ดถูกคัดลอกเข้า image ตอน build **container ที่รันอยู่ไม่ได้อ่านไฟล์จากดิสก์**
`git pull` อย่างเดียวจึงไม่เปลี่ยนอะไรเลย — เป็นกับดักที่ทำให้ "แก้แล้วแต่ไม่เปลี่ยน"

**ถ้า pull ขึ้น conflict** — deploy box ไม่ควรมีการแก้ไฟล์ ให้ทิ้งของฝั่ง VPS:
```bash
git fetch origin && git reset --hard origin/main
```
ปลอดภัย เพราะ `.env` `data/` `*.db` `logs/` ถูก gitignore ไว้ทั้งหมด
และ DB ตัวจริงอยู่ใน docker volume ไม่ได้อยู่ใน working tree ด้วยซ้ำ

> deploy key เป็น **read-only** → `git pull` ได้ `git push` ไม่ได้ (ตั้งใจให้เป็นแบบนั้น)
> ถ้า pull แล้วโดนถาม username/password แปลว่า remote เป็น HTTPS ไม่ใช่ SSH:
> ```bash
> git remote -v      # ต้องขึ้น git@github-slipingman:...
> git remote set-url origin git@github-slipingman:prommin01st-lang/thai-slip-ocr-line-bot.git
> ```
>
> **ไม่ต้องลง GitHub CLI (`gh`)** — deploy ไม่ได้ใช้ GitHub API เลย และ `gh` ต้องใช้
> token ที่เข้าถึงได้ทุก repo ในบัญชี ซึ่งขัดกับเหตุผลที่ใช้ deploy key ตั้งแต่แรก

### 11.2 อื่น ๆ

```bash
docker compose logs -f bot          # log สด
docker compose restart bot          # หลังแก้ .env

# สำรอง DB — มีข้อมูลการเงินจริง ควรทำสม่ำเสมอ
docker compose exec -T bot cat /app/data/slipingman.db > backup-$(date +%F).db
```

สรุปรายสัปดาห์ (ตัวเลือก) — cron เช้าวันจันทร์ 08:00 ไทย = 01:00 UTC:
```
0 1 * * 1 cd /path/to/slipingman && docker compose exec -T bot node scripts/weekly.mjs >> /var/log/slipingman-weekly.log 2>&1
```

---

## 12. Rollback

```bash
docker compose down                  # หยุด — volume ยังอยู่ ข้อมูลไม่หาย
git log --oneline -5
git checkout <commit ก่อนหน้า> && docker compose up -d --build
```

> ⛔ **`docker compose down -v` ลบ volume = ลบข้อมูลผู้ใช้ทั้งหมด**
> ห้ามใช้เว้นแต่ตั้งใจจริง และสำรอง DB ก่อนเสมอ

---

## 13. ✅ Checklist ก่อนบอกว่า deploy เสร็จ

- [ ] `docker compose ps` — `bot` และ `ocr` เป็น `healthy` ทั้งคู่
- [ ] `ocr` **ไม่มี** port ผูกกับ `0.0.0.0`
- [ ] `curl localhost:3000/health` → `"ok":true` และ `"engine":"paddleocr"`
- [ ] webhook: ลายเซ็นถูก = 200 · ผิด = 401
- [ ] OCR สลิปทดสอบได้**ข้อความไทยอ่านออก** ในเวลาที่สมเหตุสมผลกับจำนวน core
- [ ] `https://<โดเมน>/health` เข้าได้จากนอกเครื่อง
- [ ] LINE `webhook/test` → `"success":true`
- [ ] `ufw status` — ไม่มี 3000 / 8101 เปิดออกนอก
- [ ] `git status --short` — **ไม่มี `.env`**
- [ ] ส่งสลิปจริงผ่าน LINE แล้วได้การ์ดตอบกลับ ← **ข้อนี้ต้องให้มนุษย์ลอง**

---

## 14. ⚠️ PDPA — ต้องแจ้งเจ้าของระบบ

ระบบเก็บ**ข้อมูลการเงินของบุคคลจริง** และสลิปหนึ่งใบมีข้อมูลของ**คนที่ไม่ได้มาใช้บอทด้วย** (ผู้รับโอน)

**ระบบทำให้แล้ว:** ขอความยินยอมก่อนเก็บ · ไม่เก็บรูปสลิป (เก็บแค่ sha256) ·
เลขบัญชีเก็บแค่ 4 ตัวท้าย · `ลบข้อมูลของฉัน` ลบจริงทุกตาราง

**เจ้าของระบบต้องทำเอง:** เข้ารหัสดิสก์ VPS · เก็บ backup ในที่ปลอดภัย ·
ไม่ log ข้อความ OCR ดิบลงไฟล์ถาวร
