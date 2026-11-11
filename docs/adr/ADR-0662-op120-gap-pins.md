# ADR-0662 — OP-120 round-1 gap pins: log redaction, the phone invitee, event scoping, the concurrent duplicate, the revoke preview

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-120 (Collaboration epic, phase 3 — Events & Collaboration)
- **Card:** `t_b91b009e` (tdd_stage TEST / characterization pins, testcase-writer)
- **Branch:** `OP-120-task-invitation-gap-pins-2` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_defedc69`, off `origin/main` `bfa55af`,
  the `1.51.0` release — i.e. the trunk **after** the OP-120 squash-merge `3678c57`)
- **Range:** `0660`–`0679` (lane block). This record consumes `0662`, the cell's
  value re-read at the branch head immediately before committing; the cell
  advances to `0663`.
- **Consumes:** [ADR-0660](ADR-0660-op120-invitations-red.md) (the RED pins) and
  [ADR-0661](ADR-0661-op120-invitations-green.md) (the implementation). This
  record **adds no new contract**: it pins behaviour the trunk already ships.

## Context

The round-1 review of the OP-120 RED found five behaviours that no pin observed,
each of which lets a plausible wrong GREEN pass:

- **F2** — the four existing never-return scanners watch the response keys, the
  response value preimages, the `domainEvents` payload values and the rendered
  dispatch copy. **Nothing observed the logger**, so a route or module that wrote
  the raw token (or the link carrying it, or the raw invitee address) into a log
  line would have passed every case in the file.
- **F3** — the story is "invite by user, email **or phone**", but no case ever
  sent a `phone` invitee. A normalizer/projection/delivery path that handled only
  `email` and `user` passed.
- **F4** — every list case had exactly one event in one tenant, so a list
  filtered by **tenant** alone passed.
- **F5** — only the _sequential_ duplicate was pinned. The §13.6 unique partial
  index is the mechanism that makes the refusal race-safe, and no case exercised
  it.
- **F6** — §2.3 says the preview returns `status`, but a lookup filtered on
  `status: "pending"` answers `404` and passed every case.

## Decision

All five pins are **appended** to
`apps/web/src/test/integration/event-invitations.test.ts` (the card's rule: the
existing pins are not edited). One import line gained `maskPhone` and a new
`@/server/logging` import block; no fixture, factory or shared helper was touched.

### D1 — F2 is pinned at the process-logger seam, with a liveness proof

The spec installs a `debug`-floored `memoryTransport` through `setLogger(...)`
and restores the previous logger in `afterAll` (the OP-113
`media-signed-url-never-logged` precedent). Two cases:

1. **create** — assert the route's own audit record (`event:
"collab.invite.created"`) reached the sink (so the negatives are not
   vacuous), then assert no record's JSON contains the raw token, the link
   `/invitations/{token}`, `sha256(token)` or the raw invitee email.
2. **preview** — first drive a 404 lookup, which is the shape this pipeline does
   log (`http.request.rejected`), proving the capture is live for the preview
   route; then drive the **live** preview with the real token (recovered from the
   rendered message, exactly as the invitee would) and assert the same negatives.

The token is recovered by `tokenForHash(...)`, which reads the dispatch ledger and
keeps the base64url run whose sha256 is the row's `tokenHash` — the same
technique the shipped preview case already uses, so the pin cannot read the token
from anywhere the product exposes it.

**Layering note.** `@/server/logging/redaction` already redacts values under
token-named keys (`token`, `secret`, `sig`, `email`, `phoneE164`, …) and masks
email/E.164/`Bearer`/`opat_` patterns in free text. That is why a mutation that
logged `{ token }` stayed green — the port masked it. The realistic leak shape is
the token riding a **neutral** field (a logged request path, a `link`, a `url`),
and that is what the pin was proved against (see Evidence). The pin therefore
tests the property, not the redactor.

### D2 — F3 pins the phone invitee end to end

`{ invitee: { kind: "phone", phoneE164: "+919876543210" } }` sent exactly as
schema §13.6 stores it. Assertions: `201`; the **nine-key** body; `kind`/
`status`/`eventId`; `inviteeMasked === maskPhone(PHONE_E164)` (and not containing
the middle digits, and the raw number absent from the serialized body); the stored
`invitee` **exactly** `{ kind: "phone", phoneE164: "+919876543210" }`; a
`tokenHash` present; and an SMS-capable `channelsNotified` (`toContain("sms")`,
recorded identically on the row). A second case pins that the SMS leg is real:
a dispatch row with `channel: "sms"` whose `contactHash` is `sha256(number)` and
whose rendered copy carries a run hashing to the stored `tokenHash` — a bare
channel label without a destination would pass the first case alone.

### D3 — F4 pins event scoping on the list (and on its admission)

Two events in **one** tenant, an invitation in each, one organizer who is a
member of both: `GET …/events/{a}/invitations` must return exactly A's row and
A's `eventId`, and the converse holds for B, so a route that answered whichever
event it liked first cannot pass. A second case pins the admission half: a
co-organizer of event A (holding no `tenantMembers` row, the I9 reader shape) is
served A and gets the uniform `404 not_found` for B.

### D4 — F5 pins the concurrent duplicate's observable outcome, and the guard it requires

Two `POST`s in flight together for the same `(eventId, invitee)` with **distinct**
`Idempotency-Key`s (so the replay stage cannot be what refuses the loser) must
answer exactly one `201` and one `409 invitation_already_pending`, and store
exactly one row — the winner's id. The case is stable (5/5 runs).

Probing **which** guard answers here (Evidence) showed the in-process loser
usually loses at the route's read-then-insert duplicate pre-check, not at the
§13.6 index — so a pin on the index's `E11000 → 409` mapping alone could not be
written without a test-only seam. The pin therefore locks the **contract**
(exactly one `201`, one `409` with that code, one row), and the index's role is
recorded, not over-pinned: with the pre-check disabled the index rejects the
loser's insert (`[201, 500]` only because the mapping constant was mutated in the
same probe), and with **both** guards disabled the pair answers two `201`s. The
card asks for exactly this shape, and ADR-0661 already documents that the
pre-check exists only to make the common case clean.

### D5 — F6 pins the shipped preview answer for a non-pending invitation

A revoked invitation's preview answers **`200`** with the five-key body and
`status: "revoked"` (plus the masked invitee, the event name, no forbidden
fields, and the token absent). This is the ADR-0661 choice, recorded as-is — not
weakened to "not 500", and not replaced by the card's alternative
`410 invitation_revoked`, which the trunk does not implement.

### D6 — Expiry is deliberately **not** pinned, because the product cannot produce it

The card offered "and an expired one `"expired"` if the GREEN sweeps expiry". The
trunk does not sweep: `invitations_expire_at_ttl` is a **TTL index on
`expireAt`** with `expireAfterSeconds: 0`, so a pending invitation whose window
passes is **deleted** by the TTL monitor, not flipped to `status: "expired"`.
`status: "expired"` is therefore a legal enum value no production path writes,
and a seeded `expired` row would pin an unreachable state. The revoked case
already pins the property that matters (the lookup is **not** filtered on
`status: "pending"`), and D6 is the explicit scope boundary. If a later lane adds
an expiry sweeper, the pin to add is the `200 + "expired"` pair — no weakening of
this one is implied.

## Evidence (mutation probes, each restored byte-identically)

| Pin          | Mutation                                                                                        | Observed failure                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| F2 create    | add `link: \`${baseUrl}/invitations/${token}\``to the route's`collab.invite.created` log fields | `AssertionError: expected [ Array(1) ] to deeply equal []`                         |
| F2 preview   | log `{ path: new URL(request.url).pathname }` in the preview handler                            | `AssertionError: expected [ Array(1) ] to deeply equal []`                         |
| F3 phone     | `deliveryFor` phone arm → `channels: ["email"]`                                                 | `AssertionError: expected [ 'email' ] to include 'sms'`                            |
| F4 scoping   | drop `eventId` from the list `find(...)`                                                        | `AssertionError: expected [ '6af4a5cc…c', …(1) ] to deeply equal [ '6af4a5cc…8' ]` |
| F5 duplicate | disable the pre-check **and** break the `11000` mapping                                         | `AssertionError: expected [ 201, 500 ] to deeply equal [ 201, 409 ]`               |
| F5 duplicate | break **only** the `11000` mapping                                                              | pin stays **green** — the loser was refused by the pre-check, not the index (D4)   |
| F6 preview   | add `status: "pending"` to the token lookup                                                     | `AssertionError: expected 404 to be 200`                                           |

