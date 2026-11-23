# ADR-0920 — OP-139 TEST: the U1 IST day-window pin corrected to the day the table, the day-key case and the fixtures already agreed on

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_17103f93` (OP-139 TEST, Low — the dispute handed back from the OP-139 GREEN
  `t_c414a059` / [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md) §9, reproduced
  independently by the round-1 review of PR [#780](https://github.com/yahodu/openpic-webapp/pull/780);
  this card also carries the merge of that PR, per the same review)
- **Branch:** `OP-139-task-analytics-rollup-red` — the lane's own branch and PR head; no new
  branch, no rebase, no force-push. **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_7da4009d`
  (this card's own dispatch worktree `.worktrees/t_17103f93` is not the one that holds the PR).
- **Touches:** one unit spec (`apps/web/src/test/unit/analytics-rollup-buckets.test.ts`: two
  literals in one case, plus a two-line comment naming the arithmetic), this record, its index
  row, the lane's `Next free` cell and one ledger paragraph. **No production code, no second
  spec, no factory, helper, fixture or contract document.**
- **ADR number:** `0920` — the OP-139 lane's own `Next free` cell inside its `0918`–`0937`
  block, advanced to `0921`. The sweep is §6.
- **Consumes:** [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md) §9 (the dispute and
  the measurement that raised it), [ADR-0918](ADR-0918-op139-analytics-rollup-jobs-red.md) A1
  (the day key is a calendar day, not a 24-hour instant span) and A2 (the window is half-open),
  contract §10.2.

## 1. Context — the pin was unsatisfiable in its own file

`apps/web/src/test/unit/analytics-rollup-buckets.test.ts`, case `"returns the half-open UTC
window of an IST day"`, asserted before this card:

```ts
const window = dayWindowUtc("2026-11-17", IST);
expect(window.start.toISOString()).toBe("2026-11-17T18:30:00.000Z");
expect(window.end.toISOString()).toBe("2026-11-18T18:30:00.000Z");
```

Three assertions in that one file cannot hold together for **any** implementation:

1. the IST table row at `:45` pins `dateKeyInTimeZone(new Date("2026-11-17T18:30:00.000Z"),
IST) === "2026-11-18"` — 18:30Z is IST midnight of the **next** day, and that row is the
   file's discriminator against a UTC bucket;
2. the case `"places the window's own day key on both ends' day"` (`:88`–`:96`) calls
   `dateKeyInTimeZone(window.start, IST)` on the **same** `window.start` and requires
   `"2026-11-17"`;
3. the disputed pair requires that same `window.start` to be `2026-11-17T18:30:00.000Z`.

So `dateKeyInTimeZone` would have to answer both `"2026-11-17"` and `"2026-11-18"` for one
instant. The table, the day-key case and the nine integration fixtures — whose activity constant
is `ACTIVITY_AT = new Date("2026-11-17T06:00:00.000Z")` in
`apps/web/src/test/factories/rollup-jobs.ts:23` — agree with the IST day-17 window and against
the pair. The pair was one UTC day late.

## 2. Measurement — the correct window, independently

An `Intl.DateTimeFormat` probe over `Asia/Kolkata` (a throwaway script under the profile scratch
directory, not committed):

```
2026-11-16T18:29:59.999Z -> 2026-11-16, 23:59:59
2026-11-16T18:30:00.000Z -> 2026-11-17, 00:00:00
2026-11-17T06:00:00.000Z -> 2026-11-17, 11:30:00
2026-11-17T18:29:59.999Z -> 2026-11-17, 23:59:59
2026-11-17T18:30:00.000Z -> 2026-11-18, 00:00:00
```

The IST day `2026-11-17` is therefore `[2026-11-16T18:30:00.000Z, 2026-11-17T18:30:00.000Z)`,
and `ACTIVITY_AT` sits inside it. The shipped `dateKeyInTimeZone` / `dayWindowUtc` in
`apps/web/src/server/jobs/analytics-rollup.ts` already answer exactly that pair, and the two
reviewers' failing output agrees on the received value:

```
AssertionError: expected '2026-11-16T18:30:00.000Z' to be '2026-11-17T18:30:00.000Z'
Test Files  1 failed (1)   Tests  1 failed | 10 passed (11)
```

## 3. Decision — correct the expectation, not the implementation

In that one case, `start` becomes `"2026-11-16T18:30:00.000Z"` and `end` becomes
`"2026-11-17T18:30:00.000Z"`. Every other line of the file — the six table rows, the
zone-argument case, the day-key case, the UTC window case — is byte-identical.

**One disclosed deviation from the review's instruction.** The review said "change only the two
literals, no other line". Two comment lines were added above them:

```ts
// IST midnight on the 17th is 18:30Z on the 16th: the window opens one UTC
// day earlier than the key reads, and ends at the 18th's IST midnight.
```

The reason is this card's own failure mode: the previous literals looked plausible precisely
because IST's midnight is _not_ the day key's own UTC date, and nothing in the file said so
where the numbers are read. A comment costs nothing at runtime, is in the file's own style (every
table row carries its rationale), and is the only thing that stops the next author "fixing" the
arithmetic back. Recorded here so the review can rule on it rather than discover it in the diff.

