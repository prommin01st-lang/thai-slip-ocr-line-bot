// richmenu.mjs — สร้าง/ลบ rich menu (เมนูล่างของแชท)
//
//   node scripts/richmenu.mjs check    # ตรวจรูปอย่างเดียว ไม่แตะ LINE (ไม่ต้องมี token)
//   node scripts/richmenu.mjs create   # สร้าง + อัปโหลดรูป + ตั้งเป็นเมนู default
//        เติม --tabs / --flat เพื่อบังคับโหมด (ปกติเดาจากไฟล์รูปที่มี)
//   node scripts/richmenu.mjs list     # ดูเมนู + alias ที่มี
//   node scripts/richmenu.mjs clear    # ลบทั้งหมด
//
// **มีสองโหมด เลือกให้เองจากไฟล์รูปที่วางไว้**
//
//   โหมดแท็บ (2 หน้า)  ต้องมีครบทั้ง richmenu-tab1-* และ richmenu-tab2-*
//   โหมดหน้าเดียว      ใช้ richmenu-custom.* หรือ richmenu.png ที่ python วาดให้
//
// ต้องมีรูปครบ *ทั้งคู่* ถึงจะเข้าโหมดแท็บ เพราะเลย์เอาต์ของ **หน้าแรก** ก็ต่างกันด้วย
// (โหมดแท็บกันแถบบนสุด 230px ไว้ทำแท็บ ช่องเลยเตี้ยลงจาก 843 เหลือ 728)
// ถ้าเผลอเข้าโหมดแท็บทั้งที่หน้าแรกยังเป็นรูปเก่า พิกัดปุ่มจะเลื่อนหมดทั้งหน้า
//
// ปุ่ม "ถ่ายสลิป"/"เลือกรูป" ใช้ action `camera` / `cameraRoll` ของ LINE
// เปิดกล้อง/คลังรูปให้เลย — เร็วกว่าให้ผู้ใช้ไปหาปุ่มแนบไฟล์เอง
import "dotenv/config";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messagingApi } from "@line/bot-sdk";

const cmd = process.argv[2] || "list";

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
// `check` ไม่แตะ LINE เลย — คนออกแบบรูปจะได้ตรวจไฟล์ตัวเองได้โดยไม่ต้องมี token
if (!TOKEN && cmd !== "check") {
  console.error("!! ไม่มี LINE_CHANNEL_ACCESS_TOKEN ใน .env"); process.exit(1);
}

const client = new messagingApi.MessagingApiClient({ channelAccessToken: TOKEN });
const blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: TOKEN });

// ---------- พิกัด ----------

const W = 2500, H = 1686;                    // ขนาดที่ LINE รองรับ
const MAX_BYTES = 1024 * 1024;               // LINE รับรูป rich menu ไม่เกิน 1 MB
const CW = Math.floor(W / 3);                // 833 — กว้างช่อง เท่ากันทั้งสองโหมด
const CH_FLAT = Math.floor(H / 2);           // 843 — สูงช่อง โหมดหน้าเดียว
const TAB_H = 230, TAB_W = Math.floor(W / 2);// แถบแท็บ 2 ช่อง กว้างครึ่งหน้า
const CH_TAB = Math.floor((H - TAB_H) / 2);  // 728 — สูงช่อง โหมดแท็บ

const cell = (i, top, ch) => ({
  x: (i % 3) * CW, y: top + Math.floor(i / 3) * ch, width: CW, height: ch,
});

// ---------- ปุ่ม ----------

const msg = (label, text) => ({ type: "message", label, text: text ?? label });
/** สลับหน้าที่เครื่องผู้ใช้เลย ไม่วิ่งผ่านเซิร์ฟเวอร์เรา — ไม่กินโควตา push และไม่มีดีเลย์ */
const sw = (richMenuAliasId, label, data) => ({ type: "richmenuswitch", richMenuAliasId, label, data });

const ALIAS = { main: "sm-main", more: "sm-more" };   // ต้องตรง /^[a-z0-9_-]{1,32}$/

const MAIN_CELLS = [
  { type: "camera", label: "ถ่ายสลิป" },
  { type: "cameraRoll", label: "เลือกรูป" },
  msg("สรุป"),
  msg("รายการ"),
  msg("งบ"),
  msg("ช่วยเหลือ"),
];

// ทุกคำสั่งในหน้านี้ handlers.js รับอยู่แล้ว ไม่ต้องเพิ่มอะไรฝั่งบอท
// "ลบข้อมูล" ปลอดภัยเพราะปลายทางเป็นการ์ดยืนยันก่อน ไม่ได้ลบทันที
const MORE_CELLS = [
  msg("สรุปสัปดาห์"),
  msg("สรุปทั้งหมด"),
  msg("รายจ่าย", "รายการรายจ่าย"),
  msg("ตั้งค่า"),
  msg("ข้อมูลของฉัน"),
  msg("ลบข้อมูล", "ลบข้อมูลของฉัน"),
];

