/**
 * 构建 obsidian-clipper-cn 的环境无关裁剪 API 并固定为版本化产物。
 *
 * 上游：https://github.com/nextcaicai/obsidian-clipper-cn（MIT，v1.4.6）
 * fork 源码：src/vendor-build/clipper-fork/api.ts（仅改动 DefuddleClass 传参，
 * 见文件头部注释）；本脚本与其 scripts/build-api.mjs 等价：
 * bundle 除 dayjs 外的全部代码，并把 webextension-polyfill 替换为 CLI 桩
 * （环境无关，无 browser.* 依赖）。
 */
import "dotenv/config";

import * as esbuild from "esbuild";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const UPSTREAM = path.resolve(".ref/obsidian-clipper-cn");
const FORK_DIR = path.resolve("src/vendor-build/clipper-fork");
const OUT_DIR = path.resolve("src/vendor/obsidian-clipper-cn");

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(FORK_DIR, "api.ts")],
    bundle: true,
    platform: "neutral",
    format: "esm",
    outfile: path.join(OUT_DIR, "api.mjs"),
    // defuddle 为 CJS（UMD）格式，ESM 命名导入在 Node 下不可用，
    // 因此一并内联进产物；dayjs 仅 default import，external 后运行时解析。
    external: ["dayjs"],
    define: { "DEBUG_MODE": "false" },
    alias: { "webextension-polyfill": path.join(FORK_DIR, "utils/cli-stubs.ts") },
    logLevel: "info",
  });

  await copyFile(path.join(UPSTREAM, "LICENSE"), path.join(OUT_DIR, "LICENSE"));
  await writeFile(
    path.join(OUT_DIR, "VERSION.md"),
    [
      "# obsidian-clipper-cn 固定裁剪核心",
      "",
      "- 上游仓库：https://github.com/nextcaicai/obsidian-clipper-cn",
      "- 上游版本：v1.4.6（package.json `version`）",
      "- 固定方式：`npm run build:vendor-clipper` 从 `.ref/obsidian-clipper-cn/src/api.ts` bundle 生成 `api.mjs`",
      "- 许可：MIT（见同目录 LICENSE；版权归原作者）",
      "- 裁剪范围：仅保留环境无关的 `clip()` / `matchTemplate()` API 及其依赖",
      "  （正文提取 defuddle、模板编译、frontmatter、图片 URL 归一化），",
      "  不含 browser.*、扩展弹窗、浏览器本地存储、Obsidian URI / CLI 或 vault 写入代码。",
      "- 运行时外部依赖：`defuddle`、`defuddle/full`、`dayjs`（项目 package.json 已声明）",
      "",
      "升级前必须重跑 `npm run mcp:verify` 之外的网页剪藏回归（scripts/verify-clipping.ts）。",
    ].join("\n"),
  );
  console.log(`clipper API 已构建 → ${path.join(OUT_DIR, "api.mjs")}`);
}

void main();
