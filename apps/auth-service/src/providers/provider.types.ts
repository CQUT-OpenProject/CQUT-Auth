import type { VerificationIdentity } from "../common/types.js";

export type VerifyCredentialsInput = {
  account: string;
  password: string;
};

export interface CampusVerifierProvider {
  readonly name: string;
  verifyCredentials(input: VerifyCredentialsInput): Promise<VerificationIdentity>;
}

