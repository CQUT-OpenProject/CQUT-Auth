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

export function nowSeconds(date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}
