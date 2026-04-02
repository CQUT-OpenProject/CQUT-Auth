import { Inject, Injectable } from "@nestjs/common";
import { AppConfigService } from "../../config/app-config.service.js";
import type { VerificationIdentity } from "../../common/types.js";
import type { CampusVerifierProvider, VerifyCredentialsInput } from "../provider.types.js";
import { ApiError } from "../../common/api-error.js";

@Injectable()
export class MockProvider implements CampusVerifierProvider {
  readonly name = "mock";

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  async verifyCredentials(input: VerifyCredentialsInput): Promise<VerificationIdentity> {
    const approved = input.password === "mock-password";
    if (!approved) {
      throw new ApiError("verification_failed", "verification failed");
    }
    return {
      schoolUid: input.account || "mock-student-001",
      verified: true,
      studentStatus: "active_student",
      school: this.config.schoolCode,
      identityHash: `mock:${input.account || "mock-student-001"}`
    };
  }
}
