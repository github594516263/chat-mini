/**
 * 传给客户端的"最小用户视图"。
 * 别把整个 DB 行塞进 props：密码哈希、盐、内部状态一律不出服务端。
 */
export type AccountUser = {
  id: string;
  username: string;
  displayName: string;
};

/** 头像上用：中文取首字，英文取首字母 */
export function initialsOf(user: Pick<AccountUser, "username" | "displayName">) {
  const source = (user.displayName || user.username || "?").trim();
  return source.slice(0, 1).toUpperCase();
}
