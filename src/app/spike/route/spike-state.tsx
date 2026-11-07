"use client";

/**
 * 【临时·路由改造 A/B 实测用】验证"状态提升"能不能救真实路由。
 *
 * 背景：实测发现切会话会导致 page 子树 remount（草稿清空、进行中的流被掐断）。
 * 假设：Next 在 param 变化时**不会重挂 layout**，所以把这类状态提到 layout 层，
 * 页面 remount 就变得无所谓了 —— 这正是主流 LLM 应用"切走再切回，生成还在继续"的形态。
 *
 * 这个文件在结论落地后应当删除。
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

type SpikeState = {
  draft: string;
  setDraft: (value: string) => void;
  /** layout 层的 100ms 心跳：page remount 不该影响它 */
  ticksRef: RefObject<number>;
};

export const SpikeCtx = createContext<SpikeState | null>(null);

export function useSpikeState() {
  return useContext(SpikeCtx);
}

export function SpikeStateProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState("");
  const ticksRef = useRef(0);

  useEffect(() => {
    const w = window as unknown as { __layoutMounts?: number };
    w.__layoutMounts = (w.__layoutMounts ?? 0) + 1;

    const timer = setInterval(() => {
      ticksRef.current += 1;
      const probe = window.__probe;
      if (probe) probe.ticks = ticksRef.current;
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return <SpikeCtx.Provider value={{ draft, setDraft, ticksRef }}>{children}</SpikeCtx.Provider>;
}
