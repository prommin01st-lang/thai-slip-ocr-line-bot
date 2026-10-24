import { Router } from "express";
import { pipeline } from "node:stream/promises";
import { resolveLink, getEvidence } from "./evidence.js";
import { getDocument } from "./documents.js";
import { renderDocument } from "./documentPdf.js";
import { storage } from "./storage.js";

export const privateRouter = Router();
privateRouter.get("/private/:token", async (req, res) => {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  const link = resolveLink(req.params.token);
  if (!link) return res.sendStatus(404);
  try {
    if (link.kind === "evidence") {
      const file = getEvidence(link.line_user_id, link.target_id);
      if (!file) return res.sendStatus(404);
      const body = await storage().get(file.object_key);
      res.set({
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="evidence-${file.id}.${file.mime.split("/")[1]}"`,
      });
      await pipeline(body, res);
    } else if (link.kind === "document") {
      const doc = getDocument(link.line_user_id, link.target_id);
      if (!doc) return res.sendStatus(404);
      const bytes = await renderDocument(doc);
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${doc.number || `draft-${doc.id}`}.pdf"`,
      });
      res.send(bytes);
    } else res.sendStatus(404);
  } catch {
    if (!res.headersSent) res.sendStatus(503);
    else res.destroy();
  }
});
