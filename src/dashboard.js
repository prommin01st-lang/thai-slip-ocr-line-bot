// dashboard.js — แท็บสรุปในชีตของผู้ใช้ ประกอบจาก **สูตรล้วน**
//
// **ทำไมต้องเป็นสูตร ไม่ใช่ค่าที่คำนวณแล้วส่งขึ้นไป**
//
// ถ้าส่งเป็นตัวเลขสำเร็จรูป ทุกครั้งที่มีรายการใหม่ต้องคำนวณใหม่แล้วยิงขึ้นไปทับ
// = เพิ่มคำขอ API ทุกครั้งตลอดไป และแดชบอร์ดจะล้าสมัยทันทีที่ผู้ใช้ปิดโหมด sync
// อัตโนมัติ ส่วนสูตรเขียนครั้งเดียวแล้วคำนวณเองในชีตตลอดชีพ — **ต้นทุนหลังจากนั้นคือศูนย์**
// และยังทำงานถูกแม้ผู้ใช้จะเพิ่มแถวเองด้วยมือ
//
// ใช้ SPARKLINE แทนกราฟจริง เพราะกราฟต้องสร้างผ่าน `addChart` ซึ่งเป็น object แยก
// ที่ต้องตามลบ/สร้างใหม่เองเมื่อโครงเปลี่ยน ส่วน SPARKLINE เป็นแค่สูตรในเซลล์

/** ชื่อแท็บแดชบอร์ด — คงที่ เพื่อให้หาเจอตอนรีเฟรช */
export const DASHBOARD_TAB = "สรุป";

/** จำนวนเดือนย้อนหลังในตารางแนวโน้ม */
const MONTHS = 12;

/** อ้างอิงแท็บข้อมูลในสูตร — ชื่อแท็บภาษาไทย/มีช่องว่างต้องครอบด้วยอัญประกาศเดี่ยว */
const ref = (tab, range) => `'${String(tab).replace(/'/g, "''")}'!${range}`;

/**
 * ตำแหน่งคอลัมน์ในแท็บข้อมูล — ผูกกับลำดับใน `SHEET_HEADERS` ของ ledger.js
 * เปลี่ยนลำดับที่นั่นแล้วต้องแก้ที่นี่ด้วย ไม่งั้นสูตรจะชี้ผิดคอลัมน์เงียบ ๆ
 */
const COL = {
  date: "B", direction: "C", amount: "D", category: "F",
  party: "G", note: "H", status: "J", month: "M",
};

const THIS_MONTH = 'TEXT(TODAY(),"yyyy-mm")';
/** ทุกสูตรต้องกรองแถวที่ถูกลบออกเสมอ — ชีตใช้ soft delete เหมือน DB */
const NOT_DELETED = (t) => `${ref(t, `${COL.status}:${COL.status}`)},"<>ลบแล้ว"`;

const sumOf = (t, dir, month) =>
  `=SUMIFS(${ref(t, `${COL.amount}:${COL.amount}`)},` +
  `${ref(t, `${COL.direction}:${COL.direction}`)},"${dir}",` +
  `${ref(t, `${COL.month}:${COL.month}`)},${month},` +
  `${NOT_DELETED(t)})`;

/**
 * แถวทั้งหมดของแท็บแดชบอร์ด (2 มิติ พร้อมเขียนลง A1)
 *
 * `dataTab` = ชื่อแท็บที่เก็บรายการจริง ต้องส่งมาเพราะผู้ใช้ตั้งชื่อเองได้
 */
