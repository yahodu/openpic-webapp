# ADR-0302 — The `docs/adr/` number guard: its mechanical contract and its deliberate scope boundary

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 follow-up (process/ADR) — record the ADR-number guard's contract and scope boundary (`t_2ae626e9`, orchestrator; raised by the review of `t_8675b675`, OP-96 R-1, PR [#229](https://github.com/yahodu/openpic-webapp/pull/229))
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the policy this guard is the mechanical backstop for), [ADR-0128](ADR-0128-op96-green-review-signoff.md) (the OP-96 integration renumber), [ADR-0133](ADR-0133-op96-f1-f4-round2-red.md) (a cross-lane allocation settled by card `t_cf0b1f77`), [ADR-0143](ADR-0143-op96-flush-overlap-single-send-green.md) / [ADR-0145](ADR-0145-op96-f1-unrecorded-flush-bound-green.md) (the collisions the policy ends)
- **Schema:** n/a · **Contract:** n/a (test-only tooling; no application code)
- **Implementation:** `apps/web/src/test/helpers/` — `adr-numbering.ts` (barrel; invariants i–ii), `adr-lane-ranges.ts` (iii), `adr-source-references.ts` (iv), `adr-consumers.ts` (v), `adr-record-links.ts` (vi), shared report shapes in `adr-guard-types.ts` · **Spec:** `apps/web/src/test/unit/` — `adr-numbering.test.ts`, `adr-lane-ranges.test.ts`, `adr-source-references.test.ts`, `adr-consumers.test.ts`, `adr-record-links.test.ts`

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

The guard is one module per invariant under `apps/web/src/test/helpers/`, behind
the frozen barrel `adr-numbering.ts` (§10). It enforces **six mechanical
invariants**, and its boundary is fixed. This table is the list's one home: each
row names the module that implements the invariant and the spec that pins it.

| #     | Invariant                                                                               | Code                                                       | Module                     | Spec                            |
| ----- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------- | ------------------------------- |
| (i)   | No two in-scope files share an `ADR-NNNN` prefix                                        | `checkAdrNumbers`                                          | `adr-numbering.ts`         | `adr-numbering.test.ts`         |
| (ii)  | Every in-scope `ADR-*.md` name is well-formed                                           | `checkAdrNumbers`, `parseAdrNumber`                        | `adr-numbering.ts`         | `adr-numbering.test.ts`         |
| (iii) | Ledger ranges are disjoint, and a range-shaped row that does not parse is reported (§6) | `parseLaneRanges`, `checkAdrDirectory`                     | `adr-lane-ranges.ts`       | `adr-lane-ranges.test.ts`       |
| (iv)  | Every in-source `ADR-NNNN` reference resolves to a record (§8)                          | `checkSourceAdrReferences`, `checkRepositoryAdrReferences` | `adr-source-references.ts` | `adr-source-references.test.ts` |
| (v)   | Every citation of a declaring record names the citing file (§9)                         | `checkSourceAdrConsumers`, `checkRepositoryAdrConsumers`   | `adr-consumers.ts`         | `adr-consumers.test.ts`         |
| (vi)  | Every markdown link target inside a record resolves (§7)                                | `checkAdrRecordLinks`, `checkRepositoryAdrLinks`           | `adr-record-links.ts`      | `adr-record-links.test.ts`      |

The sections below follow the order the checks were added, not the numeric order.

### 1. The first two invariants (i) and (ii)

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
on `main`. The _disjointness_ half was mechanised on 2026-11-12 under ADR-0300
§10 (finding F-L1) — see §6 below, which supersedes it; range membership is
unchanged.

### 5. Where it runs, and non-vacuity

- The guard runs under **`pnpm test:unit`**, an existing CI step in
  `.github/workflows/ci.yml`; there is no bespoke job to add or maintain.
- It lives under `apps/web/src/test/**`, which is **excluded from coverage**, so
  it cannot move the coverage thresholds.
- It is **non-vacuous**: injecting a synthetic `ADR-0142` duplicate into
  `docs/adr/` makes the full unit project fail naming `0142`; removing it
  restores a green run. (Reproduced independently in the review of `t_8675b675`.)

### 6. The lane-range disjointness invariant (2026-11-12, finding F-L1)

Ledger finding F-L1 showed two reserved rows can intersect while every file name
stays unique on its own branch: the OP-126 uploads lane held `0760`–`0779` and
the OP-129 lane held `0769`–`0788`, so `ADR-0770` came to exist twice in flight.
That is a _row_ defect, and unlike range membership it is mechanical, so the
guard now enforces it. This section supersedes the **disjointness half** of §4;
range membership and `origin/main` freshness stay review-time.

- **Invariant.** Two rows of the reserved-range ledger in `<dir>/README.md`
  whose **closed** ranges intersect are a failure —
  `a.start <= b.end && b.start <= a.end`. One issue is reported per intersecting
  pair, in the existing report shape:
  `{ code: "lane-range-overlap", number: null, files: [holderA, holderB] }`,
  where `files` carries the two **holders** (the ledger's row labels, not file
  names) sorted ascending. Touching neighbours — `0760`–`0779` and `0780`–`0798`
  — are disjoint and clean.
