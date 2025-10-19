// backend/lib/modules/artikelExtractor.js
// 说明：只是一个“占位”实现，防止 templateParser 在启动期 require 时报错。
// 如果以后真要用到这个提取器，再替换成真实逻辑即可。
export default function artikelExtractor(_html) {
  // 返回 null/undefined 表示“没有提取到”，上层据此走原有逻辑即可
  return null;
}
