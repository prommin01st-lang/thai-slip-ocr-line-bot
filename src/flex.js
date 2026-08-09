// flex.js — ผล JSON จาก slip-ocr-th → Flex Message ภาษาไทย
//
// parser ทุกตัวคืน confidence: high|medium|low + warnings[] มาด้วย — เอามาแสดงตรง ๆ
// ดีกว่าโชว์ตัวเลขเฉย ๆ เพราะ OCR ไทยยังเพี้ยนได้ ผู้ใช้ควรเห็นว่าค่าไหน "เดา"
import { CATEGORIES, pickerFor, labelOf } from "./categories.js";

const CONF = {
  high: { label: "แม่นยำสูง", color: "#2E7D5B", bg: "#E3F3EB" },
  medium: { label: "ควรตรวจทาน", color: "#9A6B12", bg: "#FBF0DA" },
  low: { label: "ไม่มั่นใจ", color: "#A63D3D", bg: "#F8E3E3" },
};

const DOC = {
  transfer: { title: "สลิปโอนเงิน", emoji: "💸" },
  payslip: { title: "ใบเงินเดือน", emoji: "🧾" },
  receipt: { title: "ใบเสร็จ", emoji: "🛒" },
  unknown: { title: "เอกสารไม่ทราบชนิด", emoji: "❓" },
};

const BANK_NAMES = {
  kbank: "กสิกรไทย", scb: "ไทยพาณิชย์", bbl: "กรุงเทพ", ktb: "กรุงไทย",
  bay: "กรุงศรี", ttb: "ทีทีบี", gsb: "ออมสิน",
  truemoney: "TrueMoney", promptpay: "พร้อมเพย์",
};

const has = (v) => v !== null && v !== undefined && v !== "" &&
  !(Array.isArray(v) && v.length === 0);

/** แถว label/value หนึ่งบรรทัด — ข้ามไปถ้าไม่มีค่า */
function row(label, value, opts = {}) {
  if (!has(value)) return null;
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: label, color: "#8A8A8A", size: "sm", flex: 4 },
      {
        type: "text",
        text: String(value),
        wrap: true,
        color: opts.color || "#333333",
        size: opts.size || "sm",
        weight: opts.weight || "regular",
        flex: 7,
      },
    ],
  };
}

/** ยอดเงินตัวใหญ่กลางการ์ด — ตัวเลขคือสิ่งที่ผู้ใช้มาดู */
function bigAmount(amount, currency) {
  if (!has(amount)) return null;
  return {
    type: "box",
    layout: "baseline",
    contents: [
      { type: "text", text: String(amount), size: "xxl", weight: "bold", color: "#1F1F1F", flex: 0 },
      { type: "text", text: ` ${currency || "THB"}`, size: "sm", color: "#8A8A8A", margin: "sm", flex: 0 },
    ],
  };
}

function warningBox(warnings) {
  if (!has(warnings)) return null;
  return {
    type: "box",
    layout: "vertical",
    margin: "lg",
    paddingAll: "md",
    cornerRadius: "md",
    backgroundColor: "#FBF0DA",
    spacing: "xs",
    contents: warnings.map((w) => ({
      type: "text", text: `• ${w}`, size: "xxs", color: "#9A6B12", wrap: true,
    })),
  };
}

/** แถวข้อมูลตาม doc_type — แต่ละชนิดมีฟิลด์คนละชุด */
function bodyRows(d, docType) {
  if (docType === "payslip") {
    const period = d.pay_period?.from
      ? `${d.pay_period.from}${d.pay_period.to ? ` – ${d.pay_period.to}` : ""}`
      : null;
    return [
      row("บริษัท", d.company),
      row("พนักงาน", d.employee_name),
      row("รหัสพนักงาน", d.employee_id),
      row("งวดจ่าย", period),
      row("เงินเดือน", d.salary),
      row("รวมรายได้", d.gross_income),
      row("ภาษี", d.tax),
      row("ประกันสังคม", d.social_security),
      row("รวมหัก", d.total_deductions),
      row("เลขบัญชี", d.account_no),
    ];
  }
  if (docType === "receipt") {
    return [row("วันที่", d.date)];
  }
  // transfer / unknown
  const banks = (d.banks || []).map((b) => BANK_NAMES[b] || b).join(", ");
  return [
    row("วันที่", d.date),
    row("เวลา", d.time),
    row("จาก", d.from),
    row("ไปยัง", d.to),
    row("ธนาคาร", banks),
    row("เลขอ้างอิง", d.ref, { size: "xs" }),
  ];
}