// แท็บทั้งสองอันสลับไปหา alias ของตัวเองเสมอ ไม่สนว่าตอนนี้อยู่หน้าไหน
// กดแท็บที่เปิดอยู่ = สลับมาที่เดิม ไม่มีผลอะไร ดีกว่าเว้นเป็นพื้นที่ตายที่กดแล้วเงียบ
const TAB_AREAS = [
  { bounds: { x: 0, y: 0, width: TAB_W, height: TAB_H }, action: sw(ALIAS.main, "หลัก", "tab=main") },
  { bounds: { x: TAB_W, y: 0, width: TAB_W, height: TAB_H }, action: sw(ALIAS.more, "เพิ่มเติม", "tab=more") },
];

const menuOf = (name, cells, tabbed) => ({
  size: { width: W, height: H },
  selected: true,
  name,
  chatBarText: "เมนู",
  areas: tabbed
    ? [...TAB_AREAS, ...cells.map((a, i) => ({ bounds: cell(i, TAB_H, CH_TAB), action: a }))]
    : cells.map((a, i) => ({ bounds: cell(i, 0, CH_FLAT), action: a })),
});

// ---------- รูป ----------

const asset = (f) => fileURLToPath(new URL(`../assets/${f}`, import.meta.url));
// ที่ออกแบบเองมาก่อน แล้วค่อยตกมาที่ของที่ richmenu_image.py วาดไว้เป็นตัวสำรอง
// ต้องผ่าน fileURLToPath — .pathname ยังเป็น URL-encoded ("Model%20Trainer") หา path ไม่เจอ
const pick = (...names) => names.map(asset).find(existsSync) ?? null;

const TAB1 = pick("richmenu-tab1-custom.png", "richmenu-tab1-custom.jpg", "richmenu-tab1.png");
const TAB2 = pick("richmenu-tab2-custom.png", "richmenu-tab2-custom.jpg", "richmenu-tab2.png");
const FLAT = pick("richmenu-custom.png", "richmenu-custom.jpg", "richmenu.png");

// เดาโหมดจากไฟล์ที่มี แต่บังคับได้ด้วย --tabs / --flat
// ต้องบังคับได้ เพราะพอ python วาดรูปแท็บสำรองไว้ โหมดแท็บจะติดทันที
// แล้วไปบังรูปสวย ๆ ที่ออกแบบไว้สำหรับหน้าเดียวโดยที่ไม่มีใครสั่ง
const forced = process.argv.includes("--tabs") ? "tabs"
             : process.argv.includes("--flat") ? "flat" : null;
if (forced === "tabs" && !(TAB1 && TAB2)) {
  console.error(`!! สั่ง --tabs แต่รูปไม่ครบ (${TAB1 ? "ขาด tab2" : "ขาด tab1"})`);
  process.exit(1);
}
const TABBED = forced ? forced === "tabs" : !!(TAB1 && TAB2);
const isCustom = (p) => !!p && p.includes("-custom.");

const PAGES = TABBED
  ? [{ alias: ALIAS.main, image: TAB1, menu: menuOf("SlipingMan หลัก", MAIN_CELLS, true) },
     { alias: ALIAS.more, image: TAB2, menu: menuOf("SlipingMan เพิ่มเติม", MORE_CELLS, true) }]
  : [{ alias: null, image: FLAT, menu: menuOf("SlipingMan main", MAIN_CELLS, false) }];

