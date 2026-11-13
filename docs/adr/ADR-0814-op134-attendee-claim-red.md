# ADR-0814 — OP-134 RED: claim an anonymous session and the cross-tenant "my events" read

- **Status:** Accepted (RED / executable contract)
- **Consumers:** the OP-134 RED specs —
  `apps/web/src/test/unit/my-events-expiring-soon.test.ts` (U1, 13 cases),
  `apps/web/src/test/unit/attendee-claim-decision.test.ts` (U2, 8 table rows +
  1 literal), `apps/web/src/test/integration/attendee-claim.test.ts` (I1 ×2,
  I2 ×4, I4, I7 ×2 — 9 cases),
  `apps/web/src/test/integration/attendee-claim-on-signin.test.ts` (I5 ×2, I6 —
  3 cases), `apps/web/src/test/integration/my-events.test.ts` (I3 ×5),
  `apps/web/e2e/attendee-claim.spec.ts` (E1) and the shared fixture modules
  `apps/web/src/test/helpers/attendee-claim-flow.ts` and the extended
  `apps/web/src/test/helpers/authed-app.ts` (`signIn(identity, {headers})`) —
  plus the gated GREEN card `t_135c11ae`, which must not edit any of them; the
  follow-up TEST card `t_08232689` adds
  `apps/web/src/test/integration/attendee-claim-endpoint-arms.test.ts`
  (I8 ×3, I9 — 4 cases), which cites this record for the contract it observes
  and records its own decisions in
  [ADR-0818](ADR-0818-op134-claim-endpoint-arms-pins.md).
- **Lane:** the shared attendee block `0780`–`0798` is **fully minted** (the
  ledger's `Next free` and the pool both read `0811` on `origin/main`
  `f9a0f27`, and `docs/adr` holds every number from `0780` to `0810` that the
  block and the pool issued). A dependent ticket does not continue its parent's
  range ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7), so the
  record drew `0811` from the `unallocated (future lanes)` pool; **no lane row
  is created**. The sweep before minting was empty: no `ADR-0811*` file existed
  on that head, on any local branch or in `docs/adr`. **Renumbered
  `0811 → 0813 → 0814` at merge:** the OP-132 F4-R2 record
  (`ADR-0811-op132-attendee-selfie-upload-window.md`) and the F5-symmetric record
  (`ADR-0812-op132-submit-object-transport-500.md`) landed on `main` first, and a
  first renumber to `0813` then collided with the in-flight
  `ADR-0813-op132-attendee-retention-gate.md` on
  `OP-132-task-attendee-retention-gate-pins`; under ADR-0300 §10 the lane moves
  above the highest in-flight number, so this record takes `0814`, the GREEN takes
  `0815`, both ledger cells read `0816`, and the RED specs' docblock citations
  follow (`ADR-0811 → ADR-0814`, docs only — no assertion, fixture or helper
  behaviour changed).
- **Amends:** nothing. **Amended by:** the OP-134 GREEN implementation record
  (same lane, `0815`).
- **Consumes:** `0814` as renumbered (`Next free` advances to `0815`).
- **Base:** `origin/main` `f9a0f27`.

## Context

