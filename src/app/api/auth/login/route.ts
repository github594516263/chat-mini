import { createSession, setSessionCookie, sweepExpiredSessions } from "@/lib/auth";
import { explainDbError } from "@/lib/db";
import { clientIp, isSameOrigin, jsonError, readJson, userAgent } from "@/lib/http";
import { attemptKey, checkAllowed, recordFailure, recordSuccess } from "@/lib/rate-limit";
import { markLogin, normalizeUsername, verifyCredentials } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login  { username, password }
 *
 * 失败一律返回同一句话「用户名或密码错误」——不区分"用户不存在"和"密码错"，
 * 否则等于把用户名枚举接口送出去。
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return jsonError(403, "跨站请求被拒绝");
  }

  const body = await readJson(request);
  if (!body) {
    return jsonError(400, "请求格式不对", "需要 Content-Type: application/json");
  }

  const username = normalizeUsername(body.username);
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return jsonError(400, "请填写用户名和密码");
  }

  const key = attemptKey(username, clientIp(request));
  const limit = checkAllowed(key);
  if (!limit.allowed) {
    return jsonError(429, "尝试次数太多", `请 ${limit.retryAfterSeconds ?? 300} 秒后再试`);
  }

  try {
    const user = await verifyCredentials(username, password);
    if (!user) {
      recordFailure(key);
      return jsonError(401, "用户名或密码错误");
    }

    recordSuccess(key);

    const { token, expiresAt } = await createSession(user.id, {
      ip: clientIp(request),
      userAgent: userAgent(request),
    });
    await setSessionCookie(token, expiresAt);
    await markLogin(user.id);
    void sweepExpiredSessions();

    return Response.json({ user });
  } catch (error) {
    return jsonError(500, "登录失败", explainDbError(error));
  }
}
