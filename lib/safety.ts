import { resolve, sep } from "node:path";

// Borrowed idea from paper-pilot net.py: block non-public targets, cap sizes.
// Implementation is original (hostname-string guard, no DNS lookup yet).
const BLOCKED_HOSTS = ["localhost", "127.", "10.", "192.168.", "169.254.", "::1", "[::1]"];

export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  for (const b of BLOCKED_HOSTS) {
    if (host === b || host.startsWith(b) || host.endsWith(b)) return false;
  }
  if (host === "metadata.google.internal") return false;
  return true;
}

export function safePdfPath(baseDir: string, fileName: string): string | null {
  const resolved = resolve(baseDir, fileName);
  const base = resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + sep)) return null;
  if (!resolved.toLowerCase().endsWith(".pdf")) return null;
  return resolved;
}

export const MAX_DOWNLOAD_MB = 75;
export const MAX_EMBED_MB = 5;
