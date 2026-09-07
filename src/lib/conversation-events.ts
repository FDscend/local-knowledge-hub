// 侧栏会话列表 / 提问大纲与问答面板的跨组件联动事件。
export const CONVERSATIONS_CHANGED_EVENT = "ai-knowledge-base:conversations-changed";
export const SCROLL_TO_MESSAGE_EVENT = "ai-knowledge-base:scroll-to-message";

export function notifyConversationsChanged(): void {
  window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
}

export function notifyScrollToMessage(messageId: string): void {
  window.dispatchEvent(new CustomEvent<string>(SCROLL_TO_MESSAGE_EVENT, { detail: messageId }));
}