A first F2-preview probe that logged `{ token }` also stayed green — that is the
redaction layer doing its job, not a hole in the pin (D1).

## Assumptions

- **A1** — installing the process logger (`setLogger`) is the sanctioned seam for
  "did anything get logged?"; the sink is captured per case and the previous
  logger is restored in `afterAll`, so no later spec inherits it.
- **A2** — in this in-process harness the concurrent loser is normally refused by
  the route's duplicate pre-check; D4 records that and pins the outcome rather
  than the mechanism.
- **A3** — the phone mask is the contract's own `maskPhone`, so the pin cannot
  drift from §0.13 while the projection does not.
- **A4** — the unit spec is unchanged: `normalizeInvitee`'s phone arm (canonical
  stripping, `invalid_phone` refusals) is already pinned there (29 cases); F3 is
  the _wire_ half of that story.
- **A5** — the list's `eventId` scoping is asserted on the projected body's own
  `eventId`, so a route that filtered correctly but projected the wrong id would
  still fail.

## Consequences

- The invitation surface now has 34 integration cases (26 shipped + 8 appended);
  the unit project is untouched.
- The five gaps each fail loudly under the plausible wrong implementation they
  were written for (Evidence above), so a future refactor that preserves the
  behaviour breaks none of them.
- `docs/adr/README.md` is the shared-ledger hotspot: this record adds one index
  row (≤ 116 characters, inside the `0420`+ table's existing column width so
  Prettier does not re-pad ~50 rows), advances the lane's `Next free` cell to
  `0663`, and appends one lane note. Any merge conflict there resolves as a
  **union keeping the highest values**.

