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
