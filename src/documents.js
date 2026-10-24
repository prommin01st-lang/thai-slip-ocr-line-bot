import { UserError } from "./errors.js";
import * as L from "./ledger.js";
import { atomic, toCents, nowLocal } from "./db.js";
import { replayWrite } from "./replay.js";

const clean = (s, max = 500) => {
  if (
    typeof s !== "string" ||
    !s.trim() ||
    s.length > max ||
    /[\x00-\x08\x0b-\x1f]/.test(s)
  )
    throw new UserError("ข้อความว่าง ยาวเกิน หรือมีอักขระที่ใช้ไม่ได้");
  return s.trim();
};
export function setIssuer(userId, text) {
  if (!L.hasConsent(userId)) throw new UserError("กรุณาให้ความยินยอมก่อน");
  const [name, address, phone = ""] = text.split("|").map((s) => s.trim());
  L.setPref(
    userId,
    "document_issuer",
    JSON.stringify({
      name: clean(name, 120),
      address: clean(address, 500),
      phone: phone.slice(0, 40),
    }),
  );
}
export function parseDocument(text) {
  const lines = text.trim().split(/\r?\n/);
  const m = /^(บิล|ใบเสร็จ)\s+(.+)$/.exec(lines.shift());
  if (!m) throw new UserError("เริ่มด้วย บิล หรือ ใบเสร็จ ตามด้วยชื่อลูกค้า");
  const [name, address = ""] = m[2].split("|").map((s) => s.trim());
  const items = [];
  let discountCents = 0,
    note = "";
  for (const line of lines.filter((s) => s.trim())) {
    const p = line.split("|").map((s) => s.trim());
    if (p[0] === "ส่วนลด") {
      discountCents = toCents(p[1]);
      if (discountCents === null) throw new UserError("ส่วนลดไม่ถูกต้อง");
    } else if (p[0] === "หมายเหตุ") note = clean(p.slice(1).join(" | "));
    else {
      const quantity = Number(p[1]),
        unitCents = toCents(p[2]);
      if (
        p.length !== 3 ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 100000 ||
        unitCents === null ||
        !Number.isSafeInteger(unitCents * quantity)
      )
        throw new UserError("รายการใช้รูปแบบ ชื่อ | จำนวนเต็ม | ราคาต่อหน่วย");
      items.push({ name: clean(p[0], 160), quantity, unitCents });
    }
  }
  return {
    kind: m[1] === "บิล" ? "invoice" : "receipt",
    customer: { name: clean(name, 120), address: address.slice(0, 500) },
    items,
    discountCents,
    note,
  };
}
function snapshotFor(userId, input) {
  if (!L.hasConsent(userId)) throw new UserError("กรุณาให้ความยินยอมก่อน");
  const issuer = JSON.parse(L.getPref(userId, "document_issuer") || "null");
  if (!issuer)
    throw new UserError("ตั้งข้อมูลผู้ออกก่อน: ผู้ออก ชื่อ | ที่อยู่ | โทร");
  if (
    !["invoice", "receipt"].includes(input.kind) ||
    !Array.isArray(input.items) ||
    !input.items.length ||
    input.items.length > 50
  )
    throw new UserError("เอกสารต้องมี 1–50 รายการ");
  const items = input.items.map((i) => {
    if (
      !Number.isSafeInteger(i.quantity) ||
      i.quantity < 1 ||
      i.quantity > 100000 ||
      !Number.isSafeInteger(i.unitCents) ||
      i.unitCents < 0
    )
      throw new UserError("จำนวนหรือราคาไม่ถูกต้อง");
    const totalCents = i.quantity * i.unitCents;
    if (!Number.isSafeInteger(totalCents)) throw new UserError("ยอดสูงเกินไป");
    return {
      name: clean(i.name, 160),
      quantity: i.quantity,
      unitCents: i.unitCents,
      totalCents,
    };
  });
  const subtotalCents = items.reduce((sum, i) => sum + i.totalCents, 0),
    discountCents = input.discountCents ?? 0;
  if (
    !Number.isSafeInteger(subtotalCents) ||
    subtotalCents > 100000000000 ||
    !Number.isSafeInteger(discountCents) ||
    discountCents < 0 ||
    discountCents > subtotalCents
  )
    throw new UserError("ส่วนลดหรือยอดรวมไม่ถูกต้อง");
  const txn = input.txnId ? L.getTxn(userId, input.txnId) : null;
  if (
    input.txnId &&
    (!txn ||
      txn.status !== "confirmed" ||
      txn.direction !== "in" ||
      txn.currency !== "THB" ||
      txn.amount_cents !== subtotalCents - discountCents)
  )
    throw new UserError(
      "ผูกได้กับรายรับ THB ที่ยืนยันแล้วและยอดตรงกันเท่านั้น",
    );
  return {
    issuer,
    customer: {
      name: clean(input.customer?.name, 120),
      address: (input.customer?.address || "").slice(0, 500),
    },
    items,
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
    note: (input.note || "").slice(0, 500),
    currency: "THB",
    date: nowLocal().slice(0, 10),
  };
}
export function createDraft(userId, input) {
  return replayWrite(L.db(), () =>
    atomic(L.db(), () => {
      const snapshot = snapshotFor(userId, input);
      const id = L.db()
        .prepare(
          `INSERT INTO documents(line_user_id,kind,snapshot,txn_id,created_at) VALUES(?,?,?,?,?)`,
        )
        .run(
          userId,
          input.kind,
          JSON.stringify(snapshot),
          input.txnId ?? null,
          new Date().toISOString(),
        ).lastInsertRowid;
      return getDocument(userId, Number(id));
    }),
  );
}
export function updateDraft(userId, id, input) {
  const doc = getDocument(userId, id);
  if (!doc || doc.status !== "draft")
    throw new UserError("แก้ได้เฉพาะฉบับร่างของคุณ");
  const snapshot = snapshotFor(userId, input);
  L.db()
    .prepare(
      "UPDATE documents SET kind=?,snapshot=?,txn_id=? WHERE id=? AND line_user_id=? AND status='draft'",
    )
    .run(input.kind, JSON.stringify(snapshot), input.txnId ?? null, id, userId);
  return getDocument(userId, id);
}
export function getDocument(u, id) {
  const row = L.db()
    .prepare("SELECT * FROM documents WHERE line_user_id=? AND id=?")
    .get(u, id);
  return row ? { ...row, snapshot: JSON.parse(row.snapshot) } : null;
}
export const listDocuments = (u) =>
  L.db()
    .prepare(
      "SELECT id,kind,status,number FROM documents WHERE line_user_id=? ORDER BY id DESC LIMIT 10",
    )
    .all(u);
