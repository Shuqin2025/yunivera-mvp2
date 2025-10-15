// 统一配置中心
export default {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) YuniveraBot/1.0',
  request: {
    timeoutMs: 20000,
    retry: 3,
    retryDelayMs: 800, // 首次退避
    retryJitterMs: 400, // 抖动
  },
  // 并发控制（用于批量 URL）
  concurrency: {
    parse: 3,
    details: 4,
  },
  // 导出
  export: {
    outDir: 'output',
    defaultXlsxName: 'catalog.xlsx',
  },
};
