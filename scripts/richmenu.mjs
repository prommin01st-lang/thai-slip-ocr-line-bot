// richmenu.mjs — สร้าง/ลบ rich menu (เมนูล่างของแชท)
//
//   node scripts/richmenu.mjs create   # สร้าง + อัปโหลดรูป + ตั้งเป็นเมนู default
//   node scripts/richmenu.mjs list     # ดูเมนูที่มี
//   node scripts/richmenu.mjs clear    # ลบทั้งหมด
//
// ต้องมีรูปก่อน — สร้างด้วย `python3 scripts/richmenu_image.py` (ใช้ venv ไหนก็ได้ที่มี pillow)
// หรือวางรูปที่ออกแบบเองไว้ที่ assets/richmenu-custom.png (ดูสเปกใน assets/RICHMENU-SPEC.md)
//
// ปุ่ม "ถ่ายสลิป"/"เลือกรูป" ใช้ action `camera` / `cameraRoll` ของ LINE
// เปิดกล้อง/คลังรูปให้เลย — เร็วกว่าให้ผู้ใช้ไปหาปุ่มแนบไฟล์เอง
import "dotenv/config";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messagingApi } from "@line/bot-sdk";

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) { console.error("!! ไม่มี LINE_CHANNEL_ACCESS_TOKEN ใน .env"); process.exit(1); }

const client = new messagingApi.MessagingApiClient({ channelAccessToken: TOKEN });
const blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: TOKEN });

const W = 2500, H = 1686;           // ขนาดที่ LINE รองรับ (2 แถว × 3 ช่อง)
const CW = Math.floor(W / 3), CH = Math.floor(H / 2);
const MAX_BYTES = 1024 * 1024;      // LINE รับรูป rich menu ไม่เกิน 1 MB

// เลือกรูปตามลำดับ: ที่ออกแบบเองก่อน → ของเดิมที่ richmenu_image.py วาดไว้เป็นตัวสำรอง
// แยกไฟล์กันแบบนี้เพื่อให้ลองดีไซน์ใหม่ได้โดยไม่ทับของเดิม และถอยกลับด้วยการลบไฟล์ทิ้งเฉย ๆ
// ต้องผ่าน fileURLToPath — .pathname ยังเป็น URL-encoded ("Model%20Trainer") หา path ไม่เจอ
const CANDIDATES = ["richmenu-custom.png", "richmenu-custom.jpg", "richmenu.png"]
  .map((f) => fileURLToPath(new URL(`../assets/${f}`, import.meta.url)));
const IMAGE = CANDIDATES.find(existsSync) ?? CANDIDATES.at(-1);

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

const cell = (col, row) => ({ x: col * CW, y: row * CH, width: CW, height: CH });

const MENU = {
  size: { width: W, height: H },
  selected: true,
  name: "SlipingMan main",
  chatBarText: "เมนู",
  areas: [
    { bounds: cell(0, 0), action: { type: "camera", label: "ถ่ายสลิป" } },
    { bounds: cell(1, 0), action: { type: "cameraRoll", label: "เลือกรูป" } },
    { bounds: cell(2, 0), action: { type: "message", label: "สรุป", text: "สรุป" } },
    { bounds: cell(0, 1), action: { type: "message", label: "รายการ", text: "รายการ" } },
    { bounds: cell(1, 1), action: { type: "message", label: "งบ", text: "งบ" } },
    { bounds: cell(2, 1), action: { type: "message", label: "ช่วยเหลือ", text: "ช่วยเหลือ" } },
  ],
};

const cmd = process.argv[2] || "list";

if (cmd === "list") {
  const { richmenus } = await client.getRichMenuList();
  if (!richmenus.length) console.log("ยังไม่มี rich menu");
  for (const m of richmenus) console.log(`  ${m.richMenuId}  ${m.name}  (${m.areas.length} ปุ่ม)`);
  const def = await client.getDefaultRichMenuId().catch(() => null);
  console.log(`default: ${def?.richMenuId ?? "(ไม่ได้ตั้ง)"}`);

} else if (cmd === "clear") {
  const { richmenus } = await client.getRichMenuList();
  for (const m of richmenus) {
    await client.deleteRichMenu(m.richMenuId);
    console.log(`ลบ ${m.richMenuId}`);
  }
  console.log("ลบครบแล้ว");

} else if (cmd === "create") {
  if (!existsSync(IMAGE)) {
    console.error(`!! ไม่พบรูป ${IMAGE}\n   สร้างก่อนด้วย: python3 scripts/richmenu_image.py`);
    process.exit(1);
  }
  const bytes = readFileSync(IMAGE);
  console.log(`รูป: ${IMAGE.split("/assets/")[1]}  (${(statSync(IMAGE).size / 1024).toFixed(0)} KB)`);

  // ตรวจรูปก่อนยิงขึ้น LINE — ขนาดผิดแปลว่าพิกัดปุ่มด้านล่างเลื่อนไปทับช่องอื่น
  // ซึ่งจะกลายเป็น "กดสรุปแล้วเปิดกล้อง" หาสาเหตุยากกว่าให้มันฟ้องตรงนี้เยอะ
  if (bytes.length > MAX_BYTES) {
    console.error(`!! รูปใหญ่เกิน — ${(bytes.length / 1024 / 1024).toFixed(2)} MB (LINE รับไม่เกิน 1 MB)`);
    process.exit(1);
  }
  const dims = dimsOf(bytes);
  if (!dims) {
    console.error("!! อ่านขนาดรูปไม่ได้ — ต้องเป็น PNG หรือ JPEG เท่านั้น");
    process.exit(1);
  }
  if (dims[0] !== W || dims[1] !== H) {
    console.error(`!! ขนาดรูปไม่ตรง — ได้ ${dims[0]}x${dims[1]} ต้องเป็น ${W}x${H}`);
    console.error(`   พิกัดปุ่มถูกคำนวณจากตาราง 3x2 ของขนาดนี้ (ช่องละ ${CW}x${CH})`);
    console.error("   สเปกเต็ม: assets/RICHMENU-SPEC.md");
    process.exit(1);
  }

  // ลบของเก่าก่อน ไม่งั้นเมนูค้างสะสมจนชน limit
  const { richmenus } = await client.getRichMenuList();
  for (const m of richmenus) await client.deleteRichMenu(m.richMenuId);

  const { richMenuId } = await client.createRichMenu(MENU);
  const mime = IMAGE.endsWith(".jpg") ? "image/jpeg" : "image/png";
  await blob.setRichMenuImage(richMenuId, new Blob([bytes], { type: mime }));
  await client.setDefaultRichMenu(richMenuId);
  console.log(`✅ สร้างและตั้งเป็นเมนูหลักแล้ว: ${richMenuId}`);
  console.log("   (ผู้ใช้อาจต้องปิด-เปิดห้องแชทใหม่ถึงจะเห็น)");

} else {
  console.error("ใช้: node scripts/richmenu.mjs [create|list|clear]");
  process.exit(1);
}
