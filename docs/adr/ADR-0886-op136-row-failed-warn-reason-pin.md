# ADR-0886 — OP-136 TEST: the contained-row warn carries the failure reason through the real logger

- **Status:** Accepted (RED pin + GREEN mandate — the case is red at the trunk and
  the spec is carried forward to a one-word GREEN, so the PR is a **draft**,
  OP-93 / [ADR-0306](ADR-0306-op101-stale-branch-deletion.md))
- **Card:** OP-136 TEST `t_3b30fc42` (Medium; finding **F1** of the landing review
  of PR [#741](https://github.com/yahodu/openpic-webapp/pull/741), card
  `t_05687f95`, squash `b3f63308`). Branch
  `OP-136-task-row-failed-warn-reason-pin`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from `origin/main`
  `efa034ff`.
- **Implements:** nothing. This record changes **no** production file: it pins a
  property the trunk does not have and hands the fix to a GREEN card.
- **Consumes:** [ADR-0872](ADR-0872-op136-poison-row-containment-green.md) §1 (a
  row's own arm failure is contained, counted and named at `warn`, and the
  sentence "the field that carries the thrown error is `error`; the pins fix the
  event name and the id, not that key") and its Consequences bullet "the warn's
  field name for the thrown error stays unpinned",
  [ADR-0871](ADR-0871-op136-poison-row-containment-pins.md) §1 item 4 (`I27`
  asserts the warn's event name and id — and projects the error itself),
  [ADR-0867](ADR-0867-op136-indexed-check-stamp-triple-after-arm.md) §1 and
  [ADR-0866](ADR-0866-op136-indexed-check-arm-retry-and-backpressure-pins.md) §1
  (the row-retry state this case leaves untouched), the logging port's own
  contract (`apps/web/src/server/logging/types.ts`: `err` is the documented error
  key, `LogField.err`), and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 items 18–21 (an
  exhausted lane block keeps its range and draws from the pool, advancing both
  cells).
- **Consumers:** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`.
- **Findings:** **F1** (Medium, diagnostics / operator signal) of the landing
  review of `t_05687f95`.
- **Number allocation:** `0886`, a **pool draw**. The OP-136 lane block
  `0849`–`0868` is exhausted, and both `Next free` cells read `0886` at
  `efa034ff` — the value [ADR-0885](ADR-0885-op136-requeue-warn-request-scoped-logger.md)
  wrote when it advanced them from `0883`. The sweep immediately before minting
  found: the trunk's highest record is `0885`; the highest record anywhere is
  `0885` as well (`.worktrees/t_0924f321`, merged as `8b2a7f2c`); and the open PR
  heads hold `0884` (PR [#749](https://github.com/yahodu/openpic-webapp/pull/749),
  the same file's `I30` sibling pin, whose record is lower than this one) and
  `0306` / `0881` on the two stale lanes (PR #272, #743). No `ADR-0886*` file or
  object exists on the trunk, in any `.worktrees/*/docs/adr` tree or on any open
  PR head. So this record takes the highest in-flight number plus one and
  advances **both** the `OP-136 jobs lane` cell and the `unallocated (future
lanes)` cursor to `0887`. No range is re-cut (§11 item 21) and no other cell is
  touched.

## Context — the warn's reason never reaches a transport

ADR-0872 §1 records what an operator is owed when one candidate row's own OP-126
batch arm throws: the run keeps going, the row is counted in `errors`, and it is
named once, at `warn`, by its event id. The shipped call site in
`apps/web/src/server/jobs/pipeline-indexed-check.ts` is

```ts
logger.warn("pipeline indexed row check failed", {
  event: "pipeline.indexed_check.row_failed",
  eventId: row._id.toHexString(),
  error: outcome.reason,
});
```

The key is `error`. The logging port serializes **one** key:
`apps/web/src/server/logging/index.ts` does
`if (merged.err !== undefined) merged.err = serializeError(merged.err, config.env);`,
and `apps/web/src/server/logging/types.ts` documents `err` as the canonical error
field (`SerializedError`, `LogEntry.err`). Every other key travels through
`redactEntry`, which returns a non-plain object such as an `Error` unchanged, so
the entry a transport receives holds an `Error` instance where a JSON document
needs one. Measured at `b3f63308` through
`createLogger({ level: "warn", env: "production", transports: [capturingTransport] })`:

| field written | value                                                 | what the transport receives                                                       |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `error:`      | `new Error("injected failure: find on event_images")` | `{}` — `name`, `message` and `stack` all dropped                                  |
| `error:`      | the same error with an own `code: 91`                 | `{"code":91}` — message and stack dropped                                         |
| `err:`        | the same error                                        | `{"name":"Error","message":"injected failure: find on event_images","stack":"…"}` |

So the operator's only per-row signal names the event and not the reason it
failed — the diagnostic ADR-0872 §1 says the line carries. `I26` cannot see it:
it asserts the envelope, not the line. `I27` cannot see it either, and that is
the defect this record closes: `I27` reads the **recording** logger, which keeps
the call-site fields object as it was written, and then re-serializes it with a
replacer of its own —

```ts
const carried = JSON.stringify(named[0]?.fields ?? {}, (_key, value: unknown) =>
  value instanceof Error ? value.message : value
);
```

— a projection that no transport performs. `I27` therefore passes on the trunk
while every real transport writes a line with no reason in it. That is a pin
that asserts a projection only the spec produces, which is the failure mode
ADR-0860 §4 names.

## Decision

### 1. The pin asserts the message on the wire, not the field name

One case is appended in a new block at the end of
`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` (+168/−0: the
new block, its three helpers and one import line; the 30 delivered cases and every
existing helper, fixture and constant stay byte-identical):

- **Block:** `describe("pipeline-indexed-check: the contained-row warn carries the failure reason on the wire")`
- **Case:** `I31: the warn the transport receives carries the failure reason, not only the event id`

It seeds **one** `indexed` candidate of `I26`'s shape (a clean event with a
two-file batch the worker already settled), arms `failFindWhen` on that event's
`event_images` reads, and runs the job **through the real port** — a capturing
`LogTransport` and `createLogger({ level: "warn", env: "test", transports: [transport] })`
— then JSON round-trips every captured entry so the assertions read the **wire
shape**, not the in-memory object. It asserts: the injection fired; the run
resolved with `errors: 1` and `scanned: 1` (the control `I26`/`I27` already
carry); exactly one entry with `event: "pipeline.indexed_check.row_failed"`; that
entry's `level` is `warn`; its `eventId` is the poison event's id; and the thrown
error's **message text is present** in the serialized entry.

The message, not the key. The requirement in F1 is that the reason survives the
logging port; the key that makes it survive is the **port's** contract
(`err`), and a job-level spec that hard-codes `err` would pin an implementation
detail of a module this file does not own. Choosing the message keeps the pin
honest under a legitimate change of carrier, and it is the shape the card
mandates. The cost is recorded, not hidden: see §3.

### 2. The GREEN is one word, and the record it amends is named

`error:` → `err:` in that one `logger.warn` call, no other change:
`serializeError` then produces `{ name, message, stack }` (stack in production
only for a 5xx), and the entry the transport stores carries the message.
[ADR-0872](ADR-0872-op136-poison-row-containment-green.md) §1's code block and its
Consequences bullet "the warn's field name for the thrown error stays unpinned"
are corrected by the GREEN to match, with a note that the field is a **wire
property** of the log line rather than a cosmetic name — ADR-0872 itself is
frozen and is amended in place only where that bullet is now inaccurate.

Nothing else in the tree reads the `error` key of this line, measured before the
rename is handed over: `grep -rn "row_failed"` matches the call site and five ADR
prose lines only, and `grep -rn "pipeline indexed row check failed"` matches the
call site alone — no route, job, test, dashboard or fixture consumes the key, so
the rename is invisible to every consumer but a transport.

### 3. What the pin deliberately does not fix, and the arm that proves it

The pin is a **property** pin: it accepts any carrier whose serialized form keeps
the message. Measured at the pin head, with the production file restored
byte-identically after each arm:

| arm                           | change to `pipeline-indexed-check.ts` | `I31`                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 (the shipped shape)        | none — `error: outcome.reason`        | **`1 failed`** — `expected '{"env":"test","event":"pipeline.indexed_check.row_failed","eventId":"…","error":{"code":91},"ts":"…","level":"warn","msg":"pipeline indexed row check failed"}' to contain 'injected failure: find on event_images'` |
| M1 (the GREEN)                | `error:` → `err:`                     | `1 passed`                                                                                                                                                                                                                                       |
| M2 (a hand-rolled projection) | `error: String(outcome.reason)`       | `1 passed`                                                                                                                                                                                                                                       |

M2 is the accepted residual: a future call site that stringifies the reason into
an undocumented key also satisfies the operator's need (the message is in the
line) and also passes this case, while losing `name` and `stack`. Pinning `err`
would forbid M2 but would freeze the job against the port's own key choice; the
port's key is pinned where it belongs, by
`apps/web/src/server/logging/serialize-error.test.ts`. The card's GREEN is
`err:`, because it is the documented field and it also carries the stack.

The rest of the block is unchanged by design: this case runs one row and pins one
line, so it says nothing about the page size, the chunking, the announcement
order or the retry state — `I26`, `I28`, `I29` and `I30` own those.

### 4. The suite's other cases carry over byte-identically

The diff's test side is additions only. At the pin head the file reports
`1 failed | 30 passed (31)`: `I31` alone is red, at an assertion on the wire
entry, and the 30 delivered cases (`I1`–`I30`) keep their behaviour — the
containment envelope, the warn's event name and id, the retry and stamp shape,
the clean-page control and the discovery abort.

## Consequences

- An operator reading the row-failed line gets the reason the row failed —
  `{ name, message, stack }` under the port's documented key — instead of a line
  that names the event and then drops the error body.
- `I27` stays as delivered and remains green: it pins the event name, the id and
  that _some_ projection of the fields carries the message. `I31` is the case that
  can see the wire, so the two together pin naming **and** reason.
- The pin is red at the trunk until the GREEN lands, so the branch is a draft and
  is never squash-merged (OP-93 / [ADR-0306](ADR-0306-op101-stale-branch-deletion.md)).
- Known limit, measured (§3): the pin does not enshrine `err`. A hand-rolled
  string projection passes it while dropping `name`/`stack`; the documented-key
  requirement is stated by the GREEN, not enforced here.
- Hotspot: `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
  carries an in-flight appended case on PR
  [#749](https://github.com/yahodu/openpic-webapp/pull/749) (the multi-row
  containment sibling pin), and that case is
  `I31: every failing row is counted and named, including two in one chunk` — not
  `I30`, as an earlier draft of this paragraph said: `I30` is already a **trunk**
  case, [ADR-0883](ADR-0883-op136-discovery-abort-pin.md)'s discovery abort, so
  the contested id is this pin's own `I31`. Both branches append at the file's end,
  so the merge is a union of two appended blocks and no existing byte is contested.
- The rule for that merge: **whichever of PR #749 and this GREEN lands second
  renumbers its own case id** to the next free one, changing only the case title
  string and every mention of the id in its own record — no assertion, matcher,
  helper or fixture moves. Re-sweep with
  `grep -oE 'it\("I[0-9]+' <spec> | sort | uniq -c | awk '$1>1'` before either
  merge; it must print nothing.

## Alternatives

- **Pin the key `err` in the case.** Rejected in §1: it would pin a module this
  spec does not own and would red a legitimate change of carrier. The port's own
  unit spec already pins the key.
- **Assert only that the entry's error value is non-empty (`toEqual({})` inverse).**
  Rejected: it is satisfied by a `code: 91`-only projection that still tells an
  operator nothing about _why_; the message text is the observable F1 names.
- **Assert on the recording logger with a serializing replacer** (i.e. repair
  `I27`). Rejected: the recording helper is the thing that hid the defect. The
  case must be run through the real port or the pin proves the spec's own
  projection again.
- **Leave the field to prose and fix nothing.** Rejected: the trunk's only
  per-row diagnostic silently loses its reason, and ADR-0872 §1's Consequences
  bullet already recorded the key as unpinned — the gap F1 measured.

## Evidence at the pin head

- Focused spec: `1 failed | 30 passed (31)` — `I31` alone, `AssertionError: the
row-failed warn must reach the transport carrying the thrown error's message, or
an operator cannot tell why the event failed: expected '{"env":"test",…}' to
contain 'injected failure: find on event_images'`, received
  `{"env":"test","event":"pipeline.indexed_check.row_failed","eventId":"6b0013f3…","error":{"code":91},"ts":"…","level":"warn","msg":"pipeline indexed row check failed"}`
  — the field arrived as `{"code":91}`, the message gone.
- The switch case `-t "I31"`: `1 failed | 30 skipped (31)` at the pin head;
  `1 passed | 30 skipped (31)` under M1 and under M2 (§3).
- Production file restored byte-identically after every arm:
  `sha256 fa4f0b917976721090e799b582fc52b754a028e7f90d5afcdceb7cdac39a72b4`,
  `git status --short` naming only the spec.
- CI at the pushed head `7d0af839` (PR
  [#751](https://github.com/yahodu/openpic-webapp/pull/751), **draft**):
  `unit_test` pass (46 s), `lint` pass (2 m 2 s), `audit`, `audit-dev`,
  `secret-scan`, `env-changes`, `validate-branch-name`, `validate-pr-title`,
  `Analyze (javascript-typescript)` and `Assert CI evidence for the pushed head`
  pass. `ci` and `test_coverage` **fail by design**: the `ci` job's integration run
  reports `1 failed | 148 passed (149)` and the one failure is `I31` with the
  assertion above, and `test_coverage` exits on that same case. A RED-by-design
  draft (OP-93 / [ADR-0306](ADR-0306-op101-stale-branch-deletion.md)) is never
  squash-merged; the GREEN lands the one-word fix and both jobs go green with the
  case carried byte-identically.
