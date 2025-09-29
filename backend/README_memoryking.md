# Memoryking 适配器自测清单

> 目标：不依赖 Codespaces，也能本地或任意环境一条条验证。

## 0) 健康检查
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health
# 期望输出：200
