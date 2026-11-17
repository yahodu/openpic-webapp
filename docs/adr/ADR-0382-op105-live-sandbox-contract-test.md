# ADR-0382 — OP-105 follow-up TEST: the `CASHFREE_LIVE_TEST=1`-gated live Cashfree sandbox contract test

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up TEST (`t_0998dd27`) · **Branch:** `OP-105-task-live-sandbox-contract-test` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_0998dd27`
- **Relates to:** [ADR-0001](ADR-0001-ports-and-adapters.md) (ports and adapters, provider neutrality), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the RED contract — its **Out of scope** list named this test), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the GREEN — its **Coverage gaps handed to the Test Author** names it again), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.2 / §3.3 (`checkoutUrl` is opaque; no request or response field is named after a payment vendor), §10.1.1 (provider status strings never leave the adapter), §14.3 (`status` / `mandateStatus` value sets), §11.1 (`externalRefs`) · **Conventions:** §5.3 (the redaction list)

## Context

OP-105 ships the payment port and the Cashfree adapter
([ADR-0380](ADR-0380-op105-payment-provider-port-red.md) /
[ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md)). Every
existing spec for that adapter drives it through **MSW**, against payloads we
wrote ourselves from the vendor documentation — so the suite can prove the
adapter is self-consistent, and cannot notice Cashfree renaming a field, dropping
one the pinned schemas require, or answering a status string outside the
twelve-row table. That gap is exactly what a live contract test is for.

ADR-0380 declared the test out of scope and ADR-0381 listed it in its coverage
gaps; no card on the board owned it, so the orchestrator card `t_d4deaa7a`
created this one (test-only, new lane). The deliverable is the test itself: the
adapter already exists and is on `main`, so there is no GREEN sibling to gate.

## Decision

### 1. Where it lives and how it is gated

`apps/web/src/test/unit/payments-cashfree-live-sandbox.test.ts`, in the
**`unit`** Vitest project — not `integration`, whose `globalSetup` boots a
`MongoMemoryReplSet`. The live suite needs no database, and making an unrelated
infrastructure requirement (and a Mongo binary download) a precondition for a
suite that is skipped anyway would be the fastest way to make `vitest run`
red in an environment that has nothing to do with this card.

The whole live suite is wrapped in `describe.skipIf(!LIVE_REQUESTED)`, where
`LIVE_REQUESTED = isLiveSandboxEnabled(process.env)`. The predicate is
`env.CASHFREE_LIVE_TEST === "1"` — **exact**, so a stray `true`, `yes` or
`1 ` can never start network traffic in CI. A skipped Vitest suite executes
neither its hooks nor its test bodies, and the file's only module-scope work is
that boolean — so with the gate unset `vitest run` is green and **no** fetch is
issued (verified: the file reports as skipped).

### 2. Fail closed, not fail quiet

`resolveLiveSandboxCredentials(env)` throws when a required variable is unset,
empty or whitespace-only, and its message **names every missing variable** and
restates the gate. A requested live run that silently skips is worse than no live
run at all: the operator believes the contract was checked.

The guard takes the environment as an argument instead of reading `process.env`,
so its own contract is exercised on **every** CI run, inside a second `describe`
that is deliberately **not** gated. Without that, the fail-closed requirement
would be the only part of this card that nothing ever executes.

Required variables — the card's three, plus one decision:

| Variable                  | Why                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CASHFREE_CLIENT_ID`      | sent as `x-client-id`                                                                                                                                            |
| `CASHFREE_CLIENT_SECRET`  | sent as `x-client-secret`; must never reach a log line                                                                                                           |
| `CASHFREE_WEBHOOK_SECRET` | the HMAC key `verifyWebhook` uses; must never reach a log line                                                                                                   |
| `CASHFREE_LIVE_PLAN_ID`   | **this ADR's decision** — `createMandate` must address a plan that exists in the sandbox account, and a vendor-side plan id is configuration, not a test fixture |

### 3. What the live run asserts

One round trip — `createMandate` then `fetchStatus` on the ref it returned —
against `https://sandbox.cashfree.com`, with the provider built from
`{ env: "sandbox", apiVersion: "2025-01-01", … }` (the pinned `x-api-version` of
ADR-0380 §5) and a memory-transport logger. Three independent pins:

1. **`createMandate` projects onto the pinned neutral shape.** The result's key
   set is exactly `["checkoutUrl", "expiresAt", "externalRefs"]`; there is
   exactly one ref and it equals `{provider: "cashfree", env: "sandbox",
kind: "subscription", id: <non-empty>}`; `checkoutUrl` is an `https://` URL;
   `expiresAt` is a non-empty string.
2. **`fetchStatus` projects onto `{status, mandateStatus}`.** The result's key
   set is exactly `["mandateStatus", "status"]` and both values are members of
   the §14.3 sets.
