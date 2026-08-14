// sheetSync.js — worker ที่ตามไปทำใบสั่งใน `sheet_outbox`
//
// วิ่งห่างจาก webhook คนละเส้นโดยสิ้นเชิง: ต่อให้ Google ล่ม ชีตถูกถอนสิทธิ์ หรือเน็ตหลุด
// การตอบผู้ใช้ในแชทก็ยังเร็วเท่าเดิม ใบสั่งค้างอยู่ในตารางแล้วค่อยตามไปทำทีหลัง
import { config } from "./config.js";
import * as L from "./ledger.js";
import * as S from "./sheets.js";

/**
 * ล้มเหลวกี่ครั้งถึงเลิกลอง
 *
 * ปัญหาที่เจอจริงเกือบทั้งหมดคือ "ยังไม่ได้แชร์ชีตให้ service account" ซึ่งลองใหม่
 * อีกกี่รอบก็ไม่หายจนกว่าผู้ใช้จะไปกดแชร์ — ลองรัวไปเรื่อย ๆ มีแต่เปลืองโควตา API
 * และทำให้ log เต็มไปด้วย error เดิม จึงหยุดแล้วเก็บสาเหตุไว้ให้ผู้ใช้เห็นในคำสั่ง "ชีต"
 */
const MAX_TRIES = 5;

/**
 * ล้มเหลวแบบ "เดี๋ยวก็หาย" — **ห้ามนับรวมกับความล้มเหลวถาวร**
 *
 * 429 = ยิงเกินโควตา (60 คำขอ/นาที ซึ่งนับรวมทุกคนเพราะใช้ service account ตัวเดียว)
 * 5xx = ฝั่ง Google เอง · ไม่มี status = เน็ตหลุด/timeout
 *
 * เดิมนับรวมกับ 403 (ไม่ได้แชร์สิทธิ์) ทำให้ชน 429 ติดกัน 5 รอบ = 100 วินาที
 * แล้วงานนั้นหยุดถาวร ต้องกดปุ่ม sync เองถึงจะกลับมา ทั้งที่ปัญหาหายไปเองตั้งนานแล้ว
 */
const isTemporary = (err) => !err.status || err.status === 429 || err.status >= 500;

/** ชนกำแพงชั่วคราวแล้วถอยห่างขึ้นเรื่อย ๆ: 1 → 2 → 4 → 8 รอบ (สูงสุด ~2.5 นาที) */
const MAX_BACKOFF_STEPS = 8;
const backoff = new Map();   // userId → { untilMs, step }

function noteTemporary(userId) {
  const cur = backoff.get(userId);
  const step = Math.min((cur?.step ?? 0) * 2 || 1, MAX_BACKOFF_STEPS);
  backoff.set(userId, { step, untilMs: Date.now() + step * config.sheetSyncMs });
  return step;
}

/** ยิงผ่านแล้ว หรือผู้ใช้กดปุ่มเอง → เลิกถอย */
const clearBackoff = (userId) => backoff.delete(userId);

const waiting = (userId) => (backoff.get(userId)?.untilMs ?? 0) > Date.now();

