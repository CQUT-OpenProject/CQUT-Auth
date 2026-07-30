import type { IncomingHttpHeaders } from "node:http";
import type { Request } from "express";
import type { StaticConfig } from "./config.js";

type HeaderValue = string | string[] | undefined;

type TrustedRequestIpInput = {
  headers: IncomingHttpHeaders | Record<string, HeaderValue> | undefined;
  remoteAddress: string | undefined;
};

type ParsedIpAddress =
  | { family: 4; value: number }
  | { family: 6; value: bigint };

type ParsedCidr = ParsedIpAddress & {
  prefixLength: number;
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

function parseIpAddress(
  value: string | undefined,
): ParsedIpAddress | undefined {
  const normalized = normalizeIp(value)?.replace(/^\[|\]$/g, "");
  if (!normalized) {
    return undefined;
  }
  const ipv4Match = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const ipv4 = ipv4Match?.[1] ?? normalized;
  const ipv4Parts = ipv4.split(".");
  if (ipv4Parts.length === 4) {
    const octets = ipv4Parts.map((part) => Number(part));
    if (
      octets.every(
        (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
      )
    ) {
      return {
        family: 4,
        value:
          (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 +
            octets[3]!) >>>
          0,
      };
    }
  }

  const zoneIndex = normalized.indexOf("%");
  const withoutZone =
    zoneIndex >= 0 ? normalized.slice(0, zoneIndex) : normalized;
  const sections = withoutZone.split("::");
  if (sections.length > 2) {
    return undefined;
  }
  const head = sections[0] ? sections[0].split(":") : [];
  const tail = sections[1] ? sections[1].split(":") : [];
  if (
    head.some((part) => part.length === 0) ||
    tail.some((part) => part.length === 0)
  ) {
    return undefined;
  }
  const missing = sections.length === 2 ? 8 - head.length - tail.length : 0;
  if (missing < 0 || (sections.length === 1 && head.length !== 8)) {
    return undefined;
  }
  const parts = [
    ...head,
    ...Array.from({ length: missing }, () => "0"),
    ...tail,
  ];
  if (parts.length !== 8) {
    return undefined;
  }
  let parsed = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) {
      return undefined;
    }
    parsed = (parsed << 16n) + BigInt(parseInt(part, 16));
  }
  return { family: 6, value: parsed };
}

function parseCidr(value: string): ParsedCidr | undefined {
  const [ip, prefixRaw] = value.split("/");
  const parsed = parseIpAddress(ip);
  if (!parsed || prefixRaw === undefined) {
    return undefined;
  }
  const prefixLength = Number(prefixRaw);
  const maxPrefix = parsed.family === 4 ? 32 : 128;
  if (
    !Number.isInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > maxPrefix
  ) {
    return undefined;
  }
  return { ...parsed, prefixLength };
}

function ipInCidr(ip: ParsedIpAddress, cidr: ParsedCidr): boolean {
  if (ip.family !== cidr.family) {
    return false;
  }
  if (ip.family === 4 && cidr.family === 4) {
    const shift = 32 - cidr.prefixLength;
    const mask = cidr.prefixLength === 0 ? 0 : (0xffffffff << shift) >>> 0;
    return (ip.value & mask) === (cidr.value & mask);
  }
  const shift = BigInt(128 - cidr.prefixLength);
  return (ip.value as bigint) >> shift === ((cidr as ParsedCidr & { family: 6 }).value) >> shift;
}

function formatIpAddress(parsed: ParsedIpAddress): string {
  if (parsed.family === 4) {
    const v = parsed.value;
    return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
  }
  let value = parsed.value;
  const groups: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    groups.unshift((value & 0xffffn).toString(16));
    value >>= 16n;
  }
  return groups.join(":");
}

function canonicalizeResolvedIp(value: string): string {
  const parsed = parseIpAddress(value);
  return parsed ? formatIpAddress(parsed) : value;
}

function isTrustedProxy(remoteAddress: string, cidrs: string[]): boolean {
  const parsedRemote = parseIpAddress(remoteAddress);
  if (!parsedRemote) {
    return false;
  }
  return cidrs.some((cidr) => {
    const parsedCidr = parseCidr(cidr);
    return Boolean(parsedCidr && ipInCidr(parsedRemote, parsedCidr));
  });
}

export function resolveTrustedRequestIp(
  config: Pick<StaticConfig, "trustProxyHops" | "trustedProxyCidrs">,
  input: TrustedRequestIpInput,
): string {
  const remoteAddress = normalizeIp(input.remoteAddress) ?? "unknown";
  const fallback = canonicalizeResolvedIp(remoteAddress);
  if (config.trustProxyHops <= 0) {
    return fallback;
  }
  if (!isTrustedProxy(remoteAddress, config.trustedProxyCidrs)) {
    return fallback;
  }

  const forwardedFor = parseForwardedFor(input.headers?.["x-forwarded-for"]);
  if (forwardedFor.length < config.trustProxyHops) {
    return fallback;
  }

  const clientIp =
    forwardedFor[forwardedFor.length - config.trustProxyHops] ?? remoteAddress;
  const parsedClient = parseIpAddress(clientIp);
  return parsedClient ? formatIpAddress(parsedClient) : fallback;
}

export function resolveTrustedExpressRequestIp(
  config: Pick<StaticConfig, "trustProxyHops" | "trustedProxyCidrs">,
  request: Pick<Request, "headers" | "socket">,
): string {
  return resolveTrustedRequestIp(config, {
    headers: request.headers,
    remoteAddress: request.socket.remoteAddress,
  });
}

export function resolveTrustedKoaRequestIp(
  config: Pick<StaticConfig, "trustProxyHops" | "trustedProxyCidrs">,
  ctx: {
    req?: {
      headers?: IncomingHttpHeaders;
      socket?: { remoteAddress?: string | undefined };
    };
  },
): string {
  return resolveTrustedRequestIp(config, {
    headers: ctx.req?.headers,
    remoteAddress: ctx.req?.socket?.remoteAddress,
  });
}
