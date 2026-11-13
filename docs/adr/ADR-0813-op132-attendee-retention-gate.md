# ADR-0813 — OP-132: the four biometric writes refuse once `retentionExpiresAt` elapses

- **Status:** Accepted
- **Consumers:**
  `apps/web/src/test/unit/retention-gate.test.ts` (eight cases: the inclusive
  predicate and the refusal helper), `apps/web/src/test/integration/attendee-retention-gate.test.ts`
  (twelve cases: W1–W4, P1–P4, C1–C4) with their local harness (`fixture`,
  `setRetention`, `expireRetention`, `profilesOf`, `profileIds`, `profileById`,
  `storedChallenges`, `selfieRows`, `assetRows`, `storedSelfie`, `refusalOf`,
  `putBytes`, `confirmedSelfie`, `exhaustAttempts`).
- **Lane:** OP-132 attendee identity. The shared attendee block `0780`–`0798` is
  exhausted, so the lane draws from the `unallocated (future lanes)` pool
  (ADR-0800/0811 precedent); no lane row is minted. The number is the
  **allocator's reservation** written into card `t_1bbefaf0` at creation (decision
  card `t_7e4d553b`), never a read of the `Next free` cell — and the reservation
  was **`0812`**, which this record could not keep: before this branch landed, the
  F5-symmetric card `t_5f76eab8` drew `0812` from the cell (its sweep saw no
  conflict; this card's reservation was not visible to it) and merged
  `ADR-0812-op132-submit-object-transport-500.md` onto the trunk (merge
  `e0cf073`, PR #568). Under
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) a number is consumed
  **once** and the later record moves, so this record renumbers to **`0813`** —
  free against the trunk **and** every in-flight allocation — and both `Next free`
  cells advance to **`0817`**: §7 of that policy counts an **in-flight** number as
  taken, `0814`/`0815` are held by the open PR #565
  (`ADR-0814-op134-attendee-claim-red.md`, `ADR-0815-op134-attendee-claim-green.md`)
  and `0816` by the open PR #570 (`OP-132-task-concurrent-confirm-pin`,
  `ADR-0816-op132-concurrent-confirm-publication.md`), so the next newly-started
  card in this lane receives `0817`. The renumber is a ledger fact, not a new
  decision: the decision, the pins and every measurement below are unchanged, and
  no number outside `0813` is consumed. Flagged for the allocator: the reservation
  channel and the `Next free` cell disagreed, which is the collision ADR-0300 §7
  describes; the card body's `Consumes: 0812` is `0813` here for that reason.
