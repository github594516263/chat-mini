import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

/**
 * MySQL 连接层。整个项目只有这一处碰驱动，上层（API / 业务）只写 SQL。
 *
 * 两个刻意的约定：
 *
 * 1. 时间统一 UTC。连接池 timezone 设为 "Z"，写入时把 JS Date 格式化成 UTC 字符串，
 *    读出来再按 UTC 解析 —— 这样夏令时、机器时区、跨机部署都不会让时间漂。
 *    ⚠️ 因此业务代码里不要用 NOW() / CURRENT_TIMESTAMP 写入（那是 MySQL 服务器本地时间），
 *       一律从 JS 传 new Date()。
 *
 * 2. 连接池挂在 globalThis 上。Next dev 热重载会反复重新执行模块，
 *    不挂在全局会导致每次都新建一个池，把 MySQL 的连接数吃干净。
 */

type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

const globalForDb = globalThis as unknown as { __chatDbPool?: Pool };

/**
 * 允许绑定到 ? 的值类型。刻意不给 undefined —— SQL 里"没有值"应该写 NULL，
 * 而不是让驱动去猜（undefined 会让预处理语句报参数数量不匹配）。
 */
export type SqlParam = string | number | bigint | boolean | Date | null | Buffer | Uint8Array;

/** 缺配置 / 连不上时，给出"人话"报错，而不是让人对着 ECONNREFUSED 猜 */
export class DbConfigError extends Error {}

function readConfig(): DbConfig {
  const host = process.env.DB_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.DB_PORT ?? 3306);
  const user = process.env.DB_USER?.trim() ?? "";
  const password = process.env.DB_PASSWORD ?? "";
  const database = process.env.DB_NAME?.trim() ?? "";

  const missing: string[] = [];
  if (!user) missing.push("DB_USER");
  if (!database) missing.push("DB_NAME");
  if (missing.length > 0) {
    throw new DbConfigError(
      `数据库配置缺失：${missing.join("、")}。请在 chat-mini/.env.local 里补上（参考 .env.example）。`,
    );
  }

  return { host, port: Number.isFinite(port) ? port : 3306, user, password, database };
}

export function getPool(): Pool {
  if (globalForDb.__chatDbPool) return globalForDb.__chatDbPool;

  const config = readConfig();
  globalForDb.__chatDbPool = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60_000,
    queueLimit: 0,
    charset: "utf8mb4",
    timezone: "Z",
    // 一次取多行时不要因为 BIGINT/DECIMAL 之类的类型转换炸掉
    supportBigNumbers: true,
    dateStrings: false,
  });

  return globalForDb.__chatDbPool;
}

/** 全部使用预处理语句（? 占位），这是防 SQL 注入的唯一防线 */
export async function query<T extends RowDataPacket>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const [rows] = await getPool().query<T[]>(sql, params);
  return rows;
}

export async function queryOne<T extends RowDataPacket>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: SqlParam[] = []): Promise<ResultSetHeader> {
  const [result] = await getPool().execute<ResultSetHeader>(sql, params);
  return result;
}

/**
 * 事务：回调里用同一个连接，抛错自动回滚。
 * 注意事务里的操作必须走 conn，用 query() 会从池里另取一个连接（不在同一事务里）。
 */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      // 回滚失败也要把原始错误抛出去
    }
    throw error;
  } finally {
    conn.release();
  }
}

export type DbHealth = {
  ok: boolean;
  version?: string;
  database?: string;
  tables?: number;
  /** 给人看的诊断结论 */
  hint?: string;
  error?: string;
};

/** 把驱动错误翻译成能直接行动的提示 */
export function explainDbError(error: unknown): string {
  const err = error as { code?: string; errno?: number; message?: string };
  if (error instanceof DbConfigError) return error.message;

  switch (err?.code) {
    case "ECONNREFUSED":
      return "连不上 MySQL：服务没启动？Windows 上执行 `net start MySQL94`，或检查 DB_HOST/DB_PORT。";
    case "ER_ACCESS_DENIED_ERROR":
      return "MySQL 拒绝了账号密码：检查 .env.local 里的 DB_USER / DB_PASSWORD。";
    case "ER_BAD_DB_ERROR":
      return "数据库不存在：先执行 `mysql -u root -p < scripts/schema.sql` 并确认 DB_NAME 写对。";
    case "ENOTFOUND":
      return "DB_HOST 解析不到：本机应填 127.0.0.1。";
    case "ER_NO_SUCH_TABLE":
      return "表还没建：执行 `mysql -u root -p chat_mini < scripts/schema.sql`。";
    default:
      return err?.message ? `数据库操作失败：${err.message}` : String(error);
  }
}

export async function healthCheck(): Promise<DbHealth> {
  try {
    const rows = await query<RowDataPacket & { v: string; db: string }>(
      "SELECT VERSION() AS v, DATABASE() AS db",
    );
    const tables = await query<RowDataPacket & { n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
    );
    return {
      ok: true,
      version: rows[0]?.v,
      database: rows[0]?.db,
      tables: Number(tables[0]?.n ?? 0),
    };
  } catch (error) {
    return { ok: false, error: explainDbError(error), hint: (error as Error)?.message };
  }
}
