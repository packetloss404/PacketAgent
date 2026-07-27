import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT = Buffer.from("packetagent-vault-v1");
const ITERATIONS = 100_000;
const DEV_MASTER_KEY = "packetagent-dev-master";

export function deriveMasterKey(passphrase: string): Buffer {
  return pbkdf2Sync(passphrase, SALT, ITERATIONS, KEY_LEN, "sha256");
}

export function encryptSecret(plaintext: string, masterKey: Buffer): EncryptedSecret {
  if (masterKey.length !== KEY_LEN) throw new Error("vault: master key must be 32 bytes");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptSecret(secret: EncryptedSecret, masterKey: Buffer): string {
  if (masterKey.length !== KEY_LEN) throw new Error("vault: master key must be 32 bytes");
  const iv = Buffer.from(secret.iv, "base64");
  const ciphertext = Buffer.from(secret.ciphertext, "base64");
  const authTag = Buffer.from(secret.authTag, "base64");
  if (authTag.length !== TAG_LEN) throw new Error("vault: invalid auth tag length");
  const decipher = createDecipheriv(ALGO, masterKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export function maskSecret(value: string): string {
  if (value.length === 0) return "";
  const tail = value.slice(-4);
  const headLen = Math.max(0, value.length - 4);
  return "•".repeat(headLen) + tail;
}

let cachedKey: Buffer | null = null;
let cachedKeyPassphrase: string | null = null;

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.MASTER_KEY;
  if (fromEnv && fromEnv.length > 0) {
    if (cachedKey && cachedKeyPassphrase === fromEnv) return cachedKey;
    cachedKey = deriveMasterKey(fromEnv);
    cachedKeyPassphrase = fromEnv;
    return cachedKey;
  }
  if (isProduction(env)) {
    throw new Error("vault: MASTER_KEY must be set when NODE_ENV=production");
  }
  if (cachedKey && cachedKeyPassphrase === DEV_MASTER_KEY) return cachedKey;
  console.warn("[vault] MASTER_KEY not set; using deterministic dev key. DO NOT USE IN PRODUCTION.");
  cachedKey = deriveMasterKey(DEV_MASTER_KEY);
  cachedKeyPassphrase = DEV_MASTER_KEY;
  return cachedKey;
}

export function resetMasterKeyCacheForTests(): void {
  cachedKey = null;
  cachedKeyPassphrase = null;
}
