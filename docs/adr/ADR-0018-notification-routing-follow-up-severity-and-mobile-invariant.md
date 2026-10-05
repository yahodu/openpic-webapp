# ADR-0018 — Notification routing follow-up: `auth.account.completed` severity and the enabled-mobile channel-group invariant

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-84 follow-up (`t_8e6c8045`) · **Relates to:** [ADR-0016](ADR-0016-notification-routing-matrix-as-data.md) (the RED module contract), [ADR-0017](ADR-0017-notification-routing-matrix-green-implementation.md) (the GREEN transcription and derived fields)
- **Schema:** §19.1, §4.1 (authentication matrix), §1.1 (mobile group) · **Design:** `docs/Notification and Database Design.md`

## Context

The review of the OP-84 GREEN delivery (PR #123) surfaced two data-fidelity
gaps. Both are non-blocking but real, and both must be recorded here because
they fix a value and a schema rule that future edits must not silently undo.

1. **`auth.account.completed` was `important`, not `critical`.** Design §4.1
   states, verbatim, _"All `transactional: true`, `severity: critical`"_ for the
   whole `authentication` category, and ADR-0017 §1 relies on that (_"§4.1 fixes
   every authentication type to `critical`"_). The seed nevertheless set this one
   type to `important`. The schema derives
   `respectQuietHours = severity !== "critical"`, so the error flipped
   quiet-hours handling for exactly this type: a critical notification that must
   ignore quiet hours was being held back.

2. **An enabled `mobile` group could omit its routing fields.**
   `channelGroupSchema` made `candidates` and `strategy` optional
   unconditionally, so `{ group: "mobile", enabled: true, optOutAllowed: false }`
   parsed successfully. The seed's `build()` always populates them, but the schema
   is the reusable gate that an admin template/type editor will pass, and a
   mobile group with no candidates has no route for the resolver to attempt.

## Decision

### 1. `auth.account.completed` is `critical` (option a — code matches the docs)

`severity` for `auth.account.completed` is `critical`. The design §4.1 blanket
statement and ADR-0017 are authoritative; the seed was the transcription error,
so the code is corrected rather than the design superseded. No superseding ADR is
needed: §4.1 already makes the general claim, and this change makes the one
outlier conform to it. `respectQuietHours` therefore becomes `false` for this
type, like every other authentication type.

### 2. An enabled `mobile` group must declare `candidates` (≥1) and `strategy: "first_eligible"`

`channelGroupSchema` now carries a `superRefine` that rejects a group when
`group === "mobile" && enabled === true` and either:

- `candidates` is absent (a present-but-empty array was already rejected by
  `min(1)`), or
- `strategy` is absent.

`strategy` remains an enum of `["first_eligible"]`, so "present but wrong" is
already rejected by the field schema. Disabled `mobile` groups and the
single-member `in_app`/`email` groups are unaffected, preserving every one of the
81 seeded documents' validity and the factory baseline.

## Consequences

- The derived `respectQuietHours` is now consistent for all nine authentication
  types; the §4 severity/quiet-hours matrix has no internal contradiction.
- The reusable channel-group gate can no longer admit an enabled `mobile` group
  that would resolve to nothing, which is the invariant an admin editor needs.
- Behaviour-preserving for all seeded data and existing specs: the change only
  rejects shapes the seed never produced.
- Coverage gap carried forward: only the two issues above are pinned here. The
  full per-type §4 severity matrix is still guarded section-by-section rather
  than key-by-key (ADR-0017 "Coverage gap"); a future table-driven matrix spec is
  the right place to pin the remaining transcriptions.

## Alternatives considered

- **Supersede §4.1 and keep `auth.account.completed` as `important`.** Rejected:
  the product intent is that a completed-account notice is as urgent as the rest
  of the authentication category, and the docs already say so; inventing an
  exception would add a rule with no demonstrated need.
- **Enforce the mobile invariant at seed time only (`build()`), not in the
  schema.** Rejected: the schema is the documented reusable gate
  (ADR-0016 module contract); enforcing it only in the builder would let an
  admin editor persist an un-routable group.