§6.7 is the PRD's _\"she doesn't have to re-visit and re-upload\"_: an attendee
who uploaded a selfie anonymously and later signs in must find her photos already
in her account. Two surfaces carry it — `POST /me/attendee-sessions:claim` (the
explicit call) and `GET /me/events` (the account's list) — and one **seam**
already exists on the trunk for the real path an attendee takes:

- `@/server/auth/identity-hooks` types `ClaimAttendeeSession`
  (`{userId, token}`), `handleSessionCreated` invokes it (`runClaim`,
  never throwing into the auth path), `@/server/auth/identity-lifecycle` fills
  `attendeeSessionToken` from the request's `op_att` cookie, and `createAuth`
  accepts a `claim` override whose default is a **no-op** (`noopClaim`,
  ADR-0040 §5: \"until the §6.7 claim service lands\"). A browser that signs in
  from the attendee page therefore claims nothing today, and the account's list
  stays empty — which is the failure the user story names.

Everything else was decided here because the contract, the design document and
the GREEN card are silent or in tension: the merge rule when the caller already
owns a profile, whether the walk follows profiles or `attendeeSessions.eventIds`,
what a _repeat_ claim answers, the ordering and cursor of the list, and which of
the two cursor refusals this app serves.

## Decision

### 1. Two pure modules, and only two

- `@/server/attendee/my-events` exports
  `EXPIRING_SOON_WINDOW_MS` (`604_800_000`) and
  `computeExpiringSoon({galleryExpiresAt, now})`. The clock is an **input**, so
  the boundary is testable to the millisecond.
- `@/server/attendee/claim-decision` exports `ClaimSkipReason`
  (`\"already_claimed_by_this_user\"`), `ClaimDecisionInput`, `ClaimDecision` and
  `decideClaim(input)`.

The rest is I/O (a route plus a service) and is pinned only through the
observable: a `200` body, stored rows, a `Set-Cookie`, an outbox row.

### 2. `expiringSoon` is inclusive at both ends of `[0, 7 days]`

| `galleryExpiresAt − now` | `expiringSoon` |
| ------------------------ | -------------- |
| `null`                   | `false`        |
| `7 days` exactly         | `true`         |
| `7 days + 1 ms`          | `false`        |
| `1 ms`                   | `true`         |
| `0` (this instant)       | `true`         |
| `−1 ms` (already gone)   | `false`        |

\"Within 7 days\" is inclusive [§6.7]; an already-expired gallery is **not**
\"expiring soon\" (its `status`/`galleryExpiresAt` tells that story, and a
permanently-true badge is noise the attendee learns to ignore).

### 3. The claim decision table

| existing user profile | anonymous selfie | existing selfie | action    | `adoptAnonymousSelfie` |
| --------------------- | ---------------- | --------------- | --------- | ---------------------- |
| no                    | any              | any             | `repoint` | —                      |
| yes                   | present          | absent          | `merge`   | `true`                 |
| yes                   | absent           | present         | `merge`   | `false`                |
| yes                   | present, newer   | present         | `merge`   | `true`                 |
| yes                   | present, older   | present         | `merge`   | `false`                |
| yes                   | present, equal   | present         | `merge`   | `false`                |
| yes                   | absent           | absent          | `merge`   | `false`                |

The merge arm is forced, not chosen: `{eventId:1, \"subject.userId\":1}` is
**unique partial on `subject.kind:\"user\"`** (schema §15.3), so re-pointing a
second profile would collide. The documented rule is \"keep the newest active
selfie\", so the comparison is between the two `selfies.createdAt` values; the
**tie** keeps the existing profile's own selfie, because the row that already
owns the matches is not rewritten for a coin flip. The anonymous row is left
untouched (`subject` still `anonymous`) — proven by a case, because deleting it
would move data.

### 4. The claim walks **profiles**, not `attendeeSessions.eventIds`

§6.7 says \"re-points **every** `attendeeEventProfiles` row\". A profile can exist
for an event the session was never explicitly bound to (the attendee reached a
second event's page holding the cookie she already had, and the consent route
does not append to `eventIds`), so the walk keys on
`subject.attendeeSessionId === <session._id>`. One case seeds two profiles whose
session names only the first event.

### 5. The claim is one atomic update per profile, and moves nothing

`updateOne({\_id, \"subject.kind\":\"anonymous\", \"subject.attendeeSessionId\": id},
{$set:{\"subject.kind\":\"user\",\"subject.userId\":<ObjectId>,claimedAt}, $unset:
{\"subject.attendeeSessionId\":\"\"}})` — the schema §15.3 snippet verbatim. The
pins: the `_id` is unchanged, `subject` is then **exactly** `{kind, userId}`,
every `selfies` id is unchanged, `faceMatches` are untouched, and the **work
queue's** outbox does not grow (no `q:selfie` re-embedding).

### 6. Repeat claim by the owner is a `200` no-op; another user is `409`

`409 session_claimed_by_other_user` is for a **different** account, and nothing
is re-pointed. The owner calling twice gets `200` with `claimed: []` — a
refusal there would force the client to special-case the order of its own two
calls (the sign-in hook's claim and the explicit one). A lapsed session is
`401 attendee_session_expired` (the shipped resolver already throws that, with
`details.recreateUrl`); a caller with no user credential is `401
authentication_required` (Appendix D: \"claim\" is identified-attendee only), and
an anonymous `op_att` cookie is not a user credential.

### 7. The response clears `op_att`, and emits one `attendee.event.linked` per claimed event

`Set-Cookie: op_att=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` — an expired
cookie with an empty value, not merely an absent one (a browser keeps an unset
cookie). The attribute set mirrors `buildAttendeeSessionCookie` so a client
cannot end up with two differently-scoped `op_att` cookies.

`attendee.event.linked` is already a registered notification type
(`notification-types.values.ts`: category `matching`, `ATTENDEE` audience,
channels `[true,false,false]` = in-app only, `optOutAllowed: false`,
`NO_THROTTLE`), so §6.7's \"emits per claimed event\" costs the GREEN no
catalogue work. The pin is the **count** (one row per claimed event), the
`eventKey`, the row's `tenantId`, and that the row names the caller — the field
that carries the caller (a `subjectRef`/`payload` split) is deliberately not
pinned.

### 8. The list is ordered by `updatedAt` **descending**, with the `_id` tiebreaker

Schema §15.3 names `{\"subject.userId\":1, updatedAt:-1}` as _\"the whitelisted
cross-tenant read: my events\"_, and §0.8 requires a compound `(sortValue, id)`
key so a tie never skips or duplicates. Every ordering case seeds its rows in an
order **opposite** to the expected answer (and a stranger's row with the newest
`updatedAt`), so an `_id`-ordered read, or one that dropped the subject clause,
reddens. This is a deliberate departure from
`crossTenantReads.findAttendeeProfilesBySubjectUser` as shipped (OP-77 orders by
`_id` with **offset** paging); the existing `cross-tenant-read.test.ts` sorts the
ids it compares, so it does not pin an order and the GREEN may extend or replace
that function without touching it.

### 9. Paging uses the shared §0.8 codec, and a foreign cursor is `400 invalid_cursor`

`parsePageQuery` / `buildCursorPage` / `encodeCursor` from `@/server/http/cursor`
already implement §0.8 exactly (default `40`, ceiling `100`, strict `{c, i}`
decode → `400 invalid_cursor`), so the list must use them rather than invent a
codec. `page` is `{nextCursor, hasMore, limit}`, `nextCursor` is `null` on the
terminal page, and the walk over two pages must partition the list (no duplicate,
no skip). **Flagged inconsistency:** OP-133's gallery answers `422
validation_failed` for a cursor it did not mint (ADR-0794 §5); this record
follows §0.8's own `400 invalid_cursor` because the shared module implements it
and there is nothing endpoint-specific to justify a second answer. Reconciling
the gallery is out of scope here — recorded in §Consequences.

### 10. The item is exactly the thirteen keys §6.7 documents

`coverThumbnailUrl, displayTimeZone, eventId, eventName, expiringSoon,
galleryExpiresAt, galleryUrl, matchCount, newMatchCount, organizerDisplayName,
slug, startAt, status`.

The mappings this record fixes (none of them is stated in the endpoint's prose):

| key                    | source                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `eventName`            | `events.name`                                                                                         |
| `organizerDisplayName` | `tenants.name` (the §6.7 example reads `\"Rahul Studio\"`, a tenant name)                             |
| `startAt`              | `events.startAt`, RFC 3339 UTC ms (`toISOString()`)                                                   |
| `displayTimeZone`      | `events.displayTimeZone`                                                                              |
| `slug` / `galleryUrl`  | the event's **active** access link; `/e/{slug}/gallery`                                               |
| `coverThumbnailUrl`    | `null` — `events` has no cover-asset pointer, and a fixture with no media cannot answer anything else |
| `matchCount`           | `attendeeEventProfiles.matchCount` (the §15.3 cache, never a count query)                             |
| `newMatchCount`        | `faceMatches` for this profile with `seenAt: null` (and not hidden)                                   |
| `status`               | `attendeeEventProfiles.status` (`ready` before a match run, `processing` after a submit)              |
| `galleryExpiresAt`     | `events.retentionExpiresAt`, RFC 3339 UTC ms or `null`                                                |
| `expiringSoon`         | `computeExpiringSoon({galleryExpiresAt, now})` (§2 above)                                             |

### 11. The claim's `Idempotency-Key` is optional

§0.9 does not list the claim among the endpoints that **require** one, so it is
\"optional but honoured\". The fixture sends one anyway, which accepts both a
GREEN that declares the optional stage and one that does not — the pin is the
behaviour, not the header.

## Contract expected of the implementation

```ts
// apps/web/src/server/attendee/my-events.ts
export const EXPIRING_SOON_WINDOW_MS: number; // 604_800_000
export function computeExpiringSoon(input: {
  readonly galleryExpiresAt: Date | null;
  readonly now: Date;
}): boolean;

// apps/web/src/server/attendee/claim-decision.ts
export type ClaimSkipReason = \"already_claimed_by_this_user\";
export interface ClaimDecisionInput {
  readonly hasExistingUserProfile: boolean;
  readonly anonymousSelfieCreatedAt: Date | null;
  readonly existingSelfieCreatedAt: Date | null;
}
export type ClaimDecision =
  | { readonly action: \"repoint\" }
  | {
      readonly action: \"merge\";
      readonly skipReason: ClaimSkipReason;
      readonly adoptAnonymousSelfie: boolean;
    };
export function decideClaim(input: ClaimDecisionInput): ClaimDecision;

// apps/web/src/app/api/v1/me/attendee-sessions:claim/route.ts
export const POST: (request: Request) => Promise<Response>;

// apps/web/src/app/api/v1/me/events/route.ts
export const GET: (request: Request) => Promise<Response>;
```

The colon verb uses the directory convention the trunk already ships
(`me/sessions:revoke-all`, `p/events/[slug]/gallery:seen`,
`p/events/[slug]/selfies:reuse`).

The GREEN also owes: `session_claimed_by_other_user` in
`AUTH_ERROR_CODES` (`packages/contracts/src/errors.ts`) and its
`AUTH_ERROR_TRANSPORT` row (`409`, non-retryable) — §6.7's code exists in no
catalogue today — and `info attendee.claimed` with the two counts (green card
§1). The session-created hook's `claim` default must become the real service,
because the test harness builds the app exactly as production does
(`createAuth({db})`), mirroring how ADR-0783 made the attendee resolver the
guard's default.

## Evidence

RED at handoff (probe deleted, `git status --short` shows the seven spec files
and the `authed-app.ts` edit only):

- `npx vitest run --project unit <two specs>` → `Cannot find package
'@/server/attendee/my-events'` / `'@/server/attendee/claim-decision'`.
- Integration → `Cannot find package '@/app/api/v1/me/attendee-sessions:claim/route'`
  and `'@/app/api/v1/me/events/route'`.

Type-correctness and satisfiability were proven with a **faithful probe**
(deleted before handoff, production diffs restored — `git diff` empty on
`packages/contracts/src/errors.ts`, `apps/web/src/server/http/catalog.ts` and
`apps/web/src/server/auth/identity-hooks.ts`):

| probe state                                                                                      | result                                              |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| wrong-answer stubs (`decideClaim` always `repoint`, `expiringSoon` always `false`, routes `500`) | assertion-level red: unit `14 failed \\             | 7 passed (21)`, integration `17 failed (17)`                                                                                         |
| faithful pure modules                                                                            | unit `21 passed (21)`                               |
| faithful claim service + both routes + the hook default + the `409` catalogue row                | integration `17 passed (17)` across the three files |
| same probe, full projects                                                                        | unit `177 files / 2927 passed \\                    | 3 skipped`(the single failure was the ADR-source guard, because this record did not exist yet), integration`118 files / 1257 passed` |

The probe corrected one pin: the two-event claim case originally presented only
the user's cookie while sending no `sessionToken`, and the probe answered `422`
because a browser holds **both** cookies. The case now sends
`${user.cookie}; ${session.cookie}` — which is also the honest browser shape.

E1 is registered on the RED branch and executes on the GREEN's PR: `next build`
typechecks the project, so a RED branch that imports two missing modules cannot
produce a standalone server (the OP-93/ADR-0306 \"RED-by-design\" rule).

## Assumptions and open items handed to the GREEN

1. **`skipped[]` carries only the events the caller already owned**; a claimed
   event appears in `claimed[]` and nowhere else, and the response has exactly
   the two keys.
2. **The tie arm** of the decision table (equal selfie timestamps) keeps the
   existing profile's selfie (§3).
3. **`coverThumbnailUrl` is `null`** until `events` grows a cover-asset pointer;
   the §6.7 example's signed URL has no source field.
4. **`status` is the profile's status verbatim.** §6.7 does not enumerate it; the
   example shows `ready`, and `processing` is what the selfie submit writes.
5. **The field that names the caller in `attendee.event.linked` is unpinned**
   (§7) — the fan-out needs _a_ subject, and both a `subjectRef` and a `payload`
   reading are defensible.
6. **`expiringSoon` for a gallery with no retention deadline is `false`** — an
   event that never expires cannot be expiring soon.
7. **The `409` is a new catalogue code** (`AUTH_ERROR_CODES` +
   `AUTH_ERROR_TRANSPORT`); §6.7 names it in the endpoint's prose and Appendix A
   has no row, so the GREEN appends it in the OP-129 `attendee_session_expired`
   shape.
8. **`GET /me/events` is auth `user` only.** An anonymous `op_att` session gets
   `401 authentication_required`; the anonymous surface is §6.4's poll, not
   §6.7's list.
9. **`?limit=` is bounded `1..100` and echoed in `page.limit`**; a non-integer or
   `< 1` is `422 validation_failed` (the shared codec's own rule, not pinned
   here).
10. Unpinned by this card and left to the GREEN's judgement: the rate-limit
    class of either route (§0.11 has no row for them; the gallery's `read.hot` is
    the nearest precedent), `lastSeenAt`-style side effects on the claim, and
    whether the claim's domain-event emit joins the profile update's transaction.

## Out of scope

- Reconciling OP-133's `422 validation_failed` with §0.8's `400 invalid_cursor`
  (§9, §Consequences).
- Any UI: the gallery link, the \"event saved to your account\" toast and the
  sign-in prompt are client cards.
- `attendee.event.linked`'s template/preference matrix beyond \"the key already
  exists, in-app only\".
- The notification fan-out's behaviour after the claim (it is `after()`-deferred
  and consumes the outbox row; a later card owns the delivery).
- Deleting or marking the merged-away anonymous profile (§3 keeps it untouched;
  a cleanup sweep is a separate decision).
- `?limit=` edge statuses, rate-limit classes and `expiringSoon` for a
  non-null-but-unparseable deadline.

## Consequences

- The claim becomes the **only** path that re-points a subject, and it is
  idempotent for the owner, so both the hook and the explicit call can run in
  either order.
- `GET /me/events` becomes the second caller of `@/server/http/cursor`, which is
  now the app's single pagination codec — good for consistency, and the reason
  the `400 invalid_cursor` divergence with the gallery is worth a follow-up card.
- A user can hold **two** profiles for one event (a claimed one and a merged-away
  anonymous one). That is the schema's shape (the unique index is partial on
  `user`), but any future \"one profile per attendee per event\" read must decide
  which row it means — recorded here so the next lane does not discover it in
  production.
- The anonymous-profile cleanup is now a real, bounded job: rows whose
  `subject.attendeeSessionId` names an already-claimed session are inert and can
  be swept on the session's TTL.
