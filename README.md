# AI 知识库管理平台

> 把散落的资料，变成随时可检索、可提问、可沉淀的私人知识大脑。

一款运行在**本机**的 AI 知识库平台：导入文档 → 自动切片索引 → 混合检索 → 大模型问答，数据始终留在自己的电脑上。论文、技术文档、笔记、网页剪藏都能装进来，支持创建任意主题的知识库。

## 功能亮点

### 导入即用，全格式支持

- Markdown / Clipping 直接上传；PDF、DOCX、PPTX、XLSX、图片自动经 MinerU 转 Markdown 入库，PDF 默认走免登录轻量模式，复杂版式可切换精准模式
- 支持绑定本机目录同步：显式绑定受控根目录，按目录层级管理文件树，手动 / 选中同步、忽略规则、冲突处理
- 网页剪藏：输入 URL 自动抓取或粘贴 HTML，一键转 Markdown 接入流水线；飞书 Doc / Docx 同样支持转换入库

### 双引擎混合检索

- SQLite FTS5 全文索引：覆盖标题、标签、章节与正文
- 可选 sqlite-vec 语义向量索引：配置 Embedding API 后一键重建
- RRF 候选融合 + MMR 去重：词法与语义互补，查得全、排得准

### AI 多轮问答

- 基于切片证据调用 OpenAI 兼容模型归纳作答，未配置模型时自动降级为检索摘录
- 会话管理：新建、重命名、归档；提问大纲可编辑、点击定位；答案始终附引用来源
- 受控写入：助手可提议新建 / 修改 / 停用知识，只落为**待审核草稿**，人工审阅 diff 后确认应用，绝不直接改库；也可把整个会话总结为新知识草稿

### 知识图谱

- 可视化文档与标签的关系网络：显式链接、共享标签 / 来源、语义近邻三类边，每条边附证据与置信度
- 边类型 / 标签筛选、节点搜索、跳转原文，发现资料之间的隐藏联系

### 多知识库与数据治理

- 知识库逻辑隔离：列表、导入、检索、问答、会话互不串扰
- 版本快照、内容哈希、审计记录；文档导出自动改写内部附件引用
- 后台任务中心：导入、评测、向量重建统一入队，失败自动重试、进度透明

### 检索评测

- 按知识库生成自动候选评测集，一键运行并输出 Hit@K / Recall@5 / MRR 指标
- 历史运行记录与逐题失败定位，让每次检索优化都有数据可依

### 只读 MCP，接入你的 Agent

- 本地 stdio MCP 服务，暴露 `list_knowledge_bases` / `search_knowledge` / `ask_knowledge_base` / `get_document_excerpt` 四个只读工具
- 白名单控制可访问的知识库，每次调用留审计日志，不提供任何写工具
- 可直接接入 VS Code Copilot、Claude Desktop、Claude Code、Codex 等本机 Agent

## 技术栈

- Next.js 16 + React 19 + TypeScript
- Prisma 7 + SQLite（FTS5 / sqlite-vec）
- 问答模型：OpenAI 兼容接口，DeepSeek 等可直接使用
- 文档解析：MinerU（轻量免登录 / 精准两种模式）

## 快速开始

```bash
npm install
npm run db:push
npm run db:generate
npm run db:migrate-stage-a
npm run db:migrate-stage-c
npm run dev
```

访问入口：

- 首页 `/` · 知识管理 `/knowledge` · 新增知识 `/knowledge/new`
- 知识问答 `/qa` · 知识图谱 `/graph` · 审核草稿 `/drafts` · 评测 `/evaluations` · 任务中心 `/tasks`

## 配置 API Key

两种方式，二选一或并存：

1. **页面内“API 设置”**（推荐）：右上角按钮录入 LLM / MinerU / Embedding Key，保存在浏览器本地，不写入数据库与审计日志。
2. `.env` 环境变量：适合长期固定部署。

| 变量                                                           | 说明                                     |
| -------------------------------------------------------------- | ---------------------------------------- |
| `DATABASE_URL`                                                 | SQLite 地址，默认 `file:./prisma/dev.db` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`          | 问答模型（OpenAI 兼容）                  |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`    | DeepSeek 别名配置，与 `OPENAI_*` 二选一  |
| `MINERU_API_KEY`                                               | 精准 MinerU 模式所需；轻量模式免登录     |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` | 语义向量检索；未配置时仅用 FTS5          |
| `KNOWLEDGE_BASE_DATA_DIR`                                      | 可选，覆盖受管数据目录                   |
| `MCP_KNOWLEDGE_BASE_IDS`                                       | 只读 MCP 允许访问的知识库白名单          |

未配置任何 Key 时平台依然可用：问答降级为检索摘录回答，检索使用全文索引。

## 接入本机 Agent（只读 MCP）

MCP 服务走 **stdio**，无需启动 Web 服务即可被本机 Agent 调用。在 `.env` 中通过 `MCP_KNOWLEDGE_BASE_IDS` 白名单配置允许访问的知识库（默认仅 `default`）。

VS Code Copilot：在工作区新建 `.vscode/mcp.json` 并填入以下内容（该目录属本地配置，已加入 `.gitignore`，不会随仓库分发）：

```json
{
  "servers": {
    "ai-knowledge-base": {
      "command": "node",
      "args": ["node_modules/tsx/dist/cli.mjs", "src/mcp/server.ts"],
      "cwd": "${workspaceFolder}",
      "env": { "MCP_KNOWLEDGE_BASE_IDS": "default" }
    }
  }
}
```

Claude Code / Codex 终端添加：

```bash
claude mcp add ai-knowledge-base -- node node_modules/tsx/dist/cli.mjs src/mcp/server.ts
codex mcp add ai-knowledge-base --command node --args "node_modules/tsx/dist/cli.mjs" "src/mcp/server.ts"
```

验证：`npm run mcp:verify`。开发与生产服务固定监听 `127.0.0.1`，不向局域网暴露 Web UI。

## 常用命令

- `npm run knowledge-base:create-sync -- --name="资料库" --root="D:\\受控目录"`：创建绑定目录的知识库
- `npm run knowledge-base:sync -- --knowledgeBaseId=<id>`：手动同步目录知识库
- `npm run knowledge-base:rebuild-vectors -- --knowledgeBaseId=<id>`：重建向量索引
- `npm run validate:qa`：复跑问答验证题
- `npm run evaluate:retrieval`：运行检索评测
- `npm run build` / `npm run lint` / `npm run typecheck`：构建与质量检查

## 目录结构

```text
.
├── docs/                 # 本地开发文档（已忽略，不入库）
├── prisma/               # Prisma schema 与数据库文件
├── .data/knowledge-base/ # 受管对象、配置与任务产物（已忽略）
├── scripts/              # 导入与运维脚本
└── src/                  # Next.js 应用代码
```

> 本地测试材料（如 `materials/` 目录）已加入 `.gitignore`，不会随仓库分发。
