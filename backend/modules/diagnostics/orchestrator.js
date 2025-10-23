// ESM event-bus for diagnostics
const listeners = new Map(); // stage -> Set<fn>

export function onStage(stage, fn) {
  if (!listeners.has(stage)) listeners.set(stage, new Set());
  listeners.get(stage).add(fn);
}

export async function runStage(stage, ctx = {}) {
  const fns = Array.from(listeners.get(stage) || []);
  for (const fn of fns) {
    try { await fn(ctx); } catch (e) { console.warn('[diagnostics]', stage, e); }
  }
}
