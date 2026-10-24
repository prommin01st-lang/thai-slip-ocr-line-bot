import { UserError } from "./errors.js";
import { config } from "./config.js";
import * as L from "./ledger.js";
import * as E from "./evidence.js";
import * as D from "./documents.js";
import { eventValue } from "./replay.js";
import { card } from "./flex.js";

const urlFor = (u, kind, id) => config.publicUrl + E.privateLink(u, kind, id);
function documentCard(u, doc) {
  return card({
    title: doc.kind === "invoice" ? "บิลเรียกเก็บ" : "ใบเสร็จรับเงิน",
    emoji: "🧾",
    tone: "info",
    text: `#${doc.id} · ${doc.number || "ฉบับร่าง"} · ${doc.status}`,
    rows: [
      { label: "ลูกค้า", value: doc.snapshot.customer.name },
      {
        label: "ยอดสุทธิ",
        value: `${L.fromCents(doc.snapshot.totalCents)} บาท`,
      },
    ],
    notes: [
      "ออกเอกสารไม่เพิ่มยอดในบัญชี",
      ...(doc.status === "draft" ? ["ตรวจ PDF และยืนยันก่อนออกเอกสาร"] : []),
    ],
    actions: [
      ...(config.publicUrl
        ? [
            {
              label: doc.status === "draft" ? "ดูตัวอย่าง PDF" : "เปิด PDF",
              url: urlFor(u, "document", doc.id),
            },
          ]
        : []),
      ...(doc.status === "draft"
        ? [
            {
              label: "ยืนยันออกเอกสาร",
              data: `act=docissue&id=${doc.id}`,
              primary: true,
            },
          ]
        : []),
      ...(doc.status !== "cancelled"
        ? [{ label: "ยกเลิกเอกสาร", data: `act=doccancelask&id=${doc.id}` }]
        : []),
    ],
  });
}
export function evidenceCard(u, id, page = 0) {
  if (!L.getTxn(u, id) || L.getTxn(u, id).status === "rejected")
    throw new UserError("ไม่พบรายการ");
  const files = E.listEvidence(u, id);
  page = Math.min(
    Math.max(Number.isInteger(page) ? page : 0, 0),
    Math.max(Math.ceil(files.length / 4) - 1, 0),
  );
  return [
    card({
      title: `หลักฐานรายการ #${id}`,
      emoji: "📎",
      tone: "info",
      text: `${files.length} ไฟล์ · แนบแล้วไม่เพิ่มยอด · หน้า ${page + 1}`,
      actions: [
        {
          label: "แนบหลักฐานเพิ่ม",
          data: `act=attach&id=${id}`,
          primary: true,
        },
        ...(page > 0
          ? [
              {
                label: "ก่อนหน้า",
                data: `act=evidence&id=${id}&page=${page - 1}`,
              },
            ]
          : []),
        ...((page + 1) * 4 < files.length
          ? [{ label: "ถัดไป", data: `act=evidence&id=${id}&page=${page + 1}` }]
          : []),
      ],
    }),
    ...files.slice(page * 4, page * 4 + 4).map((f) =>
      card({
        title: `หลักฐาน #${f.id}`,
        emoji: "📄",
        tone: "info",
        text: `${f.mime} · ${Math.ceil(f.size_bytes / 1024)} KB`,
        actions: [
          ...(config.publicUrl
            ? [
                {
                  label: "เปิดไฟล์ (ลิงก์ 5 นาที)",
                  url: urlFor(u, "evidence", f.id),
                },
              ]
            : []),
          { label: "ลบหลักฐาน", data: `act=eviddelask&id=${f.id}` },
        ],
      }),
    ),
  ];
}
const issuerFill = (userId) => {
  const issuer = D.getIssuer(userId);
  const existing = issuer
    ? `ผู้ออก ${issuer.name} | ${issuer.address} | ${issuer.phone || ""}`
    : "ผู้ออก ";
  return existing.length <= 300 ? existing : "ผู้ออก ";
};
export function issuerCard(userId, { editing = false, saved = false } = {}) {
  const issuer = D.getIssuer(userId);
  return card({
    title: saved ? "บันทึกข้อมูลผู้ออกแล้ว" : "ข้อมูลผู้ออกเอกสาร",
    emoji: saved ? "✅" : "🏢",
    tone: saved ? "success" : "info",
    text: editing
      ? "แก้ข้อความในช่องพิมพ์ แล้วกดส่งเพื่อบันทึก\nใช้รูปแบบ: ผู้ออก ชื่อร้าน | ที่อยู่ | โทรศัพท์"
      : issuer
        ? "ข้อมูลนี้จะใช้กับเอกสารฉบับใหม่ เอกสารที่ออกแล้วจะคงข้อมูลเดิม"
        : "ยังไม่ได้ตั้งข้อมูลผู้ออก กดกรอกข้อมูลด้านล่างได้เลยครับ",
    rows: issuer
      ? [
          { label: "ชื่อร้าน/บริษัท", value: issuer.name },
          { label: "ที่อยู่", value: issuer.address },
          { label: "โทรศัพท์", value: issuer.phone || "ไม่ระบุ" },
        ]
      : [],
    notes: editing
      ? [
          "ตัวอย่าง: ผู้ออก ร้านตัวอย่าง | 123 ถนนสุขุมวิท กรุงเทพฯ | 0812345678",
          "ต้องมีชื่อและที่อยู่ โทรศัพท์เว้นว่างได้",
        ]
      : [],
    actions: [
      {
        label: issuer ? "แก้ไขข้อมูล" : "กรอกข้อมูลผู้ออก",
        data: "act=issueredit",
        fill: issuerFill(userId),
        primary: true,
      },
      { label: "บิลและใบเสร็จ", data: "act=billing" },
      { label: "กลับตั้งค่า", data: "act=settings" },
    ],
  });
}