- **Amends:** [ADR-0792](ADR-0792-op132-liveness-selfie-green.md) §2 — the
  contract order of the liveness/selfie write surface gains one stage between
  consent and the route's own checks. Closes the open item
  [ADR-0811](ADR-0811-op132-attendee-selfie-upload-window.md) §Consequences left
  explicitly undecided ("the retention boundary is not gated today … owned by
  decision card `t_7e4d553b`").
- **Consumes:** `0813`.

## Context

`events.retentionExpiresAt` is the attendee-facing window. §6.1 publishes
`gallery.open: false` and `gallery.expiredAt` from it, and
`resolvePublicEventOutcome` (`apps/web/src/server/attendee/public-event.ts:96`)
treats it as elapsed **at** the instant, not after it. §6.5 already answers
`410 gallery_expired` on the read surface "once retention has passed **and** the
purge has run" (`docs/API Contract.md:2351`), and Appendix A.7 already declares
the code (`:3656`: `gallery_expired | 410 | no | { expiredAt }`).

Nothing read the deadline on the **write** surface, and `grep -rn
"gallery_expired" apps/web/src` answered **0** hits at the cut. Measured
consequences on `origin/main` (`e760e80`):

- `POST …/selfies` and `…/selfies:reuse` pass `event.retentionExpiresAt` into
  `chargeSelfieAttempt` → `insertQueuedSelfie`, which stamps
  `expireAt: selfieExpireAt(now, retentionExpiresAt)`
  (`apps/web/src/server/attendee/selfie-submit.ts:322`). After retention that
  instant is **in the past**, so the row is born expired and still queued.
- `selfies_expire_at_ttl` (`apps/web/src/server/db/indexes.ts:455-461`,
  `keys: [["expireAt", 1]]`, `expireAfterSeconds: 0`) deletes that row within
  about a minute, but the `mediaAssets` owner row the same function upserts
  (`:272-295`, `kind: "selfie"`, `refCount: 1`) and the object
  `originals/selfies/<sha256>` have no expiry and no sweep. The only shipped
  purge is `DELETE …/consent` (ADR-0796/ADR-0798).
- The challenge and presign routes never read the deadline at all: a `201`
  challenge or a `201` presign was minted for an event whose gallery the client
  is already told is closed.

So a late submit **deterministically** minted orphaned biometric bytes — the
F1 defect class, and permanent, because the TTL deletes the row that made them
reachable while the owner row and the object survive — and a late reuse
re-processed bytes after the addressed event's window had closed.

## Decision

**The four attendee biometric writes refuse once `events.retentionExpiresAt` has
elapsed, with `410 gallery_expired` and `details: { expiredAt }`.**

| endpoint                                           | today (measured)                 | pinned     |
| -------------------------------------------------- | -------------------------------- | ---------- |
| `POST /api/v1/p/events/{slug}/liveness/challenges` | `201`, no retention read         | `410` (W1) |
| `POST …/selfies/uploads`                           | `201` presign, no retention read | `410` (W2) |
| `POST …/selfies`                                   | `202` (or its other refusals)    | `410` (W3) |
| `POST …/selfies:reuse`                             | `202`, no retention read         | `410` (W4) |

- **Code, status, details.** `410 gallery_expired`, `retryable: false`,
  `details: { expiredAt: <retentionExpiresAt>.toISOString() }` — the identical
  string §6.1 publishes as `gallery.expiredAt`, milliseconds included, so a
  client compares the two without parsing either. The code is not invented here:
  Appendix A.7 (`:3656`) declares exactly that status and that details shape,
  Appendix B's `ErrorCode` union already carries the member (`:3801`), and §6.5
  uses the same instant. The GREEN's only catalogue work is to append
  `gallery_expired` to `SELFIE_ERROR_CODES`
  (`packages/contracts/src/errors.ts:353`, append-only) and transport it from
  `SELFIE_ERROR_TRANSPORT` (`apps/web/src/server/http/catalog.ts:609`), the path
  ADR-0792 established for `liveness_challenge_invalid`.
- **Boundary: inclusive (`now >= deadline`).** Pinned at equality in the unit
  spec only (`U1`: at the deadline is elapsed, one millisecond before is open),
  because the routes read `systemClock.now()` live and the integration suite
  cannot land on the millisecond. One millisecond of asymmetry would put the two
  surfaces out of step: §6.1 must say "closed" exactly when the write refuses.
- **Unlimited:** `retentionExpiresAt === null` never refuses (C2).
- **Precedence.** The gate sits immediately after `requireAttendeeScope` and
  before the route's own checks, so `412 consent_required` wins over `410`
  (C3), and `410` wins over the object `404` (P1), `409 liveness_challenge_invalid`
  (P3), `403 plan_limit_exceeded` (P4) and `413 file_too_large` (P2). A
  body-shape error stays `422 validation_failed` before the handler runs
  (`defineRoute`); this record does not fight that.
- **A refusal writes nothing** (W3): no `selfies` row, no `mediaAssets` row for
  the hash, no `q:selfie` pointer, no attempt charged, and the presented
  challenge stays unspent (`usedAt: null`). W4 adds that the source selfie of a
  refused reuse stays `isActive`. Bytes the client already PUT are the purge
  lane's business (ADR-0796/ADR-0798), not this gate's — the gate never deletes.
- **Layer: one shared pure predicate plus one refusal helper, in
  `apps/web/src/server/attendee/request-event.ts`, called explicitly by the four
  routes.**
  `retentionElapsed(retentionExpiresAt: Date | null, now: Date): boolean` and
  `requireRetentionOpen(window: { readonly retentionExpiresAt: Date | null }, now: Date): void`
  (the routes pass the resolved event, `requireRetentionOpen(event, now)`). No
  new module: `request-event.ts` already carries ADR-0792's citation, and the
  repository's `adr-consumers` guard reddens on any source file no record cites,
  so a new module would need a forged citation. Four hand-copied comparisons
  would be four places to drift from §6.1.

### Explicitly not gated (so a fix cannot over-reach)

- `POST …/selfies/{selfieId}/confirm` — it starts no new biometric processing;
  it completes an attempt created inside the window and its row's erasure is the
  purge's. **C4** pins it: a selfie submitted before retention and confirmed
  after it answers its documented `200` envelope with `status: "ready"` and the
  row activated. It shares `requireAttendeeScope`, so **the gate must not live
  inside that helper** — a gate placed there reddens C4.
- `GET …/me`, `GET …/gallery`, the image URLs, hide/unhide and downloads —
  existing data. §6.5's own `410 gallery_expired` is "retention passed **and**
  the purge has run" and belongs to the purge lane; refusing a read at the
  instant would withhold data the contract says is still served.

### Rejected alternatives

- **(b) Accept the writes after retention** — rejected on measured evidence, not
  taste. The `selfies` row is born expired and the TTL monitor deletes it, while
  the `mediaAssets` owner row and the `originals/selfies/<sha256>` object it
  points at have **no** expiry and **no** sweep: every late submit minted
  permanent orphaned biometric bytes, and a late reuse re-processed a subject's
  bytes for an event whose window had closed. Accepting also left two surfaces
  disagreeing — §6.1 tells the client the gallery is closed while the write
  path still accepts a selfie.
- **(c) Refuse the challenge only** — rejected because the challenge is not what
  mints anything: submit and reuse would still write the born-expired row. It
  would also refuse the earliest, cheapest call (a `201` with a `nonce`) while
  leaving the expensive one open, so a client that already holds a challenge
  from inside the window would still mint bytes. The write that mints is the one
  that must refuse; W1 is pinned for consistency of the client's screen, not as
  the enforcement point.

## Consequences

- **The four writes are the only gated surface.** The gate is one predicate and
  one helper; a route that wants different semantics must supersede this record.
- **§6.3's rows are owned by the docs card `t_a1fbb7a7`.** At this cut they are
  already merged on the trunk (`docs/API Contract.md`: the challenge note
  `:2125`, the uploads note `:2135`, the submit failure-table row `:2178` with
  the "the retention check runs after consent and before the object, liveness and
  budget checks" sentence, and the reuse row `:2256`), so the pins and the
  contract agree at `e760e80`. This record edits no contract text.
- **The purge lane keeps its ownership.** §6.5's retention-plus-purge `410`, the
  `mediaAssets` sweep and the bytes already PUT at refusal time are unchanged and
  remain ADR-0796/ADR-0798's.
- **A `selfies.per_attendee` exhaustion on an expired event now reports the
  window, not the budget** (P4). That is deliberate: the client cannot fix an
  exhaustion after the gallery closed, and `410` names the reason it can act on
  (nothing — the window is gone).
- **Pinned in both directions.** Four green controls keep the gate from growing
  teeth: C1 the four writes still answer `201/201/202/202` inside the window,
  C2 a `null` deadline never refuses, C3 consent still wins, C4 the confirm is
  not gated. A gate moved earlier (into `requireAttendeeScope`) reddens C4; one
  moved later (after the object check) reddens P1.
- **The spec cites this record, not the purge records.** A source file that
  cites a record declaring `Consumers:` must be claimed by that record, so the
  integration spec's prose points at this record instead of naming ADR-0796 /
  ADR-0798 directly — the `adr-consumers` sweep reported two `consumer-mismatch`
  issues until it did. The purge records stay reachable through this one.

## Evidence — measured at the branch cut

Branch `OP-132-task-attendee-retention-gate-pins`, cut from `origin/main`
`e760e80` (`docs(attendee): OP-132 amend §6.3 for the nonce, submit body and
confirm step (#559)`), worktree `.worktrees/t_1bbefaf0`.

| gate                                                                                                                   | result                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| focused integration run of the new spec (RED on the cut)                                                               | `1 file, 8 failed \| 4 passed (12)`        |
| focused unit run of the new spec (RED on the cut)                                                                      | `1 file, 8 failed (8)`                     |
| `tsc -p apps/web/tsconfig.json --noEmit`                                                                               | only the two `TS2305` missing exports      |
| `eslint --max-warnings=0` on the two new specs                                                                         | clean                                      |
| `prettier --check` on the two specs, this record and the ledger                                                        | clean                                      |
| the five ADR guards (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`, `adr-source-references`, `adr-consumers`) | `5 files, 218 passed (218)`; `0813` unique |

**Satisfiability.** A throwaway probe (never committed) added the two exports,
appended `gallery_expired` to `SELFIE_ERROR_CODES` and its transport, and wired
the helper into the four routes: **`8 passed (8)`** unit and **`12 passed (12)`**
integration, i.e. W1–W4 and P1–P4 turned green while C1–C4 stayed green. The
probe was then removed with all seven touched files restored byte-identically
(`sha256` equal to the pre-probe hashes, `git status` naming only the two specs,
this record and the ledger). The eight RED cases therefore fail for the
behaviour they name — `expected 201 to be 410` (W1/W2), `expected 202 to be 410`
(W3/W4), and `expected 404 / 413 / 409 / 403 to be 410` (P1–P4) — not for a
broken fixture, and no case passes vacuously.

## Assumptions

- **A1 — the deadline is an instant, not a day.** `…T18:00:00.123Z` is elapsed
  at exactly that millisecond, in any display time zone (`selfies`-style
  instants are stored with milliseconds).
- **A2 — the elapsed fixture is the stored row.** The cases move the seeded
  event's own `retentionExpiresAt` with a direct `updateOne` on its `_id`
  (`Date.now() - 1`), which is the row `resolveEventBySlug` reads. The clock is
  never mocked, so the cases exercise the real deadline comparison.
- **A3 — the challenge and object a refused submit presents are real**, created
  while the window was open, so W3 cannot pass by refusing a request that would
  have failed anyway.
- **A4 — consent creates the caller's profile** (`linkProfile`, contract §6.2),
  so W1's "no new row" is measured as "the profile ids are unchanged and no
  challenge was stored".

## Open questions

1. **The reads' retention behaviour stays §6.5's** ("retention passed **and** the
   purge has run"). Nothing here decides what `GET …/gallery` does at the instant
   alone; that belongs to the purge lane.
2. **`SELFIE_ERROR_CODES`'s docblock says "(contract §6.3, Appendix A row
   3587)"** — the row number for `gallery_expired` is Appendix A.7's, not 3587's.
   The GREEN should widen that sentence rather than copy it; this record does not
   prescribe the wording.

## Review sign-off (OP-132 GREEN t_4503b5cf, round 1 — artifact + execution lens)

**Verdict: APPROVED WITH FINDINGS.** The delivery is PR #569, reviewed at head
`1088911` and merged as the squash `442e01a`; nothing was re-merged for this
sign-off. The lens was the artifact **and** the execution: every count below is
the reviewer's own run rather than a transcription of the implementer's handoff,
and both mutation probes were re-run at the trunk this append lands on.

**No section of this record is retracted.** §Context, §Decision, the
not-gated list, §Rejected alternatives, §Consequences, the evidence table and
§Assumptions stand as written. The items at the end are follow-ups and
observations, not corrections.

### The reviewed bytes are what shipped

`git diff --stat 1088911 442e01a` is **empty**: the squash kept the branch tree,
so a suite run on the branch applies to the trunk verbatim. The two pins and this
record are unchanged across the whole chain — measured as blob identity, which is
strictly stronger than a three-dot diff:

- `apps/web/src/test/unit/retention-gate.test.ts` — `df23c73…` at the RED head
  `5a2b014`, the GREEN head `1088911`, the squash `442e01a` and the trunk
  `9633f5f`;
- `apps/web/src/test/integration/attendee-retention-gate.test.ts` — `56fee94…` at
  the same four commits;
- `docs/adr/ADR-0813-op132-attendee-retention-gate.md` — `dbeb696…` at all four,
  i.e. the GREEN did not edit the record it satisfies.

The seven production blobs the GREEN touched are identical at `442e01a` and at
`9633f5f` as well, so every measurement below holds for both trees.

### Re-measured at the trunk

- the pins: unit **8 passed (8)**, integration **12 passed (12)**;
- the five ADR guards (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-source-references`, `adr-consumers`): **5 files, 218 passed (218)**, with
  `adr-numbering` alone at **29 passed (29)**;
- `tsc -p apps/web/tsconfig.json --noEmit`: exit `0`;
- `prettier --check` on this record: clean;
- `eslint` on the seven touched production files: **0 errors**, one
  `security/detect-object-injection` warning at `catalog.ts:658` — the
  pre-existing `TRANSPORT[code]` sink, at line `653` of the base blob, so the
  delivery adds **no** new warning;
- CI on the head: **15/15 checks**, the aggregate `ci`, `test_coverage` and
  `secret-scan` included.

The full suites were run at the squash `442e01a`: `unit` **178 files, 2938 passed
| 3 skipped**; `integration --maxWorkers=4` **128 files, 1321 passed**. Recorded
honestly: a **first** full integration run reported **3 failures** that did not
reproduce on the re-run at the same worker count (the runs share one mongod, so
the first was load-induced); the clean run exited `0`.

### The guard rails are pinned, not assumed

Two mutation probes, each in a throwaway worktree that was removed afterwards and
each re-run here at `9633f5f`, with the tree restored byte-identically (`git
status` empty) after it:

- **All four route gates removed** → `8 failed | 4 passed (12)`: exactly W1–W4 and
  P1–P4 redden with `expected 201/202/404/413/409/403 to be 410`, while the four
  controls C1–C4 stay green. Every route call is load-bearing, and no case rides
  another route's gate.
- **The gate moved inside `requireAttendeeScope`** → `1 failed | 11 passed (12)`:
  only C4 reddens, with `expected 410 to be 200`. The "never in the shared scope
  helper" constraint of §Decision is pinned, not merely stated.

### Honesty checks

`git diff --name-status 442e01a^ 442e01a` is **11 paths**: seven modified
production files (the four write routes, `request-event.ts`, `catalog.ts`,
`packages/contracts/src/errors.ts`), **two added** specs, the added record and
`docs/adr/README.md`. No existing test, helper, fixture or mock was touched, and
the added production lines carry no `NODE_ENV`, `process.env`, `console.`,
`ts-ignore`, `.only`, `eslint-disable` or hardcoded fixture value.

### Post-review status

The routing below is stated as at review time and names the commits that landed
since, so nothing reads as "open" that the trunk says is closed.

- **Low, routed, landed — the read surface.** The un-pinned half of §Decision
  (`GET …/gallery`, `GET …/me`, the image reads staying ungated) went to TEST card
  `t_3dccf581`, whose R1–R4 pack landed as PR #576 (squash `c5ea610`).
  `requireAttendeeProfile` (`request-event.ts:239-263`) still carries no retention
  check, which is why that pack was green on its first run.
- **Low, routed, landed — the downloads pair.** TEST card `t_86e8986e` added R5/R6
  and landed as PR #580 (squash `9633f5f`). One premise of the review is corrected
  here: the **POST** `…/events/{slug}/downloads` route _does_ call
  `requireAttendeeProfile`
  (`apps/web/src/app/api/v1/p/events/[slug]/downloads/route.ts:54`); only the
  **GET** `…/downloads/{downloadId}` resolves through `requireAuth` and
  `callerProfileId`/`ownsJob`
  (`apps/web/src/app/api/v1/p/downloads/[downloadId]/route.ts:50-59`). Both arms
  are pinned now.
- **Low, routed — the contract's `unhide` (decided).** `docs/API Contract.md:2359`
  documents `POST …/matches/{matchId}/hide` · `…/unhide`, but only the `hide`
  route exists, and [ADR-0793](ADR-0793-op133-attendee-gallery-red.md):230 and
  [ADR-0794](ADR-0794-op133-attendee-gallery-green.md):283 record `unhide` as
  deliberately out of scope — so the documented pair answers `404` on its second
  member. Decision card `t_75db3204` has settled it: §6.5 will document `hide`
  only, `unhide` is **not shipped and will not be built**, with child cards
  `t_f7de81f3` (contract amendment) and `t_447590bb` (verification).
  §"Explicitly not gated" keeps its `hide/unhide` wording: after the amendment
  that phrase is **inert for `unhide`** — there is no route to gate — not false,
  and this record is not retracted for a contract defect.
- **Info, no card — the `/me` key count.**
  `apps/web/src/app/api/v1/p/events/[slug]/me/route.ts:86` says "§6.4's fourteen
  keys plus the client's `latestMatchCursor`", while the body answers **fourteen**
  keys: §6.4's sample body carries **thirteen**, and the route adds
  `latestMatchCursor` (`me/route.ts:112`). The follow-up spec's comment states the
  correct arithmetic (`attendee-retention-read-surface.test.ts:127`); the route's
  own comment and the OP-133 record's §10 keep the two-off phrasing. Documentation
  only — no number is minted and the contract is not edited here.
- **Info, no card — one predicate, two copies.** The inclusive `now >= deadline`
  comparison now exists twice: `retentionElapsed` here
  (`request-event.ts:181`) and inline in `resolvePublicEventOutcome`
  (`public-event.ts:95-96`). Both are `null`-safe and inclusive today, so a dedupe
  would be a deliberate, pin-backed change rather than a tidy-up.
- **Info, no card — the ledger snapshot.** Both `Next free` cells read `0818`
  while the record that number belongs to is in flight on
  `OP-134-task-claim-endpoint-arms-pins`, whose branch sets the cells to `0819`;
  that branch's merge advances the snapshot. This append touches neither cell and
  consumes no number.
