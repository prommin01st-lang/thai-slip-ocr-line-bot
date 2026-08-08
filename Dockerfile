# LINE bot (Node) — ไม่มี ML dependency ใด ๆ เลย
FROM node:22-alpine

# curl ไว้ทำ healthcheck (alpine ไม่มีมาให้)
RUN apk add --no-cache curl

WORKDIR /app

# ลง dependency ก่อน → แก้โค้ดแล้ว build ใหม่ไม่ต้อง npm ci ใหม่
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
# weekly.mjs รันผ่าน `docker compose exec bot` (cron) → ต้องอยู่ใน image
COPY scripts/weekly.mjs ./scripts/

# data/ เก็บ SQLite — ต้องเป็นของ user ที่รัน ไม่งั้นเขียนไม่ได้
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
# node:sqlite ยัง experimental — ปิด warning ไม่ให้รก log
ENV NODE_ENV=production \
    DB_PATH=/app/data/slipingman.db \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
