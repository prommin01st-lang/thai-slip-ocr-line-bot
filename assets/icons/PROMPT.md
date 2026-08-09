# Prompt สั่ง AI วาดไอคอนเมนู — แผ่นเดียว 16 อัน

วาดใหม่ทั้งเมนูในรูปเดียว **ตาราง 4 × 4 = 16 ช่อง อัตราส่วน 1:1**

ใช้จริง 12 (หน้าละ 6 × 2 หน้า) เหลือ 4 เป็นตัวสำรองไว้สลับอันที่ไม่ถูกใจ

| ทำไมต้อง 4×4 บนผืน 1:1 | |
|---|---|
| **ช่องออกมาจัตุรัสเป๊ะ** | 1:1 ÷ 4 คอลัมน์ ÷ 4 แถว = ช่องละ 1:1 พอดี ไอคอนไม่ถูกบีบ |
| **1:1 มีให้เลือกทุกเครื่องมือ** | ต่างจาก 3:2 ที่ต้องการจริง ๆ แต่แทบไม่มีให้เลือก |
| **สไตล์เข้าชุดกันแน่นอน** | เกิดจากการ generate ครั้งเดียว มุมแสงและวัสดุตรงกันหมด |

> ⚠️ **ข้อควรรู้ก่อนเริ่ม:** โมเดลวาดรูปมักเบลอเมื่อต้องวาดของ 16 อย่างที่ต่างกันในภาพเดียว
> ถ้าออกมามั่ว ให้ถอยไปทำทีละ 6 อัน (ผืน **2:3** ตาราง 2×3) หรือทีละอัน (ผืน **1:1**)
> — ตัวตัดรองรับทั้งสามแบบ ดูท้ายไฟล์

**ตั้งความละเอียดให้สูงสุดเท่าที่ทำได้** ช่องละ 1/4 ของด้าน ถ้ารูปรวม 2048×2048
จะได้ช่องละ 512×512 ซึ่งกำลังพอดี (สุดท้ายใช้จริงราว 300 px)

---

## แนบรูปอ้างอิงด้วย (ถ้าอยากคงสไตล์เดิม)

| ไฟล์ | คืออะไร |
|---|---|
| `assets/icons/icon-set-01.jpeg` | **แผ่นต้นฉบับ** ที่ prompt นี้ผลิตออกมาจริง 16 อัน 2048×2048 |
| `assets/icons/STYLE-REF.png` | ย่อเหลือ 6 อันของหน้าหลัก แนบง่ายกว่า |

แนบไปเป็น style reference ได้ผลกว่าบรรยายสไตล์ยาว ๆ มาก
**ถ้าอยากได้สไตล์ใหม่ไปเลยก็ไม่ต้องแนบ** แค่แก้ย่อหน้า STYLE ใน prompt

> prompt ก้อนล่างนี้ใช้ผลิต `icon-set-01.jpeg` มาแล้วจริง ทั้ง 16 ช่องออกมาตรงลำดับ
> ไม่มีตัวหนังสือหลุด และพื้นเป็นสีเรียบตามสั่ง — ใช้ซ้ำได้เลย

---

## Prompt (ก๊อปทั้งก้อน)