/** ผลลัพธ์ → Flex bubble (ส่งเป็น messages[0] ได้เลย) */
export function resultBubble(d) {
  const docType = d.doc_type || "unknown";
  const doc = DOC[docType] || DOC.unknown;
  const conf = CONF[d.confidence] || CONF.low;

  // ใบเงินเดือนเน้น "เงินสุทธิ", ใบเสร็จเน้น "ยอดรวม", สลิปโอนเน้น "จำนวนเงิน"
  const headline =
    docType === "payslip" ? d.net_pay : docType === "receipt" ? d.total : d.amount;
  const headlineLabel =
    docType === "payslip" ? "เงินได้สุทธิ" : docType === "receipt" ? "ยอดรวม" : "จำนวนเงิน";

  const rows = bodyRows(d, docType).filter(Boolean);

  const body = [];
  if (has(headline)) {
    body.push({ type: "text", text: headlineLabel, size: "xs", color: "#8A8A8A" });
    body.push(bigAmount(headline, d.currency));
  } else {
    body.push({
      type: "text",
      text: "อ่านยอดเงินไม่ออก",
      size: "md",
      weight: "bold",
      color: "#A63D3D",
      wrap: true,
    });
  }
  if (rows.length) {
    body.push({ type: "separator", margin: "lg" });
    body.push({ type: "box", layout: "vertical", margin: "lg", spacing: "sm", contents: rows });
  }
  const warn = warningBox(d.warnings);
  if (warn) body.push(warn);

  return {
    type: "bubble",
    header: {
      type: "box",
      layout: "horizontal",
      backgroundColor: "#F7F5F2",
      paddingAll: "md",
      contents: [
        {
          type: "text",
          text: `${doc.emoji} ${doc.title}`,
          weight: "bold",
          size: "sm",
          color: "#1F1F1F",
          gravity: "center",
          flex: 1,
        },
        {
          type: "box",
          layout: "vertical",
          backgroundColor: conf.bg,
          cornerRadius: "md",
          paddingAll: "xs",
          paddingStart: "sm",
          paddingEnd: "sm",
          flex: 0,
          contents: [{ type: "text", text: conf.label, size: "xxs", color: conf.color, weight: "bold" }],
        },
      ],
    },
    body: { type: "box", layout: "vertical", paddingAll: "lg", contents: body },
  };
}

/** ห่อ bubble เป็น message พร้อมส่ง (altText โผล่ใน notification/แชทลิสต์) */
export function resultMessage(d) {
  const doc = DOC[d.doc_type] || DOC.unknown;
  const amount = d.net_pay || d.total || d.amount;
  return {
    type: "flex",
    altText: amount ? `${doc.title}: ${amount} ${d.currency || "THB"}` : `${doc.title} (อ่านยอดไม่ออก)`,
    contents: resultBubble(d),
  };
}

// ==================== การ์ดอเนกประสงค์ ====================
//
// ทุกคำตอบของบอทเป็นการ์ด ไม่ใช่ข้อความเปล่า — อ่านง่ายกว่าและดูเป็นระบบเดียวกัน
// ใช้ tone บอกอารมณ์ของข้อความ (สำเร็จ / เตือน / ผิดพลาด) แทนที่จะพึ่ง emoji อย่างเดียว

const TONES = {
  neutral: { bg: "#F7F5F2", fg: "#1F1F1F", soft: "#EFEBE5" },
  success: { bg: "#E3F3EB", fg: "#2E7D5B", soft: "#EFF8F3" },
  warn: { bg: "#FBF0DA", fg: "#9A6B12", soft: "#FDF7EC" },
  danger: { bg: "#F8E3E3", fg: "#A63D3D", soft: "#FCF0F0" },
  info: { bg: "#E8EEF6", fg: "#2E5B7D", soft: "#F2F6FA" },
};

const txt = (text, o = {}) => ({
  type: "text", text: String(text), wrap: true,
  size: o.size ?? "sm", color: o.color ?? "#333333",
  weight: o.weight, align: o.align, margin: o.margin, flex: o.flex,
});

/** แถว label→value; ถ้าไม่มี label จะเป็นบูลเล็ตบรรทัดเดียว */
function kvRow(r, tone) {
  if (r.value === undefined || r.value === null || r.value === "") {
    return txt(`• ${r.label ?? r.text ?? ""}`, { size: "xs", color: "#555555" });
  }
  return {
    type: "box", layout: "baseline", spacing: "sm",
    contents: [
      txt(r.label, { size: "xs", color: "#8A8A8A", flex: 4 }),
      txt(r.value, { size: "sm", flex: 6, align: "end", weight: r.strong ? "bold" : undefined,
                     color: r.strong ? tone.fg : "#333333" }),
    ],
  };
}

