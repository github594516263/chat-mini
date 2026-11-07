import type { ChatEvent, WireMessage } from "@/lib/protocol";

export type ProviderArgs = {
  messages: WireMessage[];
  signal: AbortSignal;
};

export type ChatProvider = (args: ProviderArgs) => AsyncGenerator<ChatEvent>;

/** 可被 abort 打断的 sleep，避免停止生成后还在后台空转 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 按“像人打字”的粒度切块：2~5 个字符一组 */
export function* chunkText(text: string): Generator<string> {
  let i = 0;
  let seed = text.length;
  while (i < text.length) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const size = 2 + (seed % 4);
    yield text.slice(i, i + size);
    i += size;
  }
}
