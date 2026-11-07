"use client";

import { createContext, useContext } from "react";

import type { useChat } from "@/lib/use-chat";

/**
 * 会话状态的传递通道。
 *
 * Provider 挂在 (chat) layout 上，所以它的生命周期比任何页面都长 ——
 * 切会话时只有 page 子树被替换，Provider 里的会话列表、消息、流式订阅、
 * 输入框草稿都还在。这是"状态提升"的全部内容。
 */

export type ChatController = ReturnType<typeof useChat>;

export const ChatContext = createContext<ChatController | null>(null);

export function useChatContext(): ChatController {
  const value = useContext(ChatContext);
  if (!value) throw new Error("useChatContext 必须在 <ChatShell> 内使用");
  return value;
}
