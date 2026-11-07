"use client";

/**
 * 【临时·路由改造 A/B 实测用】测量探针。
 *
 * 三种挂法，同一份 UI：
 *   A  真实嵌套路由 + RSC（状态在 page 里 → 切会话 remount）
 *   B  单路由 + 客户端取数（浅导航，状态天然存活）
 *   C  真实嵌套路由 + 状态提升到 layout（验证 remount 能不能被绕过）
 *
 * 量四件事：切换耗时、草稿是否存活、心跳是否归零（=进行中的流是否被掐断）、是否 remount。
 *
 * 这个文件在结论落地后应当删除。
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useSpikeState } from "@/app/spike/route/spike-state";

export type ProbeMsg = { id: string; role: string; content: string };
export type ProbeNav = { id: string; title: string };

declare global {
  interface Window {
    __probe?: { variant: string; id: string; ticks: number; mounts: number; layoutMounts: number };
    __readyAt?: number;
    __fetchMs?: number;
  }
}

type Props = {
  variant: "A" | "B" | "C";
  activeId: string;
  title: string;
  messages: ProbeMsg[];
  nav: ProbeNav[];
  /** 变体 A 专用：关掉 Link 预取，用来测"冷 RSC"最坏情况 */
  noPrefetch?: boolean;
  /** 变体 A/C 专用：链接上要带的查询串（让被测模式在切换后保持） */
  linkSuffix?: string;
};

export function SpikeProbe(props: Props) {
  const spike = useSpikeState(); // 变体 C 才有 provider
  const hoisted = props.variant === "C" && spike !== null;

  const [localDraft, setLocalDraft] = useState("");
  const draft = hoisted && spike ? spike.draft : localDraft;
  const setDraft = hoisted && spike ? spike.setDraft : setLocalDraft;

  const [local, setLocal] = useState({
    id: props.activeId,
    title: props.title,
    messages: props.messages,
  });

  const ticksRef = useRef(0);
  const lastIdRef = useRef<string>("");

  // C 用 props（服务端导航后是新 props），B 用本地 state
  const activeId = props.variant === "B" ? local.id : props.activeId;
  const title = props.variant === "B" ? local.title : props.title;
  const messages = props.variant === "B" ? local.messages : props.messages;

  // 挂载计数：放 window 上，跨 remount 累加
  useEffect(() => {
    const previous = window.__probe;
    window.__probe = {
      variant: props.variant,
      id: previous?.id ?? "",
      ticks: previous?.ticks ?? 0,
      mounts: (previous?.mounts ?? 0) + 1,
      layoutMounts: previous?.layoutMounts ?? 0,
    };
  }, [props.variant]);

  // 100ms 心跳：remount 会让 ticksRef 归零 → window.__probe.ticks 不再增长。
  // 变体 C 由 layout 里的 provider 驱动，probe 自己不起定时器。
  useEffect(() => {
    if (hoisted) {
      const sync = setInterval(() => {
        if (window.__probe) window.__probe.ticks = spike?.ticksRef.current ?? 0;
        window.__probe && (window.__probe.layoutMounts = (window as unknown as { __layoutMounts?: number }).__layoutMounts ?? 0);
      }, 100);
      return () => clearInterval(sync);
    }

    const timer = setInterval(() => {
      ticksRef.current += 1;
      if (window.__probe) window.__probe.ticks = ticksRef.current;
    }, 100);
    return () => clearInterval(timer);
  }, [hoisted, spike]);

  // 新内容上屏打点（只在会话切换时写，避免普通 re-render 覆盖）
  useEffect(() => {
    if (lastIdRef.current === activeId) return;
    lastIdRef.current = activeId;
    window.__readyAt = performance.now();
    if (window.__probe) window.__probe.id = activeId;
  }, [activeId]);

  const goShallow = useCallback(async (id: string) => {
    const startedAt = performance.now();
    const response = await fetch(`/api/spike/${id}`);
    const data = (await response.json()) as {
      ok: boolean;
      session?: { title: string };
      messages?: ProbeMsg[];
    };
    window.__fetchMs = performance.now() - startedAt;
    if (!data.ok || !data.session || !data.messages) return;
    setLocal({ id, title: data.session.title, messages: data.messages });
  }, []);

  const renderNavItem = (item: ProbeNav, index: number) => {
    if (props.variant === "B") {
      return (
        <button
          key={item.id}
          type="button"
          data-nav-index={index}
          onClick={() => void goShallow(item.id)}
          className="rounded border px-2 py-1 hover:bg-black/5"
        >
          {item.title.slice(0, 12)}#{index}
        </button>
      );
    }
    return (
      <Link
        key={item.id}
        href={`/spike/route/${item.id}${props.linkSuffix ?? ""}`}
        prefetch={props.noPrefetch ? false : undefined}
        data-nav-index={index}
        className="rounded border px-2 py-1 hover:bg-black/5"
      >
        {item.title.slice(0, 12)}#{index}
      </Link>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4 text-sm">
      <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
        <strong>spike · 变体 {props.variant}</strong> · {title} · {messages.length} 条消息 · id=
        {activeId.slice(0, 8)}
      </div>

      <nav className="flex flex-wrap gap-2" data-spike-nav>
        {props.nav.map(renderNavItem)}
      </nav>

      <textarea
        data-spike-draft
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="草稿存活测试"
        className="h-16 rounded border p-2"
      />

      <div className="flex flex-col gap-2" data-spike-body>
        {messages.map((message) => (
          <div key={message.id} className="whitespace-pre-wrap rounded border p-2">
            <span className="opacity-50">{message.role}: </span>
            {message.content}
          </div>
        ))}
      </div>
    </div>
  );
}
