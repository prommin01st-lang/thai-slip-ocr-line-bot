import * as receiptSetup from "./receiptSetup.js";
import * as issuerSetup from "./issuerSetup.js";
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
      ...(doc.txn_id
        ? [{ label: "อ้างอิงรายรับ", value: `#${doc.txn_id}` }]
        : []),
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
export function receiptCustomerCard(userId, intent, error = null) {
  const t = L.getTxn(userId, intent.txnId);
  const cancel = { label: "ยกเลิก", data: `act=receiptcancel&f=${intent.id}` };
  if (
    !t ||
    t.direction !== "in" ||
    t.status !== "confirmed" ||
    t.currency !== "THB"
  )
    return card({
      title: "รายการนี้ยังออกใบเสร็จไม่ได้",
      emoji: "🧾",
      tone: "warn",
      text: "เลือกเฉพาะรายรับ THB ที่ยืนยันแล้ว",
      actions: [{ label: "ดูรายการ", data: "act=list" }, cancel],
    });
  return card({
    title: `ใบเสร็จจากรายรับ #${t.id}`,
    emoji: "🧾",
    tone: error ? "warn" : "info",
    text: "พิมพ์ชื่อลูกค้าหรือผู้ชำระเงินได้เลย เช่น สมชาย ใจดี ระบบจะดึงยอดจากรายการนี้มาสร้างร่าง PDF",
    rows: [
      { label: "ยอดรับเงิน", value: `${L.fromCents(t.amount_cents)} บาท` },
      { label: "รายการ", value: t.note || t.counterparty || `#${t.id}` },
      {
        label: "ผู้ออก",
        value: D.getIssuer(userId)?.name || "ยังไม่ได้ตั้งค่า",
      },
    ],
    notes: [
      ...(error ? [error] : []),
      "ไม่เพิ่มยอดบัญชีซ้ำ ตรวจร่างและยืนยันก่อนออกเลขเอกสาร",
      "รอชื่อลูกค้า 10 นาที",
    ],
    actions: [
      ...(t.counterparty && t.counterparty.length <= 120
        ? [
            {
              label: "ใช้ชื่อจากรายการ",
              data: `act=receiptparty&f=${intent.id}`,
            },
          ]
        : []),
      cancel,
    ],
  });
}

export function issuerCard(userId, { saved = false } = {}) {
  const issuer = D.getIssuer(userId);
  return card({
    title: saved ? "บันทึกข้อมูลผู้ออกแล้ว" : "ข้อมูลผู้ออกเอกสาร",
    emoji: saved ? "✅" : "🏢",
    tone: saved ? "success" : "info",
    text: issuer
      ? "ข้อมูลนี้จะใช้กับเอกสารฉบับใหม่ เอกสารที่ออกแล้วจะคงข้อมูลเดิม"
      : "กดกรอกข้อมูลด้านล่าง ระบบจะถามชื่อ ที่อยู่ และโทรศัพท์ทีละช่องครับ",
    rows: issuer
      ? [
          { label: "ชื่อร้าน/บริษัท", value: issuer.name },
          { label: "ที่อยู่", value: issuer.address },
          { label: "โทรศัพท์", value: issuer.phone || "ไม่ระบุ" },
        ]
      : [],
    actions: [
      {
        label: issuer ? "แก้ไขข้อมูล" : "กรอกข้อมูลผู้ออก",
        data: "act=issueredit",
        ...(issuer ? { fill: issuer.name } : { inputOption: "openKeyboard" }),
        primary: true,
      },
      { label: "บิลและใบเสร็จ", data: "act=billing" },
      { label: "กลับตั้งค่า", data: "act=settings" },
    ],
  });
}

