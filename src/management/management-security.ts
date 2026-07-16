import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { StaticConfig } from "../config.js";
import { base64Url, parseCookies, sha256 } from "../utils.js";

export function managementSessionCookieName(
  config: Pick<StaticConfig, "cookieSecure">,
) {
  return config.cookieSecure ? "__Host-cqut_manage_sid" : "cqut_manage_sid";
}

function managementNonceCookieName(config: Pick<StaticConfig, "cookieSecure">) {
  return config.cookieSecure ? "__Host-cqut_manage_csrf" : "cqut_manage_csrf";
}

export function readManagementSessionToken(
  request: Request,
  config: Pick<StaticConfig, "cookieSecure">,
) {
  return parseCookies(request.get("cookie"))[
    managementSessionCookieName(config)
  ];
}

export function setManagementSessionCookie(
  response: Response,
  config: Pick<StaticConfig, "cookieSecure" | "sessionTtlSeconds">,
  token: string,
) {
  response.cookie(managementSessionCookieName(config), token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: config.sessionTtlSeconds * 1000,
  });
}

export function clearManagementSessionCookie(
  response: Response,
  config: Pick<StaticConfig, "cookieSecure">,
) {
  response.clearCookie(managementSessionCookieName(config), {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
  });
}

export function ensureManagementNonce(
  request: Request,
  response: Response,
  config: Pick<StaticConfig, "cookieSecure" | "csrfTokenTtlSeconds">,
) {
  const name = managementNonceCookieName(config);
  const existing = parseCookies(request.get("cookie"))[name];
  if (existing) {
    return existing;
  }
  const nonce = base64Url(randomBytes(24));
  response.cookie(name, nonce, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: config.csrfTokenTtlSeconds * 1000,
  });
  return nonce;
}

export function issueManagementCsrf(
  config: Pick<StaticConfig, "csrfSigningSecret" | "csrfTokenTtlSeconds">,
  binding: string,
  now = Math.floor(Date.now() / 1000),
) {
  const payload = `${now + config.csrfTokenTtlSeconds}.${sha256(binding)}`;
  const signature = createHmac("sha256", config.csrfSigningSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function validateManagementCsrf(
  request: Request,
  config: Pick<StaticConfig, "csrfSigningSecret" | "issuer">,
  binding: string,
  now = Math.floor(Date.now() / 1000),
) {
  const origin = request.get("origin");
  if (origin && origin !== new URL(config.issuer).origin) {
    return false;
  }
  const token = request.get("x-csrf-token");
  if (!token) {
    return false;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }
  const [expiresRaw, bindingHash, signature] = parts;
  const expires = Number(expiresRaw);
  if (
    !Number.isInteger(expires) ||
    expires < now ||
    bindingHash !== sha256(binding)
  ) {
    return false;
  }
  const expected = createHmac("sha256", config.csrfSigningSecret)
    .update(`${expiresRaw}.${bindingHash}`)
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature ?? "", "base64url");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function readManagementNonce(
  request: Request,
  config: Pick<StaticConfig, "cookieSecure">,
) {
  return parseCookies(request.get("cookie"))[managementNonceCookieName(config)];
}
