# ADR-0047 — OP-90 `GET`/`PATCH /me`: the caller's own `phoneNumber` is raw E.164; a foreign `avatarAssetId` is `422 validation_failed`

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-90 `t_daff2bfa` (decision owner, `openpic-orchestrator`) · recorded docs-only by `t_44552eee`
- **Contract:** API contract §1.2 (Current user), §0.13 (data types: "Phone", "Masked contact"), §0.15 (never-return); Appendix A.2 (`validation_failed`, `forbidden_field`)
- **Supersedes (in part):** `ADR-0044-op90-me-projection-red.md`, "Assumptions resolved unilaterally" item 1 — the claim that §1.2 masks the caller's number. The rest of that ADR stands.

## Context

The OP-90 RED card (`t_572f5d3b`, ADR-0044-op90-me-projection-red) pinned the full
§1.2 `GET`/`PATCH /me` projection contract and, in its "Assumptions resolved
unilaterally" section, deliberately left two questions unpinned rather than bake
in a guess. Its round-1 RED review (`t_fa8f43f5`, ADR-0045-op90-me-projection-red-review-signoff,
finding 1, Medium) routed both to the orchestrator as the decision owner. The
decision card `t_daff2bfa` resolved both and this ADR — a docs-only recording —
locks them into the contract.

## Decision

### D1 — the caller's own `phoneNumber` in `GET`/`PATCH /me` is the **raw E.164** value

`/me` returns the caller's own contact exactly as stored: `"+919876543210"`
(contract §0.13 "Phone" = E.164). Masking — the §0.13 "Masked contact" form
`prefix + "•"`, e.g. `"+91•••••3210"` — applies only to **other users'** contacts
surfaced by other endpoints (§0.13, §0.15).

**Rationale.**

- §1.2 is the single bootstrap call for the authenticated shell and the only
  place the caller sees their own contact; a masked value would make it
  un-editable there.
- §1.2's JSON example is already raw (`"+919876543210"`); see the supersession
  note below.
- §0.13 defines E.164 ("Phone") and the masked-contact form ("Masked contact")
  as two distinct types; the latter is what §0.15 requires for contacts that do
  not belong to the caller.

### D2 — a foreign-tenant (or non-existent) `avatarAssetId` on `PATCH /me` → `422 validation_failed`

The response is HTTP `422` with envelope code `validation_failed` and
`details.fields[].path === "avatarAssetId"`. **Not** `forbidden_field`.

**Rationale.**

- `avatarAssetId` is an **editable field** of `PATCH /me` (§1.2 table); the
  request supplies a permitted key with an **invalid value**. `forbidden_field`
  is reserved for keys that may never appear at all — `email`, `phoneNumber`,
  `platformRole` (RED pins I4/I6).
- Keeping the value failure distinct from the key failure keeps the two codes
  client-distinguishable: a client can tell "you may not send this key" from
  "this key's value is not yours".
- A non-existent asset id returns the **same** code: probing existence is not a
  service this endpoint offers (no existence oracle).
- `validation_failed` already exists in Appendix A.2 with the
  `details.fields: [{ path, code, message }]` shape, so no catalogue change.

## Superseding ADR-0044's phoneNumber bullet

`ADR-0044-op90-me-projection-red.md` ("Assumptions resolved unilaterally", item 1)
asserted that §1.2 masks the caller's own number and quoted a literal
`+919****3210`, calling §1.2-vs-§0.13 a conflict. **That bullet is superseded and
was never correct.**

- The asterisks were an artefact of **Hermes tool-output PII redaction** — a
  transcribed _display_, not the file's bytes. `docs/API Contract.md` contains no
  `*` character at all.
- Verified raw: §1.2's example line carries `"phoneNumber": "+919876543210"`
  (literal `+919876543210`), on `main` and on the OP-90 RED branch alike; §0.13's
  "Phone" row is `E.164` with the same raw value, and "Masked contact" is a
  separate row.
- There was therefore **no §1.2-vs-§0.13 conflict**. §1.2 was raw and remains raw;
  this ADR adds a clarifying §1.2 note and touches no semantics.

The rest of ADR-0044 (the projection, the capability derivation, the `PATCH`
schema and the tenant-scoped ownership rule) is unchanged and remains Accepted.

## Effect on the RED pins — none

Neither decision changes what the approved RED suite asserts, so no Test-Author
re-pin card was created:

- **I1** (`me-current-user.test.ts:355`) pins
  `expect(me.phoneNumber).toBe(user.phoneNumber ?? null)` — a comparison against
  the **stored** Better Auth document, i.e. raw by construction. The only case it
  exercises is an email-OTP account whose phone is `null`, so the raw-vs-masked
  representation was never in play.
- **I5** (`me-current-user.test.ts:536–560`) already pins HTTP `422`,
  `envelope.code === "validation_failed"` and
  `details.fields[].path` containing `"avatarAssetId"` — exactly D2.

## Consequences

- `/me` consumers receive the real, editable contact for the caller; every other
  user's contact remains masked per §0.15.
- Clients can distinguish an invalid avatar **value** (`validation_failed`) from a
  forbidden **key** (`forbidden_field`).
- Docs-only follow-through in this same change: one clarifying bullet in §1.2's
  `GET /me` Notes (raw own contact; masking is for others) and one annotation on
  the §1.2 `PATCH` table's `avatarAssetId` row (the `422 validation_failed` /
  `path === "avatarAssetId"` outcome). The §1.2 JSON example is unchanged (it is
  already raw) and Appendix A.2 is unchanged (`validation_failed` already exists).
- **Numbering coordination.** This record takes **ADR-0047**, not the 0046 the
  recording card tentatively named: the OP-90 RED branch already claims 0044, 0045
  _and_ 0046 (`ADR-0044-op90-me-projection-red`,
  `ADR-0045-op90-me-projection-red-review-signoff`,
  `ADR-0046-op90-me-projection-red-followup-review-signoff`), while `main`'s
  highest is 0044 (`ADR-0044-op89-identity-lifecycle-indexes-ttls-review`). 0046
  is taken, so the next free number in the OP-90 series is 0047. The pre-existing
  `main`-vs-RED collision at 0044 is unchanged by this ADR and is the orchestrator's
  to renumber at RED/GREEN merge (precedent: ADR-0034); if that renumbering shifts
  the RED series up by one, this ADR renumbers with it.

## Alternatives considered

- **Mask the caller's own number in `/me` (ADR-0044's assumption).** Rejected:
  §1.2's example and §0.13's "Phone" row are raw, the caller needs the real value
  to edit it, and masking one's own contact has no basis in the contract. The
  claimed conflict was a transcription artefact.
- **Return `forbidden_field` for a foreign `avatarAssetId`.** Rejected:
  `avatarAssetId` is an allowed key; only its value is invalid. `forbidden_field`
  would erase the distinction the two codes exist to draw and contradict §1.2's
  own field table.
- **Add a dedicated code (e.g. `asset_not_found`).** Rejected: it needs a new
  Appendix A.2 entry and leaks an existence oracle for asset ids;
  `validation_failed` already describes a well-formed request with a
  semantically invalid value.
- **Pin either behaviour in a new/edited test.** Rejected: neither decision
  changes an assertion, and the RED suite is the Test Author's artefact — the
  implementer neither writes nor edits tests (AGENTS.md §2.1/§3.2).
