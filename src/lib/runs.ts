import type { ChatEvent, SeqEvent } from "@/lib/protocol";

/**
 * 服务端「生成任务」表。
 *
 * 为什么需要它：一次长回答动辄几十秒，如果生成寄生在那一条 HTTP 连接上，
 * 用户一刷新就全没了。所以把生成变成 run —— 请求进来建 run、后台跑生成、
 * 事件按 seq 记在内存里；客户端用 runId + afterSeq 订阅，刷新后接着续传。
 *
 * 刻意保持最小：进程内 Map，不引数据库/队列。
 * 代价也说清楚：多实例部署不共享（要换 Redis），dev 热重载可能丢 run。
 */

export type RunStatus = "running" | "done" | "error" | "aborted";

/** 落库归属：登录用户的 run 才有这些字段（游客的 run 只在内存里） */
export type RunMeta = {
  userId?: string;
  sessionId?: string;
  messageId?: string;
};

/** 压缩后的正文快照，配合 seq 使用：这个 seq 及之前的内容都折叠在 content 里了 */
type RunSnapshot = { seq: number; content: string; thinking: string };

type Subscriber = {
  onEvent: (event: SeqEvent) => void;
  onEnd: () => void;
};

export type Run = {
  id: string;
  status: RunStatus;
  /** 只保存 seq > snapshot.seq 的事件 */
  events: SeqEvent[];
  snapshot: RunSnapshot | null;
  subscribers: Set<Subscriber>;
  abort: AbortController;
  meta: RunMeta;
  createdAt: number;
  updatedAt: number;
};

/** 结束后保留一段时间，给"刷新回来续传"留窗口 */
const RUN_TTL_MS = 10 * 60 * 1000;
/** 事件攒到这个量就压缩成快照，避免长回答把内存顶爆 */
const MAX_EVENTS = 400;
/** 压缩时保留尾部这么多条原始事件（回放更精确） */
const KEEP_EVENTS = 100;

const globalForRuns = globalThis as unknown as { __chatRuns?: Map<string, Run> };
const runs: Map<string, Run> = (globalForRuns.__chatRuns ??= new Map<string, Run>());

export function createRun(meta: RunMeta = {}): Run {
  sweep();
  const run: Run = {
    id: `run_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    status: "running",
    events: [],
    snapshot: null,
    subscribers: new Set(),
    abort: new AbortController(),
    meta,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  runs.set(run.id, run);
  return run;
}

export function getRun(runId: string): Run | undefined {
  return runs.get(runId);
}

export function appendEvent(run: Run, event: SeqEvent): void {
  run.events.push(event);
  run.updatedAt = Date.now();
  if (run.events.length > MAX_EVENTS) compact(run);
  for (const subscriber of run.subscribers) {
    try {
      subscriber.onEvent(event);
    } catch {
      run.subscribers.delete(subscriber);
    }
  }
}

export function finishRun(run: Run, status: RunStatus): void {
  run.status = status;
  run.updatedAt = Date.now();
  const subscribers = [...run.subscribers];
  run.subscribers.clear();
  for (const subscriber of subscribers) {
    try {
      subscriber.onEnd();
    } catch {
      // 忽略：订阅方自己断开很常见
    }
  }
}

export function cancelRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== "running") return false;
  run.abort.abort();
  return true;
}

export function subscribe(run: Run, subscriber: Subscriber): () => void {
  run.subscribers.add(subscriber);
  return () => {
    run.subscribers.delete(subscriber);
  };
}

/**
 * 从 afterSeq 之后开始回放。若请求的水位落在已被压缩的区间里，
 * 先补一条 sync 把之前的正文整体给过去，再补尾部事件。
 */
export function replayFrom(run: Run, afterSeq: number): SeqEvent[] {
  const out: SeqEvent[] = [];
  let floor = afterSeq;
  if (run.snapshot && afterSeq < run.snapshot.seq) {
    out.push({
      type: "sync",
      seq: run.snapshot.seq,
      content: run.snapshot.content,
      thinking: run.snapshot.thinking,
    });
    floor = run.snapshot.seq;
  }
  for (const event of run.events) {
    if (event.seq > floor) out.push(event);
  }
  return out;
}

/** 把前面的事件折叠进快照，只保留尾部 KEEP_EVENTS 条原始事件 */
function compact(run: Run): void {
  const cut = run.events.length - KEEP_EVENTS;
  if (cut <= 0) return;

  let content = run.snapshot?.content ?? "";
  let thinking = run.snapshot?.thinking ?? "";
  let seq = run.snapshot?.seq ?? 0;

  for (let i = 0; i < cut; i += 1) {
    const event = run.events[i];
    if (event.type === "delta") content += event.delta;
    else if (event.type === "think_delta") thinking += event.delta;
    seq = Math.max(seq, event.seq);
  }

  run.snapshot = { seq, content, thinking };
  run.events = run.events.slice(cut);
}

/** 清掉过期 run，顺便把"跑了一半但没人订阅"的清理掉 */
function sweep(): void {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (run.status !== "running" && now - run.updatedAt > RUN_TTL_MS) runs.delete(id);
  }
}

export function runCount(): number {
  return runs.size;
}
