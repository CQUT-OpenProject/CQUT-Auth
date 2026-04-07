import type { StudentStatus } from "@cqut/shared";

export type VerificationIdentity = {
  schoolUid: string;
  verified: boolean;
  studentStatus: StudentStatus;
  school: string;
  identityHash?: string | undefined;
};

export type VerifyCredentialsInput = {
  account: string;
  password: string;
};

export interface CampusVerifierProvider {
  readonly name: string;
  verifyCredentials(input: VerifyCredentialsInput): Promise<VerificationIdentity>;
}

export type InteractiveLoginInput = {
  provider: string;
  account: string;
  password: string;
  ip: string;
  userAgent?: string | undefined;
};

export type AuthenticatedPrincipal = {
  subjectId: string;
  schoolUid: string;
  school: string;
  studentStatus: StudentStatus;
  identitySource: string;
  identityKey: string;
  email?: string | undefined;
  emailVerified: boolean;
  displayName?: string | undefined;
  preferredUsername: string;
};

export type SubjectRecord = {
  subjectId: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export type SubjectIdentityRecord = {
  subjectId: string;
  provider: string;
  schoolUid: string;
  identityKey: string;
  currentStudentStatus: StudentStatus;
  school: string;
  createdAt: string;
  updatedAt: string;
};

export type SubjectProfileRecord = {
  subjectId: string;
  preferredUsername?: string | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
  emailVerified: boolean;
  updatedAt: string;
};
