// notify.js — แจ้งเตือน: งบเกิน · รายการประจำที่ยังไม่จ่าย · สรุปรายสัปดาห์
//
// **ข้อจำกัดที่บีบดีไซน์ทั้งหมด: LINE ให้ push แค่ 300 ข้อความ/เดือน** (เช็คจาก API แล้ว)
// แจ้งเตือนรายวันให้ผู้ใช้ 10 คนก็เต็มโควตา → ที่นี่จึง
//   1. กันเตือนซ้ำเรื่องเดิมในรอบเดิม (`alert_log`)
//   2. หยุดส่งเมื่อใกล้เต็มโควตา แล้ว **บอกผู้ใช้ตรง ๆ ไม่ใช่เงียบหาย**
//   3. เตือนเฉพาะเรื่องที่คุ้มค่าโควตาจริง (งบเกิน / บิลที่ยังไม่จ่าย)
// ส่วนการ "ขอดูสรุป" ผู้ใช้พิมพ์เอาเองได้ = reply = ฟรี ไม่แตะโควตา
import * as L from "./ledger.js";
import { fromCents } from "./db.js";

// กันไม่ให้ใช้จนหมดเกลี้ยง — เหลือไว้ให้ reply-fallback ตอนคิวยาวด้วย
const PUSH_BUDGET = Number(process.env.PUSH_MONTHLY_BUDGET || 250);

export function quota() {
  const used = L.pushUsedThisMonth();
  return { used, budget: PUSH_BUDGET, left: Math.max(0, PUSH_BUDGET - used) };
}

export const canPush = () => quota().left > 0;

// ---------- ช่วงเวลา (ยึดเวลาไทยเสมอ ไม่ใช่ UTC ของเครื่อง) ----------

const todayTh = (tz = "Asia/Bangkok") => new Date().toLocaleDateString("en-CA", { timeZone: tz });

export function thisMonth() {
  const t = todayTh();
  return [`${t.slice(0, 7)}-01`, t];
}

/** [จันทร์, วันนี้] ของสัปดาห์นี้ */
export function thisWeek() {
  const t = todayTh();
  const d = new Date(`${t}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;                 // จันทร์ = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return [d.toISOString().slice(0, 10), t];
}

/** '2026-W32' — ใช้เป็น period ของ alert_log กันส่งซ้ำในสัปดาห์เดียวกัน */
export function weekKey() {
  const [mon] = thisWeek();
  const d = new Date(`${mon}T00:00:00Z`);
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const w = Math.floor((d - jan1) / 604800000) + 1;
  return `${d.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}

// ---------- ตัวแจ้งเตือน ----------

function budgetMessages(userId, from, to) {
  const out = [];
  for (const b of L.budgetStatus(userId, from, to)) {
    const kind = `budget:${b.category}:${b.over ? "over" : "near"}`;
    if (!L.claimAlert(userId, kind, from.slice(0, 7))) continue;   // เตือนไปแล้วเดือนนี้
    const name = b.category === "*" ? "งบรวมเดือนนี้" : `งบหมวด “${b.category}”`;
    out.push({
      type: "text",
      text: b.over
        ? `🚨 ${name} เกินแล้ว\nใช้ไป ${fromCents(b.used_cents)} / ${fromCents(b.limit_cents)} บาท ` +
          `(${Math.round(b.ratio * 100)}%)`
        : `⚠️ ${name} ใกล้เต็ม\nใช้ไป ${fromCents(b.used_cents)} / ${fromCents(b.limit_cents)} บาท ` +
          `(${Math.round(b.ratio * 100)}%)`,
    });
  }
  return out;
}

function recurringMessages(userId, monthStart) {
  const due = L.recurringDue(userId, monthStart);
  if (!due.length) return [];
  if (!L.claimAlert(userId, "recurring", monthStart.slice(0, 7))) return [];
  const lines = due.map((r) =>
    `• ${r.counterparty} ~${fromCents(Math.round(r.avg_cents))} ฿ (จ่ายมาแล้ว ${r.times} ครั้ง)`);
  return [{
    type: "text",
    text: `🔔 รายการที่จ่ายประจำ แต่เดือนนี้ยังไม่เห็น:\n${lines.join("\n")}`,
  }];
}

/**
 * ตรวจและส่งแจ้งเตือนที่ค้างอยู่
 * `push(message)` = ฟังก์ชันส่งจริง (แยกออกมาเพื่อเทสได้โดยไม่ยิง LINE)
 */
export async function checkAlerts(userId, push) {
  if (!L.hasConsent(userId)) return { sent: 0, skipped: "no_consent" };
  const [from, to] = thisMonth();

  const msgs = [...budgetMessages(userId, from, to), ...recurringMessages(userId, from)];
  if (!msgs.length) return { sent: 0 };

  let sent = 0;
  for (const m of msgs) {
    if (!canPush()) {
      // โควตาใกล้หมด — บอกให้รู้ครั้งเดียว ดีกว่าเงียบแล้วผู้ใช้ไม่รู้ว่าพลาดอะไรไป
      if (L.claimAlert(userId, "quota_exhausted", from.slice(0, 7))) {
        console.warn(`[push] โควตาเดือนนี้ใกล้หมด (${JSON.stringify(quota())}) — หยุดแจ้งเตือน`);
      }
      return { sent, skipped: "quota" };
    }
    await push(m);
    L.logPush(userId, "alert");
    sent++;
  }
  return { sent };
}

/** สรุปรายสัปดาห์ — เรียกจากตัวตั้งเวลา (ดู scripts/weekly.js) */
export async function weeklySummary(userId, push, buildMessage) {
  if (!L.hasConsent(userId)) return { sent: 0, skipped: "no_consent" };
  if (!L.claimAlert(userId, "weekly", weekKey())) return { sent: 0, skipped: "already_sent" };
  if (!canPush()) return { sent: 0, skipped: "quota" };
  const [from, to] = thisWeek();
  await push(buildMessage(L.summary(userId, from, to)));
  L.logPush(userId, "weekly");
  return { sent: 1, from, to };
}
