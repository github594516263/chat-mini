/** URL ↔ 会话 id 的唯一解释层：读写路径的代码都走这里，避免正则散落各处。 */

const SESSION_PATH = /^\/c\/([A-Za-z0-9_-]{1,64})\/?$/;

/** 从 pathname 里取会话 id；不是会话页就返回 null */
export function readSessionIdFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  return SESSION_PATH.exec(pathname)?.[1] ?? null;
}

/** 会话页的规范路径 */
export function sessionPath(id: string): string {
  return `/c/${id}`;
}

/**
 * 登录回跳用的 `?next=` 只允许站内路径。
 *
 * 挡掉的东西：协议（`https://evil.com`）、协议相对（`//evil.com`）、
 * 反斜杠（部分浏览器会把 `\` 当 `/`）、以及回到登录页自己。
 * 宁可丢掉回跳，也不能变成开放重定向。
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\") || raw.includes("://")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login#")) return null;
  return raw;
}
