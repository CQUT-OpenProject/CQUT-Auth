import type {
  CampusVerifierProvider,
  VerificationIdentity,
  VerifyCredentialsInput,
} from "../types.js";
import { IdentityCoreError, RetryableProviderError } from "../errors.js";

type MockProviderOptions = {
  schoolCode: string;
};

/**
 * Sentinel password that makes the mock provider simulate a transient upstream
 * outage (as the real campus provider would signal via RetryableProviderError).
 * Test/dev only — the mock provider is never enabled in production.
 */
export const MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD =
  "__simulate_upstream_outage__";

export class MockCampusVerifierProvider implements CampusVerifierProvider {
  readonly name = "mock";

  constructor(private readonly options: MockProviderOptions) {}

  async verifyCredentials(
    input: VerifyCredentialsInput,
  ): Promise<VerificationIdentity> {
    if (input.password === MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD) {
      throw new RetryableProviderError("mock upstream outage");
    }
    // Keep test/dev flows credential-agnostic: reject only empty password.
    if (input.password.trim().length === 0) {
      throw new IdentityCoreError("verification_failed", "verification failed");
    }
    return {
      schoolUid: input.account || "mock-student-001",
      verified: true,
      studentStatus: "active",
      school: this.options.schoolCode,
      identityHash: `mock:${input.account || "mock-student-001"}`,
    };
  }
}