export function dashboardLayout(dataTab) {
  const t = dataTab;
  const rows = [];
  // คืนเลขแถว (1-indexed) ของสิ่งที่เพิ่ง push — **ห้าม hardcode เลขแถวเด็ดขาด**
  // แทรกบรรทัดเดียวข้างบนแล้วสูตรทั้งหน้าจะชี้ผิดโดยไม่มี error ให้เห็น
  // (ผลคือตัวเลขผิดแบบดูสมเหตุสมผล ซึ่งแย่กว่าหน้าพัง)
  const push = (...cells) => rows.push(cells);

  push("📊 สรุปรายรับ-รายจ่าย");
  push(`อัปเดตเองจากแท็บ “${t}” — หน้านี้เป็นสูตรทั้งหมด ไม่ต้องแก้อะไร`);
  push("");

  // --- เดือนปัจจุบัน ---
  push("เดือนนี้", `=${THIS_MONTH}`);
  push("รายรับ", sumOf(t, "รายรับ", THIS_MONTH));
  const rIn = rows.length;
  push("รายจ่าย", sumOf(t, "รายจ่าย", THIS_MONTH));
  const rOut = rows.length;
  push("คงเหลือ", `=B${rIn}-B${rOut}`);
  push("จำนวนรายการ",
    `=COUNTIFS(${ref(t, `${COL.month}:${COL.month}`)},${THIS_MONTH},${NOT_DELETED(t)})`);
  push("รอตรวจยอด",
    `=COUNTIFS(${ref(t, `${COL.month}:${COL.month}`)},${THIS_MONTH},` +
    `${ref(t, `${COL.status}:${COL.status}`)},"รอตรวจ")`);
  push("");

  // --- ทั้งหมดตั้งแต่เริ่ม ---
  push("ทั้งหมดตั้งแต่เริ่มใช้");
  push("รายรับรวม",
    `=SUMIFS(${ref(t, `${COL.amount}:${COL.amount}`)},` +
    `${ref(t, `${COL.direction}:${COL.direction}`)},"รายรับ",${NOT_DELETED(t)})`);
  const rInAll = rows.length;
  push("รายจ่ายรวม",
    `=SUMIFS(${ref(t, `${COL.amount}:${COL.amount}`)},` +
    `${ref(t, `${COL.direction}:${COL.direction}`)},"รายจ่าย",${NOT_DELETED(t)})`);
  const rOutAll = rows.length;
  push("คงเหลือสะสม", `=B${rInAll}-B${rOutAll}`);
  push("");

  // --- แนวโน้ม 12 เดือน + กราฟแท่งในเซลล์ ---
  push("แนวโน้ม 12 เดือนล่าสุด");
  push("เดือน", "รายรับ", "รายจ่าย", "คงเหลือ");
  const trendHeader = rows.length;               // แถวหัวตาราง (กราฟใช้เป็นชื่อชุดข้อมูล)
  const trendStart = rows.length + 1;            // ข้อมูลเริ่มแถวถัดจากหัวตาราง
  for (let i = MONTHS - 1; i >= 0; i--) {
    const m = `TEXT(EOMONTH(TODAY(),-${i}),"yyyy-mm")`;
    push(`=${m}`, sumOf(t, "รายรับ", m), sumOf(t, "รายจ่าย", m), null);
    const r = rows.length;
    rows[r - 1][3] = `=B${r}-C${r}`;
  }
  const trendEnd = rows.length;
  push("");
  push("กราฟรายจ่าย",
    `=SPARKLINE(C${trendStart}:C${trendEnd},{"charttype","column";"color","#A63D3D";"empty","zero"})`);
  push("กราฟรายรับ",
    `=SPARKLINE(B${trendStart}:B${trendEnd},{"charttype","column";"color","#2E7D5B";"empty","zero"})`);
  push("");

  // --- รายจ่ายตามหมวด (เดือนนี้) ---
  //
  // QUERY คืนหลายแถวจากเซลล์เดียว จึงต้องเว้นที่ว่างข้างล่างไว้ให้มันขยาย
  // ไม่งั้นจะขึ้น #REF! ทับข้อมูลที่อยู่ถัดไป
  push("รายจ่ายตามหมวด (เดือนนี้)");
  push(
    `=IFERROR(QUERY(${ref(t, "A:M")},"select ${COL.category}, sum(${COL.amount}), count(${COL.amount}) ` +
    `where ${COL.direction}='รายจ่าย' and ${COL.status}<>'ลบแล้ว' and ${COL.month}=date_month ` +
    `group by ${COL.category} order by sum(${COL.amount}) desc ` +
    `label sum(${COL.amount}) 'ยอดรวม', count(${COL.amount}) 'จำนวน'",1),"ยังไม่มีรายจ่ายเดือนนี้")`);
  const queryRow = rows.length;                  // แถวหัวของผลลัพธ์ QUERY (ข้อมูลอยู่ถัดลงไป)

  return { rows, trendHeader, trendStart, trendEnd, queryRow };
}

/** เข้ากันได้กับผู้เรียกที่ต้องการแค่แถว */
export const dashboardRows = (dataTab) => dashboardLayout(dataTab).rows;

