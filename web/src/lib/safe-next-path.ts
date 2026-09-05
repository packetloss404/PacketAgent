/**
 * Accept only same-origin absolute paths for post-sign-in redirects.
 * `//evil.example` and `/\evil.example` are scheme-relative URLs to the
 * browser even though they start with "/", so they must be rejected.
 */
export function safeNextPath(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
