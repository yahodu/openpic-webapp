# ADR-0017 — Notification routing matrix GREEN implementation: 81-key transcription, derived fields and reconcile semantics

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-84 GREEN (`t_46ce87e5`) · **Relates to:** [ADR-0016](ADR-0016-notification-routing-matrix-as-data.md) (the RED module contract), [ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) / [ADR-0015](ADR-0015-plans-seed-concurrency-atomic-upsert.md) (the sibling seed pattern)
- **Schema:** §19.1, §19.2, §4 (matrix), §1.1 (mobile group), §6 (dedupe/digest) · **Contract:** §7.6 (normative type catalogue)

## Context

ADR-0016 fixed the module contract from the OP-84 RED specs: the module paths,
export names, the `channel`-is-a-group decision, the template
variable-consistency refinement and the create-or-reconcile/version-on-change
semantics. The GREEN card then had to transcribe the §4 matrix into 81
`notificationTypes` documents and derive the template catalogue. Three things
ADR-0016 deliberately left to the implementer had to be decided:

1. **How the routing fields are modelled** for the fields the RED specs pin only
   structurally (severity, `respectQuietHours`, per-type channel toggles,
   audiences, throttle/dedupe vocabulary).
2. **How `version` is computed atomically** so an idempotent re-run never churns
   it (I1), mirroring ADR-0015.
3. **Whether templates are authored per type or derived** from the routing
   catalogue, given AC2 requires exactly one active `en-IN` template per enabled
   group.

## Decision

### 1. The 81 keys are transcribed from §4, with a small, documented derivation

`TYPE_SPECS` in `notification-types.values.ts` is one entry per contract key in
§7.6 order. Channels, `transactional` and opt-out are transcribed from §4.
Four values are **derived**, because §4 states them only in prose or not at all:

- **`respectQuietHours = severity !== "critical"`** — §19.1 states quiet hours
  are ignored for `critical` types, so storing `true` for them would be dead data.
- **`severity`** — §4.1 fixes every authentication type to `critical`; for the
  other sections severity is assigned from risk (money/access/erasure →
  `critical`, receipts/states → `important`, confirmations → `informational`).
  Flagged `TODO(product)`.
- **`audiences`** — transcribed from each row's recipient column; every billing
  type is `["billing_contact"]` so no billing type can reach a co-organizer (U2).
- **`optOutAllowed`** — transcribed from the §4 opt-out column, forced `false`
  for every group of a `transactional` type (U3, design rule 7), and forced
  `false` for `in_app` on every type (U4).

All 81 entries pass `notificationTypeSchema` before export, and
`NOTIFICATION_TYPE_KEYS` is derived from the same list, so the frozen key set and
the seeded documents cannot drift (U1).

### 2. `version` is computed server-side in one atomic upsert (ADR-0015)

`reconcilePipeline` writes the catalogue fields and computes `version` from the
stored document in a single aggregation-pipeline update:

- missing document → the catalogue `version`;
- routing/copy differs → the stored `version` **+ 1**;
- identical → the stored `version` **untouched**.

Nothing is read before the write, so a run cannot reconcile against a stale
document. `$literal` keeps every catalogue value an opaque value rather than a
field path. Overlapping same-process runs are coalesced (`runExclusive`) and a
racing cross-process insert surfaces `E11000`, which `upsertByFilter` absorbs as
"another writer won" (I1).

### 3. Templates are derived from the routing catalogue, not hand-listed

`SEED_NOTIFICATION_TEMPLATES` is built by mapping each enabled
`channelGroups[].group` of every seeded type to one `en-IN` template. This makes
AC2 structural: enabling an email group without shipping its copy cannot happen,
and a disabled group cannot carry a stray active template. Every template is
parsed through `notificationTemplateSchema`, so `variables[]` equals the
placeholders actually used **by construction** (U7/AC3).

Copy is **`TODO(product)` scaffolding** — a humanised label plus a
channel-appropriate call to action, with the one test-pinned exception that every
`billing.subscription.downgraded` template carries "Nothing has been deleted"
(U8). The card pins template structure, not marketing copy; replacing the copy is
a product content task, not a code change.

## Consequences

- The module contract of ADR-0016 is satisfied exactly; all four OP-84 spec files
  (2 unit, 1 integration, 1 template unit) pass: **15 + 11 + 4 unit/integration
  specs** on top of the full suite (**793 unit, 141 integration**).
- `version` is a faithful "the matrix changed" audit signal; an implementation
  that always wrote the catalogue version would fail I1's version-stability
  assertions.
- **Coverage gap / assumption:** the full per-type §4 matrix (which exact types
  enable email/mobile, and their section-by-section severity) is **not** pinned
  key-by-key — only U2–U9 plus the OTP/downgrade/first-match pins. The
  transcription is deliberate and commented, but a later settings-UI story should
  add a table-driven matrix spec so the transcription itself is guarded.
- **Assumption:** `in_app` template `subjectTemplate` is the feed title and
  `bodyTemplate` the body (schema §19.2 has no separate title field), per
  ADR-0016.
- **Out of scope:** the `{typeKey:1}` unique index and the active-only partial
  unique index on templates (OP-76 territory); `notificationPreferences`,
  dispatches, digests and suppressions (§19.3–§19.6).

## Alternatives considered

- **Store `severity` for authentication only and default the rest.** Rejected:
  quiet-hours bypass and admin escalation read severity on every type; a missing
  value would silently change delivery.
- **Read-then-write reconcile.** Rejected: it can reconcile against a stale
  document under concurrent deploys; ADR-0015's atomic pipeline is the
  established, race-safe pattern.
- **Hand-author one template per `(typeKey, group)`.** Rejected: 200+ rows that
  can drift from the matrix; deriving them makes AC2 hold structurally.
- **Put the template copy in a content file and load it at seed time.** Rejected
  for now: the card pins structure only; a content pipeline is a later story.