/**
 * ประกอบสูตร QUERY ที่ต้องแทรกค่าเดือนปัจจุบัน
 *
 * ทำแยกเพราะ QUERY ไม่รับ `TEXT(TODAY(),...)` ตรง ๆ ในสตริงเงื่อนไข — ต้องต่อสตริง
 * ด้วย `&` จากนอกเครื่องหมายคำพูด ซึ่งอ่านยากมากถ้าเขียนปนกับสูตรอื่น
 */
function withMonth(formula) {
  return formula.replace(/=date_month/g, `='\"&${THIS_MONTH}&\"'`);
}

/** แถวสุดท้ายที่พร้อมเขียนลงชีต (แทนค่าเดือนใน QUERY เรียบร้อยแล้ว) */
export function dashboardValues(dataTab) {
  return dashboardLayout(dataTab).rows.map((row) =>
    row.map((cell) => (typeof cell === "string" ? withMonth(cell) : cell)));
}

// ---------- กราฟจริง (ฝังเป็น object ในแท็บ ไม่ใช่สูตร) ----------

/** #RRGGBB → {red,green,blue} 0–1 ตามที่ Sheets API ต้องการ */
const rgb = (hex) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
});

/** เผื่อจำนวนหมวดสูงสุดที่กราฟวงกลมครอบ — QUERY ขยายเองจึงไม่รู้ขอบเขตล่วงหน้า */
const PIE_ROWS = 20;

/**
 * คำขอสร้างกราฟในแท็บสรุป
 *
 * ⚠️ index ของ Sheets API เป็น **0-based และ end ไม่รวม** ส่วนเลขแถวใน layout
 * เป็น 1-based แบบที่คนอ่านสูตรเข้าใจ — แปลงผิดตรงนี้กราฟจะเลื่อนไปหนึ่งแถว
 * แล้วเอาหัวตารางไปเป็นข้อมูล (ได้กราฟที่ดูเหมือนถูกแต่ผิด)
 */
export function chartRequests(sheetId, layout) {
  const src = (rowFrom, rowTo, colFrom, colTo) => ({
    sources: [{
      sheetId,
      startRowIndex: rowFrom - 1, endRowIndex: rowTo,
      startColumnIndex: colFrom, endColumnIndex: colTo,
    }],
  });
  const at = (rowIndex, columnIndex, widthPixels, heightPixels) => ({
    overlayPosition: { anchorCell: { sheetId, rowIndex, columnIndex }, widthPixels, heightPixels },
  });

  return [
    {
      addChart: {
        chart: {
          spec: {
            title: "รายรับ-รายจ่าย 12 เดือน",
            basicChart: {
              chartType: "COLUMN",
              legendPosition: "BOTTOM_LEGEND",
              // นับหัวตารางเป็นชื่อชุดข้อมูล → legend ขึ้นว่า "รายรับ"/"รายจ่าย" ไม่ใช่ Series 1/2
              headerCount: 1,
              axis: [{ position: "BOTTOM_AXIS" }, { position: "LEFT_AXIS", title: "บาท" }],
              domains: [{ domain: { sourceRange: src(layout.trendHeader, layout.trendEnd, 0, 1) } }],
              series: [
                { series: { sourceRange: src(layout.trendHeader, layout.trendEnd, 1, 2) },
                  targetAxis: "LEFT_AXIS", color: rgb("#2E7D5B") },
                { series: { sourceRange: src(layout.trendHeader, layout.trendEnd, 2, 3) },
                  targetAxis: "LEFT_AXIS", color: rgb("#A63D3D") },
              ],
            },
          },
          // วางไว้คอลัมน์ F เป็นต้นไป — พ้นข้อมูลที่ใช้ A–D ไม่บังอะไร
          position: at(3, 5, 620, 320),
        },
      },
    },
    {
      addChart: {
        chart: {
          spec: {
            title: "รายจ่ายตามหมวด (เดือนนี้)",
            pieChart: {
              legendPosition: "RIGHT_LEGEND",
              pieHole: 0.4,
              // เริ่มจากแถวถัดจากหัวผลลัพธ์ QUERY และเผื่อพื้นที่ไว้ล่วงหน้า
              // แถวว่างที่เกินมาไม่ถูกวาด Sheets ข้ามให้เอง
              domain: { sourceRange: src(layout.queryRow + 1, layout.queryRow + PIE_ROWS, 0, 1) },
              series: { sourceRange: src(layout.queryRow + 1, layout.queryRow + PIE_ROWS, 1, 2) },
            },
          },
          position: at(21, 5, 620, 340),
        },
      },
    },
  ];
}
