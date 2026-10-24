import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { fromCents } from "./db.js";

const font = (name) =>
  fileURLToPath(
    new URL(`../assets/fonts/Sarabun-${name}.ttf`, import.meta.url),
  );
export function renderDocument(record) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: 48,
      bufferPages: true,
      info: {
        Title: record.number || "ฉบับร่าง",
        Author: record.snapshot.issuer.name,
      },
    });
    const parts = [];
    pdf.on("data", (b) => parts.push(b));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(parts)));
    pdf
      .registerFont("Thai", font("Regular"))
      .registerFont("ThaiBold", font("Bold"));
    const s = record.snapshot,
      width = 499;
    const text = (v, options = {}) =>
      pdf
        .font("Thai")
        .fontSize(11)
        .fillColor("#27313B")
        .text(String(v), { width, ...options });
    pdf
      .font("ThaiBold")
      .fontSize(23)
      .fillColor("#173B3B")
      .text(
        record.kind === "invoice"
          ? "ใบแจ้งหนี้ / INVOICE"
          : "ใบเสร็จรับเงิน / RECEIPT",
        { width },
      );
    text(
      record.status === "draft"
        ? "ฉบับร่าง - ยังไม่ได้ออกเอกสาร"
        : record.status === "cancelled"
          ? "ยกเลิกเอกสารแล้ว"
          : "เอกสารออกแล้ว",
    );
    text(
      `เลขที่ ${record.number || `DRAFT-${record.id}`}     วันที่ ${s.date}`,
    );
    pdf.moveDown();
    pdf.font("ThaiBold").fontSize(12).text("ผู้ออกเอกสาร");
    text(s.issuer.name);
    text(s.issuer.address);
    if (s.issuer.phone) text(`โทร ${s.issuer.phone}`);
    pdf.moveDown();
    pdf.font("ThaiBold").fontSize(12).text("ลูกค้า");
    text(s.customer.name);
    if (s.customer.address) text(s.customer.address);
    pdf.moveDown();
    const header = () => {
      const y = pdf.y;
      pdf.save().rect(48, y, width, 26).fill("#E9F0EF").restore();
      pdf.font("ThaiBold").fontSize(10).fillColor("#173B3B");
      for (const [label, x, w, align] of [
        ["รายการ", 54, 255, "left"],
        ["จำนวน", 310, 45, "right"],
        ["ราคา", 360, 75, "right"],
        ["รวม", 440, 100, "right"],
      ])
        pdf.text(label, x, y + 6, { width: w, align });
      pdf.y = y + 34;
      pdf.x = 48;
    };
    header();
    for (const item of s.items) {
      pdf.font("Thai").fontSize(10);
      const height = Math.max(
        28,
        pdf.heightOfString(item.name, { width: 245 }) + 14,
      );
      if (pdf.y + height > 720) {
        pdf.addPage();
        header();
      }
      const y = pdf.y;
      pdf
        .font("Thai")
        .fontSize(10)
        .fillColor("#27313B")
        .text(item.name, 54, y, { width: 245 });
      for (const [value, x, w] of [
        [item.quantity, 310, 45],
        [fromCents(item.unitCents), 360, 75],
        [fromCents(item.totalCents), 440, 100],
      ])
        pdf.text(String(value), x, y, { width: w, align: "right" });
      pdf
        .moveTo(48, y + height - 6)
        .lineTo(547, y + height - 6)
        .strokeColor("#DFE4E5")
        .stroke();
      pdf.y = y + height;
      pdf.x = 48;
    }
    pdf.font("Thai").fontSize(11);
    const summaryHeight =
      145 + (s.note ? pdf.heightOfString(s.note, { width }) : 0);
    if (pdf.y + summaryHeight > 748) pdf.addPage();
    pdf.moveDown();
    text(`ยอดก่อนส่วนลด   ${fromCents(s.subtotalCents)} บาท`, {
      align: "right",
    });
    text(`ส่วนลด   ${fromCents(s.discountCents)} บาท`, { align: "right" });
    pdf
      .font("ThaiBold")
      .fontSize(16)
      .fillColor("#173B3B")
      .text(`ยอดสุทธิ   ${fromCents(s.totalCents)} บาท`, {
        width,
        align: "right",
      });
    pdf.moveDown();
    if (s.note) text(`หมายเหตุ: ${s.note}`);
    if (record.txn_id) text(`อ้างอิงรายการรับเงิน #${record.txn_id}`);
    text("เอกสารทั่วไป - ไม่ใช่ใบกำกับภาษี", { fontSize: 9 });
    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(i);
      pdf
        .font("Thai")
        .fontSize(9)
        .fillColor("#68747C")
        .text(
          `${record.number || "ฉบับร่าง"}  |  หน้า ${i + 1}/${range.count}`,
          48,
          780,
          { width, align: "right", lineBreak: false },
        );
    }
    pdf.end();
  });
}
