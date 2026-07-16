import { randomBytes } from "node:crypto";
import type { AuthenticatedPrincipal } from "../identity/index.js";
import type {
  ManagementSessionRepository,
  IdentityRepository,
} from "../persistence/contracts.js";
import { base64Url, sha256 } from "../utils.js";

export class ManagementSessionService {
  constructor(
    private readonly sessions: ManagementSessionRepository,
    private readonly identity: Pick<
      IdentityRepository,
      "findPrincipalBySubjectId"
    >,
    private readonly absoluteTtlSeconds: number,
    private readonly idleTtlSeconds: number,
    private readonly now: () => Date = () => new Date(),
    private readonly createToken: () => string = () =>
      base64Url(randomBytes(32)),
  ) {}

  async create(subjectId: string) {
    const token = this.createToken();
    const tokenHash = sha256(token);
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + this.absoluteTtlSeconds * 1000,
    ).toISOString();
    await this.sessions.deleteExpiredManagementSessions(now.toISOString());
    await this.sessions.createManagementSession({
      tokenHash,
      subjectId,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt,
    });
    return { token, expiresAt };
  }

  async authenticate(
    token: string | undefined,
  ): Promise<AuthenticatedPrincipal | null> {
    if (!token) {
      return null;
    }
    const tokenHash = sha256(token);
    const session = await this.sessions.findManagementSession(tokenHash);
    if (!session) {
      return null;
    }
    const now = this.now();
    const idleExpiresAt =
      new Date(session.lastSeenAt).getTime() + this.idleTtlSeconds * 1000;
    if (
      new Date(session.expiresAt).getTime() <= now.getTime() ||
      idleExpiresAt <= now.getTime()
    ) {
      await this.sessions.deleteManagementSession(tokenHash);
      return null;
    }
    const principal = await this.identity.findPrincipalBySubjectId(
      session.subjectId,
    );
    if (!principal) {
      await this.sessions.deleteManagementSession(tokenHash);
      return null;
    }
    if (
      now.getTime() - new Date(session.lastSeenAt).getTime() >=
      5 * 60 * 1000
    ) {
      await this.sessions.touchManagementSession(tokenHash, now.toISOString());
    }
    return principal;
  }

  async revoke(token: string | undefined) {
    if (token) {
      await this.sessions.deleteManagementSession(sha256(token));
    }
  }
}
