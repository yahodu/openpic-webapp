# ADR-0793 — OP-133 RED: participation polling, gallery, seen/hide, originals and downloads

- **Status:** Accepted (RED / executable contract)
- **Consumers:** the OP-133 RED specs —
  `apps/web/src/test/unit/attendee-poll-policy.test.ts` (U1, 19 cases),
  `apps/web/src/test/unit/attendee-image-geometry.test.ts` (U2, 16 cases),
  `apps/web/src/test/unit/attendee-status-detail.test.ts` (U3, 14 cases),
  `apps/web/src/test/unit/attendee-download-signing.test.ts` (U4, 11 cases),
  `apps/web/src/test/integration/attendee-gallery.test.ts` (10 cases),
  `apps/web/src/test/integration/attendee-participation-status.test.ts` (8 cases),
  `apps/web/src/test/integration/attendee-media-access.test.ts` (8 cases),
  `apps/web/e2e/attendee-gallery.spec.ts` (E1) and the shared fixture module
  `apps/web/src/test/helpers/attendee-gallery-flow.ts` — plus the gated GREEN
  card `t_b285eecd`, which must not edit any of them.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`); `Next free` read as `0793` at the branch cut
  on `origin/main` `1857540` (which already carries the OP-131/OP-132 lane:
  `consent-guard.ts`, `selfie-submit.ts` and the selfie routes are on `main`, so
  the reviewer's `ls-tree` rule selects `main` as the base). OP-133 is a
  **dependent** ticket of OP-132 and OP-113 and continues the shared attendee
  block per CONVENTIONS §11 rule B; a sweep of `origin`'s `docs/adr` finds no
  `ADR-0793`. This record takes `0793`; the ledger cell advances to `0794`.
- **Amends:** nothing. **Amended by:** the OP-133 GREEN ADR.
- **Consumes:** `0793` (`Next free` advances to `0794`).
- **Base:** `origin/main` `1857540`. (It was first cut from
  `origin/OP-132-task-liveness-selfie-red` `3eb7c7d`, the only branch that
  carried `requireConsent` at the time; that branch was deleted once its squash
  landed, and `main` now carries the same tree, so the pins were cherry-picked
  onto `main` unchanged.)

## Context

The attendee surface gets its read side in one card: the participation poll
(§6.4), the gallery (§6.5), the two hide semantics, the original/preview URLs
and the download job (§6.6). The contract, the design document (§15.3, §16.1,
§16.3, §17.5, §18.1) and the GREEN card agree on most of it and are silent —
or contradictory — on ten points that decide whether executable tests can be
written at all. This record fixes those ten, states the contract the specs pin,
and hands the GREEN the questions it must answer while keeping every test
unchanged.

The lane's shape is worth stating up front, because six of the ten decisions
follow from it: **the gallery is a read over the event's own library**, not over
the match rows' timestamps. A match row is stamped at the instant the matcher
wrote it, and a first match run stamps every row within milliseconds of its
neighbours; the stable "newest first" order is the image's own upload sequence
(§16.3). Everything below that looks arbitrary is downstream of that fact.

## Decision

### 1. The poll policy is a pure table, and it answers only three values

`pollIntervalMs({status, indexingComplete})` returns `2000 | 15000 | 60000`:

| status                                               | interval |
| ---------------------------------------------------- | -------- |
| `processing`                                         | `2000`   |
| `ready`, `no_match` and not complete                 | `15000`  |
| `ready`, `no_match` and complete                     | `60000`  |
| `no_selfie`, `selfie_pending`, `failed`, `withdrawn` | `60000`  |

§6.4 fixes the first three rows. The fourth is this record's decision: none of
those four states can change on the server until the attendee acts, so polling
them at 15 s only spends the `read.hot` budget. `no_match` + not-complete stays
at 15 s deliberately — the event is still indexing, so a match can still arrive.

`nextPollAfter(now, intervalMs)` returns `now + intervalMs` as a `Date` and
does not mutate its argument. §6.4's `nextPollAfter` is an instant, and the
client needs one value it can compare, not a duration to add itself.

### 2. `displayGeometry` is what the gallery sends, not what the file stores

`displayGeometry({width, height, orientation})` returns
`{width, height, aspectRatio}` **after** the EXIF transposition:

- orientations `5`–`8` swap the stored pair; `1`–`4` do not;
- an absent or unknown orientation is treated as `1` (the EXIF default);
- `aspectRatio` is `width / height` of the displayed pair, rounded to **four
  decimals** (§6.5's own `0.6667` example is why);
- a degenerate `0`/negative/non-finite dimension yields `aspectRatio: 1` with
  the numbers kept as given. A `NaN` ratio collapses every tile to zero height,
  which is a worse failure than a mis-shaped tile.

§6.5 makes all four numbers mandatory "so the grid reserves correct space
before load". Sending the _stored_ pair for an orientation-6 photo reserves a
portrait tile for a landscape photo, which is exactly the layout shift the PRD
forbids.

### 3. `statusDetail` is populated for exactly two states

`resolveStatus({status, matchCount, rejectionReason?, lastErrorCode?})` returns
`{status, statusDetail}`:

- `ready` with **no** matches is reported as `no_match` with
  `statusDetail.code: "no_matches_yet"` — an empty gallery must not be rendered
  as a success;
- `failed` maps the stored reason to one of `no_face_detected`,
  `multiple_faces`, `low_quality`, `liveness_failed`; every other value
  collapses to `processing_failed`, so an internal model/worker string is never
  echoed to a browser;
- the detail is `null` in every other state (`no_selfie`, `selfie_pending`,
  `processing`, `ready` with matches, `withdrawn`);
- the detail carries exactly `{code, message, remedy, canRetry}` and
  `canRetry` is always `true` for the two populated states (a new selfie is the
  only remedy, and §14.1 bounds the attempts);
- §6.4's copy for `no_face_detected` is pinned verbatim; every other detail only
  has to carry a non-empty `message` and `remedy`, because §6.4 fixes neither.

### 4. A download's filename is bound into the signature

§6.6 hands out a 15-minute original URL; when that URL is a _download_, the
saved file name comes from the `Content-Disposition` the media Worker derives
from the URL. An unsigned `?download=` parameter would let anyone holding a
signed link relabel it (and a hostile name would be a header/log injection
vector), so the name must be covered by the §5.7 signature.

`SignMediaInput` gains one **optional** field, `download?: string`:

- absent → the URL and its signature are byte-identical to what the shipped
  signer mints today, so every existing §5.6/§5.7 pin keeps passing (the spec
  proves this by recomputing the three-part `METHOD\nPATH\nEXPIRY` preimage
  independently);
- present → the URL carries `download=<percent-encoded name>` and `verify`
  recomputes over the name, so changing it, dropping it, or adding one to a URL
  that had none all fail.

Percent-encoding is what keeps a quote, semicolon, CR/LF or non-ASCII name out
of the raw URL; `verify` accepts the encoded form it minted.

### 5. The gallery's ordering key is `event_images.sequence`, descending

§16.3 calls `sequence` the "stable newest first ordering that can't tie like
`createdAt` can", and the green card's §2 says "use the image upload sequence as
the sort key". I1 makes the two orderings **disagree** (sequences descend while
the matches' `createdAt` ascends), so an implementation that sorts by the match
timestamp fails the ordering assertion instead of passing by luck.

The cursor is opaque. The specs never inspect its shape — they only round-trip
it — so the GREEN may encode `{sequence, matchId}` however it likes, provided a
cursor it did not mint is refused `422 validation_failed` (§6.5's query
validation).

### 6. Two hides, two semantics — and only one of them is counted

- `faceMatches.hiddenAt` is the **attendee** hide (§17.5). A hidden match is
  excluded from `data` and counted in `summary.hiddenCount`; the row is never
  deleted, because a false positive is a model-quality signal and deleting it
  would make the next incremental run re-insert it.
- `event_images.visibility: "hidden"` is the **organizer** hide (§16.3, OP-127 /
  ADR-0762 D7), which hands this card the predicate
  `{visibility: "visible", deletedAt: null}`. A hidden image is excluded from
  `data` and **not** counted in `summary.hiddenCount`: it is not the attendee's
  own action, and counting it would tell the attendee they hid something they
  did not.

I1 and I1b keep the two cases apart, and I1b pages across a boundary so a
"hide only on the first page" implementation cannot pass.

### 7. What an attendee response may never contain

`similarity` is never returned (§6.5): only the coarse `confidence`
(`strong` | `normal`). I2 scans the gallery, the poll and the original-url
answer for `similarity`, `score`, `distance`, `embedding`, `vector`, `modelKey`
and `spaceKey`, and for the seeded raw score as a substring, so a score that
leaked under a different key name still fails.

### 8. The anonymous truncation is a platform setting with a default of 10

An anonymous caller gets at most `platformSettings.attendee.anonymousPreviewLimit`
items (default **10**), with `truncatedForAnonymous: true`, `page.nextCursor:
null`, `page.hasMore: false` and a `loginUrl`; the body therefore has five keys
instead of three. `summary.matchCount` still reports the true cached count, so
the UI can say "20 photos, sign in to see all".

The specs pin the default by asserting `10` with no settings row seeded — the
green card's §6 says "add `settings.attendee.anonymousPreviewLimit`", and the
`selfie.attemptsAllowed` precedent puts that tunable in the same
`platformSettings` document.

### 9. The e2e journey needs a test-only matcher fixture

The Playwright run starts `next start` with an **in-process** MongoDB memory
replica set (`e2e/start-server.mjs`), so the spec process cannot reach the
server's database and nothing in the public API can create a `faceMatches` row
(the worker is a later card). E1 therefore needs a seeding route, and this
record fixes its contract:

`POST /api/v1/test-support/attendee-matches` (Node runtime) with
`{slug, profileId, count}` answers `201 {matchIds, imageIds}`, creating `count`
`media_assets` + `event_images` + `face_matches` rows for that profile, oldest
first, and marking the profile `ready` with `matchCount: count`. It answers
`404` outside `test`/`e2e` exactly as the OTP read-back route does
(`isTestOtpRouteEnabled` is the precedent), and the guard runs before the body
is read. An integration case pins both the `201` shape and the `404` under
`APP_ENV=production`, so the seeder cannot become a production write primitive
without a red test.

### 10. `/me` answers §6.4's fourteen keys plus `latestMatchCursor`

§6.4's body is fourteen keys. The green card's §1 adds
`latestMatchCursor` so a client can fetch only what is new
(`?newerThan=<cursor>`), and I13 pins the round trip: the cursor the poll hands
out is the cursor the gallery accepts. `nextPollAfter` is
`now + pollIntervalMs` (bracketed by the case's own clock reads), and
`indexingComplete` is the **event's** progress
(`counters.processedImageCount >= counters.imageCount`) — §6.4 calls it a
property of the event, and the fixture states progress rather than a boolean.

## Consequences

- The GREEN writes five new server modules (`poll-policy`, `image-geometry`,
  `status-detail`, the gallery projection, the download job) and nine route
  files at the paths the fixture module imports:
  `…/p/events/[slug]/me`, `…/gallery`, `…/gallery:seen`,
  `…/images/[imageId]/original-url`, `…/images/[imageId]/preview-url`,
  `…/downloads`, `…/p/matches/[matchId]/hide`, `…/p/downloads/[downloadId]` and
  `…/test-support/attendee-matches`. It also extends `SignMediaInput` in
  `src/server/media/signer.ts` with the optional `download`.
- **New collection name.** §6.6's download job is `downloadJobs` (camelCase,
  the app-owned-job precedent of `attendeeSessions`), asserted literally in I6
  because `COLLECTIONS` does not carry the key yet.
- **`gallery_expired` / `download_expired` (410) are not pinned here.** Neither
  code exists in the error catalogue yet; the purge and the TTL worker that
  produce them are later cards. I10/I13's pagination and the seen watermark are
  pinned instead. The GREEN must add the codes for its own §2/§5 arms.
- **`preview-url` is pinned for the refusal only** (I11, anonymous → `401`).
  The green card's "identified users only" success path has no observable
  contract beyond "not for anonymous", and inventing one would over-specify the
  derivative the worker has not built yet.
- **The hide/unhide pair is pinned through `hide`** (I4, I4b); `unhide` shares
  the row and the authorizer, and a second route would only duplicate the
  ownership case.
- **Six U3 cases pass on the shipped tree by construction** (the pass-through
  statuses and `nextPollAfter`'s immutability): a status-only implementation
  satisfies them. The RED evidence is the other 39 unit cases and all 26
  integration cases.
- The fixture is deliberately _not_ in `selfie-flow.ts`: appending OP-133's nine
  route imports to the OP-132 `handlers` object would make every OP-132 spec
  fail to load while this card is red.