```
A single square image containing a 4x4 grid of 16 separate app icons,
evenly spaced, one icon per cell, each icon fully inside its own cell
with clear empty margin around it. Do not let icons touch or overlap.

STYLE: soft 3D matte clay/plastic icons, rounded shapes with gentle bevels
and soft ambient shadows, friendly pastel palette, consistent studio lighting
from the upper left, all 16 icons viewed straight on at the same scale and
the same angle. Behind each icon sits a large soft flat pastel circle.
A few tiny sparkle and dot accents float around each icon.

BACKGROUND: one single flat solid off-white color (#FAF8F5) across the whole
image, with no gradient, no texture, no grid lines, no borders, no frames.

The 16 icons, in reading order (left to right, top to bottom):

 1. a green photo camera                          — mint green circle
 2. a picture frame with mountains and sun, small plus badge — sky blue circle
 3. a clipboard with a pie chart and bar chart     — light blue circle
 4. a checklist sheet with green ticks next to a red trash bin — soft pink circle
 5. a yellow ring notebook with a Thai baht symbol, next to a calculator — warm yellow circle
 6. a purple speech bubble with a question mark, small chat bubble beside it — lavender circle
 7. a calendar page with one row of days highlighted, small bar chart in front — sky blue circle
 8. a stack of gold coins next to a rising line chart on a small board — mint green circle
 9. an open wallet with one coin flying out to the upper right — coral orange circle
10. a control panel with three horizontal sliders and round knobs — lavender grey circle
11. a shield with a checkmark standing in front of a folded document — teal blue circle
12. an open trash bin with a sheet of paper dropping into it — rose red circle
13. a piggy bank with a coin above it              — soft green circle
14. a magnifying glass over a receipt              — soft blue circle
15. a bell with a small badge dot                  — soft amber circle
16. a lock in front of a folder                    — soft violet circle

ABSOLUTELY NO TEXT: no letters, no words, no numbers, no labels, no captions,
no watermark anywhere in the image. Icons only.
```

## ช่องไหนไปเป็นปุ่มอะไร

ตัวตัดอ่านเรียงซ้าย→ขวา บน→ล่าง แล้ววางตามนี้อัตโนมัติ

| ช่อง | ไฟล์ | ปุ่ม |
|---|---|---|
| 1 | `tab1-1` | ถ่ายสลิป |
| 2 | `tab1-2` | เลือกรูป |
| 3 | `tab1-3` | สรุป |
| 4 | `tab1-4` | รายการ |
| 5 | `tab1-5` | งบ |
| 6 | `tab1-6` | ช่วยเหลือ |
| 7 | `tab2-1` | สรุปสัปดาห์ |
| 8 | `tab2-2` | สรุปทั้งหมด |
| 9 | `tab2-3` | รายจ่าย |
| 10 | `tab2-4` | ตั้งค่า |
| 11 | `tab2-5` | ข้อมูลของฉัน |
| 12 | `tab2-6` | ลบข้อมูล |
| 13–16 | `extra-1…4` | สำรอง — เปลี่ยนชื่อทับอันที่ไม่ถูกใจได้ |

---

## เอามาใช้

```bash
python3 scripts/richmenu_split.py <ไฟล์แผ่น> --page both --grid 4x4
python3 scripts/richmenu_compose.py
node scripts/richmenu.mjs check
node scripts/richmenu.mjs create
```

แล้วปิด-เปิดห้องแชทใน LINE ใหม่ (มี cache รูปที่เครื่อง)

ตัวตัดไม่ได้เชื่อว่า AI จะวางตรงกลางช่องเป๊ะ — หลังตัดมันจะ **คีย์พื้นออกแล้วครอป
ตามขอบจริงของไอคอน** ช่องที่เยื้องไป 20-30 px จึงไม่มีผล (ทดสอบแล้ว)
และ `richmenu_compose.py` จัดกึ่งกลางให้อีกทีอยู่ดี

พื้นไม่โปร่งก็ได้ ขอแค่เป็น **สีเรียบสีเดียว** — ที่ prompt สั่ง `#FAF8F5` ไว้ก็เพื่อการนี้
ถ้าพื้นมีลวดลายหรือไล่เฉด ตัวคีย์จะไม่เดาแล้วปล่อยเป็นพื้นทึบ ซึ่งจะเห็นเป็นสี่เหลี่ยม

## ถ้า 16 อันในภาพเดียวออกมามั่ว

| ทำทีละ | ผืนที่ขอ | ตาราง | คำสั่งตัด |
|---|---|---|---|
| 6 อัน (หนึ่งหน้า) | **2:3** | 2×3 | `--page 2` |
| 12 อัน (ทั้งเมนู) | **4:3** | 4×3 | `--page both --grid 4x3` |
| ทีละอัน | **1:1** | — | ไม่ต้องตัด เซฟเป็น `tab2-1.png` ตรง ๆ |

ทุกแบบข้างบนช่องออกมาจัตุรัสพอดีหมด ถ้าทำทีละอันให้ตัดย่อหน้า grid ออก
เหลือแค่ STYLE + SUBJECT อันเดียว + ย่อหน้า NO TEXT
