/**
 * Collection-name registry (OP-75, §3; OP-76, schema §21).
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
  notifications: "notifications",
  events: "events",
  eventOrganizers: "event_organizers",
  eventImages: "event_images",
  attendeeEventProfiles: "attendee_event_profiles",
  subscriptions: "subscriptions",
  notificationTypes: "notification_types",
  notificationTemplates: "notification_templates",
  dispatches: "notification_dispatches",
  accessLinks: "access_links",
  mediaAssets: "media_assets",
  faceMatches: "face_matches",
  providerWebhookEvents: "provider_webhook_events",
  idempotencyKeys: "idempotency_keys",
  plans: "plans",
} as const;

/** The name of any registered collection. */
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