/** ขนาดรูปจาก header — ตรวจก่อนอัปโหลด ไม่งั้น LINE ตอบ error ที่อ่านไม่รู้เรื่อง */
function dimsOf(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47)      // PNG → IHDR
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0xff && buf[1] === 0xd8) {                       // JPEG → เดินหา marker SOFn
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/**
 * ตรวจรูปก่อนยิงขึ้น LINE — ขนาดผิดแปลว่าพิกัดปุ่มเลื่อนไปทับช่องอื่น
 * ซึ่งจะกลายเป็น "กดสรุปแล้วเปิดกล้อง" หาสาเหตุยากกว่าให้มันฟ้องตรงนี้เยอะ
 */
function checkImage(path) {
  if (!path) {
    console.error("!! ไม่พบรูปเมนูเลย\n   สร้างก่อนด้วย: python3 scripts/richmenu_image.py");
    process.exit(1);
  }
  const bytes = readFileSync(path);
  const name = path.split("/assets/")[1];
  const kb = statSync(path).size / 1024;

  if (bytes.length > MAX_BYTES) {
    console.error(`!! ${name} ใหญ่เกิน — ${(kb / 1024).toFixed(2)} MB (LINE รับไม่เกิน 1 MB)`);
    process.exit(1);
  }
  const dims = dimsOf(bytes);
  if (!dims) {
    console.error(`!! ${name} อ่านขนาดไม่ได้ — ต้องเป็น PNG หรือ JPEG เท่านั้น`);
    process.exit(1);
  }
  if (dims[0] !== W || dims[1] !== H) {
    console.error(`!! ${name} ขนาดไม่ตรง — ได้ ${dims[0]}x${dims[1]} ต้องเป็น ${W}x${H}`);
    console.error("   พิกัดปุ่มถูกคำนวณจากขนาดนี้ — สเปกเต็ม: assets/RICHMENU-SPEC.md");
    process.exit(1);
  }
  console.log(`  ${name}  (${kb.toFixed(0)} KB, ${dims[0]}x${dims[1]}) ✓`);
  return bytes;
}

/** ลบ alias ก่อนเสมอ แล้วค่อยลบเมนู — ไม่งั้นเหลือ alias ค้างชี้ไปเมนูที่ไม่มีแล้ว
 *  และสร้าง alias ชื่อเดิมซ้ำไม่ได้ (ชนกัน) */
async function wipe() {
  const { aliases } = await client.getRichMenuAliasList().catch(() => ({ aliases: [] }));
  for (const a of aliases ?? []) await client.deleteRichMenuAlias(a.richMenuAliasId);
  const { richmenus } = await client.getRichMenuList();
  for (const m of richmenus) await client.deleteRichMenu(m.richMenuId);
  return { aliases: (aliases ?? []).length, menus: richmenus.length };
}

/** เตือนตอนกำลังจะใช้รูปสำรองที่สคริปต์วาด ทั้งที่มีรูปที่ออกแบบเองรออยู่อีกโหมด */
function announceMode() {
  console.log(`โหมด: ${TABBED ? "แท็บ 2 หน้า" : "หน้าเดียว"}${forced ? ` (บังคับด้วย --${forced})` : ""}`);
  if (!forced && !TABBED && (TAB1 || TAB2)) {
    console.log(`  (เจอรูปแท็บแค่หน้าเดียว — ${TAB1 ? "ขาด tab2" : "ขาด tab1"} จึงยังไม่เข้าโหมดแท็บ)`);
  }
  if (!forced && TABBED && !PAGES.every((p) => isCustom(p.image)) && isCustom(FLAT)) {
    console.log("  !! กำลังใช้รูปสำรองที่สคริปต์วาด ทั้งที่มีรูปที่ออกแบบเองรออยู่");
    console.log(`     (${FLAT.split("/assets/")[1]}) — ใช้รูปนั้นแทนด้วย: create --flat`);
  }
}

// ---------- คำสั่ง ----------

if (cmd === "check") {
  announceMode();
  for (const p of PAGES) {
    checkImage(p.image);
    for (const a of p.menu.areas) {
      const { x, y, width, height } = a.bounds;
      const act = a.action.type === "richmenuswitch"
        ? `สลับไป ${a.action.richMenuAliasId}`
        : (a.action.text ?? a.action.type);
      console.log(`     x=${String(x).padStart(4)} y=${String(y).padStart(4)} ${width}x${height}  → ${a.action.label} (${act})`);
    }
  }

} else if (cmd === "list") {
  const { richmenus } = await client.getRichMenuList();
  if (!richmenus.length) console.log("ยังไม่มี rich menu");
  for (const m of richmenus) console.log(`  ${m.richMenuId}  ${m.name}  (${m.areas.length} ปุ่ม)`);
  const { aliases } = await client.getRichMenuAliasList().catch(() => ({ aliases: [] }));
  for (const a of aliases ?? []) console.log(`  alias ${a.richMenuAliasId} → ${a.richMenuId}`);
  const def = await client.getDefaultRichMenuId().catch(() => null);
  console.log(`default: ${def?.richMenuId ?? "(ไม่ได้ตั้ง)"}`);

} else if (cmd === "clear") {
  const n = await wipe();
  console.log(`ลบแล้ว: เมนู ${n.menus} · alias ${n.aliases}`);

} else if (cmd === "create") {
  announceMode();
  for (const p of PAGES) p.bytes = checkImage(p.image);   // ตรวจให้ครบก่อนค่อยแตะ LINE

  const n = await wipe();
  if (n.menus || n.aliases) console.log(`ลบของเก่า: เมนู ${n.menus} · alias ${n.aliases}`);

  for (const p of PAGES) {
    const { richMenuId } = await client.createRichMenu(p.menu);
    p.id = richMenuId;
    const mime = p.image.endsWith(".jpg") ? "image/jpeg" : "image/png";
    await blob.setRichMenuImage(richMenuId, new Blob([p.bytes], { type: mime }));
    console.log(`สร้าง ${p.menu.name} → ${richMenuId}`);
  }

  // alias สร้างทีหลังได้ และ *ต้อง* ทีหลัง — สองหน้าอ้าง alias ของกันและกัน
  // ถ้า LINE ตรวจว่า alias ต้องมีอยู่ก่อน ก็จะไม่มีทางสร้างหน้าแรกได้เลย
  for (const p of PAGES) {
    if (!p.alias) continue;
    await client.createRichMenuAlias({ richMenuAliasId: p.alias, richMenuId: p.id });
    console.log(`alias ${p.alias} → ${p.id}`);
  }

  await client.setDefaultRichMenu(PAGES[0].id);
  console.log(`✅ ตั้งเป็นเมนูหลักแล้ว: ${PAGES[0].id}`);
  console.log("   (ผู้ใช้อาจต้องปิด-เปิดห้องแชทใหม่ถึงจะเห็น)");

} else {
  console.error("ใช้: node scripts/richmenu.mjs [check|create|list|clear]");
  process.exit(1);
}