export const billingCard = (userId, { guide = false } = {}) =>
  card({
    title: "บิลและใบเสร็จ",
    emoji: "🧾",
    tone: "info",
    text: guide
      ? "ตั้งผู้ออกครั้งแรก:\nผู้ออก ร้านตัวอย่าง | ที่อยู่ | โทร\n\nสร้างฉบับร่าง:\nบิล ชื่อลูกค้า | ที่อยู่ลูกค้า\nสินค้า | 2 | 100\nส่วนลด | 10\nหมายเหตุ | ชำระภายใน 7 วัน\n\nใช้คำว่า “ใบเสร็จ” แทน “บิล” ได้\nผูกใบเสร็จกับรายรับ: ใบเสร็จ #12 ชื่อลูกค้า\nแก้ร่าง: แก้เอกสาร #รหัส แล้วขึ้นบรรทัดใหม่ใส่ข้อมูลเต็มชุด\nดูย้อนหลัง: เอกสาร"
      : "ตั้งข้อมูลผู้ออก แล้วเลือกสร้างบิลหรือใบเสร็จ ตรวจร่าง PDF ก่อนกดยืนยันออกเอกสาร",

    rows: [
      {
        label: "ผู้ออกเอกสาร",
        value: D.getIssuer(userId)?.name || "ยังไม่ได้ตั้งค่า",
      },
    ],
    actions: [
      {
        label: D.getIssuer(userId) ? "ข้อมูลผู้ออกเอกสาร" : "ตั้งค่าผู้ออก",
        data: "act=issuer",
        primary: !D.getIssuer(userId),
      },
      ...(D.getIssuer(userId)
        ? [
            {
              label: "สร้างบิล",
              data: "act=billprompt",
              fill: "บิล ชื่อลูกค้า | ที่อยู่ลูกค้า\nค่าบริการ | 1 | 1000",
              primary: true,
            },
            {
              label: "สร้างใบเสร็จ",
              data: "act=receiptprompt",
              fill: "ใบเสร็จ ชื่อลูกค้า | ที่อยู่ลูกค้า\nค่าบริการ | 1 | 1000",
            },
          ]
        : []),
      { label: "เอกสารของฉัน", text: "เอกสาร" },
      ...(!guide ? [{ label: "วิธีกรอกเอกสาร", data: "act=billinghelp" }] : []),
      { label: "กลับตั้งค่า", data: "act=settings" },
    ],
    notes: [
      "เอกสารทั่วไป ไม่ใช่ใบกำกับภาษี",
      "จำนวนสินค้าเป็นจำนวนเต็ม ราคาเป็นบาท รองรับสตางค์",
    ],
  });

