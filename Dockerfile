# LINE bot (Node) — ไม่มี ML dependency ใด ๆ เลย
FROM node:22-alpine

# curl ไว้ทำ healthcheck (alpine ไม่มีมาให้)
RUN apk add --no-cache curl

WORKDIR /app

# ลง dependency ก่อน → แก้โค้ดแล้ว build ใหม่ไม่ต้อง npm ci ใหม่
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
# สคริปต์ที่รันผ่าน `docker compose exec bot` → ต้องอยู่ใน image
#   weekly.mjs  สรุปรายสัปดาห์ (cron)
#   backup.mjs  สำรอง DB ด้วย VACUUM INTO (คัดลอกไฟล์ .db เฉย ๆ ไม่ได้ เพราะเปิด WAL)
# ที่เหลือใน scripts/ ตั้งใจไม่เอาเข้า — รันจากเครื่อง dev ครั้งเดียวพอ (rich menu ฯลฯ)
COPY scripts/weekly.mjs scripts/backup.mjs scripts/check-env.mjs scripts/jobs.mjs ./scripts/

# มาสคอตต้องอยู่ใน image — LINE ไปดึงรูปจาก URL เองตอนแสดงการ์ด
# (ที่เหลือใน assets/ ถูก .dockerignore กันไว้ ดูเหตุผลในไฟล์นั้น)
COPY assets/Mascot/ ./assets/Mascot/
COPY assets/fonts/ ./assets/fonts/

# data/ เก็บ SQLite — ต้องเป็นของ user ที่รัน ไม่งั้นเขียนไม่ได้
RUN mkdir -p /app/data && chmod 700 /app/data && chown -R node:node /app
USER node

EXPOSE 3000
# node:sqlite ยัง experimental — ปิด warning ไม่ให้รก log
ENV NODE_ENV=production \
    DB_PATH=/app/data/slipingman.db \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
