# สั่ง AI วาดไอคอนหน้า "เพิ่มเติม"

ต้องการไอคอน **6 อัน** สำหรับหน้า 2 ของ rich menu — สั่งทีละอัน อันละ 1 รูป

---

## ก่อนเริ่ม: แนบรูปอ้างอิงสไตล์

**แนบ `assets/icons/STYLE-REF.png` ไปกับ prompt ทุกครั้ง**

เป็นไอคอน 6 อันของหน้า "หลัก" ที่ใช้อยู่จริง — ให้ AI เห็นว่าต้องออกมาเป็นชุดเดียวกัน
นี่คือสิ่งที่ทำให้ผลต่างกันมากที่สุด มากกว่าคำบรรยายสไตล์ยาว ๆ

เครื่องมือที่รับรูปอ้างอิงได้ ให้ใส่เป็น style reference / image prompt
ถ้าใส่ไม่ได้ก็แนบเฉย ๆ แล้วพิมพ์ว่า "match the style of the attached icons"

---

## Prompt (ภาษาอังกฤษ — image model เข้าใจดีกว่า)

ใช้ท่อนนี้เหมือนกันทุกอัน แล้วเปลี่ยนแค่บรรทัด `SUBJECT` กับ `TINT`

```
A single 3D icon in soft matte clay/plastic style, rounded shapes with gentle
bevels and soft ambient shadows, friendly pastel palette, studio lighting from
the upper left, viewed straight on.

SUBJECT: <ใส่จากตารางด้านล่าง>

Behind the subject is a large soft circle of flat pastel <TINT> filling most of
the frame. A few tiny sparkle and dot accents float around the subject.

Square 1:1 composition, subject centered with generous margin, transparent
background outside the circle, no text, no letters, no numbers, no watermark,
no drop shadow on the outer edge. Clean, minimal, app icon quality.
Match the style of the attached reference icons exactly.
```

| # | ไฟล์ | ปุ่ม | SUBJECT | TINT |
|---|---|---|---|---|
| 1 | `tab2-1.png` | สรุปสัปดาห์ | a calendar page with one row of days highlighted, a small bar chart resting in front of it | soft sky blue |
| 2 | `tab2-2.png` | สรุปทั้งหมด | a stack of coins next to a rising line chart on a small board | soft mint green |
| 3 | `tab2-3.png` | รายจ่าย | an open wallet with one coin flying out toward the upper right, a small outgoing arrow | soft coral orange |
| 4 | `tab2-4.png` | ตั้งค่า | a control panel with three horizontal sliders and round knobs, one knob pulled aside | soft lavender grey |
| 5 | `tab2-5.png` | ข้อมูลของฉัน | a shield with a checkmark standing in front of a folded document | soft teal blue |
| 6 | `tab2-6.png` | ลบข้อมูล | an open trash bin with a sheet of paper dropping into it | soft rose red |

---

## ข้อบังคับที่ห้ามพลาด

| | ทำไม |
|---|---|
| **อัตราส่วน 1:1** | สคริปต์ย่อให้พอดีกรอบเอง แต่ 1:1 ทำให้ทั้ง 6 อันสมดุลกัน |
| **ห้ามมีตัวหนังสือ** | ข้อความไทยเราเรนเดอร์เอง ถ้า AI ใส่มาจะซ้อนกัน และมักสะกดผิด |
| **พื้นโปร่ง หรือพื้นสีเรียบสีเดียว** | ถ้าโปร่งไม่ได้ สคริปต์คีย์สีพื้นออกให้ ขอแค่อย่าให้พื้นมีลวดลาย/ไล่เฉด |
| **สั่งทีละอัน มุมแสงเดียวกัน** | วางเรียงกัน 6 อัน ถ้ามุมแสงไม่ตรงกันจะเห็นชัดมาก |

> ถ้า AI ชอบใส่ตัวหนังสือมาเอง เติมท้าย prompt ว่า
> `absolutely no text or typography anywhere in the image`

---

## เอามาใช้

เซฟลงโฟลเดอร์นี้ตามชื่อในตาราง แล้ว

```bash
python3 scripts/richmenu_compose.py    # ประกอบเป็นรูป 2500×1686
node scripts/richmenu.mjs check        # ตรวจก่อน
node scripts/richmenu.mjs create       # ขึ้นจริง
```

จากนั้นปิด-เปิดห้องแชทใน LINE ใหม่ (มี cache รูปที่เครื่อง)

ไม่พอใจอันไหนก็วาดใหม่เฉพาะอันนั้นแล้วรันสองคำสั่งซ้ำ — ไม่ต้องทำใหม่ทั้งหน้า

---

## อยากแก้หน้า "หลัก" ด้วย

ใช้วิธีเดียวกัน ตั้งชื่อ `tab1-1.png` … `tab1-6.png` ตามลำดับนี้

| # | ปุ่ม | SUBJECT ที่ใช้อยู่ตอนนี้ |
|---|---|---|
| 1 | ถ่ายสลิป | กล้องถ่ายรูปสีเขียว |
| 2 | เลือกรูป | กรอบรูปภูเขากับพระอาทิตย์ มีปุ่ม + |
| 3 | สรุป | คลิปบอร์ดมีกราฟวงกลมกับกราฟแท่ง |
| 4 | รายการ | กระดาษรายการติ๊กถูก กับถังขยะ |
| 5 | งบ | สมุดบัญชีสีเหลืองมีสัญลักษณ์บาท กับเครื่องคิดเลข |
| 6 | ช่วยเหลือ | ลูกโป่งคำพูดสีม่วงมีเครื่องหมายคำถาม |

ของชุดนี้ตัดมาจากงานออกแบบเดิม (`rich-menu-01.png`) ซึ่ง**ยังเก็บไว้**
ถ้าวาดใหม่แล้วไม่ถูกใจก็กู้กลับได้
