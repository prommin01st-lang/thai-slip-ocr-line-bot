import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { open } from "../src/db.js";
import * as L from "../src/ledger.js";
import { Inbox } from "../src/inbox.js";
import { withEvent } from "../src/replay.js";
import { validateEnv } from "../src/envValidation.js";
import { config } from "../src/config.js";
import { setStorage } from "../src/storage.js";
import * as E from "../src/evidence.js";
import * as D from "../src/documents.js";
import { renderDocument } from "../src/documentPdf.js";
import { handleFinance } from "../src/financeCommands.js";

let pass = 0;
const ok = (s) => {
  console.log(`  ✓ ${s}`);
  pass++;
};
const dir = mkdtempSync(join(tmpdir(), "slipingman-test-"));
try {
  const file = join(dir, "test.db");
  let db = open(file);
  L.setDb(db);
  const u = "Ua0000000000000000000000000000000",
    other = "Ub0000000000000000000000000000000";
  for (const id of [u, other]) {
    L.ensureUser(id);
    L.grantConsent(id);
  }
  const event = {
    type: "message",
    source: { type: "user", userId: u },
    webhookEventId: "evt-1",
    message: { type: "text", text: "กาแฟ 60" },
  };
  let crash = true,
    clock = Date.now();
  const worker = new Inbox(
    db,
    async () => {
      L.recordEntry(u, { direction: "out", amountCents: 6000, note: "กาแฟ" });
      if (crash) throw new Error("crash after commit");
    },
    { retryMs: 1, now: () => clock },
  );
  worker.accept([event, event]);
  await worker.drain();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM txns").get().n, 1);
  crash = false;
  clock += 1;
  await worker.drain();
  assert.equal(
    db.prepare("SELECT status FROM event_inbox WHERE event_key='evt-1'").get()
      .status,
    "done",
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM txns").get().n, 1);
  worker.accept([{ ...event, webhookEventId: "evt-2" }]);
  await worker.drain();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM txns").get().n, 2);
  ok(
    "redelivery/crash after accounting commit does not duplicate; a new identical purchase is allowed",
  );

  worker.accept([{ ...event, webhookEventId: "restart" }]);
  db.prepare(
    "UPDATE event_inbox SET status='running' WHERE event_key='restart'",
  ).run();
  db.close();
  db = open(file);
  L.setDb(db);
  let recovered = 0;
  const restarted = new Inbox(db, () => {
    recovered++;
  });
  restarted.recover();
  await restarted.drain();
  assert.equal(recovered, 1);
  assert.equal(
    db
      .prepare("SELECT payload FROM event_inbox WHERE event_key='restart'")
      .get().payload,
    null,
  );
  ok("on-disk inbox survives restart and clears completed message payloads");

  const count = db.prepare("SELECT count(*) n FROM txns").get().n;
  db.exec(
    "CREATE TRIGGER fail_slip BEFORE INSERT ON slips BEGIN SELECT RAISE(ABORT,'disk failure'); END",
  );
  assert.throws(() =>
    L.recordSlip(
      u,
      { amount: "1.00", confidence: "high", banks: [] },
      { imageSha256: "a" },
    ),
  );
  assert.equal(db.prepare("SELECT count(*) n FROM txns").get().n, count);
  db.exec("DROP TRIGGER fail_slip");
  ok("slip metadata failure rolls back the financial transaction");

  const objects = new Map();
  let unavailable = false;
  setStorage({
    put: async (k, b) => {
      if (unavailable) throw new Error("offline");
      objects.set(k, Buffer.from(b));
    },
    get: async (k) => Readable.from([objects.get(k)]),
    delete: async (k) => {
      if (unavailable) throw new Error("offline");
      objects.delete(k);
    },
    check: async () => {},
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const t = L.recentTxns(u)[0],
    before = L.countTxns(u);
  E.beginAttachment(u, t.id);
  assert.equal(E.attachmentIntent(u).txn_id, t.id);
  const proof = await E.attach(u, t.id, png),
    again = await E.attach(u, t.id, png);
  assert.equal(proof.id, again.id);
  assert.equal(L.countTxns(u), before);
  assert.equal(E.getEvidence(other, proof.id), undefined);
  await assert.rejects(() => E.attach(other, t.id, png));
  await assert.rejects(() => E.attach(u, t.id, Buffer.from("<script>")));
  await assert.rejects(() =>
    E.attach(u, t.id, Buffer.alloc(10 * 1024 * 1024 + 1)),
  );
  ok(
    "attachment deduplication, MIME/size checks, ownership; attaching never adds a financial row",
  );

  const path = E.privateLink(u, "evidence", proof.id),
    token = path.split("/").pop();
  assert.equal(E.resolveLink(token).line_user_id, u);
  const expired = E.privateLink(u, "evidence", proof.id, -1).split("/").pop();
  assert.equal(E.resolveLink(expired), undefined);
  config.evidenceEnabled = true;
  config.publicUrl = "https://bot.example.test";
  const sent = [],
    respond = async (e, m) => sent.push(m);
  const finance = (e) =>
    handleFinance(
      { source: { type: "user", userId: u }, ...e },
      { respond, downloadContent: async () => png },
    );
  await finance({ message: { type: "text", text: `แนบหลักฐาน #${t.id}` } });
  await withEvent("attachment-flow", () =>
    finance({ message: { type: "image", id: "file" }, _durable: true }),
  );
  assert.equal(L.countTxns(u), before);
  assert.equal(E.attachmentIntent(u), undefined);
  await withEvent("attachment-flow", () =>
    finance({ message: { type: "image", id: "file" }, _durable: true }),
  );
  assert.equal(L.countTxns(u), before);
  ok(
    "LINE attach prompt → image and replay after intent consumed keep the same transaction",
  );

  D.setIssuer(u, "ร้านกาแฟตัวอย่าง | 123 ถนนสุขุมวิท กรุงเทพฯ | 0812345678");
  const input = D.parseDocument(
    "บิล คุณสมชาย | กรุงเทพมหานคร\nกาแฟคั่วพิเศษ | 2 | 100.25\nส่วนลด | 10\nหมายเหตุ | ชำระภายใน 7 วัน",
  );
  const draft = await withEvent("draft", () => D.createDraft(u, input));
  const repeated = await withEvent("draft", () => D.createDraft(u, input));
  assert.equal(draft.id, repeated.id);
  assert.equal(draft.snapshot.totalCents, 19050);
  D.updateDraft(u, draft.id, { ...input, note: "ขอบคุณที่ใช้บริการ" });
  const issued = D.issueDocument(u, draft.id);
  assert.equal(D.issueDocument(u, draft.id).number, issued.number);
  assert.throws(() => D.updateDraft(u, draft.id, input));
  assert.equal(D.getDocument(other, draft.id), null);
  assert.throws(() => D.issueDocument(other, draft.id));
  D.setIssuer(u, "ร้านชื่อใหม่ | ที่อยู่ใหม่ | 02");
  assert.equal(
    D.getDocument(u, draft.id).snapshot.issuer.name,
    "ร้านกาแฟตัวอย่าง",
  );
  assert.equal(L.countTxns(u), before);
  const second = D.issueDocument(u, D.createDraft(u, input).id);
  assert.notEqual(second.number, issued.number);
  assert.throws(() => D.createDraft(u, { ...input, discountCents: 999999 }));
  const income = L.recordEntry(u, {
    direction: "in",
    amountCents: 19050,
    note: "รับค่ากาแฟ",
  });
  const receipt = D.receiptForTransaction(u, income.txnId, "คุณสมชาย");
  assert.equal(receipt.txn_id, income.txnId);
  assert.throws(() => D.receiptForTransaction(u, t.id, "ผิดรายการ"));
  ok(
    "draft/issue snapshots, discounts, unique numbers, owner isolation and receipt link without extra accounting",
  );

  const pdf = await renderDocument(issued);
  assert.ok(pdf.subarray(0, 5).toString() === "%PDF-");
  writeFileSync("/tmp/slipingman-document-qa.pdf", pdf);
  const many = D.createDraft(u, {
    ...input,
    items: Array.from({ length: 50 }, (_, i) => ({
      name: `รายการทดสอบภาษาไทย ${i + 1} สระและวรรณยุกต์ น้ำดื่ม`,
      quantity: 2,
      unitCents: 12345,
    })),
  });
  const longPdf = await renderDocument(many);
  writeFileSync("/tmp/slipingman-document-multipage-qa.pdf", longPdf);
  ok("Thai invoice and multipage PDF generation");

  const backup = join(dir, "backup.db");
  const backupRun = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "scripts/backup.mjs", backup],
    { encoding: "utf8", env: { ...process.env, DB_PATH: file } },
  );
  assert.equal(backupRun.status, 0, backupRun.stderr);
  const restored = open(backup);
  assert.equal(
    restored.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  for (const table of [
    "txns",
    "documents",
    "evidence",
    "event_inbox",
    "event_results",
  ])
    assert.equal(
      restored.prepare(`SELECT count(*) n FROM ${table}`).get().n,
      db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
    );
  restored.close();
  const extracted = spawnSync(
    "pdftotext",
    ["-layout", "/tmp/slipingman-document-qa.pdf", "-"],
    { encoding: "utf8" },
  );
  if (!extracted.error) {
    assert.match(extracted.stdout, /190\.50/);
    assert.match(extracted.stdout, /INV-\d{4}-/);
  }
  ok(
    "consistent live-WAL backup restores ledger/documents/evidence/jobs; PDF includes readable amounts",
  );

  // Real HTTP routes, including HMAC validation. Only external providers are mocked.
  const outgoing = [];
  globalThis.fetch = async (url, opts) => {
    outgoing.push({ url: String(url), body: opts?.body });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const { app } = await import("../src/index.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const request = (method, path, body = "", headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          method,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (b) => chunks.push(b));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  try {
    assert.equal((await request("GET", path)).status, 200);
    assert.equal(
      (await request("GET", path)).headers["cache-control"],
      "private, no-store, max-age=0",
    );
    assert.equal((await request("GET", "/private/invalid")).status, 404);
    const docPath = E.privateLink(u, "document", issued.id);
    assert.equal(
      (await request("GET", docPath)).headers["content-type"],
      "application/pdf",
    );
    const body = JSON.stringify({
      events: [
        {
          ...event,
          webhookEventId: "http-event",
          message: { type: "text", text: "จ่ายค่าอาหาร 25" },
        },
      ],
    });
    assert.equal(
      (
        await request("POST", "/webhook", body, {
          "content-type": "application/json",
          "x-line-signature": "bad",
        })
      ).status,
      401,
    );
    const signature = createHmac("sha256", config.channelSecret)
      .update(body)
      .digest("base64");
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await request("POST", "/webhook", body, {
            "content-type": "application/json",
            "x-line-signature": signature,
          })
        ).status,
        200,
      );
    for (let i = 0; i < 100; i++) {
      if (
        db
          .prepare(
            "SELECT status FROM event_inbox WHERE event_key='http-event'",
          )
          .get()?.status === "done"
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      db.prepare("SELECT count(*) n FROM txns WHERE amount_cents=2500").get().n,
      1,
    );
    ok(
      "real HTTP: signed webhook redelivery creates one purchase; private download routes enforce token expiry/ownership",
    );
    E.deleteEvidence(u, proof.id);
    assert.equal((await request("GET", path)).status, 404);
    unavailable = true;
    await E.collectGarbage();
    assert.ok(db.prepare("SELECT count(*) n FROM object_gc").get().n > 0);
    unavailable = false;
    db.prepare("UPDATE object_gc SET available_at=0").run();
    await E.collectGarbage();
    assert.equal(objects.size, 0);
    await E.attach(u, t.id, png);
    L.deleteAllData(u);
    assert.equal((await request("GET", docPath)).status, 404);
    assert.equal(
      db.prepare("SELECT count(*) n FROM evidence WHERE line_user_id=?").get(u)
        .n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM documents WHERE line_user_id=?").get(u)
        .n,
      0,
    );
    await E.collectGarbage();
    assert.equal(objects.size, 0);
    ok(
      "deletion revokes links immediately, retries object-store failures, deletes all personal files/documents",
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
  const good = {
    NODE_ENV: "production",
    LINE_CHANNEL_SECRET: "a".repeat(32),
    LINE_CHANNEL_ACCESS_TOKEN: "test",
    OCR_TOKEN: "b".repeat(32),
    PUBLIC_URL: "https://bot.example.test",
    ADMIN_USERS: u,
    DB_PATH: "/app/data/slipingman.db",
  };
  assert.deepEqual(validateEnv(good).errors, []);
  assert.deepEqual(validateEnv({...good,S3_INTERNAL_NETWORK:"on",S3_ENDPOINT:"http://storage:8333"}).errors,[]);
  assert.ok(validateEnv({...good,S3_INTERNAL_NETWORK:"on",S3_ENDPOINT:"http://external.example.com:8333"}).errors.length);
  for (const bad of [
    { OCR_TOKEN: "" },
    { ADMIN_USERS: "" },
    { PUBLIC_URL: "http://localhost" },
    { PORT: "NaN" },
    { GOOGLE_SA_EMAIL: "x" },
    { MAX_IMAGE_BYTES: "9999999999" },
    { EVIDENCE_ENABLED: "on", S3_BUCKET: "" },
  ])
    assert.ok(validateEnv({ ...good, ...bad }).errors.length);
  ok(
    "production validation rejects missing access controls/secrets, invalid limits and incomplete storage configuration",
  );
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`production.test: ${pass}/${pass} passed`);
