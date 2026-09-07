import type { Message, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { answerQuestion, type AnswerQuestionOptions } from "@/lib/rag";
import { createDraftProposal, type DocumentDraftSummary } from "@/lib/controlled-writes";
import { requireKnowledgeBase } from "@/lib/knowledge-base";

// 单机本地使用者标识；会话历史仅在本机 UI 内使用。
const LOCAL_USER_ID = "local-user";

// 生成回答时带入的近期对话窗口（最近 12 条消息 = 约 6 轮）。
export const CONVERSATION_HISTORY_WINDOW = 12;

export type ConversationCitation = {
  documentId: string;
  title: string;
  sourcePath: string;
};

export type ConversationSummary = {
  id: string;
  knowledgeBaseId: string;
  title: string;
  archived: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  title: string | null;
  content: string;
  citations: ConversationCitation[];
  retrievalMode: "llm" | "extractive" | "empty" | null;
  createdAt: string;
};

export type ConversationDetail = ConversationSummary & {
  messages: ConversationMessage[];
};

export type AskInConversationResult = {
  message: ConversationMessage;
  answer: string;
  retrievalMode: "llm" | "extractive" | "empty";
  sources: ConversationCitation[];
  /** 模型提案经白名单校验后生成的待审核草稿（不直接修改知识）。 */
  createdDrafts: DocumentDraftSummary[];
  /** 提案处理中的提示信息（例如草稿重复被拒）。 */
  draftNotices: string[];
};

function parseCitations(citationsJson: string): ConversationCitation[] {
  try {
    const parsed = JSON.parse(citationsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is ConversationCitation =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as ConversationCitation).documentId === "string" &&
        typeof (item as ConversationCitation).title === "string",
    );
  } catch {
    return [];
  }
}

// 提问要点自动生成：压缩空白后取前 24 个字符。
export function summarizeQuestion(question: string): string {
  const compact = question.replace(/\s+/g, " ").trim();
  return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact;
}

function toMessage(message: Message): ConversationMessage {
  const role = message.role === "assistant" ? ("assistant" as const) : ("user" as const);
  const retrievalMode =
    message.retrievalMode === "llm" || message.retrievalMode === "extractive" || message.retrievalMode === "empty"
      ? message.retrievalMode
      : null;
  return {
    id: message.id,
    role,
    title: message.title,
    content: message.content,
    citations: parseCitations(message.citationsJson),
    retrievalMode,
    createdAt: message.createdAt.toISOString(),
  };
}

function toSummary(
  conversation:
    | Prisma.ConversationGetPayload<{ include: { _count: { select: { messages: true } } } }>
    | Prisma.ConversationGetPayload<{ include: { messages: true } }>,
): ConversationSummary {
  const messageCount =
    "_count" in conversation ? conversation._count.messages : "messages" in conversation ? conversation.messages.length : 0;
  return {
    id: conversation.id,
    knowledgeBaseId: conversation.knowledgeBaseId,
    title: conversation.title,
    archived: conversation.archived,
    messageCount,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

async function requireOwnedConversation(conversationId: string, knowledgeBaseId: string): Promise<{
  id: string;
  knowledgeBaseId: string;
  title: string;
  archived: boolean;
}> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || conversation.knowledgeBaseId !== knowledgeBaseId) {
    throw new Error("会话不存在或不属于当前知识库。");
  }
  return conversation;
}

export async function listConversations(knowledgeBaseId: string): Promise<ConversationSummary[]> {
  await requireKnowledgeBase(knowledgeBaseId);
  const conversations = await prisma.conversation.findMany({
    where: { knowledgeBaseId },
    include: { _count: { select: { messages: true } } },
    orderBy: [{ archived: "asc" }, { updatedAt: "desc" }],
  });
  return conversations.map(toSummary);
}

export async function createConversation(knowledgeBaseId: string, title?: string | null): Promise<ConversationDetail> {
  const knowledgeBase = await requireKnowledgeBase(knowledgeBaseId);
  const conversation = await prisma.conversation.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      title: title?.trim() || "新会话",
    },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  return { ...toSummary(conversation), messages: conversation.messages.map(toMessage) };
}

export async function getConversationDetail(conversationId: string, knowledgeBaseId: string): Promise<ConversationDetail> {
  await requireOwnedConversation(conversationId, knowledgeBaseId);
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  return { ...toSummary(conversation), messages: conversation.messages.map(toMessage) };
}

export async function renameConversation(conversationId: string, title: string, knowledgeBaseId: string): Promise<ConversationSummary> {
  const conversation = await requireOwnedConversation(conversationId, knowledgeBaseId);
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    throw new Error("会话标题不能为空。");
  }
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { title: normalizedTitle },
    include: { _count: { select: { messages: true } } },
  });
  await prisma.auditLog.create({
    data: {
      knowledgeBaseId,
      actor: LOCAL_USER_ID,
      action: "conversation-renamed",
      targetType: "Conversation",
      targetId: conversationId,
      beforeData: JSON.stringify({ title: conversation.title }),
      afterData: JSON.stringify({ title: normalizedTitle }),
    },
  });
  return toSummary(updated);
}

