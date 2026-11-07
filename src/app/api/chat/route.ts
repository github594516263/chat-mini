import type { NextRequest } from "next/server";

import {
  STREAM_CONTENT_TYPE,
  encodeEvent,
  sanitizeMessages,
  type ChatEvent,
} from "@/lib/protocol";
import { fakeProvider } from "@/lib/providers/fake";
import { deepseekProvider } from "@/lib/providers/deepseek";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const messages = sanitizeMessages((raw as { messages?: unknown } | null)?.messages);
  if (messages.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const provider = apiKey ? deepseekProvider({ apiKey }) : fakeProvider;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let seq = 0;
      const emit = (event: ChatEvent) => {
        controller.enqueue(encoder.encode(encodeEvent({ ...event, seq: ++seq })));
      };

      try {
        for await (const event of provider({ messages, signal: request.signal })) {
          emit(event);
        }
      } catch (error) {
        emit({ type: "error", message: (error as Error).message || "stream failed" });
      } finally {
        try {
          controller.close();
        } catch {
          // 客户端已断开时 close 会抛错，忽略即可
        }
      }
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
