# ADR-0016 — Notification routing matrix as data: `notificationTypes` / `notificationTemplates` schema, seed and frozen 81-key contract

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-84 RED (`t_5bf8fd6d`) · **Relates to:** [ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) (the sibling seed pattern), [ADR-0015](ADR-0015-plans-seed-concurrency-atomic-upsert.md) (atomic upsert)
- **Schema:** §19.1, §19.2, §4 (matrix), §1.1 (mobile group), §6 (dedupe/digest) · **Contract:** §7.6 (normative type catalogue)

## Context

The routing matrix (design §4) is **stored as data** so that routing is testable
and Novu holds no routing knowledge (design §8). Two collections carry it:
`notificationTypes` (§19.1) is the routing decision — the only copy of it — and
`notificationTemplates` (§19.2) is the first-party copy per `(typeKey, channel,
locale)`. Contract §7.6 enumerates the **81** normative `typeKey`s and states
that "the seed script is the authority; it must produce exactly these 81
`notificationTypes` documents."

The RED card (`U1`–`U9`, `I1`) does not pin module paths, export names, the
`channel` vocabulary, template field names, the idempotency/version semantics, or
where the frozen key list lives. Those are decided here so the GREEN implementer
and any future refactor cannot drift.

## Decision

### Module contract

| Module (specifier)                                     | Exports                                                                                                                                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/notifications/notification-types`            | `notificationTypeSchema`, `channelGroupSchema`, `throttleSchema`, `dedupeSchema` (Zod); types `NotificationType`, `ChannelGroup`, `NotificationCategory`, `NotificationSeverity`, `NotificationAudience` |
| `@/server/notifications/notification-types.values`     | `NOTIFICATION_TYPE_KEYS: readonly string[]` — the frozen 81 contract keys; `SEED_NOTIFICATION_TYPES: readonly NotificationType[]` — one per key                                                          |
| `@/server/notifications/notification-templates`        | `notificationTemplateSchema` (Zod, with the variable-consistency refinement); type `NotificationTemplate`                                                                                                |
| `@/server/notifications/notification-templates.values` | `SEED_NOTIFICATION_TEMPLATES: readonly NotificationTemplate[]`                                                                                                                                           |
| `@/server/notifications/seed-notification-types`       | `seedNotificationTypes({ db?, types?, clock? })`; `seedNotificationTemplates({ db?, templates?, clock? })`                                                                                               |

`@/server/db/collections` gains `notificationTypes: "notification_types"` and
`notificationTemplates: "notification_templates"` (schema §12 names).

### The frozen 81-key list is inlined, never snapshotted

U1 calls for a "snapshot test". A Vitest inline snapshot is written on first run
and therefore **passes before the seed exists**, making the red state vacuous and
the guard self-fulfilling. Instead the spec inlines the 81 keys from §7.6 (and
their per-category grouping) and asserts both `NOTIFICATION_TYPE_KEYS` and the
seeded typeKeys against it. The `typeKey` set is the contract; a change to it is
a deliberate contract change, not something a snapshot should absorb silently.

### `channel` on a template names the routing group

The card says "for every enabled (`typeKey`, channel != in_app)". A "channel" in
§1 is `in_app | email | sms | whatsapp | push`, but a **group** (§1.1) is
`in_app | email | mobile`, and the whole point of §1.1 is that WhatsApp-vs-SMS is
a `channelGroups[].candidates` decision, not a per-type decision. Templating
against the concrete channel would force a template per candidate and re-encode
routing in the template layer.

Therefore a template's `channel` is the **group** it serves:
`"in_app" | "email" | "mobile"`. One active `en-IN` template is required per
enabled group; `providerRefs.whatsappTemplateName` remains the single
provider-coupling field (schema §19.2). This makes AC2 a clean correspondence
between `channelGroups[].enabled` and the template set.

### `notificationTemplateSchema` rejects declared-vs-used variable drift

`variables[]` exists so a missing placeholder is a render-time error caught in CI
(§19.2). The schema's refinement parses `{{…}}` placeholders from
`subjectTemplate` + `bodyTemplate` and rejects, at the `variables` issue path,
**both** a placeholder that is used but not declared (missing) and one declared
but never used (unused). Because the seed parses every template through this
schema, U7 is enforced as data.

For `in_app` templates, `subjectTemplate` carries the feed **title** and
`bodyTemplate` the feed **body**; there is no separate `titleTemplate` field.
This is an inferred mapping (schema §19.2 has only subject/body) and is flagged
as an assumption.

### Idempotent create-or-reconcile, version-on-change

Mirroring ADR-0014 §6 for `plans`:

- `seedNotificationTypes` upserts by `typeKey`: inserts missing types with the
  catalogue `version`; rewrites a type whose routing differs and bumps `version`
  by **exactly one**; leaves `version` untouched on an idempotent re-run.
- `seedNotificationTemplates` upserts by `(typeKey, channel, locale)`, with the
  same version-on-change semantics, and `active: true`.

`types?` / `templates?` are injectable (defaulting to the seeded constants) so
I1 can simulate a matrix edit shipped in a deploy without editing the constant.
Persistence goes through `platformRepo(db).collection(...)` — both collections
are platform-scope (schema §12), and the `no-direct-collection-access` rule
forbids raw `db.collection(...)` outside `src/server/{db,repos}`.

### U9 reading: the first-match type

The card's U9 names `attendee.matches.new`, but the design doc makes
`attendee.matches.ready` the once-per-attendee+event, mobile-eligible, deduped
"first non-empty match set" notification (§4.8, §6, §19.1 worked example), while
`attendee.matches.new` is the digest-throttled, mobile-excluded follow-up. The
spec pins **both** readings: `attendee.matches.ready` carries the
`{typeKey}:{profileId}` dedupe with `windowHours: null` on an enabled mobile
group, and `attendee.matches.new` is digest-throttled with mobile disabled. This
resolves the card's ambiguity without guessing away either fact.

### Label / description

`label` and `description` (served by `GET /api/v1/notification-types`) are
**optional** in `notificationTypeSchema` and are not asserted here: the card's
transcription list omits them, and the route story owns their projection. A
future story should pin their requiredness and never-return/serving rules.

## Consequences

- A seed that ships 80 or 82 types, omits a template for an enabled group,
  declares a variable it does not use, or leaks a raw credential placeholder now
  fails the suite instead of reaching a provider.
- `version` becomes a faithful audit signal of "the routing matrix changed"; an
  implementation that always writes the catalogue version fails I1.
- **Coverage gap / assumption:** the full per-type channel matrix from §4 (which
  exact types enable email/mobile) is **not** pinned key-by-key in the RED specs
  — only the structural invariants (U2–U9) plus the OTP/downgrade/first-match
  pins. The implementer transcribes §4; a later story that renders the settings
  UI (`GET /api/v1/notification-types`) should add a table-driven matrix spec.
- The `{typeKey:1}` unique index (schema §19.1) and the active-only partial
  unique index on templates (schema §19.2) are declared by the design doc but
  adding them to `INDEX_SPECS` is OP-76 territory and out of scope here.
- `notificationPreferences`, dispatches, digests and suppressions (§19.3–§19.6)
  are later stories.

## Alternatives considered

- **Snapshot the 81 keys.** Rejected: a snapshot passes on first write, so it
  cannot express a red state and silently absorbs an unintended key change.
- **Template `channel` = concrete channel (`sms`/`whatsapp`).** Rejected: it
  duplicates §1.1 routing into the template layer and fragments the copy the
  user actually reads into one row per transport.
- **Put the variable-consistency check only in the seed runner.** Rejected: the
  schema is the reusable gate an admin UI / future template editor must also
  pass; the invariant belongs on the schema.
- **Assert `label`/`description` requiredness now.** Rejected: the card omits
  them and the route story owns the projection; over-tightening would be a guess.
