import type { Request } from "express";
import type { StaticConfig } from "../config.js";
import { ManagementSessionService } from "../management/management-session.service.js";
import { resolveTrustedExpressRequestIp } from "../request-ip.js";

export function readAgentAccessToken(request: Request) {
  const header = request.get("authorization");
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

export async function authenticateAgentRequest(
  request: Request,
  config: StaticConfig,
  sessions: ManagementSessionService,
  adminIds: Set<string>,
) {
  const token = readAgentAccessToken(request);
  const principal = await sessions.authenticate(token);
  if (!principal || !token) {
    return null;
  }
  return {
    token,
    principal,
    actor: {
      subjectId: principal.subjectId,
      isAdmin: adminIds.has(principal.subjectId),
      sourceIp: resolveTrustedExpressRequestIp(config, request),
    },
  };
}
