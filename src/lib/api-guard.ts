import { getCurrentUser, type SessionUser } from "@/lib/auth";
import { jsonError } from "@/lib/http";

/**
 * 路由守卫。用法：
 *
 *   const auth = await requireUser();
 *   if (auth.response) return auth.response;   // 401
 *   const user = auth.user;
 *
 * 用返回值而不是抛异常：每个路由里一眼能看见"没登录就提前返回"，
 * 不会出现 try/catch 吞掉 401 的意外。
 */
export type AuthResult =
  | { user: SessionUser; response?: undefined }
  | { user?: undefined; response: Response };

export async function requireUser(): Promise<AuthResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { response: jsonError(401, "请先登录", "游客模式的数据只存在浏览器本地") };
  }
  return { user };
}
