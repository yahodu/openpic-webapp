# ADR-0096 — OP-94 fan-out mobile skip-channel fallback is not pinnable without a contract change

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_9e63f809` (RED pin) · **Parent:** `t_3b8e846d` · **Reviews:** ADR-0094, ADR-0095
- **Branch:** `OP-94-task-fanout-mobile-skip-channel-pin` (fresh from `origin/main` @ `574afef`)

## Context

The OP-94 polish review (ADR-0095) routed a RED card to pin the channel that
`groupChannel` (`apps/web/src/server/notifications/fan-out.ts`) records when an
**enabled `mobile` group declares no `candidates`** and the decision is a
pre-selection skip / defer / digest. PR #190 changed that fallback from the
hard-coded `"sms"` to `DEFAULT_MOBILE_CANDIDATES[0]` (`"whatsapp"`).

The card asked for a _failing_ pin asserting the persisted dispatch row's
`channel`, and instructed the author to **stop and report** if the branch could
not be reached without widening the public contract.

## Investigation (empirical, not just a code read)

- `fan-out.ts` exports only `runNotificationFanOut`, `resolveRecipients` and
  `interpolateDedupeKey`. `groupChannel`, `dispatchOutbound`,
  `fanOutToRecipient` and `processEvent` are module-private.
- The only route a stored type row takes to `groupChannel` is
  `processEvent` → `loadTypeRow`, which `safeParse`s the document against
  `notificationTypeSchema`; a parse failure returns `null` and the event is
  consumed with **no recipients** (`fan-out.ts:459–466`, `1001–1005`).
- `channelGroupSchema.superRefine` **rejects** an enabled `mobile` group that
  omits `candidates` (`notification-types.ts:73–91`). A _disabled_ mobile group
  is skipped by `fanOutToRecipient` (`if (!group.enabled) continue`, `:946–947`).
- **Probe (real fan-out + `MongoMemoryReplSet`):** seeding a type row whose
  enabled `mobile` group omits `candidates` (every other field schema-shaped) and
  running the consumer yields `{claimed:1, processed:1, failed:0}` with **zero**
  `notificationDispatches` rows; the event is marked `done`. The fallback branch
  is never reached, so there is no persisted row whose `channel` could be
  asserted. A test written the card's way fails for the wrong reason
  (`0 rows`, not `"sms" !== "whatsapp"`).
- **Control:** the _reachable_ pre-selection mobile skip (`no_verified_contact`
  on a group that declares `candidates: ["sms"]`) records
  `channel: "sms"` = `candidates[0]` — the non-fallback branch, already correct.

## Decision

**Do not widen the public contract. Deliver no test for this card; stop and
report.**

Reaching the fallback requires one of:

1. exporting a module-private function (`groupChannel`) — an API contract change
   the card explicitly forbids;
2. relaxing `channelGroupSchema` so an enabled mobile group may omit
   `candidates` — a stored-data-contract change with routing consequences; or
3. `vi.mock`-ing the app's own `notificationTypeSchema` so an input production
   cannot produce is admitted — a test that pins an internal collaborator, and
   which would be **GREEN** anyway (the code already records `"whatsapp"`), so it
   could not satisfy the card's "failing pin" requirement.

None is acceptable without an orchestrator decision, so the card's STOP clause
applies.

## Consequences

- Item 3's fallback alignment stays unpinned. This is acceptable because the
  branch is defensively unreachable for every schema-admitted input: no
  observable behaviour can change until the schema or the module boundary
  changes.
- The reachable analogue (a pre-selection mobile skip on a group that declares
  `candidates`) is already correct; it could be added as a _green_ regression
  guard, but it does **not** guard the fallback and is not the failing pin the
  card asked for.
- A future pin requires a decision: authorize a test seam (export the channel
  selection or accept a `typeRow` override) or accept the gap.

## Alternatives

- **Export `groupChannel` (or a test seam).** Rejected by the card; also a
  contract change that would need review.
- **Relax `channelGroupSchema`.** Rejected: a data-contract change; an enabled
  mobile group with no candidate would silently route via the default.
- **`vi.mock` the schema.** Rejected: tests an unreachable branch through an
  implementation mock, and is green.
- **Deliver the reachable green pin only.** Rejected as the card's deliverable;
  offered to the orchestrator as an option.
