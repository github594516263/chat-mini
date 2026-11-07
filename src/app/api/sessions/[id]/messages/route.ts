import { requireUser } from "@/lib/api-guard";
import { listMessages } from "@/lib/chat-repo";
import { explainDbError } from "@/lib/db";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/sessions/:id/messages[?afterSeq=N]
 *
 * afterSeq 用来增量拉取（配合流式续传）；
 * 不传就是全量（当前上限 200 条，超出由前端翻页或后续换成游标）。
 */
export async function GET(request: Request, context: Context) {
  const auth = await requireUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const url = new URL(request.url);
  const afterSeqParam = Number(url.searchParams.get("afterSeq") ?? "0");

  try {
    const result = await listMessages(auth.user.id, id, {
      afterSeq: Number.isFinite(afterSeqParam) ? afterSeqParam : 0,
    });
    if (!result) return jsonError(404, "会话不存在");
    return Response.json(result);
  } catch (error) {
    return jsonError(500, "读取消息失败", explainDbError(error));
  }
}
