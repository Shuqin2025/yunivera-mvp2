// backend/scripts/testFlowRunner.js
import { spawn } from 'node:child_process';
import path from 'node:path';

function runNode(moduleRelPath, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [moduleRelPath, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${moduleRelPath} exit ${code}`))));
    p.on('error', reject);
  });
}

async function main() {
  console.log('=== [flow] start ===');

  // 1) 自检（会生成 selfcheck 报告；我们已在脚本里按日期生成）
  console.log('--- [flow] step1: selfCheck');
  await runNode(path.join('scripts', 'selfCheck.js'));

  // 2) 视需要追加更多环节（示例占位）：
  // console.log('--- [flow] step2: parseHealth');
  // await runNode(path.join('scripts', 'parseHealth.js'));

  // console.log('--- [flow] step3: export snapshot');
  // await runNode(path.join('scripts', 'debugSnapshot.js'));

  console.log('=== [flow] done ===');
}

main().catch((err) => {
  console.error('[flow] failed:', err);
  process.exitCode = 1;
});