/** ทำใบสั่งของผู้ใช้คนเดียวให้หมด — ไม่โยน error ออก (worker ต้องไปทำคนอื่นต่อ) */
export async function syncUser(userId) {
  const jobs = L.sheetJobs(userId);
  if (!jobs.length) return { done: 0 };
  const ids = jobs.map((j) => j.id);

  try {
    // wipe = ผู้ใช้สั่ง "ลบข้อมูลของฉัน" → ใบสั่งอื่นทั้งหมดหมดความหมาย แถวต้นทางไม่มีแล้ว
    const wipe = jobs.find((j) => j.op === "wipe");
    if (wipe) {
      const p = JSON.parse(wipe.payload || "{}");
      const tab = p.tab || await S.firstTab(p.spreadsheetId);
      await S.clearData(p.spreadsheetId, tab);
      L.clearSheetJobs(ids);
      console.log(`[ชีต] ล้างข้อมูลบนชีตแล้ว (ผู้ใช้ลบข้อมูลทั้งหมด)`);
      return { done: ids.length, wiped: true };
    }

    const link = L.sheetLink(userId);
    // เลิกเชื่อมไปแล้วระหว่างที่ใบสั่งค้างอยู่ → ทิ้งทั้งหมด อย่าไปยุ่งกับชีตที่เขาตัดขาดแล้ว
    if (!link) { L.clearSheetJobs(ids); return { done: 0 }; }

    // ครั้งแรกยังไม่รู้ชื่อแท็บ — ใช้แท็บแรกของชีต จะได้ไม่ต้องขอสิทธิ์สร้างแท็บใหม่
    let tab = link.tab;
    if (!tab) {
      tab = await S.firstTab(link.spreadsheet_id);
      await S.writeHeader(link.spreadsheet_id, tab, L.SHEET_HEADERS);
      L.setSheetTab(userId, tab);
    }

    // อ่านคอลัมน์ A ครั้งเดียวต่อรอบ แล้วรู้หมดว่าแถวไหนมีอยู่แล้ว (ดูเหตุผลใน sheets.js)
    const index = await S.rowIndex(link.spreadsheet_id, tab);
    const updates = [], appends = [];

    for (const j of jobs) {
      const t = L.txnForSheet(userId, j.txn_id);
      if (!t) continue;                       // ถูกลบถาวรไปแล้ว ไม่มีอะไรให้เขียน
      const row = index.get(j.txn_id);
      // ลบรายการที่ไม่เคยขึ้นชีต = ไม่ต้องทำอะไร เติมแถว "ลบแล้ว" ลงไปมีแต่ทำให้รก
      if (!row && j.op === "delete") continue;
      const values = L.sheetValues(t);
      if (row) updates.push({ row, values }); else appends.push(values);
    }

    await S.writeRows(link.spreadsheet_id, tab, updates);
    await S.appendRows(link.spreadsheet_id, tab, appends);

    L.clearSheetJobs(ids);
    L.markSheetSync(userId, null);
    clearBackoff(userId);
    return { done: ids.length, updated: updates.length, added: appends.length };
  } catch (err) {
    L.markSheetSync(userId, err.message);
    if (isTemporary(err)) {
      // ใบสั่งค้างไว้เหมือนเดิม **ไม่นับ tries** — แค่เว้นระยะก่อนลองใหม่
      const step = noteTemporary(userId);
      console.warn(`[ชีตติดชั่วคราว] ${userId.slice(-8)}: ${err.message} — รออีก ${step} รอบ`);
      return { done: 0, error: err.message, temporary: true };
    }
    L.failSheetJobs(ids, err.message);
    console.warn(`[ชีตล้มเหลว] ${userId.slice(-8)}: ${err.message}`);
    return { done: 0, error: err.message };
  }
}

/**
 * ผู้ใช้กดปุ่ม "sync เดี๋ยวนี้" — ยิงทันทีไม่สนโหมดและไม่สนคิวถอย
 *
 * การกดปุ่มคือสัญญาณชัดว่าเขากำลังรอดูผลอยู่ตรงนั้น ให้รอ backoff ต่อไม่ได้
 */
export function syncNow(userId) {
  clearBackoff(userId);
  return syncUser(userId);
}

/** หนึ่งรอบ: ไล่ทำให้ทุกคนที่มีงานค้าง */
export async function tick() {
  const users = L.sheetPendingUsers();
  let total = 0;
  for (const u of users) {
    if (u.tries >= MAX_TRIES) continue;         // ล้มเหลวถาวร รอผู้ใช้ไปแก้สิทธิ์เอง
    if (waiting(u.line_user_id)) continue;      // เพิ่งชนโควตา — ยังไม่ถึงคิวลองใหม่
    const r = await syncUser(u.line_user_id);
    total += r.done ?? 0;
  }
  return total;
}

let timer = null;

/** เริ่ม worker — ไม่ตั้งคีย์ service account ก็ไม่ต้องวิ่งเลย */
export function start() {
  if (!config.sheetsEnabled || timer) return false;
  timer = setInterval(() => {
    tick().catch((err) => console.error(`[ชีต worker] ${err.stack || err.message}`));
  }, config.sheetSyncMs);
  // ห้ามกัน process ไม่ให้จบ — สำคัญตอนรันเทสและตอน docker หยุด container
  timer.unref?.();
  return true;
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** ใช้ในเทสเท่านั้น */
export function _reset() { backoff.clear(); }