/**
 * ปุ่มในการ์ด — รองรับ 3 แบบ
 *   {url}           เปิดลิงก์ (ใช้กับดาวน์โหลด CSV — LINE ส่งไฟล์เองไม่ได้)
 *   {data}          postback ธรรมดา (ทำงานทันที)
 *   {text}          ส่งข้อความแทนผู้ใช้
 *   {fill}          เปิดแป้นพิมพ์พร้อม**เติมข้อความไว้ให้** → ผู้ใช้พิมพ์ต่อแค่ตัวเลข
 *                   (ใช้กับคำสั่งที่ต้องมีค่าอิสระ เช่น "แก้ 12 " แล้วให้พิมพ์ยอด)
 */
function button(a, tone) {
  let action;
  if (a.url) {
    action = { type: "uri", label: a.label, uri: a.url };
  } else if (a.fill !== undefined) {
    action = { type: "postback", label: a.label, data: a.data ?? "act=noop",
               inputOption: "openKeyboard", fillInText: a.fill };
  } else if (a.data) {
    action = { type: "postback", label: a.label, data: a.data, displayText: a.displayText };
  } else {
    action = { type: "message", label: a.label, text: a.text };
  }
  return {
    type: "button", height: "sm",
    style: a.primary ? "primary" : "secondary",
    color: a.primary ? tone.fg : undefined,
    action,
  };
}

/**
 * การ์ดมาตรฐานของบอท — ใช้แทน `{type:"text"}` ทุกที่
 *
 * ตัวอย่าง: card({ title:"บันทึกแล้ว", tone:"success", big:"60.00", bigLabel:"รายจ่าย",
 *                  rows:[{label:"หมวด", value:"อาหาร"}], actions:[{label:"ลบ", data:"act=del&id=1"}] })
 */
export function card({
  title, tone = "neutral", emoji, text, big, bigLabel, bigUnit = "บาท",
  rows = [], notes = [], actions = [], quickReply, altText,
} = {}) {
  const t = TONES[tone] ?? TONES.neutral;
  const body = [];

  if (big !== undefined && big !== null) {
    if (bigLabel) body.push(txt(bigLabel, { size: "xs", color: "#8A8A8A" }));
    body.push({
      type: "box", layout: "baseline", contents: [
        txt(big, { size: "xxl", weight: "bold", color: t.fg, flex: 0 }),
        ...(bigUnit ? [txt(` ${bigUnit}`, { size: "sm", color: "#8A8A8A", margin: "sm", flex: 0 })] : []),
      ],
    });
  }
  if (text) body.push(txt(text, { margin: body.length ? "lg" : "none", color: "#444444" }));

  const validRows = rows.filter(Boolean);
  if (validRows.length) {
    if (body.length) body.push({ type: "separator", margin: "lg" });
    body.push({
      type: "box", layout: "vertical", margin: "lg", spacing: "sm",
      contents: validRows.map((r) => kvRow(r, t)),
    });
  }

  const validNotes = notes.filter(Boolean);
  if (validNotes.length) {
    body.push({
      type: "box", layout: "vertical", margin: "lg", paddingAll: "md", cornerRadius: "md",
      backgroundColor: TONES.warn.soft, spacing: "xs",
      contents: validNotes.map((n) => txt(`• ${n}`, { size: "xxs", color: TONES.warn.fg })),
    });
  }

  // LINE ไม่ยอมรับ body ที่ว่างเปล่า — กันไว้ไม่ให้ทั้งข้อความหายไปเงียบ ๆ
  if (!body.length) body.push(txt(title || "—"));

  const bubble = {
    type: "bubble",
    header: {
      type: "box", layout: "horizontal", backgroundColor: t.bg, paddingAll: "md",
      contents: [txt(`${emoji ? emoji + " " : ""}${title ?? ""}`,
                     { weight: "bold", size: "sm", color: t.fg })],
    },
    body: { type: "box", layout: "vertical", paddingAll: "lg", contents: body },
  };
  if (actions.length) {
    bubble.footer = {
      type: "box", layout: "vertical", spacing: "sm", paddingAll: "md",
      // สมาชิกที่เป็นอาเรย์ = ปุ่มเรียงแนวนอนแถวเดียวกัน
      // ใช้กับตัวเลือกสั้น ๆ ที่มีหลายอัน (เช่น หมวดหมู่) ไม่งั้นการ์ดยาวจนต้องเลื่อนหา
      contents: actions.map((a) => (Array.isArray(a)
        ? { type: "box", layout: "horizontal", spacing: "sm", contents: a.map((x) => button(x, t)) }
        : button(a, t))),
    };
  }

  const msg = {
    type: "flex",
    altText: (altText ?? `${title ?? ""} ${big ?? ""} ${text ?? ""}`).trim().slice(0, 400) || "ข้อความ",
    contents: bubble,
  };
  if (quickReply) msg.quickReply = quickReply;
  return msg;
}

