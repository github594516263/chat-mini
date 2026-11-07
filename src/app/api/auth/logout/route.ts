import { clearSessionCookie, deleteSessionByToken, readSessionToken } from "@/lib/auth";
import { isSameOrigin, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 *
 * 先删库里的行再清 cookie：删行是真正的失效手段，
 * 清 cookie 只是让浏览器别再发。就算 cookie 被复制走了，删行之后也登不进来。
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return jsonError(403, "跨站请求被拒绝");
  }

  try {
    const token = await readSessionToken();
    if (token) await deleteSessionByToken(token);
    await clearSessionCookie();
    return Response.json({ ok: true });
  } catch {
    // 即使删库失败也要把 cookie 清掉，避免客户端一直带着一个坏 token
    await clearSessionCookie().catch(() => undefined);
    return Response.json({ ok: true });
  }
}
