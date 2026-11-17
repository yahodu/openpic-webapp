# ADR-0811 — OP-132: a closed upload window does not gate the attendee selfie flow

- **Status:** Accepted
- **Consumers:**
  `apps/web/src/test/integration/attendee-upload-window.test.ts` (four cases), with
  its local harness (`closedWindowTenant`, `onlyEvent`, `readySelfie`,
  `selfieCountFor`, `profileById`, `storedSelfie`).
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity
lane`) is exhausted, so this record draws from the `unallocated (future lanes)`
  pool — the [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md)
  precedent. The number is an **allocator reservation** taken `2026-11-13` above
  the then-highest in-flight number (`0810`, card `t_3c97c2f0`; `0809` is
  reserved-and-unused by card `t_29382bcc`), never a read of the `Next free` cell.
  Since the reservation, `0810`'s record landed on the trunk (`1.62.0`) and both
  cells read `0811`, so this record draws exactly the reserved pool head. Before
  minting, the sweep was **empty**: no `.worktrees/*/docs/adr` carries an
  `ADR-0811*` file and no open or remote `OP-13x` head adds one. This record
  therefore draws **`0811`** and both cells advance to `0812`. No lane row is
  minted.
- **Amends:** none. The behaviour ships unchanged; the record supersedes the
  contract's dead `409 gallery_closed` row (§6.3), which the docs card
  `t_a1fbb7a7` deletes from §6.3, Appendix A.7 and the `ErrorCode` union.
- **Consumes:** `0811`.

## Context

Decision card `t_500d521e` (F4-R2) asked whether `events.uploadWindowEndsAt`
should gate an attendee's selfie. The contract's §6.3 submit table carried a
`409 gallery_closed { closedAt }` row, so the question was live; review found
that **no code path reads the window on any attendee endpoint**
(`gallery_closed`: 0 hits in `apps/web/src`), that the organizer's own gate is
`uploadWindowClosed()` → `409 upload_window_closed` (`uploads/params`,
`batch-resolve`, `single-put` complete, `multipart` claim and complete), and that
the public event payload never exposes `uploadWindowEndsAt` at all.

Nothing pinned the exclusion, so a later "fix" could add a window gate to the
submit route and every existing suite would still pass. This record settles the
question and names the four executable pins that hold it
(`apps/web/src/test/integration/attendee-upload-window.test.ts`).

## Decision

**No upload-window gate exists, or may be added, on
`POST /api/v1/p/events/{slug}/selfies`, `…/liveness/challenges` or
`…/selfies:reuse`.** A closed `events.uploadWindowEndsAt` neither refuses a
liveness challenge (`201`), nor a submit (`202`), nor a reuse (`202`).

Four cases, all on one seeded event whose `uploadWindowEndsAt` is one hour in the
past (`now - 3_600_000`):

| case                           | pinned observable                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1** (control, load-bearing) | organizer `POST …/uploads/params` → `409 upload_window_closed`, `details { uploadWindowEndsAt, canExtend: true }`, no `upload_sessions` row             |
| **W2**                         | `POST …/liveness/challenges` → `201` with a non-empty `nonce` — not `409`, not `403`                                                                    |
| **W3**                         | `POST …/selfies` with a valid challenge and a stored object → `202`, the seven §6.3 keys, `status: "processing"`, one `selfies` row, `attemptsUsed: 1`  |
| **W4**                         | `POST …/selfies:reuse` with a reusable selfie id → `202`, one new `selfies` row for the addressed event, no `embedding`/vector/`similarity` in the body |

W1 is deliberate: it proves the fixture's window really is closed, so W2–W4
cannot pass vacuously on an event that was never closed.

**Rejected alternative (a) — enforce the window: on submit only, or on all
three.** Rejected for four reasons, all measured on the trunk:

1. **§6.1 makes the attendee's gallery window a function of
   `retentionExpiresAt` alone.** `resolvePublicEventOutcome`
   (`apps/web/src/server/attendee/public-event.ts:89-101`) computes
   `galleryOpen` from the retention instant and nothing else, and the public
   event payload never carries `uploadWindowEndsAt`. A refusal at the upload
   window would refuse an action §6.1 tells the client is open — the client
   cannot even know the deadline exists.
2. **The window is the organizer's content-admission deadline.** It is written
   as `uploadWindowEndsAt = endAt + events.post_upload_days` and enforced where
   gallery content enters the system (§5.2/§5.3, ADR-0721 A7,
   `409 upload_window_closed`). A selfie is a matching probe; it never becomes
   gallery content.
3. **`gallery_closed { closedAt }` did not match the organizer refusal.**
   `upload_window_closed` carries `{ uploadWindowEndsAt, canExtend }`, and
   `canExtend` is meaningless to an attendee — one deadline under two shapes and
   two vocabularies is how the dead row survived this long.
4. **A gate on the challenge would be strictly worse than one on the submit:**
   it refuses before consent, before the object, and before anything the caller
   could act on, and it makes the attendee's screen dead at a moment the gallery
   is still open.

## Consequences

- **The `409 gallery_closed` row is gone.** §6.3's submit table row, Appendix
  A.7's catalogue row and the `ErrorCode` union member are deleted by the docs
  card `t_a1fbb7a7`; no replacement code and no citation is added.
- **`uploadWindowEndsAt` stays organizer-only.** §6.1's public payload keeps not
  exposing it; a client that wants the attendee deadline reads
  `gallery.expiresAt`.
- **The retention boundary is not gated today, and this record does not decide
  it.** After `retentionExpiresAt` elapses a submit still writes a biometric row
  with an already-past `expireAt`. That question is owned by decision card
  `t_7e4d553b`; the four cases here keep `retentionExpiresAt` in the future so
  only the upload window varies and this record cannot be read as a ruling on
  retention.
- **W1–W4 pin the exclusion in both directions.** Three mutations, each reverted
  byte-identically (`sha256` unchanged, `git status` clean), reddening exactly
  the intended case:

  | mutation                                                  | measured                                              |
  | --------------------------------------------------------- | ----------------------------------------------------- |
  | `uploadWindowClosed()` forced to answer `null`            | W1: `expected 201 to be 409`; W2–W4 still pass        |
  | `upload_window_closed` thrown at the submit route's entry | W3: `expected 409 to be 202` (W4's fixture also dies) |
  | `upload_window_closed` thrown at the reuse route's entry  | W4: `expected 409 to be 202`; W1–W3 still pass        |

  A "fix" that adds the gate to the submit route therefore breaks W3; one that
  adds it to reuse breaks W4; and one that opens the organizer's window breaks
  W1, so the fixture cannot silently stop being a closed-window fixture.

- **The three attendee endpoints now have a single statement of why they carry
  no window check.** A future card that wants one must supersede this record and
  change §6.1's gallery model at the same time — the two cannot disagree.

## Evidence — measured at the branch cut

Branch `OP-132-task-attendee-upload-window-pin`, cut from `origin/main`
`c1e5dc3` (`chore(release): 1.62.0`, which carries the OP-132 code and the
ADR-0805/0806 pins).

| gate                                                                                                                   | result                      |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| focused integration run of the new spec                                                                                | `1 file, 4 passed (4)`      |
| `tsc -p apps/web/tsconfig.json --noEmit`                                                                               | exit `0`                    |
| `eslint --max-warnings=0` on the new spec                                                                              | clean                       |
| `prettier --check` on the spec, this record and the ledger                                                             | clean                       |
| the five ADR guards (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`, `adr-source-references`, `adr-consumers`) | `5 files, 218 passed (218)` |
