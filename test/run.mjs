import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const file of readdirSync(new URL("./", import.meta.url))
  .filter((f) => f.endsWith(".test.js"))
  .sort()) {
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      "./test/offline.mjs",
      `test/${file}`,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "test",
        LINE_CHANNEL_SECRET: "test-secret",
        LINE_CHANNEL_ACCESS_TOKEN: "test-token",
        GOOGLE_SA_EMAIL: "",
        GOOGLE_SA_KEY: "",
        PUBLIC_URL: "",
        ADMIN_USERS: "",
        ALLOWED_USERS: "",
        EVIDENCE_ENABLED: "",
        S3_BUCKET: "",
      },
    },
  );
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    break;
  }
}