The pin stays load-bearing after the correction: it is the file's only direct assertion on the
window's two **UTC instants**, and it still reds a UTC-day window (`2026-11-17T00:00:00.000Z`), a
one-day-late window, and any implementation that closes the interval instead of opening it.

## 4. Why the test was wrong and the implementation right

The GREEN card was forbidden by the pipeline to edit a test, and it was correct not to: re-pinning
the product to answer the disputed pair would have written the wrong day's rows in production
(the row keyed `2026-11-17` would have covered IST 18 Nov), reddened the same file's day-key case
and all nine integration cases, and left `analytics-rollup` unable to satisfy its own red. The
defect is in the expectation, and only the expectation moved.

## 5. Evidence

Measured in the PR's worktree on the branch head, `pnpm`/`vitest` 5.0.3:

| Step          | Command                                                                             | Result                                                           |
| ------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| RED (before)  | `vitest run --project unit apps/web/src/test/unit/analytics-rollup-buckets.test.ts` | `1 failed \| 10 passed (11)` — the disputed case alone, at `:77` |
| GREEN (after) | same                                                                                | `11 passed (11)`                                                 |
| Whole project | `vitest run --project unit`                                                         | `193` files, `3233 passed \| 3 skipped (3236)`                   |

`tsc` is not separately required by this diff (no type surface moved), and the change is
`prettier`-formatted in the file's own shape. The seven `adr-*` guards run on this head with the new
record and its ledger rows — `7` files, `248 passed (248)` — `adr-numbering`, `adr-lane-ranges`,
`adr-record-links`, `adr-ledger-links`, `adr-inline-code-spans`, `adr-source-references`,
`adr-consumers`.

The PR carries the ADR-0318 merge gate (`G1`–`G6`) evaluated on the pushed head and pasted as a
comment; this record is committed **inside** the head it certifies, so it cannot quote that head's
own SHA or its check rollup. The gate's verdict and the squash SHA were unknown at this point; the
PR has since merged, and §9 records both.

## 6. Number allocation and sweep

