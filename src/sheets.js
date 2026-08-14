// sheets.js — คุย Google Sheets API v4 ด้วย fetch + node:crypto ล้วน
//
// **ทำไมไม่ใช้ `googleapis`** — แพ็กเกจนั้นลากมาหลายสิบ MB และ dependency หลายสิบตัว
// เทียบกับทั้งโปรเจกต์ฝั่งบอทที่มี dependency แค่ 3 ตัว งานที่เราต้องใช้จริงมีแค่
// "เซ็น JWT แล้วแลกเป็น access token" (~25 บรรทัด) กับ "ยิง REST 4 เส้น" ซึ่ง fetch
// ที่มากับ Node ทำได้หมด ผลคือฟีเจอร์นี้เพิ่ม dependency **ศูนย์ตัว**
//
// ยืนยันตัวตนแบบ Service Account: ผู้ใช้แชร์ชีตของตัวเองให้อีเมล service account
// ชีตยังเป็นของผู้ใช้ 100% เราแค่ถูกเชิญเข้าไปแก้ ถอนสิทธิ์เมื่อไหร่ก็ได้จากฝั่งเขาเอง
import { createSign } from "node:crypto";
import { config } from "./config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** `permanent` = ลองใหม่กี่ครั้งก็ไม่หาย (สิทธิ์ผิด/ชีตหาย) → ต้องบอกผู้ใช้ ไม่ใช่วน retry */
export class SheetError extends Error {
  constructor(message, { status = 0, permanent = false } = {}) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

// ---------- ยืนยันตัวตน ----------

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** JWT ที่เซ็นด้วย private key ของ service account (RS256 ตามที่ Google บังคับ) */
function signedJwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: config.googleSaEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(config.googleSaKey, "base64url")}`;
}

// token อายุ 1 ชม. — ขอใหม่ทุกครั้งคือเสียเวลา round-trip เปล่า ๆ ทุกการ sync
let cached = { token: null, expMs: 0 };

async function accessToken() {
  if (cached.token && cached.expMs > Date.now() + 60_000) return cached.token;
  if (!config.sheetsEnabled) throw new SheetError("ยังไม่ได้ตั้งค่า Google Service Account", { permanent: true });

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signedJwt(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SheetError(`ต่อ Google ไม่ได้: ${err.message}`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant ตอนใช้ JWT มักแปลว่าคีย์ผิด/นาฬิกาเครื่องเพี้ยน — ลองใหม่ก็ไม่หาย
    throw new SheetError(
      `ขอ token ไม่ผ่าน (${res.status}): ${data.error_description || data.error || "ไม่ทราบสาเหตุ"}`,
      { status: res.status, permanent: res.status === 400 || res.status === 401 });
  }
  cached = { token: data.access_token, expMs: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

/** ใช้ในเทส — ยัด token ปลอมเข้าไปจะได้ไม่ต้องมีคีย์จริง */
export function _setToken(token, ttlMs = 3600_000) {
  cached = { token, expMs: Date.now() + ttlMs };
}

// ---------- ตัวช่วย ----------

/**
 * ลิงก์ชีต → spreadsheetId
 *
 * รับได้ทั้งลิงก์เต็มที่ผู้ใช้ก๊อปจากแถบที่อยู่ และ ID เปล่า ๆ — คนส่วนใหญ่ก๊อปทั้งลิงก์
 * แล้วมันมี `/edit#gid=0` ต่อท้าย ซึ่งต้องตัดทิ้ง ไม่งั้น API ตอบ 404 แบบไม่บอกสาเหตุ
 */