- **Scope: rows only, closed ranges only — but a range-shaped row is never
  dropped silently.** A row contributes a range only when its second cell is a
  closed `` `NNNN`–`NNNN` `` pair (`–` U+2013 or `-`) whose start is not above
  its end. A cell that is **range-shaped** — two backticked 3–4 digit tokens with
  one dash-family separator (`–`, `-`, `—`, `−`, `~`) and nothing else in the
  cell — but fails that test is **reported**, not skipped:
  `{ code: "lane-range-malformed", number: null, files: [holder] }`, one issue
  per row, holder trimmed verbatim (finding F1 follow-up). Still **skipped**, and
  named here so a later "fix" cannot red the board: the open-ended
  `unallocated (future lanes)` cursor (`` `0700`+ … ``), a single-number cell,
  the header and `---` separator rows, any prose mention, the ADR index rows
  (their titles quote numbers — the real `0341` row reads "the `` `402`/`403` ``
  denial split"), an **indented** row (the row shape requires a leading `|`), and
  an **annotated** range cell such as `` `0789`-`0808` (20 per lane) `` (the
  accepted cell is fully anchored). A missing, empty or row-less `README.md` adds
  no issue.
- **Why range notation, not "any non-alphanumeric separator".** The F1 pins
  describe a row as "two backticked number tokens with a non-alphanumeric
  separator between them"; applied literally to a whole cell that also catches
  the `0341` index row and would call an annotated range malformed. The
  implementation therefore gates on _range notation_ — one dash-family separator
  inside an otherwise fully anchored cell. This is the one place the rule is
  narrower than the pins' wording, and it is settled by the harder requirement
  that `checkAdrDirectory("docs/adr")` on this repository stays exactly
  `{ ok: true, issues: [] }`.
- **A malformed row never feeds the overlap predicate.** `0780`-`0760` matches
  the accepted pattern and would parse as `{ start: 780, end: 760 }`, inventing
  an overlap against a lane at `0760`-`0799` that no lane reserved.
  `parseLaneRanges` drops a descending pair (its result for every valid row is
  unchanged), and the malformed issue is the only report that row produces.
- **Measured (F1 follow-up).** An inverted (`0780`-`0760`), em-dash
  (`0760`—`0779`), minus-sign, tilde and three-digit (`760`-`779`) row each
  produce exactly one `lane-range-malformed` issue; an indented copy of the
  inverted row produces none; the real ledger is `{ ok: true, issues: [] }` over
  31 parsed ranges. **Why the silent direction was worse than the false
  positive:** a skipped row is indistinguishable from a lane that reserved
  nothing, so the guard reports clean while the ledger's promise is broken — the
  same silence that let F-L1 ship. A false positive is a one-line ledger fix in
  the PR that introduced it, and the code names the offending row.
- **Parser.** `parseLaneRanges(markdown: string): LaneRange[]` in the same
  module returns one `{ holder, start, end }` per closed row — holder trimmed
  verbatim, leading zeros dropped, document order preserved. It is row-shape
  based and does **not** require the `### Reserved ranges` heading: the row is
  the reservation, and the heading carries a date that is re-worded more often
  than the rows are written.
- **Ordering.** Overlap issues join the numbering issues and pass through the
  same deterministic sort (§2): `number: null` places them with the malformed
  issues, then `code`, then `files[0]`. Two overlaps that share a first holder
  tie on that key and keep insertion order — the report pins the key, not
  README-row-order independence.
- **What it still cannot see.** A _file_ numbered inside a foreign range. The
  guard has no file→lane map, and must not infer one from the `Next free` cell
  (a consumed count, not a reservation bound — ADR-0300 §10), so that remains a
  review-time defect.

### 7. The record link-target invariant (vi) (2026-11-12, finding F3)

Every **markdown link target** inside a `docs/adr/ADR-*.md` record must name a
file that exists in `docs/adr/`. The records were the one tree the source sweep
never read, so a renamed record's links rot in silence: three OP-129 records
pointed at pre-rename file names while every guard stayed green.

- **Scope: records, not the ledger.** Only names matching `^ADR-.*\.md$` are
  swept. `docs/adr/README.md` is deliberately out, because its ledger notes keep
  pre-rename names on purpose, and flagging them would force the record of a
  collision to stop describing it.
- **Prose is not a link.** A fenced code block and an inline code span are
  prose: a `](…)` shape inside backticks documents the shape, it does not
  navigate.
- **Shapes read (2026-11-12, finding F1 of card `t_e042ab22`).** A markdown
  inline link's target is read in **three** shapes — bare `](ADR-….md)`,
  **titled** `](ADR-….md "title")`, and **angle-bracket** `](<ADR-….md>)` — and
  all three resolve on the leaf, so a dangling target in any of them is reported.
  A title is peeled before resolution and is **not** part of the reported
  `target`; the brackets are likewise stripped, so the report quotes
  `ADR-….md` and never `<ADR-….md> "title"`, while a `#fragment` stays in the
  report after the bracket is removed. Every shape read is counted in
  `checkedLinks`, because `ok: true` alone would also pass on a rule that
  silently skips it. An image link (`![alt](ADR-….md)`) is a target too: it
  navigates like a text link.
- **Shapes not read — stated so a later change cannot widen the rule by
  accident.** A `./ADR-….md` and every other path-bearing target (the leaf
  predicate rejects a path separator, now and by decision), a reference-style
  `[label][ref]` with its `[ref]: ADR-….md` definition, a bare autolink
  `<ADR-….md>`, and a target containing `(` or `)` are **not** targets: they are
  neither resolved nor counted. The combined `](<ADR-….md> "title")` is read by
  the same two peels but is deliberately **not pinned** — the trunk carries no
  such link, and pinning it would widen the shape matrix past the two shapes this
  section records.
- **Exact leaf matching.** Any `#fragment` is stripped, and the leaf must carry
  no path separator, start `ADR-` and end `.md`. It resolves only against a file
  name **equal** to the leaf — never a prefix and never a number-only match,
  which is how `0029-domain-event-outbox.md` (the record is the plural
  `…-domain-events-outbox.md`) and `0306-red-branch-pipeline.md` (0306 is now
  `0306-op101-stale-branch-deletion.md`, a different decision) passed as valid.
- **The ratchet, and its retirement.** The invariant landed as a ratchet: the
  real-tree case pinned the trunk's observed debt exactly — **32 occurrences of
  16 distinct targets** in other lanes' records — so it failed on a new dangling
  link _and_ on a repair, which coupled every docs fix to this file. The repair
  retargeted all 16 and retired the list to `{ ok: true, issues: [] }` over 292
  records and 881 links; the case keeps its non-vacuity bounds (`>= 250`
  records, `>= 800` links) and the two census floors recorded next. Two
  targets had no live record to point at — `ADR-0360`/`ADR-0361`, the OP-104
  lane's records, which exist only on the unmerged
  `OP-104-task-entitlements-usage-endpoints` branch — and are named as prose
  there.
- **The census floors, with headroom (2026-11-12, card `t_0fb1fa25`).** The
  real-tree case pins **two** floors and never an equality: the link floor
  `checkedLinks >= 860` — about 2.4% below the 881 census at the retirement —
  and the population floor `scannedRecords >= 292`, the record population
  itself. The pair exists because each value alone binds the wrong thing. A
  prose repair that replaces a link with its record's name is legitimate and
  lowers the link count: the F2 repair (`t_bd371d4d`) drops exactly two links,
  881 → 879, so a floor pinned at the census reddens a _repair_ — the coupling
  the ratchet's retirement removed, one direction over. A link floor low enough
  to leave that repair room cannot, however, see a **record-sweep narrowing**:
  reading 280 of the 292 records still counts 866 links, above `>= 860`, while
  the population floor fails
  (`expected 280 to be greater than or equal to 292`). Records are frozen and
  never deleted, so 292 fails only on a deletion or on a narrowed read, never on
  a mint — which is why the pair, and not one tuned number, is the form the
  guard takes. The `>= 250` / `>= 800` bounds stay as the contract's own floor
  (a near-empty sweep); they are not the narrowing guard and cannot be, since
  any narrowing that leaves 866 links is far above both.
- **Resolution is not correctness (2026-11-12, review of card `t_bd371d4d`).**
  Invariant (vi) proves **resolution only**: a retarget that names a live record
  of the cited number is green even when that record decides a different thing,
  and the failure is silent by construction, because the sweep has no notion of
  subject. A repair therefore retargets to **the record the sentence means**;
  when no record on `main` decides the thing, name the gap in prose — the shape
  the OP-104 pointers `ADR-0360`/`ADR-0361` use — rather than pointing at a
  record that merely mentions the noun. Two measured instances: the F2 repair
  (`ADR-0560`/`ADR-0561:5`, `ADR-0540` is the branding-upload RED) and the F1
  site (`ADR-0600:5`, `ADR-0040` is the OP-89 identity-hooks RED and mentions
  `event_organizers` zero times; fix card `t_130572f1`). No mechanical check
  closes this class, so it stays a review obligation.

### 8. The source-reference resolution invariant (iv) (2026-11-12, finding F6-b)

Every `ADR-NNNN` reference inside a source file must resolve to a record. The
trigger was the OP-128 round-1 renumber: five shipped comments still cited
`0764`/`0765` after those decisions moved to `0766`/`0767`, and `0764`/`0765`
belong to sibling lanes, so the comments pointed at the wrong decisions while
every other guard stayed green.

- **The token.** A case-sensitive `ADR-` plus exactly four digits not followed by
  a fifth (`ADR-(\d{4})(?!\d)`), so `ADR-12345` is not a reference to `1234` and
  a lowercase `adr-…` is not a reference at all.
- **What resolves.** Only the digits of a **well-formed** record name. A
  reference against a malformed name (`ADR-96-x.md`) resolves nothing, and that
  name is already a `malformed` issue under §1, so the two guards agree instead
  of contradicting each other.
- **The report.** One `dangling-reference` issue per **occurrence** — two
  comments citing one missing number are two issues, and two files citing it are
  two — shaped `{ code: "dangling-reference", file, line, number }`, with the
  digits **as written** (leading zeros kept, e.g. `"0764"`) and a 1-based `line`.
  Issues sort by `file`, then `line`, then `number`.
- **Counters and the reconciliation identity.**
  `checkSourceAdrReferences(sources, adrFileNames)` counts every evaluated
  reference in `checkedReferences` and every exempt one in `exemptReferences`.
  Its accuracy sibling (§9) classifies the same population and reports
  `checkedReferences + danglingReferences === checkSourceAdrReferences(...).checkedReferences`;
  that identity is pinned, because it is what proves the two sweeps read one
  population rather than quietly diverging.
- **Scope: the same sweep as §9.** `checkRepositoryAdrReferences(root)` reads
  `<root>/docs/adr/` first — a wrong root throws `ENOENT` instead of sweeping
  nothing and passing vacuously — then every `.ts`, `.tsx`, `.js`, `.jsx`,
  `.mjs` and `.cjs` file under `apps/` and `packages/`, never `scripts/` or the
  docs. The skipped directories are `node_modules`, `.git`, `.next`,
  `.worktrees`, `coverage`, `dist`, `build`, `.turbo`, `playwright-report` and
  `test-results`, so a build output copy cannot make the result depend on
  whether a build ran.
- **The fixture marker.** A line inside `apps/web/src/test/**` that carries
  `adr-fixture` is exempt and counted in `exemptReferences`. The exemption is
  scoped per line **and** per path, so a marked line in shipped source is still
  checked — finding F-M1, where an unscoped substring test let a real pointer be
  silenced.
- **Executable contract:** `apps/web/src/test/unit/adr-numbering.test.ts`.

### 9. The citation-accuracy invariant (v) (2026-11-12, finding F-N1)

Existence is not accuracy (§8). Nine OP-129 spec headers cited the never-minted
`0768`; when a record with that number was minted for the OP-128 lane, all nine
silently became "valid" references to a decision about the media signer's
account-status gate. The accuracy rule is decidable only where a record states
its own consumers, so participation is **declared per record, never inferred**.

- **The canonical field.** `- **Consumers:**` — a `-` list item at column 0, the
  label in `**…**` bold, the colon inside the bold — anywhere in the record.
  `Consumes:` is a different field (what the decision consumes) and is not a
  declaration; neither is prose that merely contains the word. A record declaring
  the field is hard-checked; a record that does not is counted in the
  `unlisted-consumer` channel so the debt stays visible.
- **Malformed shapes are recognised, and still declare.** An indented or
  `*`/`+` bullet, a `>` blockquote level, an ordered-list marker, `__…__` bold,
  the colon outside the bold, no bullet, a plain unbolded label, and a
  `## Consumers` heading are each `consumers-malformed`: one punctuation slip
  cannot switch the rule off for its record, and the record's citations stay
  hard-checked. Recognition is deliberately wider than canonicality —
  blockquote levels first, then list or heading markers (a line can carry both,
  in either order), then the bold markers — and prose is not a shape: after the
  peels the label must open the line and, unless the line is a heading, carry its
  colon.
- **The three channels.** `consumer-mismatch` — the cited record declares
  consumers and does not name the citing file: a failure. `consumers-malformed` —
  a non-canonical field, reported **per record** (so a field in a record nobody
  cites still fails), with `file` and `record` set to the record's own name and
  `line` to the offending line: a failure. `unlisted-consumer` — the cited record
  declares nothing; each citation is reported in the separate `unlisted` channel
  and counted, **never failed**, because most records predate the field and a
  hard failure would demand a whole-docs adoption programme. `ok` is false
  exactly when `issues` is non-empty, and on a malformed-free record set every
  evaluated reference is classified once
  (`verifiedReferences + issues.length + unlisted.length === checkedReferences`).
- **How a record identifies a citing file.** Over the record's **whole text**,
  not only its field block: a file the record names in prose counts exactly as
  one it names in the field. Identification is by any of four channels: (1) the
  repo-relative path as a token, exact or a directory prefix of the citing path;
  (2) an `@/…` specifier,
  resolved against both `apps/web/src/…` and `apps/web/src/app/…`, exact or with
  a swept extension or as a directory prefix, after a trailing `[...]`
  annotation group is stripped; (3) the bare file name as a whole token, but only
  when that name is unique across the swept population — a shared name
  (`route.ts`) identifies nothing; (4) in backticks, an identifier the citing
  file exports (`export … <Name>` or an `export { <Name> }` alias) with the name
  at least **six** characters, because short generic names would verify
  arbitrary files.
- **Colon-bearing path tokens (review finding F-C, PR #506).** A Next.js route
  segment may legally contain `:`, so `:` stays a token character in both the
  repo-relative path and the `@/…` specifier patterns
  (`RECORD_PATH_TOKEN_PATTERN` / `RECORD_SPECIFIER_TOKEN_PATTERN`;
  `…/uploads:link/route.ts` is a real swept file); a record that names that file
  is read exactly as written. The colon is one **path** character, not an instruction to read the
  rest of the line, so a token still ends at the first non-path character and
  nothing after the path is swallowed. A trailing `:<digits>` suffix is a line
  annotation, not part of the file name, so a token written `path.ts:42.` names
  `path.ts`. **Why the widening matters:** without `:`, a token naming
  `…/uploads:link` stops at the colon as `…/uploads`, and the directory-prefix
  arm then verifies the colon-free sibling `…/uploads/…` while the file the
  record actually named is reported as a mismatch — a wrong file in both
  directions at once, which is the failure the widening removed.
- **Literal first, annotation second.** A `Consumers:` path or `@/…` specifier
  token whose written form names a swept file is read exactly as written; only a
  token that names **no** swept file is re-read with **one** trailing `:<suffix>`
  stripped. The suffix may contain a dot, so `…/route.ts:D1`,
  `…/route.ts:D1.2` and `…/route.ts:4.2` all name `…/route.ts`, and a second `:`
  is left alone. The order is load-bearing: a blind trim rewrites the directory
  token `…/uploads:link` to `…/uploads`, the colon-free sibling's directory, so
  the colon route and its decoy would both verify — the wrong-file failure above,
  reintroduced. Read the other way round, a benign annotation the guard cannot
  tell from a path keeps its citation verified instead of turning it into a
  named failure.
- **Duplicate numbers.** A citation is declared when _any_ record with that
  number declares, and verified when any of them identifies the citing file;
  reporting the duplicate stays §1's job.
- **The fixture marker** is §8's population, byte for byte: the same references,
  the same per-line exemption, a reference whose record is missing counted in
  `danglingReferences` and left to §8, so
  `accuracy.checkedReferences + accuracy.danglingReferences === existence.checkedReferences`.
- **No census snapshot is published here.** The counts move with every record
  added, and a figure a reader cannot re-derive from a named commit is worse than
  no figure, so measure them yourself at the commit under review with the guard's
  own exports — `checkRepositoryAdrReferences`, `checkRepositoryAdrConsumers` and
  `checkRepositoryAdrLinks`.
- **Executable contract:** `apps/web/src/test/unit/adr-numbering.test.ts`.

### 10. Module layout (2026-11-12)

This is §10, not §7 as the implementing card calls it: §7–§9 are already the
invariant sections the `## Decision` table points at, and renumbering an
accepted record's sections would break every cross-reference that names them.

The guard was one module, `adr-numbering.ts` (1568 lines), and the six invariants
were appended to it as sections. Three lanes landed inside one hour (#494, #462,
#497) and the third merge conflicted in the invariant list, which was duplicated
in the helper docblock, in the spec docblock and in the `## Decision` table. It
is now one module per invariant, and the list has one home: the `## Decision`
table above.

- `adr-numbering.ts` is the **frozen barrel**. It still owns invariants (i) and
  (ii), it composes (iii) into `checkAdrDirectory`, and it re-exports the whole
  public surface, so every import of `helpers/adr-numbering.js` keeps working
  with the same names and signatures. _New invariants are imported from their own
  module and are added to this barrel only if an external caller needs them._ The
  barrel exists because the specs and the ADR-0300 §12 pre-merge command import
  from it — not because appending here is how the guard grows.
- `adr-guard-types.ts` holds the shared report and issue shapes plus the
  deterministic comparators. All report shapes live here (the specs import six of
  them from this path); it holds no filesystem access and no invariant logic, so
  it never imports an invariant module.
- `adr-lane-ranges.ts` (iii), `adr-source-references.ts` (iv), `adr-consumers.ts`
  (v) and `adr-record-links.ts` (vi) each own exactly one invariant.
- The guard family's two `fs` call sites (`readDirectoryEntries`,
  `readTextFile`) and the tree walk (`collectSourceFiles`) live in
  `adr-source-references.ts`; the other readers import them, so the security
  preset still sees one non-literal `fs` call per kind rather than one per module.
- **Spec:** one spec per module — `apps/web/src/test/unit/adr-*.test.ts` — over
  the shared fixture factories in `apps/web/src/test/helpers/adr-guard-fixtures.ts`
  (repository root, temp-directory factories, the lane-ledger factory, and the
  `tempDirs` registry each spec's `afterEach` cleans up).

**Measured size at this layout.** `wc -l` over the seven helper modules and the five
specs at `79e132e`, the split's reviewed head:

```sh
wc -l apps/web/src/test/helpers/adr-numbering.ts apps/web/src/test/helpers/adr-guard-types.ts \
  apps/web/src/test/helpers/adr-lane-ranges.ts apps/web/src/test/helpers/adr-source-references.ts \
  apps/web/src/test/helpers/adr-consumers.ts apps/web/src/test/helpers/adr-record-links.ts \
  apps/web/src/test/helpers/adr-guard-fixtures.ts apps/web/src/test/unit/adr-numbering.test.ts \
  apps/web/src/test/unit/adr-source-references.test.ts apps/web/src/test/unit/adr-record-links.test.ts \
  apps/web/src/test/unit/adr-lane-ranges.test.ts apps/web/src/test/unit/adr-consumers.test.ts
```

```
helpers: adr-numbering 223, adr-guard-types 284, adr-lane-ranges 148, adr-source-references 266,
         adr-consumers 547, adr-record-links 217, adr-guard-fixtures 83      → all < 700  ✓
specs:   adr-numbering 397, adr-source-references 462, adr-record-links 844,
         adr-lane-ranges 849                                                  → all < 900  ✓
         adr-consumers.test.ts 2543                                           → 2543 > 900  ✗
```

Every helper module is under 700 lines and four of the five specs under 900. **A spec is
capped at ~900 lines, except invariant (v)'s**, which stays one file: the layout rule is one spec
per module, and (v) carries the largest case set (64 `ADR-NNNN` tokens, 40+ cases), so splitting it
again would put one invariant across two specs. The measured figures are the delivered layout;
**this section supersedes the ~900-line spec bound the decomposition carried** — the bound, not the
delivery, was miscalibrated — in the same superseding form as the pre-merge command below. A spec
other than (v)'s crossing ~900 lines is still a layout smell.

**The rule: a new invariant is a new module + its spec + one row in the
`## Decision` table.** It is never another section appended to `adr-numbering.ts`.

**Pre-merge command — supersedes ADR-0300 §12 item 12.** ADR-0300 item 12 pins
the single-spec run; the guard is now five specs, so the pre-merge run is

```sh
./node_modules/.bin/vitest run --project unit apps/web/src/test/unit/adr-*.test.ts
```

ADR-0300 itself is not edited: this section supersedes its command, exactly as §6
supersedes its §4 reading.

**Census rule for the real-tree cases.** A real-tree case keeps its non-vacuity
bounds and pins the census as a floor with headroom (`checkedLinks`) plus a
population floor (`scannedRecords`) — never an equality; the values live in the
spec. A minted record carrying a `Relates to` line raises the count, a prose
repair that replaces a link lowers it by a few, and an equality pin would
re-couple every ADR to the spec file. A shrink below the retirement census still
cannot pass.

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

## Review sign-off (RED rounds 1–2, execution lens)

- **Verdicts: round 1 — CHANGES REQUESTED (one High finding); round 2 — APPROVED.** Nothing in
  §Decision is retracted: the round-1 finding was inside the RED's spec, not in this contract, and
  the GREEN closed it before the guard landed. Recorded here, inside the delivered ADR, so the
  sign-off consumes no new ADR number.
- **Reviewer:** `openpic-webapp-reviewer` (card `t_2aaa8a18`) · **RED card:** `t_e23bb540` ·
  **GREEN card:** `t_94a437c4` · **PR:** [#448](https://github.com/yahodu/openpic-webapp/pull/448) ·
  **Branch:** `OP-96-task-adr-lane-range-guard` · **Reviewed heads:** `440b00b` (round 1) →
  `d327e47` (round 2).

### Scope

The sign-off covers the RED deliverable of card `t_e23bb540`: the pins for `parseLaneRanges` and
for the `lane-range-overlap` report shape that later became §6. That card delivered them on PR
#448 as a **draft, RED-by-design**. The draft itself was never merged — the GREEN card `t_94a437c4`
promoted the same PR, added the implementation, ADR-0300 §10, this §6 and the README bullets, and
the guard review + land card `t_c8727284` approved and squash-merged it as `d85de6f`. "Never
merged" therefore describes the pre-GREEN draft only, not PR #448 as a whole.

### Round 1 (artifact lens) — CHANGES REQUESTED, one High finding

- **F1 (High, spec brittleness).** The real-ledger case pinned the ledger's then-last row,
  `OP-122 queue lane 0680`–`0699`. Any new lane row inserted above the pool row therefore turned
  the guard's own spec red while the guard still reported the ledger clean — the pin would have
  blocked an allocation the guard correctly accepted.
- **Measured.** With a faithful stub: `54 passed (54)`. Inserting `| OP-129 attendee identity lane | 0780–0798 | 0782 |` above the pool row: `1 failed | 53 passed`.
- The finding was in the pin, not in the contract: §6 as written needed no change.

### Round 2 (execution lens) — APPROVED

- **F1 closed** by deriving the last closed row from the file (`closedRows()`) instead of naming it. The reviewer re-ran the same insert at **both ends** of the table; both stayed `54 passed (54)`, while the pre-fix spec failed the same probe.
- The `TS2532` follow-on fix in `d327e47` (`noUncheckedIndexedAccess` on the derived-row helper)
  weakens no assertion.
- **Red state on the reviewed head** (`d327e47`): `adr-numbering.test.ts 3 failed | 34 passed (37)`, `adr-lane-ranges.test.ts 17 failed (17)`, and the full unit project `20 failed | 2380 passed | 3 skipped` with only those two specs. `lint`, `secret-scan`, `audit`, `audit-dev`, `env-changes`, branch-name, PR-title and CodeQL green; `unit_test` red by design on exactly those 20 cases.
- **Contract untouched.** The specs' only removed lines were one import and four docblock lines;
  `checkAdrNumbers` and `parseAdrNumber` bodies were not edited.

### The acceptance proof, measured in a throwaway worktree

- An intersecting row, or the live bug itself (uploads rows `0700`–`0779` with OP-129 still at
  `0769`–`0788`), turns `finds no intersecting pair among the repository's reserved ranges` **and**
  the delivered `checkAdrDirectory(realAdrDir)` case red: `2 failed | 52 passed`.
- The destination state (uploads `0700`–`0779`, OP-129 `0780`–`0798`, pool `0799`+) is
  `54 passed (54)`, and that is the ledger `main` now carries.
- That measured bite is why the lane repair card `t_da4088d2` was gated on the guard: the guard
  cannot be green on a ledger that still carries the live overlap.

### Recorded, no change requested

- The RED spec pins the real ledger **by row shape**, not by the `### Reserved ranges` heading —
  the heading carries a date that is re-worded more often than the rows are written.
- `ranges[0]` stays positional by convention in the overlap cases.
- The derived last-row assertion is near-redundant with the count check, but still catches a wrong
  `end`, so it was kept deliberately.
- The helper is **exempt from the coverage gate**: `vitest.config.ts` `include` covers only
  `packages/contracts/src/**`, `apps/web/src/app/api/**` and `apps/web/src/server/**`, and
  `exclude` carries `**/*.test.ts`, `**/__tests__/**` and `**/test/**`; so no defensive branch had
  to be deleted to hold 80 %.
- **F1 (Low) from the guard's land review `t_c8727284`** — recorded, with no change to §6. A
  range-shaped ledger row that does not parse is skipped silently: an inverted `0780`–`0760` cell
  parses as `{ start: 780, end: 760 }` and reports `{"ok":true,"issues":[]}` even with another
  lane inside the intended span; an em dash and three-digit pairs behave the same way. That is
  inside §6's documented "skipped, never thrown on" scope, so it is a limitation, not a contract
  violation. Follow-ups: card `t_4f74644d` (TEST, pins `lane-range-malformed`) → card
  `t_00321ecb` (GREEN, implements it and amends §6 in place).

### Post-review status

The open items are carried by card, never by an ADR number: `t_c8727284` (guard review + land —
done, squash `d85de6f`), `t_4f74644d` → `t_00321ecb` (the Low F1 above), `t_da4088d2` (lane repair
— done, delivered on PR #444), `t_b8c449d4` (OP-129 stack land — done, squash `741b607`). Nothing
recorded above is retracted; those cards' own records document what followed.

## Review sign-off (F1 GREEN, round 1 — artifact lens, landed)

### Scope

The GREEN for the Low F1 recorded under the RED sign-off above: card `t_00321ecb`
(GREEN, report `lane-range-malformed` for a range-shaped ledger row that does not
parse), delivered on PR [#481](https://github.com/yahodu/openpic-webapp/pull/481),
reviewed at head `fb50c7e` and landed as squash `fc4ad00`. This section records that
round only; it amends no contract and mints no number.

### What shipped

- `lane-range-malformed` joins `AdrNumberIssue["code"]`; `scanLaneLedger` reports
  `{ code: "lane-range-malformed", number: null, files: [holder] }` for a
  range-shaped row that is not an accepted ascending four-digit pair.
- The accepted cell form, the `parseLaneRanges` contract for valid rows and the
  `lane-range-overlap` shape are unchanged, so a valid ledger reports exactly what
  it reported before.
- §6 above and ADR-0300 §10 rule 17 were amended in place: the scope bullet now
  names the reported malformed row, and the policy rule states that a ledger typo
  is a CI failure rather than a silent hole.

### Verification (reviewed head `fb50c7e`)

- Pins carried byte-identical through the squash: `adr-numbering.test.ts` blob
  `3174d4a`, `adr-lane-ranges.test.ts` blob `3ad145a`; the PR diff carries no test
  path.
- Focused `adr-numbering` + `adr-lane-ranges`: **83 passed (83)**.
- Real ledger: `{"ok":true,"issues":[]}` over **31** parsed ranges.
- Full unit: **162 files, 2637 passed | 3 skipped (2640)** against the then-trunk's
  **2625 passed | 3 skipped (2628)** — delta **+12**, exactly the new pins.
- `tsc -p apps/web/tsconfig.json --noEmit` exit 0; eslint 0 errors with the helper
  warnings identical to the trunk; prettier clean; 14/14 PR checks.

### Load-bearing probes

- Dropping the `start <= end` guard → **4 failed**.
- Narrowing the range shape to four digits → **2 failed**.
- Measured silent edges: an indented row → `{ok:true,issues:[]}`; an annotated cell
  `` `0789`-`0808` (20 per lane) `` → `[]`; an inverted row beside a `0760`-`0799`
  lane → the malformed issue only, no phantom overlap.

### Landing

- Squash `fc4ad00`. The four reviewed paths are byte-identical between `fb50c7e`
  and the squash; the only other tree difference is trunk-owned `18f2056` (the
  OP-129 ADR-0781 sign-off, +48 lines), which landed while PR #481 was open.
- Re-run at the squash: focused **83 passed**, `tsc` exit 0. `docs/adr` holds
  **289** records, with no duplicate number.

### Open item routed, not fixed

The §6 guarantee that a malformed row never feeds the overlap predicate was
regression-invisible at that head: re-adding a descending four-digit pair to the
range list left the focused suite at **83 passed**, and the indented-row and
descending-pair-drop edges were asserted only in comments. That is a **coverage
gap, not a defect in the shipped behaviour**. It was routed to card `t_ce88dbcb`
(TEST, characterization pins; needs no GREEN), which landed three pins on PR
[#484](https://github.com/yahodu/openpic-webapp/pull/484) as squash `beae024`, each
proven load-bearing by a helper mutation:

- `adr-numbering.test.ts`, phantom-overlap pin:
  `reports only the malformed row when the inverted span would intersect a real lane`.
  Mutation "also push the range-shaped row into `ranges`" → **3 failed | 83 passed
  (86)**; the failure is the phantom
  `lane-range-overlap [OP-201 alpha lane, OP-204 delta lane]` instead of
  `lane-range-malformed [OP-201 alpha lane]`.
- `adr-numbering.test.ts`, indented-row pin:
  `stays silent for an indented row: the row shape requires a leading pipe`.
  Deleting the `line.startsWith("|")` continue → **1 failed | 85 passed (86)**,
  that case only.
- `adr-lane-ranges.test.ts`, descending-pair pin:
  `drops an inverted pair instead of returning the inverted span`. Dropping the
  `start <= end` guard → **6 failed | 80 passed (86)**.

With those pins on the merged trunk (`beae024`), the focused pair is **86 passed
(86)** — the 83 above plus the three pins. The later OP-128 pin scoping
(`ff0d03c`, PR [#477](https://github.com/yahodu/openpic-webapp/pull/477)) adds six
cases to `adr-numbering.test.ts` without changing any assertion cited here, so the
same pair is **92 passed (92)** on the trunk this section is appended to.

### Figure correction (Info)

The implementer handoff quoted a trunk baseline of `2632 passed`. The real baseline
was **2625 passed | 3 skipped (2628)** — no test file changed on `main` between
`a08d2aa` and `18f2056` — so the correct relation is 2625 + 12 pins = 2637. This is
a figure correction, not a defect.

### Post-review status

Nothing in §6 or in the RED rounds 1–2 sign-off above is retracted. The F1 item in
this section is carried by `t_ce88dbcb`, which is done (squash `beae024`). The card
ids are the record, not an ADR number.

## Review sign-off (annotation amendment, round 1 — artifact lens, landed)

### Scope

The §9 amendment delivered on PR [#524](https://github.com/yahodu/openpic-webapp/pull/524) — card `t_a9470ac6`
(DOCS, Low: record the literal-first / annotation-second precedence and make the census snapshot reproducible) —
reviewed at head `65c136a` and landed as squash `f9d3a62`. This section records that round only; it amends no
contract and mints no number.

### Verdict and landing proof

- **APPROVED (round 1, artifact lens).** No changes were requested and nothing was re-merged: the PR was already
  `MERGED` when the review ran.
- The reviewed bytes are the shipped bytes: `git diff 65c136a f9d3a62` is empty over the whole tree, and both
  commits share the tree hash `b3ae93097354c8842b5031f036d3d6fa757b880f`.
- 15/15 PR checks pass at `65c136a` (incl. `ci`, `unit_test`, `test_coverage`, `lint`, `audit`, `secret-scan`,
  `CodeQL`, branch-name and PR-title validation).

### Verification, measured by the reviewer

- `prettier --check docs/adr/ADR-0302-adr-number-guard-contract.md`: clean at the head and on the merged tree.
- `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts`: **200 passed (200)** at the head and
  **200 passed (200)** on the merged tree.
- Census measured by importing the guard's own exports from outside the swept tree, at the head and again on the
  merged tree — identical both times: `checkRepositoryAdrReferences` ok, 0 issues, checked **1250**, exempt
  **176**; `checkRepositoryAdrConsumers` ok, 0 issues, checked **1250**, dangling **0**, verified **149**,
  unlisted **1101**, declared **16**, no `consumer-mismatch` and no `consumers-malformed`;
  `checkRepositoryAdrLinks` ok, 0 issues, **881** links over **292** records. Identities:
  `149 + 0 + 1101 = 1250` and `1250 + 0 = 1250 = existence.checkedReferences`. The trunk holds 292 `ADR-*.md`
  files, the same number as `scannedRecords`.
- Scope: one `M` record (+16/−4); `docs/adr/README.md` untouched; no ADR number minted; `ADR-0302` present once on
  the trunk, no duplicate numbers in `docs/adr/`.

### Findings

- **F1 (was Low) — closed.** §9 now states literal first / annotation second, with the dotted suffix
  (`…/route.ts:D1`, `:D1.2`, `:4.2`), a second `:` left alone, and both reasons the order is load-bearing — the
  blind trim collapsing `…/uploads:link` onto the colon-free sibling's directory, and the reverse order turning a
  benign annotation into a named failure. Checked against the shipped code, not the description:
  `namesAFile(token) ? token : stripTrailingAnnotation(token)` on both `paths` and `specifiers`, with
  `stripTrailingAnnotation = token.replace(/:[A-Za-z0-9_.-]+$/, "")`, and `trimPathToken`'s `:\d+$` stage intact.
- **F2 (was Low) — closed.** The dated snapshot is replaced by a pointer to `checkRepositoryAdrReferences`,
  `checkRepositoryAdrConsumers` and `checkRepositoryAdrLinks`; all three exports exist, so no figure is published
  that a reader cannot re-derive.

### Recorded, no change requested

- The implementer committed with `--no-verify` because `pnpm lint-staged` aborted on
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; the identity check and prettier were run by hand and CI's `lint`
  and format gates passed on the pushed head.
- The census figures this record carried before the amendment (`1250` / `174` / `149` / `1101` / `16` at `960bb02`)
  were accurate for their head but named no commit; removing them, rather than pinning a head, is the option the
  card sanctioned and the one that cannot go stale.

## Review sign-off (module split, round 1 — artifact lens, landed)

### Scope

The module split delivered on PR [#521](https://github.com/yahodu/openpic-webapp/pull/521) — card
`t_85523d51` (GREEN: one module per invariant behind a frozen barrel) with the RED spec split
reviewed alongside it. Reviewed at head `79e132e`, landed as squash `1a492ae`. This section records
that round only; it amends no contract and mints no number.

### Verdict and landing proof

- **APPROVED (round 1, artifact lens).**
- The reviewed bytes are the shipped bytes: `79e132e` and `1a492ae` share the tree hash
  `4793dafa7577a54b69f6c2d57abeeacc7874b65c`.
- 14/14 PR checks pass at `79e132e`.

### Verification, measured by the reviewer

- **Surface unchanged:** 22 exported names before and after, with identical signatures (probe over
  the barrel with aliases resolved). The 13 extra `^export` names live in the five modules and are
  intra-family plumbing.
- **Specs moved, not rewritten:** the `describe`/`it` multiset is identical (174 distinct lines) and
  `expect(` counts 299 = 299.
- **Green on that tree:** `adr-*.test.ts` **218 passed (218)**; full unit **2772 passed | 3 skipped
  (2775)**; `tsc`, `eslint` and `prettier` clean; exact-head CI 14/14.
- **Census (measured by the reviewer):** links 881/292; references 1256 checked / 176 exempt;
  consumers 1256 checked, 0 dangling, 149 verified, 1107 unlisted, 16 declared, 0 issues. That is
  **+5 checked references and +5 unlisted against the pre-split trunk `3e268a0` (1251/1102)** and
  **+6 against the branch base `daf054a` (1250/1101)**: the split adds nine source files whose
  docblocks cite this record, and the guard sweeps its own modules. Direction and cause recorded —
  this is not a behaviour change.
- **Merge resolution:** main's `#529` (`3e268a0`) reframe was carried verbatim into the moved block
  in `adr-consumers.test.ts` (five lines, `diff` against main empty).

### Findings

- **F1** — the census delta above. Recorded, no code change.
- **F2** — invariant (v)'s spec at 2543 lines against the 900-line bound. Recorded in §10 above: the
  delivery stands and the bound was miscalibrated.
- **F3** — the "§1 table" cross-reference pointed one block early. Fixed in §10 and in the six
  docblocks; the table itself did not move.
- **F5** — §10's "floor, never an equality" rule versus the spec's still-equality pin. Closed by
  `t_af27bac3` → `t_0fb1fa25` before this card ran.

### Post-review status

Follow-ups are carried by card, never by an ADR number that is still in flight: `t_af27bac3` →
`t_0fb1fa25` (the census-floor pair — done, squash `ad17a9a`), `t_bd371d4d` (the two-link repair),
`t_03cfe3db` (this card: the §10 exception, the cross-reference and both sign-offs), and PR #525.

## Review sign-off (F1b census floors, artifact + execution lens)

### Verdict and landing proof

- **Verdict: APPROVED** (round 1, artifact + execution lens). **Card:** `t_0fb1fa25` · **PR:**
  [#532](https://github.com/yahodu/openpic-webapp/pull/532) · **Reviewed head:** `d6699b3`
  **Squash:** `ad17a9a` — trees identical (`5bbd2239…` both), branch cut off the squash parent
  `103290f`, so the shipped bytes are the reviewed bytes. Two files: `adr-record-links.test.ts`
  (+32/−17) and this record's §7 (+19/−1). `docs/adr/README.md` and ADR-0300 byte-identical; 292
  records, 0 duplicate numbers.

### What it decided

§7's single floor at the retirement census (`>= 881`) reddened a _repair_: card `t_bd371d4d` removes
exactly two links, so the census reads 879 and the floor failed (`expected 879 to be greater than or
equal to 881`). The replacement is a pair — `checkedLinks >= 860` (2.4 % headroom, tolerates prose
repairs) plus `scannedRecords >= 292` (exact population; a record is never deleted, so it fails only
on a deletion or a narrowed read).

### Measured by the reviewer

In a throwaway worktree at `ad17a9a` (probe specs deleted):

- base `881/292` → 28 passed;
- one temp record with one link `882/293` → 28 passed;
- the F2 two-link repair `879/292` → 28 passed, and the same tree under the retired `>= 881` →
  `1 failed`;
- a narrowed sweep (280 of 292 records) `866/280` → `1 failed` on the population floor while 866
  stays above 860, which is why the pair and not one number is the form;
- a link-parser gap with all 292 records counted gives 866 (green) at 12 records unparsed, 863
  (green) at 20, and 859 (red) at 22 — the residual headroom band, recorded as Info.

### Green on that tree

Focused spec `28 passed (28)`; `adr-*` glob `218 passed (218)`; `adr-numbering.test.ts`
`29 passed (29)`; full unit `2772 passed | 3 skipped (2775)`; `prettier --check` clean; exact-head CI
15/15.

### Findings, all Info, no code change

- The handoff's "moves zero reference tokens" is off by two (`checkRepositoryAdrReferences` 1257 →
  1259, consumers unlisted 1108 → 1110, the two new citations of this record).
- The residual parser-gap band above.
- This record takes no new row and no new number, per the lane's ledger convention.
- Card `t_bd371d4d`'s body still carries its original placeholder worktree path (its board row and
  a comment carry the right one).

### Follow-ups

By card id, never by an in-flight ADR number: `t_bd371d4d` (the F2 repair, now green under the pair —
no number to bump), `t_03cfe3db` (this card: §10 exception, the §1 cross-reference, and both
sign-offs), `t_0fb1fa25` (closed by `ad17a9a`).

Nothing in §7 is retracted by this section: it records the form the floors take from here on.

## Review sign-off (ADR-0302 §7 resolution-not-correctness, round 1 — artifact lens, landed)

### Scope

The §7 amendment delivered on PR [#538](https://github.com/yahodu/openpic-webapp/pull/538) — card
`t_d7c2e90f`: a link that names a live record of the cited number is green even when that record
decides a different thing, so a repair retargets to the record the sentence means, and names the gap
in prose where no record on `main` decides it. Reviewed at head `77eba0d`, landed as squash `787d00c`.
One file, `+12/−0`: the single `Resolution is not correctness` bullet at `:267-278` on the shipped
tree, between the census-floors bullet and `### 8.`. This section records that round only; it amends
§7 only and mints no number.

### Verdict and landing proof

- **APPROVED (round 1, artifact lens).** No changes were requested and nothing was re-merged: the PR
  was already `MERGED` when the review ran.
- The reviewed bytes are the shipped bytes: `git diff 77eba0d 787d00c` over the record path is empty.
  The only path differing between the two trees is `docs/CONVENTIONS.md`, which is `main`'s own commit
  `6310982` and landed inside the merge window.
- 15/15 PR checks pass at `77eba0d`: `ci`, `unit_test`, `test_coverage`, `lint`, `audit`, `audit-dev`,
  `env-changes`, `secret-scan`, `validate-branch-name`, `validate-pr-title`, `CodeQL`, both `Analyze`
  legs, `Assert CI evidence` and the close side-effect `notify-discord`.

### Measured by the reviewer

- **Census unchanged, and provably cannot move.** `checkRepositoryAdrLinks` on the shipped trunk:
  `ok: true`, 0 issues, **882** links over **294** records — the pre-change pair. Negative control: the
  record restored to its pre-change `6310982` blob, swept in a copied `docs/adr` tree, also measures
  882/294, because the added lines carry no bracket-and-parenthesis target.
- `adr-record-links.test.ts` **28 passed (28)** and `adr-numbering.test.ts` **29 passed (29)**, so
  **57 passed (57)** together; the whole `adr-*.test.ts` glob **218 passed (218)**.
- `prettier --check` on this record: clean, rc=0.
- Ledger: **294** record basenames on the trunk with an empty duplicate-number sweep;
  `docs/adr/README.md` and `ADR-0300` byte-identical to the pre-change tree. No record added, no row and
  no `Next free` cell touched.
- The prose's own citations, checked at source: `ADR-0540` is the OP-114 branding-upload RED; `ADR-0040`
  is the OP-89 identity-lifecycle-hooks RED and mentions `event_organizers` **zero** times;
  `ADR-0560`/`ADR-0561:5` and `ADR-0600:5` now carry the prose form, so both instances are historical as
  the bullet words them.

### Findings, all Info, no code change

- **I1** — the bullet's label attributes the round to `t_bd371d4d` alone, while the F1 instance came
  from the review of `t_81980030`. The trail stays followable: the fix card `t_130572f1` is named inline.
- **I2** — "the OP-104 pointers `ADR-0360`/`ADR-0361`" reads as link targets, where §7's retirement
  bullet records those two as _prose names_. The phrase is the commissioning card's wording verbatim.
- **I3** — the bullet does not cross-reference §7's exact-leaf bullet (`0306` → a different decision
  passed as valid), which already describes this failure mode, minus the policy.

### Post-review status

No follow-up card beyond this sign-off. The F1 site was closed by `t_130572f1` (PR
[#536](https://github.com/yahodu/openpic-webapp/pull/536), squash `302ff4d`) and the F2 site by
`t_bd371d4d` (PR [#534](https://github.com/yahodu/openpic-webapp/pull/534), squash `a9d17bf`). Cards
are cited by id and PRs by number, never by an ADR number that can renumber.