export function issuerWizardCard(draft, error = null) {
  const { stage, fields } = draft;
  const action = (name) => `act=${name}&f=${draft.id}&s=${stage}`;
  const titles = {
    name: "ชื่อผู้ออก (1/3)",
    address: "ที่อยู่ผู้ออก (2/3)",
    phone: "โทรศัพท์ (3/3)",
    confirm: "ตรวจข้อมูลผู้ออก",
  };
  const descriptions = {
    name: "พิมพ์ชื่อ-นามสกุล หรือชื่อร้านได้เลย เว้นวรรคระหว่างชื่อและนามสกุลได้ เช่น สมชาย ใจดี",
    address: "พิมพ์ที่อยู่ที่ต้องการแสดงในเอกสารได้เลยครับ",
    phone: "พิมพ์เบอร์โทรศัพท์ หรือกดไม่ระบุโทรศัพท์ได้ครับ",
    confirm: "ตรวจข้อมูลด้านล่าง แล้วกดบันทึกเพื่อใช้ออกเอกสารฉบับใหม่",
  };
  const labels = { name: "ชื่อผู้ออก", address: "ที่อยู่", phone: "โทรศัพท์" };
  const rows =
    stage === "confirm"
      ? [
          { label: labels.name, value: fields.name },
          { label: labels.address, value: fields.address },
          { label: labels.phone, value: fields.phone || "ไม่ระบุ" },
        ]
      : fields[stage]
        ? [{ label: "ข้อมูลเดิม", value: fields[stage] }]
        : [];
  return card({
    title: titles[stage],
    emoji: "🏢",
    tone: error ? "warn" : "info",
    text: descriptions[stage],
    rows,
    notes: [
      ...(error ? [error] : []),
      "เก็บร่างไว้ 10 นาที ข้อมูลเดิมจะเปลี่ยนเมื่อกดบันทึกเท่านั้น",
    ],
    actions: [
      ...(stage === "confirm"
        ? [{ label: "บันทึกข้อมูล", data: action("issuersave"), primary: true }]
        : []),
      ...(stage !== "confirm" && fields[stage]
        ? [{ label: "ใช้ข้อมูลเดิม", data: action("issuerkeep") }]
        : []),
      ...(stage === "phone"
        ? [{ label: "ไม่ระบุโทรศัพท์", data: action("issuerphoneomit") }]
        : []),
      ...(stage !== "name"
        ? [{ label: "ย้อนกลับ", data: action("issuerback") }]
        : []),
      { label: "ยกเลิก", data: action("issuercancel") },
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
  if (!u || (event.type && !["message", "postback"].includes(event.type)))
    return false;
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
  const draft = eventValue(L.db(), -3, () => issuerSetup.getDraft(u));
  const receiptIntent = eventValue(L.db(), -4, () => receiptSetup.getIntent(u));
  const receiptAct = ["txnreceipt", "receiptcancel", "receiptparty"].includes(
    act,
  );
  const issuerActs = [
    "issuersave",
    "issuerback",
    "issuercancel",
    "issuerkeep",
    "issuerphoneomit",
  ];
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
    ...issuerActs,
    "billing",
    "billinghelp",
    "billprompt",
    "receiptprompt",
  ].includes(act);
  const command =
    /^(ผู้ออก(?:\s|$)|ข้อมูลผู้ออก(?:เอกสาร)?$|ตั้งค่าผู้ออก(?:เอกสาร)?$|บิลและใบเสร็จ$|บิล(?:\s|$)|ใบเสร็จ(?:\s|$)|เอกสาร(?:\s|$)|แก้เอกสาร\s|แนบหลักฐาน\s|หลักฐาน\s|ยกเลิกแนบ$|เก็บต้นฉบับ(?:\s|$))/.test(
      text,
    );
  if (
    !target &&
    !attachmentAct &&
    !docAct &&
    !settingsAct &&
    !command &&
    !draft &&
    !receiptAct &&
    !receiptIntent
  )
    return false;
  try {
    if (!L.hasConsent(u)) throw new UserError("กรุณาพิมพ์ “ยินยอม” ก่อนใช้งาน");
    if (act === "txnreceipt") {
      const transaction = D.receiptTransaction(u, id);
      if (draft) issuerSetup.cancel(u, draft.id);
      if (receiptIntent) receiptSetup.cancel(u, receiptIntent.id);
      const existing = D.receiptForEntry(u, id);
      if (existing) {
        await respond(event, documentCard(u, existing));
        return true;
      }
      if (!D.getIssuer(u)) {
        await respond(event, [
          card({
            title: `ตั้งผู้ออกก่อนออกใบเสร็จ #${id}`,
            emoji: "🧾",
            tone: "info",
            text: "ตั้งข้อมูลผู้ออกเอกสารให้เรียบร้อย แล้วกดต่อใบเสร็จจากการ์ดนี้ ยอดรับเงินเดิมยังอยู่ครบ",
            rows: [
              {
                label: "ยอดรับเงิน",
                value: `${L.fromCents(transaction.amount_cents)} บาท`,
              },
            ],
            actions: [
              {
                label: "ตั้งข้อมูลผู้ออก",
                data: "act=issueredit",
                primary: true,
              },
              { label: `ต่อใบเสร็จ #${id}`, data: `act=txnreceipt&id=${id}` },
            ],
          }),
          issuerCard(u),
        ]);
        return true;
      }
      await respond(event, receiptCustomerCard(u, receiptSetup.begin(u, id)));
      return true;
    }
    if (act === "receiptcancel") {
      if (!p.get("f") || !receiptSetup.cancel(u, p.get("f")))
        throw new UserError(
          "คำขอเดิมหมดอายุ กดออกใบเสร็จจากรายการอีกครั้งครับ",
        );
      await respond(
        event,
        card({
          title: "ยกเลิกการสร้างใบเสร็จแล้ว",
          emoji: "🧾",
          text: "รายการรับเงินเดิมยังอยู่ครบ",
          actions: [{ label: "ดูรายการ", data: "act=list" }],
        }),
      );
      return true;
    }
    if (act === "receiptparty") {
      if (!receiptIntent || receiptIntent.id !== p.get("f"))
        throw new UserError("คำขอเดิมหมดอายุ กดออกใบเสร็จอีกครั้งครับ");
      const t = D.receiptTransaction(u, receiptIntent.txnId);
      if (!t.counterparty)
        throw new UserError("ไม่พบชื่อลูกค้า กรุณาพิมพ์ชื่อได้เลยครับ");
      await respond(
        event,
        documentCard(
          u,
          receiptSetup.complete(u, receiptIntent, t.counterparty),
        ),
      );
      return true;
    }
    if (receiptIntent) {
      const nav =
        /^(ตั้งค่า|settings|ช่วยเหลือ|help|บิล|ใบเสร็จ|บิลและใบเสร็จ|เอกสาร|ข้อมูลของฉัน|ลบข้อมูลของฉัน|สรุป|รายการ|ผู้ออก|ข้อมูลผู้ออก(?:เอกสาร)?)$/i.test(
          text,
        );
      const legacy = /^ใบเสร็จ\s+#(\d+)\s+(.+)$/.exec(text);
      const leaving =
        act ||
        nav ||
        (/^ผู้ออก\s/.test(text) && text.includes("|")) ||
        (legacy && Number(legacy[1]) !== receiptIntent.txnId);
      if (leaving) {
        receiptSetup.cancel(u, receiptIntent.id);
        if (
          !target &&
          !attachmentAct &&
          !docAct &&
          !settingsAct &&
          !command &&
          !draft
        )
          return false;
      } else if (!draft) {
        if (/^(ยกเลิก|cancel)$/i.test(text)) {
          receiptSetup.cancel(u, receiptIntent.id);
          await respond(
            event,
            card({
              title: "ยกเลิกการสร้างใบเสร็จแล้ว",
              emoji: "🧾",
              text: "ยอดบัญชีเดิมไม่เปลี่ยน",
              actions: [{ label: "ดูรายการ", data: "act=list" }],
            }),
          );
          return true;
        }
        if (event.message?.type !== "text") {
          await respond(
            event,
            receiptCustomerCard(
              u,
              receiptIntent,
              "กรุณาพิมพ์ชื่อลูกค้า หรือกดยกเลิกก่อนแนบไฟล์",
            ),
          );
          return true;
        }
        await respond(
          event,
          documentCard(
            u,
            receiptSetup.complete(u, receiptIntent, legacy ? legacy[2] : text),
          ),
        );
        return true;
      }
    }
    if (act === "issueredit") {
      await respond(event, issuerWizardCard(issuerSetup.begin(u)));
      return true;
    }
    if (issuerActs.includes(act)) {
      const expected = { id: p.get("f"), stage: p.get("s") };
      if (act === "issuercancel") {
        if (!expected.id || !issuerSetup.cancel(u, expected.id))
          throw new UserError("คำขอเดิมหมดอายุ กดกรอกข้อมูลใหม่ครับ");
        await respond(event, issuerCard(u));
        return true;
      }
      if (act === "issuersave") {
        issuerSetup.save(u, expected.id);
        await respond(event, issuerCard(u, { saved: true }));
        return true;
      }
      if (!draft || draft.id !== expected.id || draft.stage !== expected.stage)
        throw new UserError("ขั้นตอนนี้เปลี่ยนแล้ว กดปุ่มจากการ์ดล่าสุดครับ");
      const next =
        act === "issuerback"
          ? issuerSetup.back(u, expected)
          : issuerSetup.advance(
              u,
              expected,
              act === "issuerphoneomit" ? "" : draft.fields[draft.stage],
            );
      await respond(event, issuerWizardCard(next));
      return true;
    }
    const navigation =
      /^(ตั้งค่า|settings|ช่วยเหลือ|help|บิล|ใบเสร็จ|บิลและใบเสร็จ|เอกสาร|ข้อมูลของฉัน|ลบข้อมูลของฉัน|สรุป|รายการ|ผู้ออก|ข้อมูลผู้ออก(?:เอกสาร)?|ตั้งค่าผู้ออก(?:เอกสาร)?)$/i.test(
        text,
      );
    const legacyIssuer = /^ผู้ออก\s/.test(text) && text.includes("|");
    if (draft && (act || navigation || legacyIssuer)) {
      issuerSetup.cancel(u, draft.id);
      if (!target && !attachmentAct && !docAct && !settingsAct && !command)
        return false;
    }
    if (draft && !act && !navigation && !legacyIssuer) {
      if (event.message?.type !== "text") {
        await respond(
          event,
          issuerWizardCard(
            draft,
            "ขั้นตอนนี้กรุณาส่งข้อความ หรือกดยกเลิกก่อนแนบไฟล์",
          ),
        );
        return true;
      }
      if (/^(ยกเลิก|cancel)$/i.test(text)) {
        issuerSetup.cancel(u, draft.id);
        await respond(event, issuerCard(u));
        return true;
      }
      const value =
        draft.stage === "phone" && /^(ข้าม|ไม่ระบุ|ไม่มี|-)$/i.test(text)
          ? ""
          : draft.stage === "name"
            ? text.replace(/^ผู้ออก\s+/, "")
            : text;
      await respond(
        event,
        issuerWizardCard(issuerSetup.advance(u, draft, value)),
      );
      return true;
    }
    if (
      act === "issuer" ||
      /^(ผู้ออก|ข้อมูลผู้ออก(?:เอกสาร)?|ตั้งค่าผู้ออก(?:เอกสาร)?)$/.test(text)
    ) {
      await respond(event, issuerCard(u));
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
      if (!text.includes("|")) {
        const started = issuerSetup.begin(u);
        await respond(
          event,
          issuerWizardCard(
            issuerSetup.advance(u, started, text.replace(/^ผู้ออก\s+/, "")),
          ),
        );
        return true;
      }
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
    const activeReceipt = receiptSetup.getIntent(u);
    if (activeReceipt && err instanceof UserError) {
      await respond(event, receiptCustomerCard(u, activeReceipt, err.message));
      return true;
    }
    const activeDraft = issuerSetup.getDraft(u);
    if (activeDraft && err instanceof UserError) {
      await respond(event, issuerWizardCard(activeDraft, err.message));
      return true;
    }
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
