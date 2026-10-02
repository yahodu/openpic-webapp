/**
 * Collection-name registry (OP-75, §3).
 *
 * Every collection name the application uses is declared here so a rename or a
 * typo is caught at the type level rather than silently creating a new
 * collection at runtime.
 */

/** The canonical collection names used by the application. */
export const COLLECTIONS = {
  users: "users",
  sessions: "sessions",
  invitations: "invitations",
  uploads: "uploads",
  billingAccounts: "billing_accounts",
  auditLogs: "audit_logs",
} as const;

/** The name of any registered collection. */
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
