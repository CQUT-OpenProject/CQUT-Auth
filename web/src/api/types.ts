export type User = {
  subjectId: string;
  preferredUsername?: string;
  displayName: string;
  isAdmin: boolean;
};

export type AuthContext =
  | { authenticated: false; csrfToken: string }
  | {
      authenticated: true;
      csrfToken: string;
      user: User;
      clientSecretPolicy: {
        defaultGraceSeconds: number;
        maxGraceSeconds: number;
      };
    };

export type ProjectAction =
  | "view"
  | "manage_project"
  | "manage_members"
  | "write_client"
  | "rotate_secret"
  | "revoke_authorizations"
  | "revoke_secret"
  | "disable_client"
  | "review";

export type Project = {
  projectId: string;
  name: string;
  description: string;
  status: "active" | "archived";
  version: number;
  role: "owner" | "maintainer" | "viewer" | null;
  capabilities: ProjectAction[];
};

export type ProjectMember = {
  projectId: string;
  subjectId: string;
  role: "owner" | "maintainer" | "viewer";
  createdAt: string;
  updatedAt: string;
};

export type ClientSecret = {
  secretId: string;
  status: "active" | "retiring" | "revoked";
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  version: number;
};

export type ClientRevision = {
  revisionId: number;
  revisionNumber: number;
  status: "draft" | "pending" | "approved" | "rejected";
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopeWhitelist: string[];
  rejectionReason: string | null;
  version: number;
};

export type Client = {
  clientId: string;
  projectId: string;
  createdBySubjectId: string | null;
  displayName: string;
  description: string;
  clientType: "web" | "spa";
  lifecycleStatus: "draft" | "active" | "disabled";
  activeRevision: ClientRevision | null;
  proposedRevision: ClientRevision | null;
  updatedAt: string;
  clientVersion: number;
  secrets: ClientSecret[];
};

export type AuditLog = {
  id: number;
  projectId: string;
  clientId: string | null;
  subjectId: string | null;
  action: string;
  details: Record<string, any>;
  createdAt: string;
};