3. **No secret, signature or raw payload is logged.** The memory transport
   captured at least one entry (so the assertion is not vacuous),
   `expectNoSecretsInLogs` passes, and the serialized entries contain neither the
   client id, the client secret nor the webhook secret.

**Reading of §3.2 "no vendor field" (an interpretation this card had to make).**
The rule is about **field names**, not values: §3.3 says "no request or response
field is named after a payment vendor", while §11.1 _requires_
`externalRefs[].provider === "cashfree"` and the sandbox `checkoutUrl` legitimately
lives on a Cashfree-hosted domain. The pin is therefore "no key outside the
pinned neutral set" — asserting the absence of the _string_ `cashfree` anywhere
in the result would contradict §11.1 and fail on the hosted authorization URL.

### 4. What this test deliberately does not pin

- **`expiresAt`'s format.** ADR-0380/0381 pin only that it is "the vendor's
  expiry"; the live spec asserts a non-empty string. Whether the adapter should
  normalize it to ISO 8601 rather than pass the vendor's
  `subscription_expiry_time` through is **open** (flagged in the handoff).
- **The outgoing headers** (`x-api-version`, `x-client-id`, `x-idempotency-key`).
  Already pinned without network by I1/I5 of the MSW spec; the live spec does not
  wrap `globalThis.fetch` to re-assert them, because a global monkey-patch inside
  a live suite is a failure mode of its own and buys nothing.
- **`paymentMethodKind`'s wire mapping** — ADR-0381 §6's gap, routed by the
  orchestrator to `t_9f1dd822` → `t_27873de6`. The live spec sends
  `mandate_upi` because the port requires a value, and asserts nothing about how
  it travels.
- **Cleanup.** Each run creates a real sandbox subscription and does not cancel
  it: `cancelMandate` is not implemented (ADR-0380 §5) and is out of scope here.
- **CI wiring.** The suite must never run in CI; no workflow is touched and no
  credential is ever committed.

## Consequences

- `pnpm test:unit` stays green with the gate unset, and the new file reports
  `3 skipped` — no network I/O, no new CI dependency, no gate weakened.
- The gate's own contract (`isLiveSandboxEnabled`,
  `resolveLiveSandboxCredentials`) is covered on every CI run: 11 executed
  assertions, including the four per-variable "missing" and "whitespace-only"
  cases and the exact fail-closed message.
- An operator can run the live contract deliberately:

  ```bash
  CASHFREE_LIVE_TEST=1 \
  CASHFREE_CLIENT_ID=… CASHFREE_CLIENT_SECRET=… \
  CASHFREE_WEBHOOK_SECRET=… CASHFREE_LIVE_PLAN_ID=… \
  pnpm vitest run --project unit apps/web/src/test/unit/payments-cashfree-live-sandbox.test.ts
  ```

- **Follow-up outside this card:** `.env.example` documents no `CASHFREE_*`
  variable at all (only `PAYMENT_PROVIDER=memory`), so the four names live in the
  spec docstring and this ADR alone. Documenting them is a config/docs change,
  and this card is test-only.
- The new `src/test/helpers/cashfree-live-sandbox.ts` guard adds three
  `security/detect-object-injection` **warnings** (not errors) for reading a
  named env var — the same class of false positive the existing
  `test/helpers/*.ts` files already carry (23 pre-existing in that directory).
- No production file, gate, workflow or fixture is modified.

### ADR-number allocation

`0382` is the next unused number in the **OP-105 payments adapter lane**'s
reserved range `0380`–`0399` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md));
`0380` is consumed by ADR-0380 and `0381` by ADR-0381, and
`docs/adr/README.md`'s lane cell read `0382` on the branch cut (`origin/main`
`2baaf14`). The cell advances to `0383`. No number outside the lane's range is
touched.

## Alternatives considered

- **Gate with a dedicated Vitest project (`--project live`).** Rejected: it needs
  a `vitest.config.ts` edit (outside a test-only card), and the ledger's plain
  `vitest run` would still have to skip the suite somehow — `skipIf` does that in
  one line.
- **Throw from module scope when the gate is on and a credential is missing.**
  Rejected: evaluated at collection, so it either fires when the gate is _off_ or
  needs the same conditional it was meant to avoid, and Vitest reports it as an
  import error rather than a named suite failure.
- **Assert no `cashfree` string anywhere in a response.** Rejected: contradicts
  §11.1's `provider` key and the vendor-hosted `checkoutUrl`; §3.2 forbids
  vendor-named _fields_.
- **Wrap `fetch` to assert the live request's headers.** Rejected: already pinned
  live-lessly by I1/I5, and a global patch inside a live run can itself fail for
  the wrong reason.
