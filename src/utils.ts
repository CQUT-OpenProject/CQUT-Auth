import { createHash, randomBytes } from "node:crypto";

export function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomId(prefix: string, size = 18): string {
  return `${prefix}_${base64Url(randomBytes(size))}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256Base64Url(input: string): string {
  return base64Url(createHash("sha256").update(input).digest());
}

export function parseCookies(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  return raw.split(";").reduce<Record<string, string>>((cookies, part) => {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      return cookies;
    }
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseScope(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
