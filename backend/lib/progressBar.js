// 终端单行进度条（零依赖）
export class ProgressBar {
  constructor(total, label = 'progress') {
    this.total = Math.max(1, total);
    this.current = 0;
    this.label = label;
    this.start = Date.now();
    this._render();
  }
  tick(step = 1) {
    this.current += step;
    if (this.current > this.total) this.current = this.total;
    this._render();
  }
  _render() {
    const ratio = this.current / this.total;
    const width = 24;
    const filled = Math.round(ratio * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const pct = (ratio * 100).toFixed(1).padStart(5, ' ');
    const elapsed = ((Date.now() - this.start) / 1000).toFixed(1);
    const line = `${this.label} [${bar}] ${pct}% (${this.current}/${this.total}) ${elapsed}s`;
    process.stdout.write('\r' + line + ' '.repeat(8));
    if (this.current >= this.total) process.stdout.write('\n');
  }
}
