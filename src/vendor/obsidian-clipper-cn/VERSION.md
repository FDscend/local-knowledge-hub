# obsidian-clipper-cn 固定裁剪核心

- 上游仓库：https://github.com/nextcaicai/obsidian-clipper-cn
- 上游版本：v1.4.6（package.json `version`）
- 固定方式：`npm run build:vendor-clipper` 从 `.ref/obsidian-clipper-cn/src/api.ts` bundle 生成 `api.mjs`
- 许可：MIT（见同目录 LICENSE；版权归原作者）
- 裁剪范围：仅保留环境无关的 `clip()` / `matchTemplate()` API 及其依赖
  （正文提取 defuddle、模板编译、frontmatter、图片 URL 归一化），
  不含 browser.*、扩展弹窗、浏览器本地存储、Obsidian URI / CLI 或 vault 写入代码。
- 运行时外部依赖：`defuddle`、`defuddle/full`、`dayjs`（项目 package.json 已声明）

升级前必须重跑 `npm run mcp:verify` 之外的网页剪藏回归（scripts/verify-clipping.ts）。