export async function setConversationArchived(conversationId: string, archived: boolean, knowledgeBaseId: string): Promise<ConversationSummary> {
  const conversation = await requireOwnedConversation(conversationId, knowledgeBaseId);
  if (conversation.archived === archived) {
    return toSummary(await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: { _count: { select: { messages: true } } },
    }));
  }
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { archived },
    include: { _count: { select: { messages: true } } },
  });
  await prisma.auditLog.create({
    data: {
      knowledgeBaseId,
      actor: LOCAL_USER_ID,
      action: archived ? "conversation-archived" : "conversation-restored",
      targetType: "Conversation",
      targetId: conversationId,
      afterData: JSON.stringify({ archived }),
    },
  });
  return toSummary(updated);
}

export async function deleteConversation(conversationId: string, knowledgeBaseId: string): Promise<void> {
  await requireOwnedConversation(conversationId, knowledgeBaseId);
  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        knowledgeBaseId,
        actor: LOCAL_USER_ID,
        action: "conversation-deleted",
        targetType: "Conversation",
        targetId: conversationId,
        afterData: JSON.stringify({ deleted: true }),
      },
    });
    await tx.conversation.delete({ where: { id: conversationId } });
  });
}

export async function updateMessageTitle(
  messageId: string,
  title: string,
  knowledgeBaseId: string,
): Promise<ConversationMessage> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { select: { knowledgeBaseId: true } } },
  });
  if (!message || message.conversation.knowledgeBaseId !== knowledgeBaseId) {
    throw new Error("消息不存在或不属于当前知识库。");
  }
  if (message.role !== "user") {
    throw new Error("只有提问消息可以编辑要点标题。");
  }
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    throw new Error("要点标题不能为空。");
  }
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { title: normalizedTitle },
  });
  return toMessage(updated);
}

export async function askInConversation(
  conversationId: string,
  question: string,
  knowledgeBaseId: string,
  options: AnswerQuestionOptions = {},
): Promise<AskInConversationResult> {
  const conversation = await requireOwnedConversation(conversationId, knowledgeBaseId);
  const normalizedQuestion = question.trim();
  if (!normalizedQuestion) {
    throw new Error("问题不能为空。");
  }

  const history = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: CONVERSATION_HISTORY_WINDOW,
    select: { role: true, content: true },
  });

  const userMessage = await prisma.message.create({
    data: { conversationId, role: "user", title: summarizeQuestion(normalizedQuestion), content: normalizedQuestion },
  });

  const result = await answerQuestion(normalizedQuestion, {
    ...options,
    knowledgeBaseId,
    toolProposals: true,
    history: history
      .reverse()
      .filter((item): item is { role: "user" | "assistant"; content: string } => item.role === "user" || item.role === "assistant"),
  });

  const citations: ConversationCitation[] = result.sources.map((source) => ({
    documentId: source.documentId,
    title: source.title,
    sourcePath: source.sourcePath,
  }));

  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: "assistant",
      content: result.answer,
      citationsJson: JSON.stringify(citations),
      retrievalMode: result.retrievalMode,
    },
  });

  // 模型提案只落为待审核草稿，不直接修改知识；失败（重复、越权）只记录提示。
  const createdDrafts: DocumentDraftSummary[] = [];
  const draftNotices: string[] = [];
  if (result.toolProposals.length > 0) {
    for (const proposal of result.toolProposals) {
      try {
        const draft = await createDraftProposal({
          knowledgeBaseId,
          kind: proposal.tool === "propose_document_patch" ? "PATCH" : proposal.tool === "disable_document" ? "DISABLE" : "CREATE",
          documentId: proposal.documentId,
          documentTitle: proposal.documentTitle,
          markdown: proposal.markdown,
          changeReason: proposal.changeReason,
          sourceTool: proposal.tool,
          sourceConversationId: conversationId,
          sourceMessageId: assistantMessage.id,
          modelInfo: options.llmModel ?? null,
          citations,
        });
        createdDrafts.push(draft);
        draftNotices.push(
          `> **知识草稿已生成（待审核）**：《${draft.documentTitle}》(${draft.kind === "CREATE" ? "新建" : draft.kind === "PATCH" ? "修改" : "停用"})，请到「草稿中心」审核后应用。`,
        );
      } catch (error) {
        draftNotices.push(`> 知识提案未生成：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }
  }

  let finalAssistantMessage = assistantMessage;
  if (draftNotices.length > 0) {
    finalAssistantMessage = await prisma.message.update({
      where: { id: assistantMessage.id },
      data: { content: `${result.answer}\n\n${draftNotices.join("\n")}` },
    });
  }

  // 首轮提问且尚未手动重命名时，自动用问题命名会话，便于列表识别。
  if (history.length === 0 && conversation.title === "新会话") {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { title: normalizedQuestion.slice(0, 30) },
    });
  }

  return {
    message: toMessage(finalAssistantMessage),
    answer: result.answer,
    retrievalMode: result.retrievalMode,
    sources: citations,
    createdDrafts,
    draftNotices,
  };
}
