# ADR-0078 — OP-93 RED: `resolveChannel` pure resolver contract and strict template renderer

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-93 RED (`t_fe5e3429`) · **Relates to:** [ADR-0016](ADR-0016-notification-routing-matrix-as-data.md) (routing matrix as data), [ADR-0076](ADR-0076-op92-message-transport-and-novu-drift-guard-green.md) (`MessageTransport` port the resolved decision feeds)
- **Design:** §1.1 (mobile group), §3 (routing principles), §5 (channel resolution), §6 (throttle/digest/dedupe), §19.2–§19.6 (templates, preferences, dispatches, suppressions) · **Contract:** §7.4 (preferences), §7.5 (unsubscribe/suppression), Appendix F Phase 1, §19.5 `SkipReason`

## Context

OP-84 seeded the routing matrix as data (ADR-0016/0017) — `notificationTypes`
carries the routing decision, `notificationTemplates` carries the copy. OP-93 is
the code that _reads_ that data: a **pure** `resolveChannel` (design §5: "a pure
function of DB state — unit-testable with zero network") and a strict
`renderTemplate` that renders copy at write time (design §19.4) and fails loudly
on a broken template.

The RED card (`U1`–`U21`, plus the acceptance criterion "All seven `skipReason`s
are reachable and tested") does not pin module paths, export names, the input
shape, the decision union, the suppression shape, or the digest bucket key. Those
are decided here so the GREEN implementer and any later refactor cannot drift.

## Decision

### Module contract

| Module (specifier)                       | Exports                                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/notifications/resolve-channel` | `resolveChannel(input: ResolveChannelInput): ChannelDecision`; types `ResolveChannelInput`, `ChannelDecision`, `ResolvedChannel`, `SkipReason`, `ResolvePreferences`, `ResolveProfile`, `ResolveContacts`, `ThrottleState`, `NotificationSuppression` |
| `@/server/notifications/render-template` | `renderTemplate(templates: readonly NotificationTemplate[], vars: RenderVars, locale: string): RenderedTemplate`; `TemplateRenderError` (class); types `RenderVars`, `RenderedTemplate`                                                               |

Both modules are pure: no Mongo, no clock read (the caller passes `now`), no
network. `resolveChannel` is the only place routing is decided at runtime;
`renderTemplate` is the only place copy is produced.

### `resolveChannel` input

```ts
interface ResolveChannelInput {
  typeRow: NotificationType; // §19.1
  group: ChannelGroup; // the one group being resolved
  prefs: ResolvePreferences; // §19.3 (global/byType/byEvent/quietHours/locale)
  profile: ResolveProfile; // contactCapabilities.whatsappCapable lives here
  contacts: ResolveContacts; // email/phone + verified flags (Better Auth user)
  suppressions: readonly NotificationSuppression[];
  now: Date; // injected clock — purity
  eventId?: string | null; // byEvent scope + digest bucket key
  throttleState?: ThrottleState;
}
```

`ResolvedChannel = "in_app" | "email" | "sms" | "whatsapp"`.

**`eventId` is an addition to the GREEN card's signature.** The card's
`{typeRow, group, prefs, profile, contacts, suppressions, now, throttleState}`
omits it, but `byEvent` precedence (U2/U4) and the digest bucket key (U14) are
unreachable without the event scope. The fan-out worker always knows the event,
so it is passed in rather than smuggled through `prefs`.

**`profile` vs `contacts`.** The green card lists both, mirroring the real
storage split: `userProfiles.contactCapabilities` (§13, contract §1.2 `Me`) is
the profile, while `emailVerified`/`phoneNumberVerified` are Better Auth user
facts. `profile.contactCapabilities.whatsappCapable` is the only field the
resolver reads from the profile today.

**Suppression shape is `(channel, scope, reason)`, not a `contactHash`.** The
stored §19.6 row is keyed by `{channel, contactHash}`, but hashing the
destination is the caller's job (it already owns the contact facts). Passing the
already-matched rows keeps the resolver a pure function of values and makes the
`scope: "all" | "marketing"` distinction — "an unsubscribe can never silently
block an OTP" — testable directly. A `marketing` suppression blocks a candidate
only for a **non-transactional** type (U11).

### `resolveChannel` decision union

```ts
type ChannelDecision =
  | { kind: "send"; channel: ResolvedChannel }
  | { kind: "skip"; reason: SkipReason }
  | { kind: "defer"; until: string; reason: "quiet_hours_deferred" }
  | { kind: "digest"; bucketKey: string };
```

- All seven `SkipReason`s (`user_opt_out`, `no_verified_contact`, `suppressed`,
  `throttled`, `deduped`, `type_disabled`, `quiet_hours_deferred`) are reachable;
  `quiet_hours_deferred` is spelled `kind: "defer"` because the §5 flow
  _schedules_ the send after the window rather than dropping it.
- `until` is an ISO-8601 UTC instant (`…Z`) so the decision is serialisable and
  the worker can enqueue it verbatim. `now: Date` is the injected clock.

**Resolution order** (design §5): type disabled → group preference (transactional
forces ON; else `byEvent[eventId][group] ?? byType[typeKey][group] ?? global[group] ?? "on"`;
`off` is honoured only when the group's `optOutAllowed` is true and the group is
not `in_app`) → candidate eligibility + per-candidate suppression → throttle →
quiet hours.

**`mobile` first-eligible order** (design §1.1): a candidate is eligible when a
verified contact exists; `whatsapp` additionally requires
`whatsappCapable === true`. `auth.otp.mobile.requested` carries candidates
`["sms"]` only (ADR-0016), so U17 pins it to `sms` even for a WhatsApp-capable
user — phase 2 must never reroute auth.

**Digest bucket key** is `` `${typeKey}:${eventId}` `` — exactly the §19.6
example `"attendee.matches.new:6702abc"`.

**Dedupe is a passthrough.** `throttleState.deduped === true` (the unique index
already matched upstream, §6) becomes `{kind:"skip", reason:"deduped"}`; the
resolver does not re-implement the index. `throttleState.rateLimitExceeded`
becomes `{kind:"skip", reason:"throttled"}`.

### `renderTemplate` contract

- The first parameter is the **candidate template list** for one
  `(typeKey, channel)`; a single template is a one-element list. (The GREEN card
  wrote `template` singular; locale fallback needs the set, so the list is
  authoritative.)
- Locale selection: exact `locale` match, else the `en-IN` template, else
  `TemplateRenderError`. It returns `{ subject, body, locale }` where `locale` is
  the one actually used.
- `{{value}}` interpolation is HTML-escaped in **both** `subject` and `body`
  (U18, U26): `<`, `>`, `&` become entities.
- A declared `variables[]` value missing at render time throws
  `TemplateRenderError` naming the variable (U19); a **supplied value that was
  never declared** throws (U20) — the inverse guard of the seed schema, so a
  caller cannot smuggle an undeclared value into copy.
- A triple-stash `{{{value}}}` is **rejected** (U23). The card's security note
  forbids unescaped output "except in whitelisted layout partials"; no partial
  whitelist exists yet, so unescaped output is rejected outright. When layout
  partials arrive they must add an explicit allow-list rather than relax this
  default.

### Added tests beyond the card's U1–U21

The card's list omits `type_disabled` (required by the acceptance criterion "all
seven `skipReason`s reachable") and the triple-stash security requirement. Two
tests are added and marked so the GREEN worker and QA can see they are
intentional: **U22** (type disabled → `type_disabled`) and **U23** (triple-stash
rejected).

A review follow-up (card `t_2fc90876`, PR #185 round 1) adds three more pins so
GREEN cannot ship these behaviours untested:

- **U24** — `respectQuietHours: false` inside an enabled quiet window sends
  immediately instead of deferring (design §19.1 line 1819, §5).
- **U25 / U25b** — the `mobile` group falls through to the next eligible
  candidate when one is suppressed (`whatsapp` → `sms`), and skips with
  `reason:"suppressed"` when every candidate is suppressed (design §5
  lines 269–270).
- **U26** — the rendered `subject` is HTML-escaped exactly like `body` (U18), so
  an injected value cannot reach a mail subject unescaped.

## Consequences

- The whole §5 routing decision is exercised offline; a routing bug (wrong
  precedence, WhatsApp rerouting auth, quiet-hours off-by-one across midnight,
  a marketing suppression blocking a receipt) now fails the suite instead of
  reaching a provider (design §8).
- A template that interpolates an undeclared or missing value cannot ship.
- The resolver reconciles the card vs. the stored-document reality on three
  points (`eventId`, the suppression shape, digest key), all recorded above.
- **Coverage gaps / assumptions** (all deliberate, none silently guessed):
  1. `group.enabled === false` ("group disabled → no-op") is **not** pinned: the
     fan-out already filters enabled groups (design §5 `filter(g => g.enabled)`),
     and the decision union has no "nothing to do" member. The implementer may
     treat it defensively, but no test constrains it.
  2. Per-candidate _fallback_ on suppression for the `mobile` group (design §5:
     "contact suppressed? → next candidate") is now pinned by **U25**: a
     suppressed `whatsapp` candidate falls through to `sms`, and all candidates
     suppressed yields `{kind:"skip", reason:"suppressed"}`.
  3. `null` vs absent preference overrides: the stored §19.3 document is sparse
     (`null` is a PATCH verb, not a stored value), so U4 tests **absence**.
  4. The `in_app` decision is only pinned as a `send`; its feed-row write
     (`writeFeedRow`, design §25) is out of scope.
  5. `until` timezone math is pinned for one window (`22:00–07:00`
     `Asia/Kolkata`, crossing midnight). **U24** reuses the same window with the
     per-type switch `respectQuietHours: false` (design §19.1 line 1819) and
     pins that the resolver **sends** instead of deferring — quiet hours only
     defer when the type respects them. Non-crossing windows and DST-timezones
     are not pinned.
  6. `handlebars` is currently only a **transitive** dependency in
     `pnpm-lock.yaml`; the GREEN implementation must add it as a direct
     dependency of `@openpic/web`, or hand-roll an equivalent escaping renderer.
     The tests assert behaviour, not the library.

## Out of scope (deliberately not tested)

- Fan-out/recipient resolution, dispatch persistence, `recordSkip`, the dedupe
  unique index, digest-bucket writes and the quiet-hours release cron (design
  §25, §19.5–§19.6) — later OP-93 phases.
- `notificationPreferences` read/write routes and the `resolved` projection
  (contract §7.4).
- Template/type seeding and the seed schema (OP-84, ADR-0016).

## Alternatives considered

- **`resolveChannel` reads Mongo/clock itself.** Rejected: the card and design §5
  require a pure function; injecting `now`, `prefs`, `profile`, `contacts`,
  `suppressions` and `throttleState` is what makes it offline-testable.
- **Fold `eventId` into `prefs`.** Rejected: `prefs` is the user's stored
  document; the event scope is per-send context, not stored preference state.
- **Pin the stored `contactHash` suppression shape.** Rejected: it forces the
  resolver to hash, and the hash is the caller's contract, not the decision's.
- **`renderTemplate(template, …)` singular with no fallback.** Rejected: locale
  fallback (U21) is impossible without the candidate set.
- **Allow `{{{}}}` and rely on review.** Rejected: the card names unescaped
  output as a security requirement; default-deny is the safer RED pin.
