// flex.test.js — ตรวจว่า resultMessage() สร้าง Flex ที่ถูกกติกา LINE จากผลจริงของ parser
//
// ข้อมูลนำเข้าคือ output จริงของ slip_parser / payslip_parser / receipt_parser ฝั่ง Python
// (ดู fixtures/parser-output.json — สร้างจากการรัน parser พวกนั้นตรง ๆ)
//
// รัน: npm test
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { resultMessage } from "../src/flex.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, "fixtures", "parser-output.json"), "utf8"));

/** เดินทั้ง tree หาสิ่งที่ LINE จะปฏิเสธ: null ใน contents, text ว่าง, ค่าที่ไม่ใช่สตริง */
function validate(node, path = "$") {
  assert.ok(node !== null && node !== undefined, `${path}: มีค่า null/undefined ใน Flex tree`);
  assert.equal(typeof node.type, "string", `${path}: ไม่มี field "type"`);

  if (node.type === "text") {
    assert.equal(typeof node.text, "string", `${path}.text: ต้องเป็นสตริง`);
    assert.ok(node.text.length > 0, `${path}.text: ห้ามว่าง (LINE จะตอบ 400)`);
  }
  for (const key of ["contents", "header", "body", "footer", "hero"]) {
    const child = node[key];
    if (!child) continue;
    if (Array.isArray(child)) {
      child.forEach((c, i) => validate(c, `${path}.${key}[${i}]`));
    } else {
      validate(child, `${path}.${key}`);
    }
  }
}

let passed = 0;
for (const [name, data] of Object.entries(fixtures)) {
  const msg = resultMessage(data);

  assert.equal(msg.type, "flex", `${name}: type ต้องเป็น flex`);
  assert.ok(msg.altText.length > 0 && msg.altText.length <= 400,
    `${name}: altText ต้องยาว 1–400 ตัวอักษร (ได้ ${msg.altText.length})`);
  assert.equal(msg.contents.type, "bubble", `${name}: contents ต้องเป็น bubble`);
  validate(msg.contents, name);

  // การ์ดต้องมีเนื้อหาจริง ไม่ใช่กล่องเปล่า
  assert.ok(msg.contents.body.contents.length > 0, `${name}: body ว่าง`);

  console.log(`  ✓ ${name.padEnd(9)} altText: "${msg.altText}"`);
  passed++;
}

console.log(`\nflex.test: ${passed}/${Object.keys(fixtures).length} ผ่าน ✅`);
