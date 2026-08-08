// weekly.mjs — ส่งสรุปรายสัปดาห์ให้ผู้ใช้ที่เปิดไว้
//
//   node scripts/weekly.mjs          # ส่งจริง
//   node scripts/weekly.mjs --dry    # ดูว่าจะส่งให้ใครบ้าง โดยไม่ส่งจริง
//
// ตั้ง cron ทุกเช้าวันจันทร์ (เวลาไทย = UTC+7 → 08:00 ไทย = 01:00 UTC):
//   0 1 * * 1  cd /path/to/SlipingMan-line-assistant && node scripts/weekly.mjs >> logs/weekly.log 2>&1
//
// **opt-in เท่านั้น** — ผู้ใช้ต้องพิมพ์ "เตือนรายสัปดาห์" เปิดเอง
// เพราะ push มีโควตา 300/เดือน: เปิดให้ทุกคนอัตโนมัติ = ผู้ใช้ 75 คนก็เต็มแล้ว
import "dotenv/config";
import { messagingApi } from "@line/bot-sdk";
import * as L from "../src/ledger.js";
import { summaryBubble } from "../src/flex.js";
import { weeklySummary, quota, thisWeek } from "../src/notify.js";
import { fromCents } from "../src/db.js";

const DRY = process.argv.includes("--dry");
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN && !DRY) { console.error("!! ไม่มี LINE_CHANNEL_ACCESS_TOKEN"); process.exit(1); }

const client = TOKEN ? new messagingApi.MessagingApiClient({ channelAccessToken: TOKEN }) : null;

const users = L.usersWithPref("weekly");
const [from, to] = thisWeek();
console.log(`สรุปสัปดาห์ ${from} → ${to} | ผู้ใช้ที่เปิดไว้ ${users.length} คน | โควตา ${JSON.stringify(quota())}`);

let sent = 0, skipped = 0;
for (const u of users) {
  const r = await weeklySummary(
    u,
    async (msg) => {
      if (DRY) { console.log(`  [dry] จะส่งให้ ${u.slice(0, 10)}…: ${msg.altText ?? msg.text}`); return; }
      await client.pushMessage({ to: u, messages: [msg] });
    },
    (s) => summaryBubble(s, fromCents),
  );
  if (r.sent) sent++; else { skipped++; console.log(`  ข้าม ${u.slice(0, 10)}… (${r.skipped})`); }
}
console.log(`เสร็จ: ส่ง ${sent} · ข้าม ${skipped}`);
