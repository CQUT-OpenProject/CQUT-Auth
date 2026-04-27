import type { IncomingHttpHeaders } from "node:http";
import type { Request } from "express";
import type { OidcOpConfig } from "./config.js";

type HeaderValue = string | string[] | undefined;

type TrustedRequestIpInput = {
  headers: IncomingHttpHeaders | Record<string, HeaderValue> | undefined;
  remoteAddress: string | undefined;
};

function normalizeIp(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized;
}

function parseForwardedFor(header: HeaderValue): string[] {
  const values = Array.isArray(header) ? header : [header];
  return values
    .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
    .map((value) => normalizeIp(value))
    .filter((value): value is string => Boolean(value));
}

export function resolveTrustedRequestIp(
  config: Pick<OidcOpConfig, "trustProxyHops">,
  input: TrustedRequestIpInput
): string {
  const remoteAddress = normalizeIp(input.remoteAddress) ?? "unknown";
  if (config.trustProxyHops <= 0) {
    return remoteAddress;
  }

  const forwardedFor = parseForwardedFor(input.headers?.["x-forwarded-for"]);
  if (forwardedFor.length < config.trustProxyHops) {
    return remoteAddress;
  }

  return forwardedFor[forwardedFor.length - config.trustProxyHops] ?? remoteAddress;
}

export function resolveTrustedExpressRequestIp(
  config: Pick<OidcOpConfig, "trustProxyHops">,
  request: Pick<Request, "headers" | "socket">
): string {
  return resolveTrustedRequestIp(config, {
    headers: request.headers,
    remoteAddress: request.socket.remoteAddress
  });
}

export function resolveTrustedKoaRequestIp(
  config: Pick<OidcOpConfig, "trustProxyHops">,
  ctx: { req?: { headers?: IncomingHttpHeaders; socket?: { remoteAddress?: string | undefined } } }
): string {
  return resolveTrustedRequestIp(config, {
    headers: ctx.req?.headers,
    remoteAddress: ctx.req?.socket?.remoteAddress
  });
}