## Alternatives

- **A separate spec file** — rejected: the card sanctions appending, and the
  existing file already owns the harness (workspace/event/member seeding, request
  builders, scanners, the delivery drain) those five pins need.
- **A `Db`-proxy seam to force the index to answer the concurrent duplicate** —
  rejected: the route resolves its database through `getDb()`, so reaching the
  index deterministically would need a test-only seam, and the observable
  contract (`201`/`409`/one row) is what the API owes. D4 records the limitation
  instead of hiding it.
- **Pinning `410 invitation_revoked` for the revoked preview** — rejected: the
  trunk answers `200` with the status, §2.3 says the preview carries `status`,
  and the card forbids weakening a pin to a shape the product does not have.
- **Seeding an `expired` row to pin `status: "expired"`** — rejected (D6): the
  TTL deletes such rows, so no production path reaches that state.

## Round-1 review sign-off (2026-11-11)

**Verdict: APPROVED WITH FINDINGS**, round 1, artifact lens, at head `4349d84`.
The delivery landed on the trunk as the squash `f0f85e9` (PR #412); the review
record is PR #412 comment
[`#issuecomment-6803317999`](https://github.com/yahodu/openpic-webapp/pull/412#issuecomment-6803317999).
`git diff --stat 4349d84 f0f85e9` is **empty**: the tree the review read is
byte-identical to the merged tree, so every measurement below was taken on the
merged bytes.

### Independently re-measured by the reviewer

These numbers are the reviewer's own runs, not a transcription of the handoff. In
a detached worktree at the merged trunk `f0f85e9`: the focused spec `34 passed
(34)`; the whole integration project `96 files / 878 passed (878)`; the
`adr-numbering` guard `29 passed (29)`; `prettier --check` clean on the three
files PR #412 carries. The guard was also run on the branch head, with the same
`29 passed (29)`. Every PR check was green before the merge, including `ci`,
`test_coverage` and `secret-scan`.

The spec removal audit finds exactly **one** removed line across the 403 added:
the `@openpic/contracts` import gaining `maskPhone`. The 26 shipped cases are
therefore byte-identical — this delivery appends, it does not rewrite.

### The pins are load-bearing (reviewer's own probes)

Four mutations were applied one at a time in a throwaway worktree at the merged
tree, and every file was restored byte-identically (`sha256` unchanged, `git diff
--stat` empty). Each turned the pin it was written for red: logging the request
`path` in the preview handler reddens F2 with `expected [ Array(1) ] to deeply
equal []`; adding an `inviteUrl` to the `collab.invite.created` record reddens
**both** F2 cases with that same assertion; dropping `eventId` from the list
`find(...)` reddens F4 with a deep-equality mismatch between the two events' ids;
adding `status: "pending"` to the token lookup reddens F6 with `expected 404 to
be 200`. F5 ran `4/4` consecutive green, so the concurrent pin is not flaky.

D4's two disclosures and D6's boundary also reproduce as this record states them.
A token-named key such as a one-word `token` field is masked by the logging
redaction layer, so only a **neutral** field name leaks; the concurrent loser is
normally refused by the route's duplicate pre-check, not by the §13.6 index,
which is why F5 pins the observable `201`/`409`/one-row contract rather than the
mechanism; and `invitations_expire_at_ttl` is `expireAfterSeconds: 0`, so an
expired row is deleted and `status: "expired"` stays unreachable.

### Findings, and where they went

One **Low**, test-side, and it is the reason a follow-up exists: F2 drove only
the create and preview success paths, so the `collab.invite.delivery_failed`
record emitted inside `invitation-delivery.ts` was unpinned. It named no link and
no destination at the reviewed head, so there was no leak — but a later edit that
added either one to that record would have passed every pin in the file. It is
routed to card `t_cd08dc0f` as a characterization pin with no GREEN owed; that
card's own record documents what followed, and this sign-off cites the card id
rather than any ADR number the follow-up may have consumed.

Three **Info** items were recorded and closed without cards: F5's row query over
the invitee's email is not tenant- or event-scoped and is correct today only
because the file's per-test wipe empties every collection first; F2's preview
liveness assertion matches any `http.request.rejected` record instead of
filtering on the route template, which is tight enough today because the case
issues exactly one rejected request; and the Evidence table above abbreviates two
assertion strings, which the reviewer's own probes reproduced in full with real
ids.

### Nothing above is retracted

Every decision in `D1`–`D6`, every row of `## Evidence`, every assumption in
`A1`–`A5` and every rejected alternative stands exactly as written, including
D4's two honest disclosures (token-named keys are already redacted; the
concurrent loser is normally refused by the pre-check) and D6's expiry boundary.
This section is appended, not rewritten: every historical section of this record
is byte-identical to the merged one.

`docs/adr/README.md` is **byte-identical** for this change as well — the sign-off
adds no index row and moves no lane `Next free` cell, so it consumes **no** ADR
number.
