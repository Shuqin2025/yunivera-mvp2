
## 2025-09 · Memoryking 适配器 v2.9 变更
- 列表/详情“真图”抓取：优先 `data-srcset / data-src / data-fallbacksrc / <picture><source>`，过滤 `loader.svg`，缺失时对 **原始 HTML** 做“源码直扫兜底”
- 详情页：URL 含 `/details/`、存在 `.product--detail[s]` 或 `ld+json @type=Product` 时，仅返回 **主商品 1 条**
- 列表：仅匹配真正的 listing 容器（`.listing--container / #listing / .product--listing / .js--isotope`），排除 `related / cross-selling / accessories / slider` 等推荐区
- 服务端（memoryking 分支）：传入 `rawHtml` 给适配器以便兜底直扫，其它站点不受影响
- 回归：S-IMPULS 未受影响；Memoryking 列表与详情均可导出含图片的 Excel
