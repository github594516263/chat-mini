import { requireUser } from "@/lib/api-guard";
import { searchSessions } from "@/lib/chat-repo";
import { explainDbError } from "@/lib/db";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/search?q=断线
 *
 * 标题用 LIKE，正文用 ngram 全文索引（中文不用额外分词器）。
 * 注意：这个路由是静态段，会优先于 /api/sessions/[id] 匹配，不会被当成 id。
 */
export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return Response.json({ query: "", hits: [] });

  try {
    const hits = await searchSessions(auth.user.id, q);
    return Response.json({ query: q, hits });
  } catch (error) {
    return jsonError(500, "搜索失败", explainDbError(error));
  }
}
