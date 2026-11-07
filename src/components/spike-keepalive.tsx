"use client";

/**
 * 【临时·路由改造实测用】变体 D：keep-alive 内存模型。
 *
 * 把访问过的会话树**全部保留挂载**，只把非当前的用 display:none 藏起来 ——
 * 这就是 keep-alive（react-activation / 标签页保活）在内存上的真实形态。
 *
 * 用它量出"同时保活 N 条会话"的代价，与"状态提升"（只存几个小对象）对比。
 *
 * 这个文件在结论落地后应当删除。
 */

import { useCallback, useEffect, useState } from "react";

import type { ProbeMsg, ProbeNav } from "@/components/spike-probe";

type Tree = { id: string; title: string; messages: ProbeMsg[] };

export function SpikeKeepAlive({
  initial,
  nav,
}: {
  initial: Tree;
  nav: ProbeNav[];
}) {
  const [trees, setTrees] = useState<Tree[]>([initial]);
  const [activeId, setActiveId] = useState(initial.id);

  useEffect(() => {
    const w = window as unknown as { __probe?: Record<string, unknown> };
    w.__probe = { variant: "D", id: activeId, ticks: 0, mounts: trees.length };
  }, [activeId, trees.length]);

  const open = useCallback(
    async (id: string) => {
      const existing = trees.find((t) => t.id === id);
      if (existing) {
        setActiveId(id);
        return;
      }
      const response = await fetch(`/api/spike/${id}`);
      const data = (await response.json()) as {
        ok: boolean;
        session?: { title: string };
        messages?: ProbeMsg[];
      };
      if (!data.ok || !data.session || !data.messages) return;
      const { title, messages } = { title: data.session.title, messages: data.messages };
      setTrees((prev) => [...prev, { id, title, messages }]);
      setActiveId(id);
    },
    [trees],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4 text-sm">
      <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
        <strong>spike · 变体 D（keep-alive 模型）</strong> · 已保活 {trees.length} 条会话
      </div>

      <nav className="flex flex-wrap gap-2">
        {nav.map((item, index) => (
          <button
            key={item.id}
            type="button"
            data-nav-index={index}
            onClick={() => void open(item.id)}
            className="rounded border px-2 py-1 hover:bg-black/5"
          >
            {item.title.slice(0, 12)}#{index}
          </button>
        ))}
      </nav>

      {/* 所有访问过的会话树都留在 DOM 里，非当前的只隐藏不卸载 */}
      {trees.map((tree) => (
        <div
          key={tree.id}
          data-kept-session={tree.id}
          style={{ display: tree.id === activeId ? "block" : "none" }}
          className="flex flex-col gap-2"
        >
          {tree.messages.map((message) => (
            <div key={message.id} className="whitespace-pre-wrap rounded border p-2">
              <span className="opacity-50">{message.role}: </span>
              {message.content}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
