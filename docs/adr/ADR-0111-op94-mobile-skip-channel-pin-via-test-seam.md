# ADR-0110 — OP-94 follow-up: pin the pre-selection `mobile` skip channel through an authorised test seam on `groupChannel`

- **Status:** Accepted · **Date:** 2026-10-20 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_9e63f809` (OP-94 fan-out follow-up RED) · **Origin:** review of card `t_3b8e846d` (PR #190, ADR-0094), finding `mobile-skip-channel-unpinned` (Low)
- **Relates to:** [ADR-0094](ADR-0094-op94-fan-out-polish.md) (the polish under pin), [ADR-0095](ADR-0095-op94-fan-out-polish-review-signoff.md) (the finding), [ADR-0085](ADR-0085-op93-channel-resolution-and-template-renderer-red.md) / [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) (resolver + fan-out contracts)

## Context

`groupChannel` in `apps/web/src/server/notifications/fan-out.ts` chooses the
`channel` recorded on a dispatch row for an outcome decided **before** candidate
selection — a quiet-hours `defer`, a throttled `skip`, or an outbound `digest`
(`fanOutToRecipient` → `writeSkip` / `writeDigestQueued`). Its `mobile` branch
mirrors the resolver's candidate order:

```ts
return group.candidates?.[0] ?? DEFAULT_MOBILE_CANDIDATES[0];
```

PR #190 replaced a hard-coded `"sms"` fallback with the resolver's exported
`DEFAULT_MOBILE_CANDIDATES[0]` (`"whatsapp"`). Nothing pinned it, so a later
edit could restore `"sms"` — and the ledger would name a channel the resolver
would never have tried first — with every suite still green.

The unit card (`t_9e63f809`, attempt 1) proved the branch is **unreachable from
stored data**: `processEvent` resolves the type via `loadTypeRow` →
`notificationTypeSchema`, `channelGroupSchema` rejects an _enabled_ `mobile`
group that omits `candidates`, and `fanOutToRecipient` skips a _disabled_ group.
A probe inserting such a row produced **zero** dispatch rows with the event
consumed `done` — a stored-row assertion would fail for the wrong reason
(`0 rows`, not `"sms" !== "whatsapp"`). The card's STOP clause was invoked and
the decision was escalated. The answer was **option (b): authorise a test seam**.

## Decision

### 1. `groupChannel` is exported as a documented test seam

The production helper gains only the `export` keyword — no signature, behaviour
or call-site change:

```ts
// apps/web/src/server/notifications/fan-out.ts
export function groupChannel(group: ChannelGroup): ResolvedChannel;
```

It is a total function of its argument (no Mongo, clock, network or module
state), so exporting it is the smallest seam that makes the fallback pinnable.
The alternative seam — letting `runNotificationFanOut` accept a `typeRow`
override — was rejected: it would bypass `notificationTypeSchema` in a
production entry point, i.e. ship a real routing hole to make a test reachable.

**The RED for this seam is the missing export**, not a behavioural bug: the
helper is already correct. A GREEN card must add the one-word export; no other
production change is in scope.

### 2. The pin lives in `fan-out.test.ts` and states the failure explicitly

`apps/web/src/server/notifications/fan-out.test.ts` gains a U4 section that
declares the expected signature in its docstring (the contract declaration a
test may own) and reads the seam through a typed namespace accessor:

```ts
const fanOut = fanOutModule as typeof fanOutModule & {
  readonly groupChannel?: GroupChannelSeam;
};
```

The accessor exists so the RED is **scoped and legible**: a bare named import of
a missing export aborts module instantiation, which would report all 15 existing
U1–U3 tests as failed and hide the real message. Instead `groupChannelOf()`
throws
`fan-out must export "groupChannel(group: ChannelGroup): ResolvedChannel" (authorized test seam, ADR-0110) …`,
so the 8 intended failures each name the missing contract while U1–U3 stay
green. `tsc` also stays clean because the seam is declared optional.

The pins:

| Case                                                  | Assertion                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| seam exists                                           | `expect(fanOut.groupChannel).toBeTypeOf("function")`                                                        |
| no `candidates`                                       | `toBe(DEFAULT_MOBILE_CANDIDATES[0])` — the _relationship_ to the resolver default                           |
| no `candidates`                                       | `toBe("whatsapp")` — the literal contract value, so re-hard-coding `"sms"` fails even if the constant moves |
| `["whatsapp","sms"]`, `["sms","whatsapp"]`, `["sms"]` | first declared candidate is recorded (order preserved)                                                      |
| `in_app`, `email`                                     | the group's own name is recorded                                                                            |

### 3. The integration spec is deliberately not touched

`apps/web/src/test/integration/notification-fan-out.test.ts` still covers the
_reachable_ analogue (a pre-selection mobile skip on a group that declares
`candidates` records `candidates[0]`). Adding a stored-row pin for the fallback
would mean relaxing `channelGroupSchema` or mocking the app's own validator,
both of which the card forbids — and the latter would be green anyway, so it
could not satisfy RED.

## Consequences

- Verified RED: `pnpm vitest run --project unit …/fan-out.test.ts` →
  **8 failed / 15 passed**, every failure naming the missing seam.
- Verified GREEN by a temporary probe (adding only `export`, then reverted):
  **23/23 passed**. Verified regression sensitivity by a second probe
  (`?? "sms"`, then reverted): exactly the two `whatsapp` pins fail with
  `expected 'sms' to be 'whatsapp'`.
- Full `unit` project: 1460 passed / 8 intended failures (1 file). `tsc`
  (root + contracts + web), `prettier --check` clean; `eslint .` 0 errors
  (39 pre-existing warnings, none in the touched file).
- `groupChannel` is now part of the module's importable surface. It is
  **internal by contract**: only tests may import it (documented in the
  spec's docstring). Any future consumer should go through
  `runNotificationFanOut` / `resolveChannel`.
- No `unbound-method` relaxation is added or widened; the narrowed two-file
  exemption from PR #190 is untouched.

## Alternatives considered

- **Accept the gap** (attempt 1's recommendation). Rejected by the owner: the
  two-line fallback is exactly the kind of silent routing regression a pin
  should catch, and the seam cost is one keyword.
- **Relax `channelGroupSchema` so an enabled `mobile` group may omit
  `candidates`.** Rejected: a data-contract change with real routing
  consequences, in order to test a defensive branch.
- **`vi.mock` `notificationTypeSchema` to admit the input.** Rejected: it tests
  an internal collaborator instead of behaviour, and would be green — not a pin.
- **Export `processEvent`/`fanOutToRecipient` instead.** Rejected: far larger
  surface (needs `Db`, transport, recipient port) for the same single value.