/** ข้อความแจ้ง error → การ์ดโทนแดง */
export function errorMessage(text, actions = []) {
  return card({ title: "เกิดข้อผิดพลาด", emoji: "⚠️", tone: "danger", text, actions });
}

// ==================== quick reply ====================

const pb = (label, data) => ({ type: "action", action: { type: "postback", label, data } });

/**
 * ถามว่าผู้ใช้เป็นผู้โอนหรือผู้รับ — สลิปบอกแค่ "จาก A ไป B" เท่านั้น
 * ตอบครั้งเดียวแล้วระบบจำบัญชีไว้ ครั้งต่อไปเดาเองได้
 *
 * ใช้ **ปุ่มในการ์ด** ไม่ใช่ quick reply — ชิป quick reply ลอยอยู่เหนือแป้นพิมพ์
 * เลื่อนแชทหนีแล้วหาย ส่วนปุ่มในการ์ดอยู่ติดกับข้อความ กดย้อนหลังได้
 */
export function askDirection(txnId, amount) {
  return card({
    title: "รายการนี้เป็นรับหรือจ่าย?", emoji: "❓", tone: "warn",
    big: amount, bigLabel: "ยอด",
    text: "ตอบครั้งเดียว ครั้งต่อไปผมจำได้เอง",
    actions: [
      { label: "💰 เป็นรายรับ", data: `act=dir&id=${txnId}&v=in`, primary: true },
      { label: "💸 เป็นรายจ่าย", data: `act=dir&id=${txnId}&v=out` },
      { label: "ข้ามไปก่อน", data: `act=skip&id=${txnId}` },
    ],
    altText: `รายการ ${amount ?? ""} เป็นรับหรือจ่าย?`,
  });
}

/**
 * ปุ่มเลือกหมวด — 2 คอลัมน์ + ปุ่ม "หมวดอื่น" ถ้ายังมีที่ไม่ได้โชว์
 *
 * โชว์แค่ 4 ตัวเพราะ footer ของ Flex สูงเกินไปแล้วผู้ใช้ต้องเลื่อนหา
 * ที่เหลือซ่อนหลัง `act=catpick` ซึ่งเปิดการ์ดที่มีครบทุกหมวด
 */
export function categoryButtons(txnId, current, { all = false } = {}) {
  const list = all
    ? CATEGORIES.filter((c) => c.key !== current)
    : pickerFor(current, 4);
  const btn = (c) => ({ label: `${c.emoji} ${c.key}`, data: `act=cat&id=${txnId}&c=${encodeURIComponent(c.key)}` });
  const rows = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map(btn));
  if (!all && CATEGORIES.length - 1 > list.length) {
    rows.push({ label: "🏷 หมวดอื่น…", data: `act=catpick&id=${txnId}` });
  }
  return rows;
}

/** ปุ่มจัดการรายการที่เพิ่งบันทึก */
export function txnActions(txnId, text) {
  return {
    type: "text",
    text,
    quickReply: { items: [pb("🗑 ลบรายการนี้", `act=del&id=${txnId}`), pb("📊 สรุป", "act=summary")] },
  };
}

const TH_MONTH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
                  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** '2026-08-01' + (-1) → '2026-07' — ใช้ทำปุ่มเลื่อนเดือน */
