import type { CampusVerifierProvider, VerificationIdentity, VerifyCredentialsInput } from "../types.js";
import { IdentityCoreError } from "../errors.js";

type MockProviderOptions = {
  schoolCode: string;
};

export class MockCampusVerifierProvider implements CampusVerifierProvider {
  readonly name = "mock";

  constructor(private readonly options: MockProviderOptions) {}

  async verifyCredentials(input: VerifyCredentialsInput): Promise<VerificationIdentity> {
    // Keep test/dev flows credential-agnostic: reject only empty password.
    if (input.password.trim().length === 0) {
      throw new IdentityCoreError("verification_failed", "verification failed");
    }
    return {
      schoolUid: input.account || "mock-student-001",
      verified: true,
      studentStatus: "active_student",
      school: this.options.schoolCode,
      identityHash: `mock:${input.account || "mock-student-001"}`
    };
  }
}
