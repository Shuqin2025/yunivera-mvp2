// backend/modules/reports/templateClusterReport.js
import fs from 'node:fs/promises';
import path from 'node:path';

function getSaveDir() {
  return process.env.DIAG_SAVE_DIR || 'logs/diagnostics';
}

export function summarizeClusters(clusters = []) {
  const bySize = clusters.map((c, i) => ({
    id: c.id ?? i,
    size: Array.isArray(c.items) ? c.items.length : 0,
    label: c.label ?? `cluster#${i}`,
    sampleUrl: c.items?.[0]?.url || null,
  })).sort((a, b) => b.size - a.size);

  return {
    clusters: bySize,
    totalClusters: bySize.length,
    totalSamples: bySize.reduce((acc, c) => acc + c.size, 0),
    generatedAt: new Date().toISOString(),
  };
}

export async function writeClusterReport(clusters = [], filename = 'templateClusterReport.json') {
  const dir = path.resolve(process.cwd(), getSaveDir());
  const file = path.join(dir, filename);
  await fs.mkdir(dir, { recursive: true });
  const report = summarizeClusters(clusters);
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  return { file, report };
}