export function shiftMonth(iso, delta) {
  const [y, m] = String(iso ?? "").split("-").map(Number);
  if (!y || !m) return "";
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** '2026-05-29' → 'พ.ค. 69' (พ.ศ.) — อ่านง่ายกว่าเลขล้วนบนปุ่ม */
export function thaiMonth(iso) {
  if (!iso) return "";
  const [y, m] = iso.split("-").map(Number);
  return `${TH_MONTH[(m || 1) - 1]} ${String((y || 2000) + 543).slice(-2)}`;
}

/**
 * ถามว่าจะลงรายการไว้เดือนไหน — สลิปเก่าที่เพิ่งส่งมาวันนี้เป็นเคสที่สับสนที่สุด
 * (ลงตามสลิป = ถูกในแง่บัญชี · ลงเดือนนี้ = ตรงกับที่ผู้ใช้เพิ่งจ่ายจริง)
 */
export function askPeriod(txnId, slipDate, todayIso) {
  return card({
    title: "สลิปใบนี้เป็นของเดือนก่อน", emoji: "📅", tone: "warn",
    rows: [
      { label: "วันที่บนสลิป", value: `${slipDate} (${thaiMonth(slipDate)})` },
      { label: "เดือนปัจจุบัน", value: thaiMonth(todayIso) },
    ],
    text: "จะให้ลงยอดนี้ไว้เดือนไหนครับ?",
    altText: `สลิปลงวันที่ ${slipDate} — จะลงเดือนไหน?`,
    actions: [
      { label: `📅 ลงเดือน ${thaiMonth(slipDate)}`, data: `act=period&id=${txnId}&v=slip`,
        primary: true },
      { label: `📆 ลงเดือนนี้ (${thaiMonth(todayIso)})`, data: `act=period&id=${txnId}&v=now` },
    ],
  });
}

// ==================== สรุปเป็น Flex ====================

const money = (s) => ({ type: "text", text: s, size: "sm", align: "end", flex: 0 });

function sumRow(label, value, color = "#333333", bold = false) {
  return {
    type: "box", layout: "horizontal", contents: [
      { type: "text", text: label, size: "sm", color: "#8A8A8A" },
      { ...money(value), color, weight: bold ? "bold" : "regular" },
    ],
  };
}

/** สรุปรายรับ-รายจ่าย → Flex bubble (อ่านง่ายกว่าข้อความเปล่ามาก) */
export function summaryBubble(s, fromCents) {
  const body = [
    { type: "text", text: "รายรับ-รายจ่าย", size: "xs", color: "#8A8A8A" },
    { type: "text", text: `${s.from} — ${s.to}`, size: "xxs", color: "#B0B0B0", margin: "xs" },
    { type: "separator", margin: "lg" },
    {
      type: "box", layout: "vertical", margin: "lg", spacing: "sm", contents: [
        sumRow("รายรับ", `${fromCents(s.income_cents)} ฿`, "#2E7D5B"),
        sumRow("รายจ่าย", `${fromCents(s.expense_cents)} ฿`, "#A63D3D"),
        { type: "separator", margin: "md" },
        sumRow("คงเหลือ", `${fromCents(s.net_cents)} ฿`,
            s.net_cents >= 0 ? "#1F1F1F" : "#A63D3D", true),
      ],
    },
  ];

  if (s.top_categories?.length) {
    body.push({ type: "separator", margin: "lg" });
    body.push({ type: "text", text: "ใช้มากสุด", size: "xxs", color: "#8A8A8A", margin: "lg" });
    body.push({
      type: "box", layout: "vertical", margin: "sm", spacing: "xs",
      contents: s.top_categories.map((c) => sumRow(c.category, `${c.amount} ฿`)),
    });
  }

  const notes = [];
  // สลิปลงวันที่ตามที่พิมพ์บนใบ ซึ่งมักเป็นเดือนก่อน — ถ้าไม่บอก ผู้ใช้จะคิดว่ายอดหาย
  if (s.outside_n) {
    notes.push(`📅 มีอีก ${s.outside_n} รายการอยู่นอกช่วงนี้` +
               (s.outside_oldest ? ` (${s.outside_oldest} – ${s.outside_newest})` : "") +
               ` — กดปุ่มล่างดูทั้งหมด`);
  }
  // ต้องบอกยอดด้วย ไม่ใช่แค่จำนวน — ยอดพวกนี้ไม่ถูกรวมใน รับ/จ่าย/คงเหลือ
  // ถ้าบอกแค่ "1 รายการ" ผู้ใช้จะเห็นการ์ดขึ้น 0.00 ทั้งที่เพิ่งบันทึกเงินไป
  if (s.unknown_n) {
    notes.push(`⚠️ ${s.unknown_n} รายการยังไม่รู้ว่ารับหรือจ่าย` +
               (s.unknown_cents ? ` รวม ${fromCents(s.unknown_cents)} ฿ (ยังไม่นับในยอดข้างบน)` : "") +
               ` — กด “รายการล่าสุด” เพื่อระบุ`);
  }
  // บอกด้วยว่ามันคืออะไรและต้องทำอะไร — เดิมเขียนแค่ "1 รายการรอตรวจยอด"
  // ผู้ใช้ไม่รู้ว่ารายการไหน ไม่รู้ว่าต้องทำยังไง และไม่มีปุ่มพาไป (มีปุ่มให้แล้วที่ footer)
  if (s.pending_n) {
    notes.push(`📝 ${s.pending_n} รายการที่ระบบไม่มั่นใจ — อ่านสลิปได้ไม่ชัด ` +
               `หรือเดาเองว่าเป็นรายรับ/รายจ่าย ยอดถูกนับรวมไปแล้ว ` +
               `กดปุ่มล่างเพื่อดูว่ารายการไหน`);
  }
  if (notes.length) {
    body.push({
      type: "box", layout: "vertical", margin: "lg", paddingAll: "md", cornerRadius: "md",
      backgroundColor: "#FBF0DA", spacing: "xs",
      contents: notes.map((t) => ({ type: "text", text: t, size: "xxs", color: "#9A6B12", wrap: true })),
    });
  }

  const bubble = {
    type: "bubble",
    header: {
      type: "box", layout: "horizontal", backgroundColor: "#F7F5F2", paddingAll: "md",
      contents: [{ type: "text", text: `📊 ${s.title ?? "สรุปรายเดือน"}`,
                   weight: "bold", size: "sm", color: "#1F1F1F" }],
    },
    body: { type: "box", layout: "vertical", paddingAll: "lg", contents: body },
    footer: {
      type: "box", layout: "vertical", spacing: "sm", paddingAll: "md",
      contents: [
        // ต้องมีทางกดไปดูว่า "รายการที่ระบบไม่มั่นใจ" คืออันไหน
        // ไม่งั้นหมายเหตุนั้นเป็นแค่ข้อความที่ทำอะไรต่อไม่ได้
        ...(s.pending_n ? [{
          type: "button", height: "sm", style: "primary", color: "#9A6B12",
          action: { type: "postback", label: "📝 ดูรายการที่ต้องตรวจ", data: "act=list&s=pending" },
        }] : []),
        ...(s.outside_n ? [{
          type: "button", height: "sm", style: "primary", color: "#2E5B7D",
          action: { type: "postback", label: "📅 ดูสรุปทั้งหมด", data: "act=sum&r=all" },
        }] : []),
        // เลื่อนดูเดือนก่อน/ถัดไปด้วยปุ่ม — ไม่ต้องพิมพ์ "สรุป 2026-05" เอง
        {
          type: "box", layout: "horizontal", spacing: "sm",
          contents: [
            { type: "button", height: "sm", style: "secondary",
              action: { type: "postback", label: "◀ เดือนก่อน",
                        data: `act=sum&m=${shiftMonth(s.from, -1)}` } },
            { type: "button", height: "sm", style: "secondary",
              action: { type: "postback", label: "เดือนถัดไป ▶",
                        data: `act=sum&m=${shiftMonth(s.from, 1)}` } },
          ],
        },
        { type: "button", height: "sm", style: "secondary",
          action: { type: "postback", label: "🧾 ดูรายการ", data: "act=list" } },
      ],
    },
  };

  return {
    type: "flex",
    altText: `สรุป: รับ ${fromCents(s.income_cents)} จ่าย ${fromCents(s.expense_cents)} คงเหลือ ${fromCents(s.net_cents)}`,
    contents: bubble,
  };
}

// ==================== รายการล่าสุด (แก้/ลบ) ====================

const DIR_ICON = { in: "💰", out: "💸", unknown: "❓" };

/**
 * ปุ่มไอคอนท้ายแถว — เป็น `box` ที่มี action ไม่ใช่ `button`
 *
 * `button` มี padding ในตัวเยอะ พอวาง 3 อันในความกว้างการ์ด (~260px) ป้ายจะถูกตัด
 * เหลือ "✏️ แ…" / "📂 เป…" อ่านไม่รู้เรื่อง — ใช้ไอคอนล้วนแล้วอธิบายที่หัวการ์ดครั้งเดียว
 * คุ้มกว่า ทั้งอ่านง่ายกว่าและการ์ดสั้นลงแถวละบรรทัด
 */
const CHIP_BG = "#F0EDE8", CHIP_TODO = "#FBF0DA";   // TODO = สีเหลืองอ่อน "ยังไม่ได้ทำ"
const chip = (icon, action, bg = CHIP_BG) => ({
  type: "box", layout: "vertical", cornerRadius: "8px", backgroundColor: bg,
  paddingAll: "6px", action,
  contents: [{ type: "text", text: icon, size: "sm", align: "center", color: "#5A5A5A" }],
});

/** ป้ายบอกว่ากรองอะไรอยู่ — null = ไม่ได้กรอง */
function filterLabel({ dir, cat, pending } = {}) {
  const parts = [];
  if (pending) parts.push("📝 รอตรวจ");
  if (dir === "out") parts.push("💸 รายจ่าย");
  else if (dir === "in") parts.push("💰 รายรับ");
  if (cat === "-") parts.push("🏷 ยังไม่จัดหมวด");
  else if (cat) parts.push(labelOf(cat));
  return parts.length ? parts.join(" · ") : null;
}

/** ปุ่มเลือกหมวดสำหรับ "กรองรายการ" — ต่างจาก categoryButtons ตรงที่ไม่ผูกกับ txn ใด */
export function categoryFilterButtons() {
  const btn = (c) => ({ label: `${c.emoji} ${c.key}`, data: `act=list&c=${encodeURIComponent(c.key)}` });
  const rows = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) rows.push(CATEGORIES.slice(i, i + 2).map(btn));
  return rows;
}

