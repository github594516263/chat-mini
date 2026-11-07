import type { NextRequest } from "next/server";

import { cancelRun } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 真正停掉服务端生成（否则"停止生成"只是不看了，token 还在烧） */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const runId = (raw as { runId?: unknown } | null)?.runId;
  if (typeof runId !== "string" || !runId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }

  return Response.json({ cancelled: cancelRun(runId) });
}
