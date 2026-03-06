// backend/lib/governance/policyContextBuilder.js

export function buildPolicyContext(compressedBundle, compressionManifest) {
  return {
    bundle: compressedBundle || {},
    items: compressedBundle?.items || [],
    manifest: compressionManifest || {},
    loss: {
      avgLossScore: compressionManifest?.summary?.avgLossScore ?? 0
    }
  };
}