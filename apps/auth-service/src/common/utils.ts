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

export function nowSeconds(date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}

export function parseScope(raw: string): string[] {
  return raw
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
}
