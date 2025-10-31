/**
 * backend/server.js — clean, stable bootstrap
 * - Global CORS + preflight
 * - Image proxy: /v1/api/image and /v1/api/image64
 * - Snapshots static server
 * - Lightweight HTTP logger
 * - Mount compat/detect/catalog routers under both /v1 and /v1/api
 * - Health endpoints
 */

import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";

// Optional diagnostics (present in your repo)
import compat from "./routes/compat.js";
import detectRouter from "./routes/detect.js";
import catalogRouter from "./routes/catalog.js";
import { logger } from "./lib/logger.js";
import { autoLogInspector } from "./modules/diagnostics/autoLogInspector.js";

const app = express();

/* ──────────────────────────── global middlewares ──────────────────────────── */

// Parse JSON bodies (adjust limit as needed)
app.use(express.json({ limit: "1mb" }));

// Lightweight auto log inspector (safe if module is a no-op)
try { app.use(autoLogInspector()); } catch { /* ignore if module not present */ }

// One-shot CORS + preflight so OPTIONS never blocks you
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*, Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,PUT,PATCH,DELETE");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Also expose via cors() to add standard headers (safe duplicate)
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang", "X-Adapter"] }));

// Tiny HTTP access log
app.use((req, _res, next) => {
  try {
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.ip || "").trim();
    const ua = (req.headers["user-agent"] || "").slice(0, 120);
    logger?.info?.(`[http] ${req.method} ${req.url} ip=${ip} ua="${ua}"`);
  } catch {}
  next();
});

/* ──────────────────────────── image proxy ──────────────────────────── */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** GET /v1/api/image?url=...&format=(raw|base64)
 *  Proxy-fetches images with proper headers (Referer, UA), returns raw bytes by default,
 *  or base64 JSON when format=base64.
 */
app.get("/v1/api/image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "").toLowerCase();
  if (!url) return res.status(400).send("missing url");

  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      maxRedirects: 5,
      headers: {
        "User-Agent": UA,
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: new URL(url).origin + "/",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const ct = r.headers["content-type"] || "image/jpeg";
    res.set("Access-Control-Allow-Origin", "*");

    if (format === "base64") {
      const base64 = Buffer.from(r.data).toString("base64");
      return res.json({
        ok: true,
        contentType: ct,
        base64: `data:${ct};base64,${base64}`,
      });
    }

    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=604800");
    res.send(r.data);
  } catch (e) {
    logger?.warn?.(`[image] fetch failed: ${e?.message || e}`);
    res.status(502).send("image fetch failed");
  }
});

// Convenience alias that forces format=base64 (you already added this; keep here, before routers)
app.get("/v1/api/image64", (req, res) => {
  const params = new URLSearchParams({ ...req.query, format: "base64" });
  req.url = `/v1/api/image?${params.toString()}`;
  app._router.handle(req, res, () => {});
});

/* ──────────────────────────── snapshots static ──────────────────────────── */

const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || path.resolve("./snapshots");
try { if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch {}

// Directory index for convenience
app.use("/snapshots", (req, res, next) => {
  const p = path.join(SNAPSHOT_DIR, req.path);
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      const list = fs.readdirSync(p).sort().reverse();
      res.type("html").send(
        `<h3>/snapshots${req.path}</h3><ul>` +
          list.map((n) => `<li><a href="${encodeURIComponent(n)}/">${n}/</a></li>`).join("") +
          `</ul>`
      );
      return;
    }
  } catch {}
  next();
}, (req, res, next) => express.static(SNAPSHOT_DIR)(req, res, next));

/* ──────────────────────────── mount routers ──────────────────────────── */

// Mount the three routers under both /v1 and /v1/api to keep old links working
app.use(["/v1", "/v1/api"], compat);
app.use(["/v1", "/v1/api"], detectRouter);
app.use(["/v1", "/v1/api"], catalogRouter);

/* ──────────────────────────── health ──────────────────────────── */

app.get(["/v1/health", "/health", "/api/health", "/"], (_req, res) => {
  res.json({ ok: true, service: "mvp2-backend", ts: Date.now() });
});

/* ──────────────────────────── error handler (always last) ──────────────────────────── */

// Final error guard so any thrown error becomes JSON instead of HTML
// (keep last, after all routes)
app.use((err, req, res, _next) => {
  try {
    const status = Number(err?.status) || 500;
    res.status(status).json({
      ok: false,
      error: err?.name || "INTERNAL_ERROR",
      code: err?.code || "INTERNAL_ERROR",
      message: err?.message || "Internal Server Error",
      ts: Date.now(),
    });
  } catch {
    res.status(500).json({ ok: false, error: "INTERNAL_ERROR", code: "INTERNAL_ERROR", message: "Internal Server Error" });
  }
});

/* ──────────────────────────── listen ──────────────────────────── */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[mvp2-backend] listening on :${PORT}`));