export function parseSheetId(text) {
  const s = String(text ?? "").trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

/** ชื่อแท็บ → ช่วง A1 ที่ปลอดภัย (ชื่อไทย/มีช่องว่าง/มี ' ต้องครอบด้วยอัญประกาศเดี่ยว) */
const rangeOf = (tab, a1) => `'${String(tab).replace(/'/g, "''")}'!${a1}`;

async function api(method, path, body = null) {
  const token = await accessToken();
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new SheetError(`ต่อ Google Sheets ไม่ได้: ${err.message}`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    // 403 = ยังไม่ได้แชร์ชีตให้ service account · 404 = ID ผิดหรือชีตถูกลบ
    // ทั้งคู่ต้องให้ผู้ใช้ไปแก้เอง วน retry มีแต่จะเปลืองโควตา API
    throw new SheetError(msg, { status: res.status, permanent: res.status === 403 || res.status === 404 });
  }
  return data;
}

// ---------- สิ่งที่ sheetSync ใช้ ----------

/** ชื่อแท็บแรกของชีต — ใช้แท็บที่มีอยู่แล้ว จะได้ไม่ต้องขอสิทธิ์สร้างแท็บใหม่ */
export async function firstTab(spreadsheetId) {
  const d = await api("GET", `/${spreadsheetId}?fields=sheets.properties.title`);
  const title = d.sheets?.[0]?.properties?.title;
  if (!title) throw new SheetError("ชีตนี้ไม่มีแท็บเลย", { permanent: true });
  return title;
}

/**
 * คอลัมน์ A ทั้งคอลัมน์ → Map(รหัสรายการ → เลขแถว)
 *
 * อ่านใหม่ทุกรอบ sync **โดยตั้งใจ** — ถ้าจำเลขแถวไว้ฝั่งเรา แล้วผู้ใช้แทรกหรือลบแถว
 * ในชีตเอง (ซึ่งเป็นชีตของเขา เขาทำได้) เลขที่จำไว้จะเลื่อนทั้งหมดแล้วเราจะเขียนทับ
 * ข้อมูลผิดแถวแบบเงียบ ๆ ต้นทุนคือ 1 request ต่อรอบ ซึ่งถูกกว่าความเสียหายนั้นมาก
 */
export async function rowIndex(spreadsheetId, tab) {
  const d = await api("GET", `/${spreadsheetId}/values/${encodeURIComponent(rangeOf(tab, "A:A"))}`);
  const map = new Map();
  (d.values ?? []).forEach((r, i) => {
    const id = Number(r[0]);
    if (Number.isInteger(id) && id > 0) map.set(id, i + 1);   // A1 = แถว 1
  });
  return map;
}

/** เขียนทับหลายแถวในคำขอเดียว — `updates` = [{ row, values }] */
export function writeRows(spreadsheetId, tab, updates) {
  if (!updates.length) return Promise.resolve();
  return api("POST", `/${spreadsheetId}/values:batchUpdate`, {
    // USER_ENTERED = ให้ Sheets ตีความชนิดเอง ตัวเลขจึงเป็นตัวเลขจริง (บวกลบได้)
    // ไม่ใช่ข้อความ — สำคัญ เพราะจุดขายของการต่อชีตคือผู้ใช้เอาไปทำสูตร/กราฟต่อ
    valueInputOption: "USER_ENTERED",
    data: updates.map((u) => ({ range: rangeOf(tab, `A${u.row}`), values: [u.values] })),
  });
}

/** ต่อท้ายแถวใหม่ — Sheets หาแถวว่างถัดไปให้เอง */
export function appendRows(spreadsheetId, tab, rows) {
  if (!rows.length) return Promise.resolve();
  return api(
    "POST",
    `/${spreadsheetId}/values/${encodeURIComponent(rangeOf(tab, "A:A"))}:append` +
      "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
    { values: rows });
}

/** ล้างข้อมูลทั้งหมดแต่เก็บหัวตารางไว้ (ใช้ตอน "ลบข้อมูลของฉัน") */
export function clearData(spreadsheetId, tab) {
  return api("POST", `/${spreadsheetId}/values/${encodeURIComponent(rangeOf(tab, "A2:Z"))}:clear`, {});
}

/** เขียนหัวตารางทับแถวแรก — เรียกตอนเชื่อมครั้งแรก และเป็นตัวทดสอบสิทธิ์เขียนไปในตัว */
export function writeHeader(spreadsheetId, tab, headers) {
  return api("POST", `/${spreadsheetId}/values:batchUpdate`, {
    valueInputOption: "RAW",
    data: [{ range: rangeOf(tab, "A1"), values: [headers] }],
  });
}
