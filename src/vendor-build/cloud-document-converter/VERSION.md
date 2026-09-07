# cloud-document-converter 固定飞书转换核心

- 上游仓库：https://github.com/whale4113/cloud-document-converter
- 上游版本：packages/lark v2.6.6（`package.json` `version`）；packages/common 同仓
- 固定方式：源码复制自 `.ref/cloud-document-converter/packages/{lark,common}/src`
  到 `src/vendor-build/cloud-document-converter/`，`tsconfig.json` 通过 paths 别名
  `@dolphin/common` 指向本目录 `common/src/index.ts`
- 许可：MIT（见同目录 LICENSE；版权归原作者）
- 复用范围：仅 `packages/lark` 的 Doc / Docx → Markdown AST 与附件提取逻辑
  （`docx.ts` / `env.ts` / `image.ts` / `file.ts` / `utils/mdast.ts`），
  不含扩展菜单、下载 / 剪贴板、浏览器存储或任意文件保存代码
- 运行环境：`env.ts` 直接读取 `window.PageMain` / `window.User`，因此本核心
  只能在“用户已登录且已获页面访问许可的飞书文档页面主上下文”运行；
  `src/lib/feishu.ts`（convertFeishuDocument）为页面侧适配层，
  `src/lib/feishu-import.ts`（importFeishuClipping）为服务端落库入口
- fork 维护标记：所有 .ts 文件头部追加 `// @ts-nocheck`（第三方源码不参与
  本项目类型检查；`src/vendor-build/**` 已加入 tsconfig exclude 与 eslint ignore）
- 运行时依赖：es-toolkit、mdast-util-to-markdown、mdast-util-gfm-\*、
  mdast-util-math、js-base64（项目 package.json 已声明）

升级前必须重跑 `npm run feishu:verify` 导入链路回归；页面侧转换行为需在真实
飞书文档页面验证（不属于本仓库自动化范围）。
