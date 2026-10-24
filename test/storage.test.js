import assert from "node:assert/strict";
import http from "node:http";
import { config } from "../src/config.js";
import { setStorage, storage } from "../src/storage.js";

// Exercise the actual SDK/HTTP/signing adapter against a tiny local S3 protocol fixture.
// Bucket policy, cloud IAM and the provider's persistence are verified separately at deploy time.
const objects = new Map(),
  requests = [];
const server = http.createServer(async (req, res) => {
  requests.push({
    method: req.method,
    url: req.url,
    auth: req.headers.authorization,
  });
  if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256")) {
    res.writeHead(403).end();
    return;
  }
  const key = req.url.split("?")[0];
  if (req.method === "HEAD") {
    res.writeHead(200).end();
    return;
  }
  if (req.method === "PUT") {
    const chunks = [];
    for await (const b of req) chunks.push(b);
    objects.set(key, Buffer.concat(chunks));
    res.writeHead(200, { ETag: '"fixture"' }).end();
  } else if (req.method === "GET") {
    const b = objects.get(key);
    if (!b) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-length": b.length,
      "content-type": "application/pdf",
    });
    res.end(b);
  } else if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204).end();
  } else res.writeHead(405).end();
});
server.listen(0, "127.0.0.1");
await new Promise((r, j) => {
  server.once("listening", r);
  server.once("error", j);
});
try {
  Object.assign(config, {
    s3Endpoint: `http://127.0.0.1:${server.address().port}`,
    s3Bucket: "private-evidence",
    s3Region: "us-east-1",
    s3AccessKeyId: "test-key",
    s3SecretAccessKey: "test-secret",
    s3ForcePathStyle: true,
  });
  setStorage(null);
  const client = storage(),
    bytes = Buffer.from("%PDF-1.4\nfixture");
  await client.check();
  await client.put("evidence/test", bytes, "application/pdf");
  const stream = await client.get("evidence/test"),
    chunks = [];
  for await (const b of stream) chunks.push(b);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await client.delete("evidence/test");
  assert.equal(objects.size, 0);
  assert.ok(requests.every((r) => r.auth.includes("Credential=test-key/")));
  assert.ok(
    requests.some((r) => r.url.startsWith("/private-evidence/evidence/test")),
  );
  console.log(
    "storage.test: actual S3 SDK HEAD / PUT / GET / DELETE and signing passed",
  );
} finally {
  await new Promise((r) => server.close(r));
}
