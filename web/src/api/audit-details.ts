import type { AuditLog } from "./types";

export function auditDetails(audit: AuditLog) {
  return Object.fromEntries(
    Object.entries({
      changedFields: audit.changedFields,
      revisionId: audit.revisionId,
      revisionNumber: audit.revisionNumber,
      secretId: audit.secretId,
      previousClientStatus: audit.previousClientStatus,
      newClientStatus: audit.newClientStatus,
      previousRevisionStatus: audit.previousRevisionStatus,
      newRevisionStatus: audit.newRevisionStatus,
      reason: audit.reason,
    }).filter(([, value]) => value !== undefined),
  );
}
