# ADR-0663 — OP-120 round-1 follow-up: the delivery-failure log record carries no link, token or destination

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-120 (Collaboration epic, phase 3 — Events & Collaboration)
- **Card:** `t_cd08dc0f` (tdd_stage TEST / one characterization pin, testcase-writer)
- **Branch:** `OP-120-task-delivery-failure-log-pin` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_defedc69`, off `origin/main` `f0f85e9`,
  the OP-120 gap-pins squash-merge — tree-identical to the reviewed head `4349d84`)
- **Range:** `0660`–`0679` (lane block). This record consumes `0663`, the cell's
  value re-read at the branch head immediately before pushing; the cell advances
  to `0664`.
- **Consumes:** [ADR-0662](ADR-0662-op120-gap-pins.md) (the round-1 gap pins,
  whose F2 left this adjacent branch unpinned). This record **adds no new
  contract**: it pins behaviour the trunk already ships.

## Context

ADR-0662's F2 pins watch the logger for the create and the preview. The round-1
review then observed the one invitation surface still unobserved:
`sendInvite`'s `catch` in
`apps/web/src/server/collaboration/invitation-delivery.ts`, which emits the
operator-visible record `collab.invite.delivery_failed`
(`event`, `invitationId`, `channel`, `reason`). It runs **inside** the create
path, so it is part of what F2 promises to guard, but no case ever reaches it:
the configured transport in `test` is the in-memory outbox, whose `send` always
resolves.

The hazard is a future edit, not a present leak. `InviteDeliveryInput` already
carries `inviteUrl`, `email` and `sms`, so the natural debugging move —
`inviteUrl: input.inviteUrl` or `destination` on that record — would have passed
every assertion in `event-invitations.test.ts`: `deliverInvite` swallows the
failure, the create still answers `201`, and no shipped scanner observes the
logger.

## Decision

**One case appended** to the existing
`F2 — the invitation surface never logs a token-bearing value` describe in
`apps/web/src/test/integration/event-invitations.test.ts`. The 34 shipped cases
are untouched (the diff is 45 insertions and 1 deletion, and the deletion is the
`vitest` import line gaining `vi`).

### D1 — The failing channel is forced at the transport selector, not by a module mock

`vi.spyOn(await import("@/server/services/notification-transport"),
"getNotificationTransport").mockReturnValue(failingTransport)` where
`failingTransport: MessageTransport = { send: () => Promise.reject(new
Error("smtp unavailable")) }`. The spy is installed per case and restored in a
`.finally()` on the request promise, so the harness's own drain
(`settleInviteDelivery()` → `runNotificationFanOut`) that recovers the raw token
still sees the real memory outbox. A file-scope `vi.mock` is rejected by the
card and would poison the other cases, which depend on that outbox.

The seam works because Vite's SSR transform rewrites
`invitation-delivery.ts`'s `import { getNotificationTransport }` into a property
read on the module namespace at each call site, so replacing the namespace's
export is observed by the production module without any production change. That
is also why no seam had to be added to the source (the card's stop condition was
not met).

### D2 — The case pins the create contract, the liveness and four negatives

1. Arrange — `captureLogs()`, a workspace, an event and the organizer's
   membership (`seedWorkspace`/`seedEvent`/`addEventMember`), invitee
   `buck@example.com`.
2. Act — **one** `POST …/invitations` whose only delivery leg (email) rejects.
3. Assert `201`: a delivery failure never fails the create, because the
   invitation row is already durable.
4. Assert **liveness** —
   `sink.entries` contains an entry with `event ===
"collab.invite.delivery_failed"`. Without it the negatives could pass because
   nothing was observed. The raw token is recovered through the file's existing
   `tokenForHash(stored.tokenHash)`, i.e. from the rendered message, never from
   the response or the row.
5. Assert the negatives over `recordTexts(sink)` (every captured record,
   JSON-stringified, so no field can hide a leak): no record contains the raw
   token, the string `/invitations/${token}`, `sha256Hex(token)` or the raw
   invitee address.

### D3 — The `destination` half of the card's expected RED cannot fire, and that is the redaction port, not a hole

The card expected a probe adding `destination` to the record to turn the pin
RED. It does not, and the probe proves why: the appended key reaches the record
but `@/server/logging/redaction` masks contact-shaped **values in any string
field** (`VALUE_PATTERNS`: email, E.164, `Bearer`, `opat_`) before any transport
sees the entry. The record under that mutation reads

```
{"event":"collab.invite.delivery_failed","invitationId":"6af4afb9…","channel":"email",
 "destination":"[REDACTED]","reason":"Error","msg":"invitation delivery failed","level":"error"}
