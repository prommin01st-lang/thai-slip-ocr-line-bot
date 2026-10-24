import { createPrivateKey } from "node:crypto";

const truth = (v) => /^(1|true|on|yes)$/i.test(v || "");
export function validateEnv(e, production = e.NODE_ENV === "production") {
  const errors = [],
    warnings = [];
  for (const k of ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN"])
    if (!e[k]?.trim()) errors.push(`${k}: required`);
  for (const [k, min, max] of [
    ["PORT", 1, 65535],
    ["OCR_TIMEOUT_MS", 1000, 900000],
    ["MAX_IMAGE_BYTES", 1024, 10485760],
    ["MAX_PDF_BYTES", 1024, 10485760],
    ["MAX_TEXT_BYTES", 1024, 2097152],
    ["SHEET_SYNC_MS", 1000, 3600000],
  ]) {
    if (
      e[k] &&
      (!Number.isSafeInteger(Number(e[k])) ||
        Number(e[k]) < min ||
        Number(e[k]) > max)
    )
      errors.push(`${k}: integer ${min}..${max} required`);
  }
  for (const k of ["PUBLIC_URL", "OCR_ENDPOINT", "S3_ENDPOINT"])
    if (e[k]) {
      try {
        const u = new URL(e[k]);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password ||
          u.search ||
          u.hash
        )
          throw new Error();
        if (
          k === "PUBLIC_URL" &&
          (u.pathname !== "/" ||
            (production &&
              (u.protocol !== "https:" ||
                /localhost|127\.0\.0\.1|example\.com$/.test(u.hostname))))
        )
          throw new Error();
      } catch {
        errors.push(`${k}: invalid URL`);
      }
    }
  const email = e.GOOGLE_SA_EMAIL?.trim(),
    key = e.GOOGLE_SA_KEY?.trim();
  if (!!email !== !!key)
    errors.push("GOOGLE_SA_EMAIL / GOOGLE_SA_KEY: set both");
  if (email && !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(email))
    errors.push("GOOGLE_SA_EMAIL: invalid");
  if (key) {
    try {
      createPrivateKey(key.replace(/\\n/g, "\n"));
    } catch {
      errors.push("GOOGLE_SA_KEY: invalid private key");
    }
  }
  if (truth(e.EXPORT_CSV) && !e.PUBLIC_URL)
    errors.push("PUBLIC_URL: required for CSV");
  if (truth(e.EVIDENCE_ENABLED) && !e.S3_BUCKET)
    errors.push("S3_BUCKET: required for evidence");
  if (!!e.S3_ACCESS_KEY_ID !== !!e.S3_SECRET_ACCESS_KEY)
    errors.push("S3 credentials: set both");
  if (production) {
    if (!/^[a-f0-9]{32}$/i.test(e.LINE_CHANNEL_SECRET || ""))
      errors.push("LINE_CHANNEL_SECRET: invalid format");
    if (!e.OCR_TOKEN || e.OCR_TOKEN.trim().length < 32)
      errors.push("OCR_TOKEN: at least 32 characters required");
    const admins = (e.ADMIN_USERS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!admins.length)
      errors.push("ADMIN_USERS: explicitly required in production");
    for (const k of ["ADMIN_USERS", "ALLOWED_USERS"])
      if (
        e[k] &&
        !e[k].split(",").every((x) => /^U[a-f0-9]{32}$/i.test(x.trim()))
      )
        errors.push(`${k}: invalid LINE user ID`);
    if (!e.PUBLIC_URL)
      errors.push("PUBLIC_URL: HTTPS origin required in production");
    const internalStorage = truth(e.S3_INTERNAL_NETWORK) && /^http:\/\/storage:8333\/?$/.test(e.S3_ENDPOINT || "");
    if (e.S3_ENDPOINT && !e.S3_ENDPOINT.startsWith("https://") && !internalStorage)
      errors.push("S3_ENDPOINT: HTTPS required in production");
    if (!e.DB_PATH?.startsWith("/app/data/"))
      warnings.push("DB_PATH: confirm a persistent volume covers this path");
  }
  return { errors, warnings };
}