/**
 * รายการล่าสุดพร้อมปุ่มจัดการต่อแถว
 * `filter` = { dir, cat, total } — total คือจำนวนที่ตรงตัวกรองทั้งหมด (ไม่ใช่แค่ที่แสดง)
 */
export function txnListBubble(rows, fromCents, filter = {}) {
  const active = filterLabel(filter);

  if (!rows.length) {
    // กรองแล้วไม่เจอ ≠ ยังไม่เคยบันทึกอะไร — ถ้าโชว์การ์ดสอนใช้งานจะกลายเป็นทางตัน
    // ผู้ใช้ต้องมีปุ่มถอยกลับไปดูทั้งหมดเสมอ
    if (active) {
      return card({
        title: "ไม่พบรายการที่ตรงกับตัวกรอง", emoji: "🔍", tone: "info",
        rows: [{ label: "กรองอยู่", value: active }],
        text: "ลองเอาตัวกรองออก หรือเปลี่ยนไปดูหมวดอื่นครับ",
        actions: [
          { label: "🧾 ดูทั้งหมด", data: "act=list", primary: true },
          { label: "📂 เลือกหมวดอื่น", data: "act=listcat" },
        ],
        altText: `ไม่พบรายการที่ตรงกับ ${active}`,
      });
    }
    return card({
      title: "ยังไม่มีรายการ", emoji: "🧾", tone: "info",
      text: "ส่งรูปสลิปเข้ามา หรือพิมพ์รายการเองก็ได้ครับ",
      rows: [
        { label: "จดรายจ่าย", value: "พิมพ์ “กาแฟ 60”" },
        { label: "จดรายรับ", value: "พิมพ์ “ได้เงินเดือน 30000”" },
      ],
      actions: [{ label: "📊 ดูสรุป", data: "act=summary", primary: true }],
      altText: "ยังไม่มีรายการ — ส่งสลิปหรือพิมพ์ “กาแฟ 60” ได้เลย",
    });
  }

  const items = rows.map((t) => {
    // ปุ่ม 3 ช่องเสมอ แถวที่ใช้ไม่ครบเติม filler — ไอคอนทุกแถวจะได้ตรงคอลัมน์กัน
    const acts = [
      chip("🗑", { type: "postback", label: "ลบ", data: `act=del&id=${t.id}` }),
      // "แก้ยอด" ใช้ fillInText เติม "แก้ 12 " ให้ ผู้ใช้พิมพ์ต่อแค่ตัวเลข
      chip("✏️", { type: "postback", label: "แก้ยอด", data: `act=prompt&kind=edit&id=${t.id}`,
                   inputOption: "openKeyboard", fillInText: `แก้ ${t.id} ` }),
    ];
    // ปุ่มช่องที่ 3 เปลี่ยนตามสถานะ — เอาสิ่งที่ "ค้างอยู่" ขึ้นมาก่อนเสมอ
    // รายการที่ยังไม่ยืนยัน ✅ สำคัญกว่าหมวด เพราะจัดหมวดทีหลังได้
    // แต่ pending ที่ค้างจะไปขึ้นเตือนบนการ์ดสรุปทุกครั้ง
    if (t.status === "pending") {
      // unshift แล้วได้ ✅ 🗑 ✏️ = ครบ 3 ช่องพอดี ไม่ต้องเติม filler
      acts.unshift(chip("✅", { type: "postback", label: "ยืนยันว่าถูก", data: `act=ok&id=${t.id}` },
                        CHIP_TODO));
    // แก้หมวดย้อนหลัง — หมวดถูกเดาให้ตอนบันทึก ถ้าเดาผิดหรือยังไม่ได้จัดต้องแก้จากตรงนี้ได้
    // มีเฉพาะรายจ่าย เพราะหมวดมีไว้คุมงบ/ดูว่าใช้อะไรมากสุด
    // ยังไม่มีหมวด → ปุ่มเป็นสีเหลือง สะดุดตาว่ายังค้างอยู่
    // (ป้ายข้อความ "จัดหมวด/เปลี่ยนหมวด" ใช้ไม่ได้แล้วเพราะเหลือแต่ไอคอน)
    } else if (t.direction === "out") {
      acts.push(chip("📂", { type: "postback", label: "หมวด", data: `act=catpick&id=${t.id}` },
                     t.category ? CHIP_BG : CHIP_TODO));
    } else if (t.direction === "unknown") {
      acts.push(chip("↕️", { type: "postback", label: "รับหรือจ่าย", data: `act=askdir&id=${t.id}` },
                     CHIP_TODO));
    } else {
      acts.push({ type: "filler" });
    }

    return {
      type: "box", layout: "vertical", margin: "md", spacing: "xs",
      contents: [
        {
          type: "box", layout: "baseline", contents: [
            { type: "text", text: `${DIR_ICON[t.direction] ?? "•"} #${t.id}`, size: "xs",
              color: "#8A8A8A", flex: 3 },
            { type: "text", text: `${fromCents(t.amount_cents)} ฿`, size: "sm", weight: "bold",
              align: "end", color: t.direction === "in" ? "#2E7D5B" : "#1F1F1F", flex: 4 },
          ],
        },
        {
          // รายละเอียดกับปุ่มอยู่บรรทัดเดียวกัน ปุ่มชิดขวาท้ายรายการ
          type: "box", layout: "horizontal", spacing: "xs", contents: [
            {
              type: "text", flex: 6, gravity: "center", size: "xxs", wrap: true,
              color: t.status === "pending" ? "#9A6B12" : "#B0B0B0",
              // ติดป้าย "รอตรวจ" ให้เห็นว่าแถวไหนคือตัวที่การ์ดสรุปเตือนถึง
              text: [t.status === "pending" ? "📝 รอตรวจ" : null,
                     t.occurred_at?.slice(0, 16), t.note || t.counterparty, labelOf(t.category)]
                .filter(Boolean).join(" · ") || "—",
            },
            { type: "box", layout: "horizontal", flex: 5, spacing: "xs", contents: acts },
          ],
        },
        { type: "separator", margin: "md" },
      ],
    };
  });

  // อธิบายไอคอนครั้งเดียวที่หัวการ์ด — โชว์เฉพาะไอคอนที่มีจริงในชุดนี้
  const legend = [
    rows.some((t) => t.status === "pending") ? "✅ ยืนยันว่าถูก" : null,
    "🗑 ลบ", "✏️ แก้ยอด",
    rows.some((t) => t.status !== "pending" && t.direction === "out") ? "📂 หมวด" : null,
    rows.some((t) => t.status !== "pending" && t.direction === "unknown") ? "↕️ รับ/จ่าย" : null,
  ].filter(Boolean).join(" · ");

  const fbtn = (label, data, on) => ({
    type: "button", height: "sm", style: on ? "primary" : "secondary",
    ...(on ? { color: "#2E5B7D" } : {}),
    action: { type: "postback", label, data },
  });
  const noFilter = !filter.dir && !filter.cat;

  return {
    type: "flex",
    altText: active
      ? `รายการ ${active} — ${rows.length} รายการ`
      : `รายการล่าสุด ${rows.length} รายการ`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "horizontal", backgroundColor: "#F7F5F2", paddingAll: "md",
        contents: [{ type: "text", weight: "bold", size: "sm", wrap: true,
                     text: active ? `🧾 รายการ · ${active}` : "🧾 รายการล่าสุด" }],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "lg",
        contents: [
          { type: "text", text: legend, size: "xxs", color: "#8A8A8A", wrap: true },
          // บอกตรง ๆ ว่าที่เห็นเป็นแค่บางส่วน ไม่งั้นผู้ใช้นึกว่ามีอยู่เท่านี้แล้วสรุปผิด
          ...(filter.total > rows.length
            ? [{ type: "text", text: `แสดง ${rows.length} จาก ${filter.total} รายการ`,
                 size: "xxs", color: "#B0B0B0", margin: "xs" }]
            : []),
          ...items,
        ],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "md",
        contents: [
          { type: "box", layout: "horizontal", spacing: "sm", contents: [
              fbtn("💸 รายจ่าย", "act=list&d=out", filter.dir === "out"),
              fbtn("💰 รายรับ", "act=list&d=in", filter.dir === "in"),
            ] },
          { type: "box", layout: "horizontal", spacing: "sm", contents: [
              fbtn("🧾 ทั้งหมด", "act=list", noFilter),
              fbtn("📂 ตามหมวด", "act=listcat", !!filter.cat),
            ] },
          { type: "button", height: "sm", style: "link",
            action: { type: "postback", label: "📊 ดูสรุป", data: "act=summary" } },
        ],
      },
    },
  };
}
