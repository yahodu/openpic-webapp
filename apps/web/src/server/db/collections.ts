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
  dispatches: "notification_dispatches",
  accessLinks: "access_links",
  mediaAssets: "media_assets",
  faceMatches: "face_matches",
  providerWebhookEvents: "provider_webhook_events",
  idempotencyKeys: "idempotency_keys",
  plans: "plans",
  notificationTypes: "notification_types",
  notificationTemplates: "notification_templates",
  domainEvents: "domain_events",
  /**
   * App-owned identity collections (schema §13.2, §19.3; ADR-0040, ADR-0041).
   * They are registered here — rather than only as literals in their owning
   * module — so `INDEX_SPECS` can declare their indexes without duplicating the
   * collection names.
   */
  userProfiles: "userProfiles",
  notificationPreferences: "notificationPreferences",
  sessionDevices: "sessionDevices",
  contactChangeFanouts: "contactChangeFanouts",
} as const;

/** The name of any registered collection. */
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
