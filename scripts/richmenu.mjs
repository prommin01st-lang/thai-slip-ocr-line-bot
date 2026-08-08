// richmenu.mjs — สร้าง/ลบ rich menu (เมนูล่างของแชท)
//
//   node scripts/richmenu.mjs create   # สร้าง + อัปโหลดรูป + ตั้งเป็นเมนู default
//   node scripts/richmenu.mjs list     # ดูเมนูที่มี
//   node scripts/richmenu.mjs clear    # ลบทั้งหมด
//
// ต้องมีรูปก่อน — สร้างด้วย `python3 scripts/richmenu_image.py` (ใช้ venv ไหนก็ได้ที่มี pillow)
//
// ปุ่ม "ถ่ายสลิป"/"เลือกรูป" ใช้ action `camera` / `cameraRoll` ของ LINE
// เปิดกล้อง/คลังรูปให้เลย — เร็วกว่าให้ผู้ใช้ไปหาปุ่มแนบไฟล์เอง
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messagingApi } from "@line/bot-sdk";

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) { console.error("!! ไม่มี LINE_CHANNEL_ACCESS_TOKEN ใน .env"); process.exit(1); }

const client = new messagingApi.MessagingApiClient({ channelAccessToken: TOKEN });
const blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: TOKEN });

const W = 2500, H = 1686;           // ขนาดที่ LINE รองรับ (2 แถว × 3 ช่อง)
const CW = Math.floor(W / 3), CH = Math.floor(H / 2);
// ต้องผ่าน fileURLToPath — .pathname ยังเป็น URL-encoded ("Model%20Trainer") หา path ไม่เจอ
const IMAGE = fileURLToPath(new URL("../assets/richmenu.png", import.meta.url));

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
  // ลบของเก่าก่อน ไม่งั้นเมนูค้างสะสมจนชน limit
  const { richmenus } = await client.getRichMenuList();
  for (const m of richmenus) await client.deleteRichMenu(m.richMenuId);

  const { richMenuId } = await client.createRichMenu(MENU);
  await blob.setRichMenuImage(richMenuId, new Blob([readFileSync(IMAGE)], { type: "image/png" }));
  await client.setDefaultRichMenu(richMenuId);
  console.log(`✅ สร้างและตั้งเป็นเมนูหลักแล้ว: ${richMenuId}`);
  console.log("   (ผู้ใช้อาจต้องปิด-เปิดห้องแชทใหม่ถึงจะเห็น)");

} else {
  console.error("ใช้: node scripts/richmenu.mjs [create|list|clear]");
  process.exit(1);
}
