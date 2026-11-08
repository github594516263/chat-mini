"use client";

import { createContext, useContext } from "react";

import type { ModelSelection } from "@/lib/use-models";

/**
 * 模型选择的传递通道。
 *
 * 和 ChatContext 一样挂在 ChatShell 上：输入框、设置面板、以后的消息气泡
 * 都从同一个地方读，避免"顶栏显示 A、实际请求 B"这种两份状态。
 */
export const ModelContext = createContext<ModelSelection | null>(null);

export function useModelContext(): ModelSelection {
  const value = useContext(ModelContext);
  if (!value) throw new Error("useModelContext 必须在 <ModelContext.Provider> 内使用");
  return value;
}
