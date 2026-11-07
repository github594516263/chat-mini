/**
 * 登录爆破防护：同一「用户名 + IP」连错 5 次，锁 5 分钟。
 *
 * 刻意用进程内存而不是数据库：
 *   - 单实例部署，够用
 *   - 失败计数不需要持久化，进程重启清零反而是好事
 *   - 不占用数据库连接
 * 挂 globalThis 是为了 dev 热重载不丢计数（否则改一次代码就能重置限流，等于没有）。
 */

const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

type Entry = { failures: number; firstAt: number; lockedUntil: number };

const globalForLimit = globalThis as unknown as { __chatLoginAttempts?: Map<string, Entry> };

function store(): Map<string, Entry> {
  if (!globalForLimit.__chatLoginAttempts) globalForLimit.__chatLoginAttempts = new Map();
  return globalForLimit.__chatLoginAttempts;
}

export function attemptKey(username: string, ip: string): string {
  return `${username.toLowerCase()}|${ip}`;
}

export function checkAllowed(key: string): { allowed: boolean; retryAfterSeconds?: number } {
  const entry = store().get(key);
  if (!entry) return { allowed: true };

  const now = Date.now();
  if (entry.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  // 窗口过期，清掉
  if (now - entry.firstAt > WINDOW_MS) {
    store().delete(key);
  }
  return { allowed: true };
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const table = store();
  const entry = table.get(key);

  if (!entry || now - entry.firstAt > WINDOW_MS) {
    table.set(key, { failures: 1, firstAt: now, lockedUntil: 0 });
    return;
  }

  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
    entry.failures = 0;
    entry.firstAt = now;
  }
}

export function recordSuccess(key: string): void {
  store().delete(key);
}

/** 定期清掉过期条目，避免内存里堆积无用的 key */
export function sweepAttempts(): void {
  const now = Date.now();
  for (const [key, entry] of store()) {
    if (entry.lockedUntil < now && now - entry.firstAt > WINDOW_MS) store().delete(key);
  }
}
