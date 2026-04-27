import type { IdentityStore } from "../store.js";
import type { AuthenticatedPrincipal, InteractiveLoginInput } from "../types.js";
import { IdentityCoreError } from "../errors.js";
import { ProviderRegistry } from "../provider-registry.js";
import { IdentityLinkService } from "./identity-link.service.js";
import { SubjectProfileService } from "./subject-profile.service.js";

export class InteractiveAuthenticatorService {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly identityLinkService: IdentityLinkService,
    private readonly subjectProfileService: SubjectProfileService,
    private readonly store: IdentityStore
  ) {}

  async authenticate(input: InteractiveLoginInput): Promise<AuthenticatedPrincipal> {
    if (!input.account || !input.password) {
      throw new IdentityCoreError("invalid_request", "missing account or password");
    }
    const provider = this.providerRegistry.getByName(input.provider);
    const identity = await provider.verifyCredentials({
      account: input.account,
      password: input.password
    });
    const linkedIdentity = await this.identityLinkService.linkVerifiedIdentity({
      provider: input.provider,
      identity
    });
    const profile = await this.subjectProfileService.ensureProfile({
      subjectId: linkedIdentity.subjectId,
      preferredUsername: linkedIdentity.schoolUid,
      displayName: `CQUT User ${linkedIdentity.schoolUid}`
    });
    const subject = await this.store.findSubject(linkedIdentity.subjectId);
    if (!subject || subject.status !== "active") {
      throw new IdentityCoreError("verification_failed", "subject is inactive");
    }
    return {
      subjectId: linkedIdentity.subjectId,
      schoolUid: linkedIdentity.schoolUid,
      school: linkedIdentity.school,
      studentStatus: linkedIdentity.currentStudentStatus,
      identitySource: linkedIdentity.provider,
      identityKey: linkedIdentity.identityKey,
      emailVerified: profile.emailVerified,
      preferredUsername: profile.preferredUsername ?? linkedIdentity.schoolUid,
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.displayName ? { displayName: profile.displayName } : {})
    };
  }
}
