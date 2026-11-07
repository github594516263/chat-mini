import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me
 *
 * renew: true —— 只有在这里滑动续期，因为只有路由处理器能写 cookie。
 * 前端可以把它当"保活"接口，也可以用来判断登录态。
 */
export async function GET() {
  const user = await getCurrentUser({ renew: true });
  if (!user) {
    return Response.json({ user: null }, { status: 401 });
  }
  return Response.json({
    user: { id: user.id, username: user.username, displayName: user.displayName },
  });
}
