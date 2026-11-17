# ADR-0794 — OP-133 GREEN: participation polling, gallery, seen/hide and download jobs

- **Status:** Accepted (GREEN / implementation record)
- **Consumers:** `apps/web/src/server/attendee/poll-policy.ts`,
  `apps/web/src/server/attendee/image-geometry.ts`,
  `apps/web/src/server/attendee/status-detail.ts`,
  `apps/web/src/server/attendee/gallery-projection.ts`,
  `apps/web/src/server/attendee/download-job.ts`,
  `apps/web/src/server/attendee/attendee-media.ts`,
  `apps/web/src/server/attendee/image-access.ts`,
  `apps/web/src/server/attendee/request-event.ts`,
  `apps/web/src/server/http/optional-json-body.ts`,
  `apps/web/src/server/repos/cross-tenant.ts`,
  `apps/web/src/server/media/signer.ts`,
  `apps/web/src/server/settings/platform-settings.ts`,
  `apps/web/src/server/db/collections.ts`,
  `apps/web/src/server/db/indexes.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/me/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/gallery/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/gallery:seen/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/downloads/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/images/[imageId]/original-url/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/images/[imageId]/preview-url/route.ts`,
  `apps/web/src/app/api/v1/p/matches/[matchId]/hide/route.ts`,
  `apps/web/src/app/api/v1/p/downloads/[downloadId]/route.ts`,
  `apps/web/src/app/api/v1/test-support/attendee-matches/route.ts` and the
  OP-133 GREEN specs `apps/web/src/test/integration/attendee-gallery.test.ts`,
  `apps/web/src/test/integration/attendee-participation-status.test.ts`,
  `apps/web/src/test/integration/attendee-media-access.test.ts` — all pinned by
  [ADR-0793](ADR-0793-op133-attendee-gallery-red.md).
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`); `Next free` read as `0794` at the branch cut
  on `OP-133-feature-attendee-gallery-red` (`3e09f5a`, itself on `origin/main`
  `1857540`). OP-133 is a **dependent** ticket of OP-132 and OP-113 and continues
  the shared attendee block per CONVENTIONS §11 rule B. This record takes `0794`;
  the ledger cell advances to `0795`.
- **Amends:** [ADR-0793](ADR-0793-op133-attendee-gallery-red.md) — its ten
  decisions (§1–§10) are implemented as written; §11–§17 below record what the
  implementation itself had to decide, and §18 records the one pin that was
  unsatisfiable as written and how it was corrected.
- **Consumes:** `0794`.

## Context

ADR-0793 fixed the executable contract for OP-133 and handed the GREEN its own
questions: the shape of the cursor, where the anonymous allowance lives, how the
e2e seeder may write, and what `/me` answers beyond §6.4. This record states what
the implementation chose, how the one test pin that was unsatisfiable as written
was corrected by the Test Author (§18), and the work it deliberately left to
later cards.

## Decision

### 1. The poll cadence is a table, and the event's progress feeds it

`pollIntervalMs({status, indexingComplete})` answers `2000` for `processing`,
`15000` for `ready`/`no_match` while the event still indexes and `60000`
otherwise (ADR-0793 §1, implemented as written). `eventIndexingComplete` lives in
the same module because it is the same fact: `counters.processedImageCount >=
counters.imageCount`, read once for both the poll and the gallery summary.

### 2. The gallery sends displayed geometry, never the stored pair

`displayGeometry` transposes EXIF `5`–`8`, rounds the ratio to four decimals and
falls back to `1` on a degenerate pair (ADR-0793 §2).

### 3. `statusDetail` is populated for two states only

`resolveStatus` maps `ready` + no matches to `no_match`/`no_matches_yet`, maps a
`failed` reason onto four stable codes plus `processing_failed`, and answers
`null` everywhere else (ADR-0793 §3).

### 4. The signed URL's `exp` keeps its shipped floor; `expiresAt` is the refetch deadline

`sign({download})` appends a fourth preimage line for the file name (ADR-0793
§4), so a name cannot be relabelled, dropped or added.

I5 brackets the answer's `expiresAt` between the case's own clock reads
(`[before + TTL, after + TTL]`), which is a millisecond-wide window: no
whole-second `?exp=` value can land in it. The two facts are therefore kept
apart, each where it belongs:

- `?exp=` stays the shipped §5.7 value (`floor(now/1000) + ttl`). Rounding it up
  instead breaks OP-128's `expectSignedLifetime`, which pins the signed-urls
  answer to `[before + (ttl − 1)s, after + ttl]` — the pin that exists to catch
  a TTL inversion, and which this card does not get to rewrite.
- the attendee routes answer `expiresAt = now + ttlSeconds` (millisecond
  precision, read once in the handler), the instant a client must refetch at.
- because a floored token can retire up to 999 ms **before** that instant, the
  attendee tokens are minted with `ttlSeconds + 1` while `ttlSeconds` keeps
  advertising the nominal life. The URL therefore never dies before the
  `expiresAt` the answer states, and lives at most one second longer — the safe
  direction for a download the attendee just tapped.

### 5. The gallery's ordering key is `event_images.sequence`, descending

The sequence lives on `event_images`, so the route reads the profile's matches
and their images and orders them in memory (`newestFirst`, match id as the
stable tiebreak). One attendee's match set is bounded by
`settings.face.matchLimit` (500), so nothing large is materialised; a future
card can push the order into an aggregation with a `$lookup` if that bound moves.

Pagination is keyset, not offset: a page cursor carries
`{sequence, matchId}` and the next page is "rows that sort after it". I12
(matches arriving between pages) therefore neither duplicates nor skips: the new
rows sort **before** the cursor and are simply not part of that walk.

### 6. Two cursors, one envelope: `cursor` pages, `newerThan` filters

Both are base64url JSON with a `k` discriminator:

- `?cursor=` → `{k:"page", n: sequence, m: matchId}` — the last row a page served;
- `?newerThan=` → `{k:"watermark", t: createdAtMillis, m: matchId}` — the
  `latestMatchCursor` the poll handed out, i.e. the newest match the client
  already has. The gallery keeps every row created after it (I13).

Either value that does not decode to its own shape is `422 validation_failed`
(§6.5). The cursors are unsigned: they address only the caller's own gallery, so
a forged one can skip items in the caller's own list and nothing else.
`summary.newMatchCount` is counted over the filtered **window**, which is what
makes `?newerThan=` answer "how many of the new ones are still new" (I13: `2`,
not the `6` unseen rows the whole gallery holds).

### 7. Two hides, two semantics, and only the attendee's is counted

`faceMatches.hiddenAt` is excluded from `data` and counted in
`summary.hiddenCount`; `event_images.visibility: "hidden"` (or `deletedAt`) is
excluded and **not** counted (ADR-0793 §6, I1/I1b).

### 8. The anonymous allowance is a total, not a page size

`settings.attendee.anonymousPreviewLimit` (default **10**, a new `attendee`
section of `platformSettings` with a Zod default so an older singleton still
parses). An anonymous caller is capped at `min(limit, allowance)` items per page,
and the response carries `truncatedForAnonymous: true` + `loginUrl` only when the
gallery holds **more** photos than the allowance — not when an explicit `limit`
is simply smaller than it. Without that distinction I7 (20 matches, default
limit, truncated) and I1b (2 matches, `limit=1`, paginates normally) contradict
each other.

### 9. `downloadJobs` is a platform-scope collection, and the id is not the authorization

`GET /p/downloads/{id}` carries no event, so the row cannot be reached through a
tenant scope without inventing a cross-tenant read for it. Like
`attendeeSessions`, the job therefore lives outside the tenant boundary
(`COLLECTIONS.downloadJobs`, camelCase app-owned name), with `tenantId` carried
as data for the build worker and a future per-tenant purge.

The unguessable id is never the authorization: the route resolves the caller's
own profile in the job's `{tenant, event}` and answers `404` unless it is the
job's profile (I6). A TTL index on `expireAt` (24 h) retires the row and its link
(§22, the `expireAt` field name is the schema's TTL invariant).

### 10. The e2e matcher fixture is a test-only route, guarded before the body

`POST /api/v1/test-support/attendee-matches` answers `404` outside `test`/`e2e`
through `isTestOtpRouteEnabled`, i.e. **before** the body is read, exactly as the
OTP read-back route does (ADR-0793 §9). It is a plain `(request) => Response`
handler rather than a `defineRoute` because the pipeline parses a declared body
before the handler; the guard must win. It seeds `mediaAssets` + `eventImages` +
`faceMatches` oldest-first and marks the profile `ready` with `matchCount`
incremented by the count it just wrote.

### 11. The event resolves **before** the credential, so `401` and `404` keep their order

I5's last case pins "unknown slug + no credential → `404 not_found`", which a
pipeline `auth` stage cannot express: the stage runs before the handler. The six
`/p/events/{slug}/…` routes therefore resolve the event, then the `attendee`
credential (`requireAttendeeSubject`, built from `resolvePrincipal` +
`enforceAuth`), then the consent, then the profile. The two id-only routes
(`/p/matches/{id}/hide`, `/p/downloads/{id}`) keep the `auth` stage.

### 12. `gallery:seen` and `hide` take an **optional** body

`defineRoute`'s `body` option is all-or-nothing (a bodyless request would be
`415`), while §6.5 writes `{seenAt?}` and `{reason?}`. Those two routes read the
body in the handler through `optionalJsonBody` and default to "no body, now" /
"no reason". I3's bare `POST …/gallery:seen` depends on it.

### 13. `preview-url` is identified-only, and the gallery carries no preview flag

The green card calls the preview "for identified users only", so an anonymous
session is refused `403 forbidden` (no credential stays `401`, I11); the
successful path signs the `preview` derivative with its own §5.6 TTL and no
`originals.download` gate, because a preview is not an original. `previewAvailable`
is **not** added to the gallery item: §6.5's item has exactly twelve keys and I7
asserts them, so the flag would have to break a pin to exist.

### 14. `originalAvailable` is a media fact, not a plan fact

I1-shape asserts `originalAvailable: true` with no plan seeded, while I5-plan
refuses the same tenant's original with `feature_not_available`. The item
therefore answers "the stored original exists" (`status:
"derivatives_ready"`) and the plan gate stays where §6.6 puts it — on the
`original-url` request.

### 15. The two new `face_matches` indexes and the download TTL are declared

`{profileId, createdAt}` (the poll's watermark and the newest-first read) and
`{profileId, seenAt, createdAt}` partial on `{seenAt: null}` (the "New" badge
count) join `INDEX_SPECS`, both as §17.5 documents them; `faceMatches` is
deliberately outside the tenant-leading rule. `downloadJobs` gets the `expireAt`
TTL. No other index is added, so `ensureIndexes` stays a data edit.

### 16. Nothing is emitted for the download build yet

§6.6's job needs a worker wake-up, but no registered domain-event key
(`attendee.download.ready` is the _ready_ notification, not the request) and no
work-queue kind exists for a download build. Emitting one would mean adding a
catalogue entry the notification matrix owns; the row is written and the worker
card owns the enqueue. Recorded as a deliberate gap, not an omission.

### 17. Nothing logs a similarity, a raw score or a vector

No attendee answer reads `similarity` at all; the gallery projects `confidence`
only (I2 scans the gallery, the poll and the original-url answer for the seven
banned keys and for the seeded raw score as a substring). The hide route logs
`match.hidden` with the match id and the optional reason, and the seen route logs
nothing.

### 18. One pin was unsatisfiable: I7's key-order assertion, corrected by sorting

`attendee-gallery.test.ts` (I7) asserts

```ts
expect(keysOf(body)).toEqual([...BODY_KEYS, "loginUrl", "truncatedForAnonymous"]);
```

`keysOf` returns **sorted** keys, so the received array is
`["data","loginUrl","page","summary","truncatedForAnonymous"]`, while the
expected array — `BODY_KEYS` is already sorted and the two anonymous keys are
appended — is `["data","page","summary","loginUrl","truncatedForAnonymous"]`.
`toEqual` on arrays is order-sensitive, so no implementation can satisfy this
line: the two arrays differ only in the position of `loginUrl`, which is fixed by
`Array.prototype.sort`. Every other assertion of that case passes against the
implementation (ten items, `truncatedForAnonymous: true`, `loginUrl` starting
with `/`, `nextCursor: null`, `hasMore: false`, `matchCount: 20`).

The GREEN correctly refused to edit the pin: Prime Directive 1 makes a test edit
the Test Author's call, and reporting beats papering over. The Test Author then
corrected the expectation itself on the lane branch
(`OP-133-feature-attendee-gallery-main`, `cf00f6e`, PR #547) — the expected side
is sorted, so both sides are in `keysOf`'s order:

```ts
expect(keysOf(body)).toEqual([...BODY_KEYS, "loginUrl", "truncatedForAnonymous"].sort());
```

The set-comparison alternative (`expect.arrayContaining` plus a length check) was
rejected: it states in two assertions what one `toEqual` states, and it
expresses "at least these keys" where the pin's intent is "exactly these five".
Sorting corrects the literal, not the contract — no status code, key or value
moved, and the five value assertions above the line were already green.

Sorting does not soften the pin. Mutation probes run against the commit: adding a
phantom key to the expected array and removing `loginUrl` from it each turn I7 red
again (`1 failed | 9 passed`, `expected [ 'data', 'loginUrl', 'page', …(2) ] to
deeply equal …`). The assertion therefore still fails loudly for an extra key and
for a missing key; it was never a superset check.

Verification after the correction: the file is 10/10, and the CI-equivalent run
(`vitest run --project unit --project integration --coverage`) is 4144 passed,
3 skipped (the pre-existing `skipIf(!LIVE_REQUESTED)` Cashfree live-sandbox
suite, unrelated), 0 failed, branches 80.88 % against the 80 % threshold.

## Consequences

- Five new server modules (`poll-policy`, `image-geometry`, `status-detail`,
  `gallery-projection`, `download-job`) plus two small shared ones
  (`attendee-media`, `image-access`) and one HTTP helper (`optional-json-body`),
  and the nine route files ADR-0793 names. `SignMediaInput` gains `download`;
  `platformSettings` gains `attendee.anonymousPreviewLimit`; `COLLECTIONS` gains
  `downloadJobs`; `crossTenantReads` gains `findFaceMatchById` (the hide route's
  id-only lookup) and `request-event.ts` gains `requireAttendeeSubject` /
  `requireAttendeeProfile`.
- **Corrected, not open:** `attendee-gallery.test.ts` I7's key-order line (§18).
  It was the only red in the pack and unsatisfiable as written; the Test Author
  sorted the expected side (`cf00f6e`), which restores the exact-five-key intent
  and keeps the pin red for a phantom or a missing key. No other pin changed and
  no production code changed with it.
- **Out of scope, not silently dropped:** `gallery_expired` and `download_expired`
  (no catalogue code, no purge yet — I10/I13 pin pagination and the watermark
  instead), `unhide` (the RED pins ownership through `hide`; a second route would
  duplicate it), the download worker/zip build and its wake-up (§16), and
  `previewAvailable` (§13).
- `docs/adr/README.md` remains the shared-ledger hotspot: this record's row,
  paragraph and the `0794`/`0795` cell merge as a union keeping the highest
  value. No number outside `0780`–`0798` is touched.