```

so the pin is honest and green, and the raw address cannot reach a transport
even if the record names it. Tokens are **not** masked (a base64url run is not
email/phone/`Bearer`/`opat_`-shaped), which is exactly why the token-bearing
negative — the one this pin exists for — does bite (Evidence). The address
negative stays as a backstop for a caller that bypasses the port; it is
documented as defence-in-depth rather than claimed as mutation-detectable.

## Evidence (mutation probes in a throwaway worktree, each restored byte-identically)

The probe worktree was `git worktree add --detach …/scratch/probe-e962600
e962600` (the pin's commit) with `node_modules`, `apps/web/node_modules` and
`packages/contracts/node_modules` symlinked to the lane worktree. Both mutations
were applied to `invitation-delivery.ts`'s `collab.invite.delivery_failed`
record, run, and reverted; the file's sha256 is
`9f1caa661514654457a1ddec304e0d1b5ebf9bcd805358d6aa7fb4a1c0e19703` before and
after, and `git diff --stat` on it is empty after each run.

| Probe                                     | Mutation                                           | Observed                                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| full file, mutation `a`                   | `inviteUrl: input.inviteUrl` on the failure record | `AssertionError: expected [ Array(1) ] to deeply equal []` at `event-invitations.test.ts:1374:64` (the raw-token negative); `Tests 1 failed \| 34 passed (35)` — every other case stays green |
| focused, mutation `a`                     | same                                               | `Tests 1 failed \| 34 skipped (35)`, exit `1`                                                                                                                                                 |
| focused, mutation `b`                     | `destination,` on the failure record               | `Tests 1 passed \| 34 skipped (35)`, exit `0` — D3: the port masked it                                                                                                                        |
| focused, mutation `b` + a temporary throw | same, plus the record thrown into the message      | the record carries `destination: "[REDACTED]"` (quoted in D3)                                                                                                                                 |
| unmutated probe worktree                  | none                                               | `Tests 35 passed (35)` — the pin is green on arrival on this head                                                                                                                             |

## Assumptions

- **A1** — installing the process logger (`setLogger`) and forcing the transport
  selector (`vi.spyOn` on the module namespace) are the sanctioned test seams;
  neither needs a production change, and both are undone per case (`mockRestore`
  in `.finally()`, logger restored by the describe's existing `afterAll`).
- **A2** — "the record reached the sink" is asserted on the record's `event`
  field, matching the shape F2's create case already uses; the field set of the
  record is deliberately not asserted, so an operator may add a
  non-identifying field (a retry count, a classified code) without failing a
  behaviour that is still safe.
- **A3** — one channel is enough (the card's own allowance): the invitee is an
  email invitee, so `deliverInvite` makes exactly one send attempt. A
  phone-invitee variant was **not** added — the case carries no phone contact,
  so a "no raw E.164" assertion in it would be vacuous, and the token/link
  negatives are channel-independent.
- **A4** — the unit project is untouched by this change (the `unit` project's
  include set excludes `**/test/integration/**`), so its count is unchanged.

## Consequences

- The invitation spec now runs **35** integration cases (34 shipped + 1
  appended); the unit project is untouched.
- `deliverInvite`'s failure branch is observed for the first time, and a future
  edit that puts the link (or the token) on that record fails loudly with
  `expected [ Array(1) ] to deeply equal []`.
- The redaction port is what stops a contact-shaped value on that record; this
  ADR records that so a later reader does not mistake the pin's silence on a
  `destination` mutation for an uncovered surface.
- `docs/adr/README.md` is the shared-ledger hotspot: this record adds one index
  row (≤ 116 characters, far inside the `0420`+ table's existing 655-wide Title
  cell, so Prettier does not re-pad the table), advances the lane's `Next free`
  cell to `0664`, and appends one lane note. A merge conflict there resolves as
  a **union keeping the highest values**.

## Alternatives

- **`vi.mock("@/server/services/notification-transport")` at file scope** —
  rejected by the card and by necessity: every other case in the file drains the
  outbox through that exact selector.
- **Spy on `MessageTransport.prototype.send`** — rejected: `MessageTransport` is
  an interface, and `getMessageTransport()` mints a fresh memory transport per
  call, so the route's instance is not reachable from the spec.
- **Reaching `deliverInvite` directly instead of through the route** — rejected:
  the property under test is the create's behaviour (`201` stands, the failure
  is recorded), which only the route can demonstrate.
- **Asserting the record's exact field set** — rejected (A2): it would fail a
  safe future addition without pinning anything the contract promises.
