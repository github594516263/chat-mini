import type { NextRequest } from "next/server";

import { STREAM_CONTENT_TYPE, encodeEvent, type SeqEvent } from "@/lib/protocol";
import { getRun, replayFrom, subscribe } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 订阅一个 run：GET /api/chat/stream?runId=run_xxx&afterSeq=137
 *
 * - afterSeq 之前的事件不会再发（客户端已经消费过）
 * - 若水位落在已压缩区间，先发一条 sync 覆盖正文
 * - run 已结束：回放完直接关闭，浏览器不需要再挂着连接
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }

  const afterSeq = Math.max(0, Number(url.searchParams.get("afterSeq") ?? 0) || 0);
  const run = getRun(runId);
  if (!run) {
    // run 过期/服务重启/dev 热重载都会走到这里，客户端据此降级为"生成中断"
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 已经关闭
        }
      };
      const send = (event: SeqEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          closed = true;
        }
      };

      for (const event of replayFrom(run, afterSeq)) send(event);

      if (run.status !== "running") {
        close();
        return;
      }

      let unsubscribe: () => void = () => {};
      unsubscribe = subscribe(run, {
        onEvent: send,
        onEnd: () => {
          unsubscribe();
          close();
        },
      });

      // 客户端断开（关页面/切换会话）时退订，但服务端继续生成
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": STREAM_CONTENT_TYPE,
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
