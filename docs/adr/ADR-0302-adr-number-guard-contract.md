# ADR-0302 — The `docs/adr/` number guard: its mechanical contract and its deliberate scope boundary

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 follow-up (process/ADR) — record the ADR-number guard's contract and scope boundary (`t_2ae626e9`, orchestrator; raised by the review of `t_8675b675`, OP-96 R-1, PR [#229](https://github.com/yahodu/openpic-webapp/pull/229))
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the policy this guard is the mechanical backstop for), [ADR-0128](ADR-0128-op96-green-review-signoff.md) (the OP-96 integration renumber), [ADR-0133](ADR-0133-op96-f1-f4-round2-red.md) (a cross-lane allocation settled by card `t_cf0b1f77`), [ADR-0143](ADR-0143-op96-flush-overlap-single-send-green.md) / [ADR-0145](ADR-0145-op96-f1-unrecorded-flush-bound-green.md) (the collisions the policy ends)
- **Schema:** n/a · **Contract:** n/a (test-only tooling; no application code)
- **Implementation:** `apps/web/src/test/helpers/adr-numbering.ts` · **Spec:** `apps/web/src/test/unit/adr-numbering.test.ts`

## Context

[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) replaced "take the
lowest free number at commit time" with **per-lane reserved ranges** and said, in
its §Consequences:

> A purely mechanical duplicate-prefix check (two files in `docs/adr/` sharing an
> `ADR-NNNN`) remains worthwhile as a backstop and **is tracked separately; this
> record is the policy, not the guard.**

That promise is now due. The guard landed on `main` as `eda4e1b` (PR
[#229](https://github.com/yahodu/openpic-webapp/pull/229)):
`apps/web/src/test/helpers/adr-numbering.ts`, its spec
`apps/web/src/test/unit/adr-numbering.test.ts`, and
`docs/CONVENTIONS.md` §11. Its **contract** and, more importantly, its
**deliberate scope boundary** currently live only in a `docs/CONVENTIONS.md`
section and in TSDoc. That is thin for a rule that is easy to "improve" in the
wrong direction: a future engineer who reads ADR-0300's prose ledger
(`docs/adr/README.md` § "ADR number allocation") may reasonably try to make the
guard verify reserved ranges — the exact brittleness the boundary exists to
avoid. This record pins the contract and the boundary so the next reader
inherits the _why_, not just the _what_.

## Decision

The guard `apps/web/src/test/helpers/adr-numbering.ts` enforces **exactly two
mechanical invariants**, and its boundary is fixed:

### 1. The two invariants

1. **No duplicate number.** No two in-scope files in `docs/adr/` share an
   `ADR-NNNN` prefix. Two or more well-formed names carrying the same four-digit
   number are reported together as **one** `duplicate` issue.
2. **Well-formed names only.** Every in-scope `ADR-*.md` file name matches

   ```
   ^ADR-(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$
   ```

   a four-digit number and a lowercase `[a-z0-9]`-only dashed slug. A wrong
   number length (`ADR-96-x.md`, `ADR-12345-x.md`), an uppercase slug
   (`ADR-0146-X.md`), a non-`.md` extension or a name that does not start with a
   case-sensitive `ADR-` is **malformed**.

**Scope is case-sensitive and name-based.** Only names matching
`^ADR-.*\.md$` are looked at; `README.md`, a lowercase `adr-…` and any other
non-ADR markdown are ignored silently. A lowercase `adr-0146-x.md` is therefore
_not_ an ADR reference — it is out of scope, not a malformed ADR.

### 2. Report semantics

- One `duplicate` issue per shared number, listing **its names sorted**
  ascending.
- Each malformed in-scope name produces **its own** `malformed` issue and never
  joins a duplicate group (a malformed name with the same _digits_ as a
  well-formed one does not collide with it).
- `ok === (issues.length === 0)`.
- Ordering is **deterministic**: issues sort by numeric ADR number ascending,
  with `malformed` issues (`number === null`) last, then by `code`, then by the
  first file name. `files` within an issue is sorted ascending. The same input in
  any order yields the same report — `fs.readdir` order is not guaranteed and CI
  logs must be stable.

### 3. One directory, no recursion

`checkAdrDirectory(dir)` reads **exactly one** directory (a synchronous
`readdirSync` filtered to files) and **never recurses**. A nested `archive/` copy
of an ADR cannot produce a phantom duplicate.

### 4. The deliberate scope boundary — the load-bearing part

The guard does **not**:

- verify that a number sits inside its lane's **reserved range**, or
- cross-check the number against **`origin/main`** (or any other ref).

Both remain **review-time obligations for the reviewer**, not CI checks. The
reasons are structural, not incidental:

- The range ledger is **prose** in `docs/adr/README.md` § "ADR number
  allocation". Parsing prose in CI is brittle: the ledger's format is a
  documentation choice, and coupling a merge gate to it trades one failure mode
  (a human miss) for a worse one (a false red on a doc-format tweak).
- A PR checkout **does not guarantee a fetched `origin/main`**. A cross-ref check
  would either fail closed on an unfetched remote or fail open on a stale one —
  both worse than the reviewer checking it.

**Mechanising either of these is a decision that requires a superseding ADR.**
Absent one, they are reviewer duties: CONVENTIONS.md §11 records them as such,
and the reviewer confirms a new number is both inside its lane's range and free
on `main`.

### 5. Where it runs, and non-vacuity

- The guard runs under **`pnpm test:unit`**, an existing CI step in
  `.github/workflows/ci.yml`; there is no bespoke job to add or maintain.
- It lives under `apps/web/src/test/**`, which is **excluded from coverage**, so
  it cannot move the coverage thresholds.
- It is **non-vacuous**: injecting a synthetic `ADR-0142` duplicate into
  `docs/adr/` makes the full unit project fail naming `0142`; removing it
  restores a green run. (Reproduced independently in the review of `t_8675b675`.)

## Consequences

- The mechanical half of ADR-0300 is enforceable and gated: a duplicate number or
  a malformed name is caught by CI, not by a reviewer's memory.
- The guard's boundary is now a recorded decision, so "why doesn't the guard
  check the range?" is answered by an ADR rather than re-litigated — and changing
  the boundary is explicitly a superseding-ADR decision, not a drive-by "fix".
- The reviewer keeps two duties that no tool covers (range membership and
  `origin/main` freshness). That asymmetry is intentional and accepted.
- `pnpm test:unit` is now a required pre-merge check for any PR that touches
  `docs/adr/**`; a new ADR must satisfy the very guard it is subject to.

## Alternatives

- **Mechanise the range check by parsing `docs/adr/README.md`.** Rejected: it
  makes the prose ledger's format a CI contract, so a harmless table reflow can
  red the whole board — the serialization/brittleness ADR-0300 set out to remove,
  reintroduced as a parse dependency.
- **Mechanise a cross-ref check against `origin/main`.** Rejected: a PR checkout
  cannot assume a fetched `origin/main`; the check would be unreliable (stale =
  false green, unfetched = false red) and so strictly worse than a reviewer
  looking.
- **Extend the guard to recurse into `archive/` subdirectories.** Rejected: an
  archived ADR legitimately keeps a number that has been superseded; recursing
  would produce phantom duplicates and force renumbers of frozen history.
- **Fold this contract into ADR-0300.** Rejected: ADR-0300 is the allocation
  _policy_ and says so ("this record is the policy, not the guard"); keeping the
  guard's contract separate lets the boundary change without rewriting the
  policy, and matches the "one decision per record" rule.
