// backend/scripts/ci_regression_lossPenalty.js
import reasonRouter from "../routes/reason.js";

function findPostHandler(router, routePath) {
  // Express router internals: router.stack -> layer.route.stack -> handle
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== routePath) continue;

    const postLayer = layer.route.stack.find(
      (s) => s.method && s.method.toLowerCase() === "post"
    );
    if (postLayer && typeof postLayer.handle === "function") return postLayer.handle;
  }
  return null;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const handler = findPostHandler(reasonRouter, "/reason");
  assert(handler, "Cannot find POST /reason handler in reasonRouter");

  const req = {
    body: {
      compressed_bundle: {
        requestId: "demo",
        items: [
          {
            itemId: "1",
            normalized: { title: "t", url: "u", price: { amount: 10, currency: "EUR" } },
          },
        ],
      },
      compression_manifest: {
        summary: { avgLossScore: 0.4 }, // expected lossPenalty = 0.4 * 0.6 = 0.24
      },
    },
  };

  const res = createMockRes();

  await handler(req, res);

  assert(res._json, "No JSON response captured");
  const out = res._json;

  // Summary assertions
  assert(out.summary, "Missing out.summary");
  assert(out.summary.avgLossScore === 0.4, "avgLossScore should echo 0.4");
  assert(Math.abs(out.summary.lossPenalty - 0.24) < 1e-9, "lossPenalty should be 0.24");
  assert(out.summary.status === "needs_review", "status should be needs_review when avgLossScore >= 0.15");
  assert(out.summary.decision === "partial", "decision should be partial when loss is non-trivial");

  // Item assertions
  assert(Array.isArray(out.items) && out.items.length === 1, "items should have length 1");
  const item = out.items[0];
  assert(item.conclusion && typeof item.conclusion.confidence === "number", "item.conclusion.confidence missing");
  assert(Math.abs(item.conclusion.confidence - 0.76) < 1e-9, "confidence should be 0.76 (1 - 0.24)");

  // Rule trace must include G-LOSS-PENALTY
  const hasLossTrace = Array.isArray(item.ruleTrace) && item.ruleTrace.some((r) => r.ruleId === "G-LOSS-PENALTY");
  assert(hasLossTrace, "ruleTrace must include G-LOSS-PENALTY");

  console.log("[regression-lossPenalty] PASS");
  process.exit(0);
}

function createMockRes() {
  return {
    _status: 200,
    _json: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(payload) {
      this._json = payload;
      return this;
    },
  };
}

run().catch((e) => {
  console.error("[regression-lossPenalty] FAIL:", e.message);
  process.exit(1);
});