// Return true when consumed, so an attachment never falls through to OCR / a new expense.
export async function handleFinance(event, { respond, downloadContent }) {
  const u = event.source?.userId;
  if (!u) return false;
  const text =
    event.message?.type === "text" ? (event.message.text || "").trim() : "";
  const p = new URLSearchParams(event.postback?.data || ""),
    act = p.get("act"),
    id = Number(p.get("id"));
  // Persist routing before consuming the intent: retry after a crash cannot create a fresh expense.
  const target =
    event.message?.type === "image" || event.message?.type === "file"
      ? eventValue(L.db(), -2, () => E.attachmentIntent(u)?.txn_id ?? null)
      : null;
  const attachmentAct = [
    "attach",
    "evidence",
    "eviddelask",
    "eviddel",
    "attachcancel",
  ].includes(act);
  const docAct = ["doc", "docissue", "doccancelask", "doccancel"].includes(act);
  const settingsAct = [
    "issuer",
    "issueredit",
    "billing",
    "billinghelp",
    "billprompt",
    "receiptprompt",
  ].includes(act);
  const command =
    /^(ผู้ออก(?:\s|$)|ข้อมูลผู้ออก(?:เอกสาร)?$|ตั้งค่าผู้ออก(?:เอกสาร)?$|บิลและใบเสร็จ$|บิล(?:\s|$)|ใบเสร็จ(?:\s|$)|เอกสาร(?:\s|$)|แก้เอกสาร\s|แนบหลักฐาน\s|หลักฐาน\s|ยกเลิกแนบ$|เก็บต้นฉบับ(?:\s|$))/.test(
      text,
    );
  if (!target && !attachmentAct && !docAct && !settingsAct && !command)
    return false;
  try {
    if (!L.hasConsent(u)) throw new UserError("กรุณาพิมพ์ “ยินยอม” ก่อนใช้งาน");
    if (
      act === "issuer" ||
      act === "issueredit" ||
      /^(ผู้ออก|ข้อมูลผู้ออก(?:เอกสาร)?|ตั้งค่าผู้ออก(?:เอกสาร)?)$/.test(text)
    ) {
      await respond(event, issuerCard(u, { editing: act === "issueredit" }));
      return true;
    }
    if (
      act === "billing" ||
      act === "billinghelp" ||
      text === "บิลและใบเสร็จ"
    ) {
      await respond(event, billingCard(u, { guide: act === "billinghelp" }));
      return true;
    }
    if (act === "billprompt" || act === "receiptprompt") {
      if (!D.getIssuer(u)) {
        await respond(event, issuerCard(u));
        return true;
      }
      await respond(
        event,
        card({
          title: act === "billprompt" ? "สร้างร่างบิล" : "สร้างร่างใบเสร็จ",
          emoji: "🧾",
          tone: "info",
          text: "เติมตัวอย่างไว้ในช่องพิมพ์แล้ว แก้ชื่อลูกค้า รายการ จำนวน และราคา แล้วกดส่งเพื่อดูร่าง PDF",
          notes: ["ยังไม่ออกเลขเอกสารจนกว่าจะกดยืนยัน"],
          actions: [
            { label: "ข้อมูลผู้ออกเอกสาร", data: "act=issuer" },
            { label: "กลับเมนูเอกสาร", data: "act=billing" },
          ],
        }),
      );
      return true;
    }
    if (target) {
      if (!config.evidenceEnabled)
        throw new UserError("ยังไม่ได้เปิดพื้นที่เก็บหลักฐาน");
      const bytes = await downloadContent(
        event.message,
        10 * 1024 * 1024,
        "หลักฐาน",
      );
      const f = await E.attach(u, target, bytes);
      await respond(
        event,
        card({
          title: `แนบหลักฐานให้ #${target} แล้ว`,
          emoji: "📎",
          tone: "success",
          text: "ยอดเงินเดิมไม่เปลี่ยน",
          actions: [
            {
              label: "ดูหลักฐาน",
              data: `act=evidence&id=${target}`,
              primary: true,
            },
          ],
        }),
      );
      E.cancelAttachment(u);
      return true;
    }
    if (text === "ยกเลิกแนบ" || act === "attachcancel") {
      E.cancelAttachment(u);
      await respond(
        event,
        card({ title: "ยกเลิกการรอหลักฐานแล้ว", emoji: "📎" }),
      );
      return true;
    }
    if (attachmentAct || /^(แนบหลักฐาน|หลักฐาน|เก็บต้นฉบับ)/.test(text)) {
      if (!config.evidenceEnabled)
        throw new UserError("ยังไม่ได้เปิดพื้นที่เก็บหลักฐาน กรุณาแจ้งผู้ดูแล");
      if (/^เก็บต้นฉบับ/.test(text)) {
        const m = /^เก็บต้นฉบับ\s+(เปิด|ปิด)$/.exec(text);
        if (!m)
          throw new UserError(
            "พิมพ์ “เก็บต้นฉบับ เปิด” เพื่อยินยอมเก็บรูปสลิปที่ส่งครั้งถัดไป หรือ “เก็บต้นฉบับ ปิด”",
          );
        L.setPref(u, "save_originals", m[1] === "เปิด" ? "on" : "off");
        await respond(
          event,
          card({
            title: `${m[1]}การเก็บต้นฉบับแล้ว`,
            emoji: "📎",
            text: "ไฟล์เก็บเป็นหลักฐานส่วนตัว ลบได้จากเมนูหลักฐานหรือลบข้อมูลของฉัน",
          }),
        );
        return true;
      }
      const txnId = id || Number(/#?(\d+)/.exec(text)?.[1]);
      if (act === "eviddelask") {
        if (!E.getEvidence(u, id)) throw new UserError("ไม่พบหลักฐาน");
        await respond(
          event,
          card({
            title: "ยืนยันลบหลักฐาน?",
            emoji: "🗑",
            text: "ยอดเงินในรายการจะไม่เปลี่ยน",
            actions: [{ label: "ยืนยันลบไฟล์", data: `act=eviddel&id=${id}` }],
          }),
        );
        return true;
      }
      if (act === "eviddel") {
        E.deleteEvidence(u, id);
        await respond(
          event,
          card({
            title: "ลบหลักฐานแล้ว",
            emoji: "🗑",
            text: "ไฟล์อยู่ระหว่างลบออกจากพื้นที่จัดเก็บ",
          }),
        );
        return true;
      }
      if (act === "evidence" || /^หลักฐาน/.test(text)) {
        await respond(
          event,
          evidenceCard(u, txnId, Number(p.get("page") || 0)),
        );
        return true;
      }
      E.beginAttachment(u, txnId);
      await respond(
        event,
        card({
          title: `แนบหลักฐานให้ #${txnId}`,
          emoji: "📎",
          tone: "info",
          text: "ส่งรูปหรือ PDF ภายใน 10 นาที ไฟล์นี้จะเก็บเป็นหลักฐานส่วนตัวให้รายการเดิม ไม่เพิ่มยอด\nแนบเพิ่มได้สูงสุด 10 ไฟล์ต่อรายการ",
          actions: [{ label: "ยกเลิก", data: "act=attachcancel" }],
        }),
      );
      return true;
    }
    if (/^ผู้ออก\s/.test(text)) {
      D.setIssuer(u, text.replace(/^ผู้ออก\s+/, ""));
      await respond(event, issuerCard(u, { saved: true }));
      return true;
    }
    if (text === "บิล" || text === "ใบเสร็จ") {
      await respond(event, billingCard(u));
      return true;
    }
    if (/^เอกสาร\s+#?\d+$/.test(text)) {
      const doc = D.getDocument(u, Number(text.match(/\d+/)[0]));
      if (!doc) throw new UserError("ไม่พบเอกสาร");
      await respond(event, documentCard(u, doc));
      return true;
    }
    if (text === "เอกสาร") {
      const docs = D.listDocuments(u);
      await respond(
        event,
        docs.length
          ? card({
              title: "เอกสารล่าสุด",
              emoji: "🧾",
              text: docs
                .map((d) => `#${d.id} ${d.number || "ฉบับร่าง"} · ${d.status}`)
                .join("\n"),
              actions: docs.slice(0, 5).map((d) => ({
                label: `เปิด #${d.id}`,
                data: `act=doc&id=${d.id}`,
              })),
            })
          : billingCard(u),
      );
      return true;
    }
    let doc;
    if (docAct) {
      if (act === "doccancelask") {
        if (!D.getDocument(u, id)) throw new UserError("ไม่พบเอกสาร");
        await respond(
          event,
          card({
            title: "ยืนยันยกเลิกเอกสาร?",
            emoji: "🧾",
            text: "เก็บเลขและประวัติเอกสารเดิมไว้ ยอดบัญชีไม่เปลี่ยน",
            actions: [
              { label: "ยืนยันยกเลิก", data: `act=doccancel&id=${id}` },
            ],
          }),
        );
        return true;
      }
      if (act === "doccancel") D.cancelDocument(u, id);
      doc = act === "docissue" ? D.issueDocument(u, id) : D.getDocument(u, id);
      if (!doc) throw new UserError("ไม่พบเอกสาร");
    } else if (/^แก้เอกสาร/.test(text)) {
      const m = /^แก้เอกสาร\s+#?(\d+)\s*\n([\s\S]+)$/.exec(text);
      if (!m)
        throw new UserError(
          "พิมพ์ แก้เอกสาร #รหัส แล้วขึ้นบรรทัดใหม่ใส่ข้อมูลบิลเต็มชุด",
        );
      doc = D.updateDraft(u, Number(m[1]), D.parseDocument(m[2]));
    } else {
      const m = /^ใบเสร็จ\s+#(\d+)\s+(.+)$/.exec(text);
      doc = m
        ? D.receiptForTransaction(u, Number(m[1]), m[2])
        : D.createDraft(u, D.parseDocument(text));
    }
    await respond(event, documentCard(u, doc));
    return true;
  } catch (err) {
    if (!(err instanceof UserError) && event._durable) throw err;
    await respond(
      event,
      card({
        title: "ยังทำรายการไม่ได้",
        emoji: "⚠️",
        tone: "warn",
        text:
          err instanceof UserError
            ? err.message
            : "ระบบยังไม่พร้อม กรุณาลองอีกครั้ง",
      }),
    );
    return true;
  }
}
