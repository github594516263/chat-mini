/**
 * 路由处理器的小工具：统一的 JSON 出入口 + 最低限度的 CSRF 防护。
 *
 * CSRF 的三层防线（都很便宜，一起用）：
 *   1. cookie 的 SameSite=Lax —— 跨站 POST 不带 cookie
 *   2. 写操作必须是 JSON —— 跨站表单只能发 urlencoded / multipart，发不出 application/json
 *   3. 校验 Origin/Referer 的 host 与请求 Host 一致 —— 挡住漏网的跨站请求
 */

export type ApiError = { error: string; hint?: string };

export function jsonError(status: number, error: string, hint?: string): Response {
  return Response.json({ error, ...(hint ? { hint } : {}) } satisfies ApiError, { status });
}

export function jsonOk<T extends object>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** 只接受 application/json 的请求体（顺便挡掉跨站表单提交） */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Origin 校验：允许没有 Origin/Referer 的请求（curl、服务端调用），
 * 但只要有 Origin，就必须和请求的 Host 一致。
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const requestHost = request.headers.get("host") ?? new URL(request.url).host;
  return originHost === requestHost;
}

/** 取客户端 IP：优先反代头，退化到直连 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 45);
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim().slice(0, 45);
  return "";
}

export function userAgent(request: Request): string {
  return (request.headers.get("user-agent") ?? "").slice(0, 255);
}
