import assert from "node:assert/strict";
import fs from "node:fs";
import { open } from "../src/db.js";
import * as L from "../src/ledger.js";
import { normalizeDocument } from "../src/ocrDocument.js";
import * as ocr from "../src/ocrClient.js";

const fixtures=JSON.parse(fs.readFileSync(new URL("./fixtures/parser-output.json",import.meta.url)));
const db=open(":memory:");L.setDb(db);const u="ocr-doc-probe";
L.ensureUser(u);L.grantConsent(u);
for(const [kind,cents]of [["transfer",25000],["receipt",3210],["payslip",3005000]]){
  const rec=L.recordSlip(u,fixtures[kind],{imageSha256:kind});
  assert.equal(rec.ok,true,kind);assert.equal(rec.amountCents,cents,kind);
}
assert.equal(normalizeDocument({...fixtures.receipt,amount:"9999.00"}).amount,"32.10");
assert.equal(normalizeDocument({...fixtures.payslip,net_pay:null,amount:"32000.00"}).amount,null);
const repeat=L.recordSlip(u,fixtures.receipt,{imageSha256:"different-receipt-same-day"});
assert.equal(repeat.ok,true,"date-only receipts must not be merged by a fictitious midnight timestamp");
assert.equal(L.recordSlip(u,fixtures.receipt,{imageSha256:"receipt"}).reason,"duplicate");
globalThis.fetch=async()=>Response.json(fixtures.receipt);
const receipt=await ocr.parseImage(Buffer.from("fixture"));assert.equal(receipt.amount,"32.10");assert.equal(receipt.total,"32.10");
globalThis.fetch=async()=>Response.json({...fixtures.payslip,doc_type:undefined});
assert.equal((await ocr.parseAs(Buffer.from("fixture"),"payslip")).amount,"30,050.00");
globalThis.fetch=async()=>Response.json({count:2,pages:[{...fixtures.receipt,page:1,source:"ocr"},{...fixtures.payslip,page:2,source:"text"}]});
const pdf=await ocr.parsePdf(Buffer.from("fixture"));assert.equal(pdf.pages[0].amount,"32.10");assert.equal(pdf.pages[1].amount,"30,050.00");
assert.equal(pdf.pages[1].page,2);assert.equal(pdf.pages[1].source,"text");
db.close();console.log("ocrDocument.test: parser-native totals/net pay, image/PDF normalization and receipt deduplication passed");