export function issueDocument(u, id) {
  return atomic(L.db(), () => {
    const doc = getDocument(u, id);
    if (!doc) throw new UserError("ไม่พบเอกสาร");
    if (doc.status === "issued") return doc;
    if (doc.status !== "draft") throw new UserError("เอกสารถูกยกเลิกแล้ว");
    if (doc.txn_id) {
      const t = L.getTxn(u, doc.txn_id);
      if (
        !t ||
        t.status !== "confirmed" ||
        t.direction !== "in" ||
        t.currency !== "THB" ||
        t.amount_cents !== doc.snapshot.totalCents
      )
        throw new UserError("รายการรับเงินเปลี่ยนแล้ว กรุณาสร้างฉบับร่างใหม่");
    }
    // Freeze a current issue date, while retaining all monetary and party snapshots.
    doc.snapshot.date = nowLocal().slice(0, 10);
    const prefix = `${doc.kind === "invoice" ? "INV" : "RCT"}-${doc.snapshot.date.slice(0, 4)}`;
    const n = L.db()
      .prepare(
        `INSERT INTO document_sequences VALUES(?,1) ON CONFLICT(prefix)
      DO UPDATE SET value=value+1 RETURNING value`,
      )
      .get(prefix).value;
    L.db()
      .prepare(
        "UPDATE documents SET status='issued',number=?,snapshot=?,issued_at=? WHERE id=?",
      )
      .run(
        `${prefix}-${String(n).padStart(6, "0")}`,
        JSON.stringify(doc.snapshot),
        new Date().toISOString(),
        id,
      );
    return getDocument(u, id);
  });
}
export function cancelDocument(u, id) {
  return (
    L.db()
      .prepare(
        "UPDATE documents SET status='cancelled',cancelled_at=? WHERE line_user_id=? AND id=? AND status!='cancelled'",
      )
      .run(new Date().toISOString(), u, id).changes > 0
  );
}
export function receiptForTransaction(u, id, customer) {
  const t = L.getTxn(u, id);
  if (
    !t ||
    t.direction !== "in" ||
    t.status !== "confirmed" ||
    t.currency !== "THB"
  )
    throw new UserError("เลือกเฉพาะรายรับ THB ที่ยืนยันแล้ว");
  return createDraft(u, {
    kind: "receipt",
    customer: { name: customer },
    txnId: id,
    items: [
      {
        name: t.note || t.counterparty || `รับชำระรายการ #${id}`,
        quantity: 1,
        unitCents: t.amount_cents,
      },
    ],
  });
}