- **Skip the whole file with `describe.skip` and no guard.** Rejected: it makes a
  requested live run silently skip.

## Review sign-off — 2026-10-25 (card `t_0998dd27`, round 1 · artifact lens)

The round-1 (**artifact-lens**) review of the OP-105 follow-up TEST
(`t_0998dd27`) returned **APPROVED** — zero changes requested, **zero reviewer
edits to the deliverable**. PR
[#295](https://github.com/yahodu/openpic-webapp/pull/295) (head `54cc96a`) was
squash-merged as `a27f360`, and the merged tree is identical to the reviewed head
(`git diff --stat 54cc96a a27f360` empty), so the trunk carries the reviewed
bytes.

- **Criterion 1 — the gate is exact and offline.** The focused `unit` spec
  (`payments-cashfree-live-sandbox.test.ts`) reports `1 passed (1)` file and
  `11 passed | 3 skipped (14)`, the three live tests reporting as **skipped**;
  with the variable unset no network I/O is issued. Gate exactness was probed
  independently at suite level: `CASHFREE_LIVE_TEST=true` and
  `CASHFREE_LIVE_TEST=""` both stay green and skipped, so only the exact value
  `1` starts the run.
- **Criterion 2 — fail closed.** `CASHFREE_LIVE_TEST=1` with no `CASHFREE_*` in
  the environment **fails** the suite with:

  ```text
  CASHFREE_LIVE_TEST=1 requested a live Cashfree sandbox run but CASHFREE_CLIENT_ID,
  CASHFREE_CLIENT_SECRET, CASHFREE_WEBHOOK_SECRET, CASHFREE_LIVE_PLAN_ID are unset.
  Refusing to run a partial live contract test.
  ```

  thrown in `beforeAll` before any provider is constructed.

- **Criterion 3 — the round trip against the sandbox on the neutral shapes.**
  Reviewed **by construction** against the merged port and adapter
  (`payment-provider.ts`, `cashfree-provider.ts:429-482`, `refFor` at `:323`):
  the exact key sets `["checkoutUrl", "expiresAt", "externalRefs"]` and
  `["mandateStatus", "status"]`, `env: "sandbox"`, and the pinned
  `x-api-version 2025-01-01`. **Not executed** — no Cashfree sandbox credentials
  were available to the reviewer.
- **Criterion 4 — no secret, signature or raw payload logged (§5.3).** The
  memory transport is non-vacuous (`entries.length > 0`), `expectNoSecretsInLogs`
  passes, and the serialized entries contain none of the three secrets.
- **Criterion 5 — no gate weakened, no production conditional.** The diff is
  exactly **4 files**, of which **0 are production files**.

**Repo gates reproduced at the reviewed head:** full unit `105 files / 1811
passed | 3 skipped`; integration `73 files / 521 passed`
(`TMPDIR=/root/tmp-mongo`); `tsc -p apps/web/tsconfig.json` exit `0`; `eslint` 0
errors (3 `security/detect-object-injection` warnings, a pre-existing class);
`prettier --check` clean on the four files; the `adr-numbering` guard 29/29;
`gh pr checks 295` green except `audit-dev`, which is `continue-on-error: true`
(ADR-0301).

### Findings carried out of the review

These findings are **beyond this card's pinned acceptance criteria**: the card is
test-only, so it cannot own an adapter change or `/.env.example`. They are
**routed, not fixed here**, and are cited by card id and PR number on purpose —
an ADR number belonging to a still-unmerged follow-up is unstable.

- **F1 (Medium) — `createMandate().expiresAt` has no pinned format.** The
  adapter passes the vendor's `subscription_expiry_time` through
  (`cashfree-provider.ts:458`) while contract §3.3 line 1088 shows
  `"2026-09-25T10:14:00.000Z"` and §0.13 line 360 requires RFC 3339 UTC
  millisecond precision with a `Z` suffix. Routed to card `t_d32c89cf`
  (ORCHESTRATE/DECISION, created out of review `t_0998dd27`): the vendor's
  timezone has to be decided before a pin can be written.
- **F2 (Low) — `.env.example:95` documents none of the four `CASHFREE_*` names.**
  Folded into `t_d32c89cf`.

**Info (recorded, no card):** a live run leaves its sandbox subscription
uncancelled (`cancelMandate` is deliberately not on the port, ADR-0380 §5); the
three lint warnings above are a pre-existing class; and this record's "11
executed assertions" (§Consequences) reads as 11 executed **tests**.

Nothing in §Context–§Alternatives above is retracted: the delivered test was
found correct as pinned, and the sign-off only records that — anything F1/F2
imply lands through their own cards, not by editing this record. F1 and F2 remain
open and owned by `t_d32c89cf`; neither is a defect in this record's deliverable.
