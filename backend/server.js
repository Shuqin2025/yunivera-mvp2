// backend/server.js — cleaned & unified bootstrap
// ------------------------------------------------
// - Global CORS + preflight
// - Image proxy: /v1/api/image and /v1/api/image64 (base64 helper)
// - Snapshots static server (/snapshots/*)
// - Mount unified routers under /v1 and /v1/api
// - Health endpoint
// - Lightweight request logging (no PII)
// ------------------------------------------------

import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";

// Optional utilities (present in repo; keep imports guarded by try/exists)
let logger = console;
try {
  const mod = await import("./lib/logger.js");
  if (mod?.logger) logger = mod.logger;
} catch {}

let autoLogInspector = (_req, _res, next) => next();
try {
  const mod = await import("./modules/diagnostics/autoLogInspector.js");
  if (mod?.autoLogInspector) autoLogInspector = mod.autoLogInspector;
} catch {}

// Routers (must exist in the repo)
const compat = (await import("./routes/compat.js")).default;
const detectRouter = (await import("./routes/detect.js")).default;
const catalogRouter = (await import("./routes/catalog.js")).default;

// ------------------------------------------------
// App init
// ------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

// Minimal access log (method, path, ip, UA first 100 chars)
app.use((req, _res, next) => {
  try {
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.ip || "").trim();
    const ua = (req.headers["user-agent"] || "").slice(0, 100);
    logger.info?.(`[http] ${req.method} ${req.url} ip=${ip} ua="${ua}"`);
  } catch {}
  next();
});

// Global CORS + preflight one-liner
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*, Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,PUT,PATCH,DELETE");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Also keep cors() for safety (exposes headers to the browser)
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang", "X-Adapter"] }));

// Auto log inspector (no-op if module not present)
app.use(autoLogInspector());

// ------------------------------------------------
// Image proxy
// ------------------------------------------------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

app.get("/v1/api/image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "").toLowerCase();
  if (!url) return res.status(400).send("missing url");

  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent": UA,
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: new URL(url).origin + "/",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const ct = r.headers["content-type"] || "image/jpeg";

    // Shortcut: return base64 json if requested
    if (format === "base64") {
      const base64 = Buffer.from(r.data).toString("base64");
      return res.json({ ok: true, contentType: ct, base64: `data:${ct};base64,${base64}` });
    }

    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=604800"); // 7 days
    res.send(r.data);
  } catch (e) {
    logger.error?.("[image] fail:", e?.message || e);
    res.status(502).send("image fetch failed");
  }
});

// Convenience: /v1/api/image64?url=...  -> rewrites to /v1/api/image&format=base64
app.get("/v1/api/image64", (req, res) => {
  const params = new URLSearchParams({ ...req.query, format: "base64" });
  req.url = `/v1/api/image?${params.toString()}`;
  app._router.handle(req, res, () => {});
});

// ------------------------------------------------
// Snapshots static (optional; safe even if folder missing)
// ------------------------------------------------
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || path.resolve("./snapshots");
try {
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
} catch {}

app.use(
  "/snapshots",
  (req, res, next) => {
    const p = path.join(SNAPSHOT_DIR, req.path);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        const list = fs.readdirSync(p).sort().reverse();
        res
          .type("html")
          .send(
            `<h3>/snapshots${req.path}</h3><ul>` +
              list.map((n) => `<li><a href="${encodeURIComponent(n)}/">${n}/</a></li>`).join("") +
              `</ul>`
          );
        return;
      }
    } catch {}
    next();
  },
  (req, res, next) => express.static(SNAPSHOT_DIR)(req, res, next)
);

// ------------------------------------------------
// Mount routers (both /v1 and /v1/api are supported)
// ------------------------------------------------
app.use(["/v1", "/v1/api"], compat);
app.use(["/v1", "/v1/api"], detectRouter);
app.use(["/v1", "/v1/api"], catalogRouter);

// Health
app.get(["/v1/health", "/health", "/api/health", "/"], (_req, res) => {
  res.json({ ok: true, service: "mvp2-backend", ts: Date.now() });
});

// Error handler (keep JSON format)
app.use((err, _req, res, _next) => {
  const status = Number(err?.status) || 500;
  res.status(status).json({
    ok: false,
    error: err?.name || "INTERNAL_ERROR",
    code: err?.code || "INTERNAL_ERROR",
    message: err?.message || "Internal Server Error",
    ts: Date.now(),
  });
});

// ------------------------------------------------
// Start
// ------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info?.(`[mvp2-backend] listening on :${PORT}`));

