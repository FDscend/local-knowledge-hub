export type EvaluationCaseDefinition = {
  externalId: string;
  question: string;
  expectedTitles: string[];
};

export const DEFAULT_EVALUATION_SET_NAME = "默认收件箱回归（自动候选）";
export const LEGACY_DEFAULT_EVALUATION_SET_NAME = "阶段 2 问答回归（自动候选）";
export const DEFAULT_EVALUATION_SET_DESCRIPTION = "由当前知识库文档章节自动生成的候选题（LLM 生成，externalId 为 auto- 前缀），尚未完成人工审核，只用于检索冒烟和回归比较。";

export const defaultEvaluationCases: EvaluationCaseDefinition[] = [
  {
    externalId: "Q-001",
    question: "什么是检索增强生成（RAG）？它由哪几个环节组成？",
    expectedTitles: ["RAG检索增强生成"],
  },
  {
    externalId: "Q-002",
    question: "混合检索为什么需要同时考虑词法与语义两路候选？",
    expectedTitles: ["混合检索"],
  },
  {
    externalId: "Q-003",
    question: "向量索引中的 Embedding 是怎么生成的？",
    expectedTitles: ["向量索引与Embedding"],
  },
  {
    externalId: "Q-004",
    question: "SQLite FTS5 全文索引支持哪些查询特性？",
    expectedTitles: ["SQLite FTS5"],
  },
  {
    externalId: "Q-005",
    question: "RRF 是如何融合多路候选排名的？",
    expectedTitles: ["重排序与RRF"],
  },
  {
    externalId: "Q-006",
    question: "文档入库时为什么按标题层级切片？",
    expectedTitles: ["知识库切片"],
  },
  {
    externalId: "Q-007",
    question: "Hit@K 与 MRR 分别衡量检索的什么能力？",
    expectedTitles: ["检索评测指标"],
  },
  {
    externalId: "Q-008",
    question: "Markdown 表格与任务列表如何书写？",
    expectedTitles: ["Markdown语法"],
  },
  {
    externalId: "Q-009",
    question: "Next.js 服务端组件与客户端组件如何区分？",
    expectedTitles: ["Next.js"],
  },
  {
    externalId: "Q-010",
    question: "飞书文档如何转换成 Markdown 导入？",
    expectedTitles: ["飞书文档转换"],
  },
];
