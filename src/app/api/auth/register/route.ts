import { clientIp, isSameOrigin, jsonError, readJson, userAgent } from "@/lib/http";
import { createSession, setSessionCookie, sweepExpiredSessions } from "@/lib/auth";
import { explainDbError } from "@/lib/db";
import { validatePassword } from "@/lib/password";
import { createUser, findUserByUsername, markLogin, validateUsername } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/register  { username, password }
 *
 * 默认关闭（ALLOW_REGISTER 不为 "true" 时返回 403）——个人站不该让陌生人注册，
 * 但接口保留：将来想开放，改一个环境变量即可。
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return jsonError(403, "跨站请求被拒绝");
  }

  if (process.env.ALLOW_REGISTER !== "true") {
    return jsonError(403, "注册未开放", "本实例未开放注册；用 scripts/create-user.mjs 建号");
  }

  const body = await readJson(request);
  if (!body) {
    return jsonError(400, "请求格式不对", "需要 Content-Type: application/json");
  }

  const username = validateUsername(body.username);
  if (!username.ok) return jsonError(400, username.message);

  const password = validatePassword(body.password);
  if (!password.ok) return jsonError(400, password.message);

  try {
    if (await findUserByUsername(username.value)) {
      return jsonError(409, "这个用户名已被占用");
    }

    const user = await createUser({ username: username.value, password: password.value });
    const { token, expiresAt } = await createSession(user.id, {
      ip: clientIp(request),
      userAgent: userAgent(request),
    });
    await setSessionCookie(token, expiresAt);
    await markLogin(user.id);
    void sweepExpiredSessions();

    return Response.json({ user }, { status: 201 });
  } catch (error) {
    // 并发注册同名用户：唯一索引会报 ER_DUP_ENTRY
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      return jsonError(409, "这个用户名已被占用");
    }
    return jsonError(500, "注册失败", explainDbError(error));
  }
}
