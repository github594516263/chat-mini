import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 模型凭据的对称加密。
 *
 * 只做一件事：把 API Key 变成「库里可存、接口不可读」的密文。
 * 密钥来自 MODEL_SECRET_KEY（32 字节 base64），绝不跟数据库密码共用。
 *
 * 格式：AES-256-GCM，每次写入随机 12 字节 IV；AAD 绑定 userId + providerId，
 * 防止把 A 的密文搬到 B 的记录上还能解开。
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_VERSION = 1;

export class ModelCryptoError extends Error {}

export type EncryptedSecret = {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
};

function readKey(): Buffer {
  const raw = process.env.MODEL_SECRET_KEY?.trim();
  if (!raw) {
    throw new ModelCryptoError(
      "MODEL_SECRET_KEY 未配置：在 .env.local 里放一个 32 字节的 base64 密钥，再重启服务。",
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new ModelCryptoError("MODEL_SECRET_KEY 不是合法的 base64。");
  }
  if (key.length !== KEY_BYTES) {
    throw new ModelCryptoError("MODEL_SECRET_KEY 必须是 32 字节（base64 编码后 44 个字符左右）。");
  }
  return key;
}

function aad(userId: string, providerId: string): Buffer {
  return Buffer.from(`${userId}\u0000${providerId}`, "utf8");
}

export function encryptSecret(
  plaintext: string,
  context: { userId: string; providerId: string },
): EncryptedSecret {
  const key = readKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(context.userId, context.providerId));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    cipher: encrypted,
    iv,
    tag: cipher.getAuthTag(),
    keyVersion: KEY_VERSION,
  };
}

export function decryptSecret(
  secret: { cipher: Buffer; iv: Buffer; tag: Buffer; keyVersion: number },
  context: { userId: string; providerId: string },
): string {
  if (secret.keyVersion !== KEY_VERSION) {
    throw new ModelCryptoError(`不支持的凭据密钥版本：${secret.keyVersion}`);
  }
  const key = readKey();
  const decipher = createDecipheriv(ALGORITHM, key, secret.iv);
  decipher.setAAD(aad(context.userId, context.providerId));
  decipher.setAuthTag(secret.tag);
  return Buffer.concat([decipher.update(secret.cipher), decipher.final()]).toString("utf8");
}

/** 只用于「已保存 •••• 1234」的展示，不参与解密 */
export function last4Of(secret: string): string {
  return secret.slice(-4);
}
