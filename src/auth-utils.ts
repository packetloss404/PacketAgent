import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "packetagent_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const [salt, expected] = passwordHash.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const target = Buffer.from(expected, "hex");
  if (actual.length !== target.length) return false;
  return timingSafeEqual(actual, target);
}

export function generateId(): string {
  return randomUUID();
}

export function generateSessionSecret(): string {
  return randomBytes(32).toString("hex");
}

export function hashSessionSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function buildSessionCookieValue(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

export function parseSessionCookieValue(cookieValue: string): { sessionId: string; secret: string } | null {
  const [sessionId, secret] = cookieValue.split(".");
  if (!sessionId || !secret) return null;
  return { sessionId, secret };
}

export function now(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
