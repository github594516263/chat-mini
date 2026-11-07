import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * 密码哈希。只用 Node 内置 crypto，不引第三方包。
 *
 * 存储格式：scrypt$N$r$p$<salt_base64>$<hash_base64>
 *   —— 参数跟着哈希一起存，将来调高 N 不需要迁移旧数据（旧哈希用自己的参数验证）。
 *
 * 两条不能改的规矩：
 * 1. 用异步 scrypt，不用 scryptSync。同步版会阻塞事件循环 ~160ms，
 *    而本进程同时还在给别的会话流式生成 —— 一堵，所有人的流都会卡一下。
 * 2. 比较用 timingSafeEqual，不用 ===（防时序侧信道）。
 */

const N = 65_536; // 实测本机 158ms / 64MB
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;
const MAX_MEM = 256 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

function derive(password: string, salt: Buffer, keylen: number, params: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    // NFKC 归一：避免同一个密码因为组合字符的编码不同而"看起来一样、哈希不一样"
    scrypt(password.normalize("NFKC"), salt, keylen, { ...params, maxmem: MAX_MEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await derive(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    // 参数被改坏 / 内存超限等，一律当作验证失败，不向调用方泄露细节
    return false;
  }
}

/** 口令强度校验：只挡明显不合格的，不搞复杂规则（规则越复杂，用户越会写在便签上） */
export function validatePassword(password: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof password !== "string") return { ok: false, message: "密码格式不对" };
  const value = password.normalize("NFKC");
  if (value.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` };
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: `密码最多 ${PASSWORD_MAX_LENGTH} 位` };
  }
  return { ok: true, value };
}
