#!/usr/bin/env node
import fs from "node:fs";
import dotenv from "dotenv";
import { validateEnv } from "../src/envValidation.js";

// Print names and outcomes only. Never dump compose config / process.env / provider bodies.
const at = process.argv.indexOf("--file"),
  file = at < 0 ? ".env" : process.argv[at + 1];
const e = {
  ...(fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {}),
  ...process.env,
};
const result = validateEnv(
  e,
  process.argv.includes("--production") || e.NODE_ENV === "production",
);
for (const error of result.errors) console.error(`FAIL ${error}`);
for (const warning of result.warnings) console.log(`WARN ${warning}`);
if (fs.existsSync(file) && fs.statSync(file).mode & 0o077) {
  console.error("FAIL env file permissions: use chmod 600");
  result.errors.push("permissions");
}
console.log(`Static configuration: ${result.errors.length ? "FAIL" : "PASS"}`);
if (process.argv.includes("--online") && !result.errors.length) {
  Object.assign(process.env, e);
  const checks = [
    [
      "LINE token",
      async () => {
        const r = await fetch("https://api.line.me/v2/bot/info", {
          headers: { Authorization: `Bearer ${e.LINE_CHANNEL_ACCESS_TOKEN}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error();
      },
    ],
    [
      "LINE webhook configuration",
      async () => {
        const r = await fetch(
          "https://api.line.me/v2/bot/channel/webhook/endpoint",
          {
            headers: { Authorization: `Bearer ${e.LINE_CHANNEL_ACCESS_TOKEN}` },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!r.ok) throw new Error();
        const d = await r.json();
        if (
          !d.active ||
          ![`${e.PUBLIC_URL}/webhook`, `${e.PUBLIC_URL}/line/webhook`].includes(
            d.endpoint,
          )
        )
          throw new Error();
      },
    ],
    [
      "OCR health/auth enabled",
      async () => {
        const r = await fetch(
          `${e.OCR_ENDPOINT || "http://localhost:8101"}/health`,
          { signal: AbortSignal.timeout(10000) },
        );
        const d = await r.json();
        if (!r.ok || !d.loaded || !d.auth) throw new Error();
      },
    ],
  ];
  if (/^(on|true|1)$/i.test(e.EVIDENCE_ENABLED || ""))
    checks.push([
      "S3 bucket access",
      async () => {
        const { storage } = await import("../src/storage.js");
        await storage().check();
      },
    ]);
  if (e.GOOGLE_SA_EMAIL) {
    checks.push(["Google credential token exchange", async () => {
      const { checkCredentials } = await import("../src/sheets.js");
      await checkCredentials();
    }]);
    if (e.CHECK_SPREADSHEET_ID) checks.push(["Google Sheets read access", async () => {
      const { tabs } = await import("../src/sheets.js");
      await tabs(e.CHECK_SPREADSHEET_ID);
    }]);
    else console.log("SKIP Google Sheets target access: no CHECK_SPREADSHEET_ID; user must share/link a sheet");
  }
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch {
      console.error(`FAIL ${name}`);
      result.errors.push(name);
    }
  }
}
process.exitCode = result.errors.length ? 1 : 0;
