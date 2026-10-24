import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { config } from "../src/config.js";
import * as S from "../src/sheets.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
config.sheetsEnabled = true;
config.googleSaEmail = "probe@test.iam.gserviceaccount.com";
config.googleSaKey = privateKey.export({ type: "pkcs8", format: "pem" });
let calls = 0;
globalThis.fetch = async (url, options) => {
  calls++;
  assert.equal(url, "https://oauth2.googleapis.com/token");
  const form = new URLSearchParams(options.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const payload = JSON.parse(Buffer.from(form.get("assertion").split(".")[1], "base64url"));
  assert.equal(payload.iss, config.googleSaEmail);
  return Response.json({ access_token: "synthetic-probe-token", expires_in: 3600 });
};
assert.equal(await S.checkCredentials(), true);
assert.equal(await S.checkCredentials(), true);
assert.equal(calls, 1);
S._setToken(null);
globalThis.fetch = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
await assert.rejects(() => S.checkCredentials(), (err) => err.status === 400 && err.permanent);
console.log("envProbe.test: OAuth exchange/cache/rejection checked without exposing tokens");