Draws **`0920`**, the `OP-139 jobs & compliance lane` row's `Next free` cell (block `0918`–`0937`),
and advances that cell to **`0921`**. No other cell moves, no cell is lowered and no range is
re-cut; `unallocated (future lanes)` stays `0942` and the `OP-136 jobs lane` cell stays `0942`
(its `0938`–`0941` records sit outside this lane's block).

The sweep immediately before minting read four surfaces, because the pool cell moves
independently of this branch:

- `origin/main` (fetched at this run): highest records `ADR-0909` and the OP-136 lane's
  `ADR-0938`–`ADR-0941`; no `ADR-0910`–`ADR-0937`;
- every `.worktrees/*/docs/adr` tree present on this host, tracked and untracked: no
  `ADR-0920` path;
- the open PR heads — #780 (`a9d35355`, this branch, carries `0918`/`0919` only), #755
  (`c90ae3ba`), #743 (`40df0afd`), #272 (`d5be9af4`): no `0920` and no `09xx` source ADR on the
  three others;
- `git rev-list --objects --all -- docs/adr`: `ADR-0920` resolves in **no** object.

## 7. Alternatives rejected

1. **Make `dayWindowUtc` answer the disputed pair.** Rejected in §4: it writes the wrong day's
   rows and reds the nine integration cases.
2. **Delete the case.** Rejected: the file would keep no direct assertion on the window's UTC
   instants, which is the only place the `+05:30` shift is pinned as an instant rather than as a
   day key.
3. **`it.skip` / `it.todo` the case.** Rejected: a skipped pin is not a pin, and the file would
   report green while the window was unmeasured.
4. **Leave the pin and block the PR.** Rejected by the review: the dispute is decidable from the
   repository's own three surfaces (§1), and the trunk would stay red for every later PR.

## 8. Consequences and residuals

- The unit project is fully green on this head, so `ci`, `unit_test` and `test_coverage` can pass
  and PR #780 becomes mergeable.
- **Residual:** the IST window is pinned only against a fixed `+05:30` zone. No case exercises a
  DST zone, so a `dayWindowUtc` that assumed a constant offset would still pass. ADR-0918's A1
  records the assumption deliberately (the platform buckets every tenant in `Asia/Kolkata`), and
  the `UTC` case covers the zone-argument seam; a DST zone stays out of scope until a tenant can
  choose one.
- **Residual:** the two comment lines are the only prose this card adds to the spec, and they
  carry no assertion. If the review rejects them, deleting them is a no-op for every measurement
  in §5.

## 9. Landing

_Appended by card `t_264d5a4c` once PR [#780](https://github.com/yahodu/openpic-webapp/pull/780)
merged. §1–§4 and §6–§8 are unchanged, §5 gains the measured guard count and the pointer to this
section, no ADR number is consumed and `docs/adr/README.md` is untouched._

- **Squash.** PR [#780](https://github.com/yahodu/openpic-webapp/pull/780) squash-merged as
  **`b1cec73e163e6e5c97a2876d03f150741ba3c696`** at 2026-11-23T10:56:06Z, review head
  `b2f715798a3a42cd4c256b0fe76801d847ef0719`.
- **Gate on that head: `GATE: PASS`.** All 14 gating checks are `COMPLETED`/`SUCCESS`:
  - `ci`, `unit_test`, `test_coverage`, `lint`, `audit`, `audit-dev`, `secret-scan`, `env-changes`
  - `validate-branch-name`, `validate-pr-title`, both `Analyze (*)`, `CodeQL`, and
    `Assert CI evidence for the pushed head`

  `gh pr checks 780` reads 15 entries: those 14 plus the `notify-discord` close side effect. The
  gate output is pasted on the PR as
  [issuecomment-7098738297](https://github.com/yahodu/openpic-webapp/pull/780#issuecomment-7098738297).

- **Squash ↔ branch parity.** This diff is empty, so every reviewed byte is the byte the trunk
  carries:

  ```
  git diff b2f715798a3a42cd4c256b0fe76801d847ef0719 origin/main --
    apps/web/src/test/unit/analytics-rollup-buckets.test.ts
    docs/adr/ADR-0920-op139-u1-ist-day-window-correction.md docs/adr/README.md
  ```

  The branch tip is **not** an ancestor of `main`: a squash merge rewrites the commits, so the
  failed ancestor check is the expected result and not a regression.

- **Post-merge verification on `origin/main` `b1cec73e`.** The focused spec
  `apps/web/src/test/unit/analytics-rollup-buckets.test.ts` reads `11 passed (11)`; the whole `unit`
  project reads `193` files, `3233 passed | 3 skipped (3236)`.
