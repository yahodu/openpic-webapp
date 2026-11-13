# ADR-0822 — OP-134 GREEN: `GET /me/events` answers `galleryUrl: ""` when the event has no active access link

- **Status:** Accepted
- **Lane:** the shared attendee block `0780`–`0798` is exhausted, so this
  record draws from the `unallocated (future lanes)` pool — the
  [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md) precedent. At
  this head both `Next free` cells read `0820`, while `0820` is in flight on
  `origin/OP-132-task-confirm-tx-failure-pin` (`ADR-0820-op132-confirm-transaction-failure-pin.md`)
  and `0821` on `.worktrees/t_edad86b6`
  (`ADR-0821-op132-confirm-burst-pin.md`), so under
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7 this record
  draws **`0822`** and both cells advance to `0822`.
- **Satisfies:** the four pins of
  [ADR-0819](ADR-0819-op134-my-events-gallery-url-pin.md)
  (`apps/web/src/test/integration/my-events-gallery-url.test.ts`), carried onto
  this branch unchanged: **F4a** `accessLinks: []` → `slug: ""` and
  `galleryUrl: ""`; **F4b** a dead `active: false` link → the same pair; **F4c**
  the claim's `""` answer for the same fixture, recorded as the reference; **F4d
  control** one active-link fixture through both §6.7 surfaces, so a fix cannot
  pass by emptying every URL.
- **Amends:** nothing. [ADR-0819](ADR-0819-op134-my-events-gallery-url-pin.md)
  is a RED pin record and is not edited; nor is ADR-0815, whose §5 sentence this
  GREEN completes for the no-active-link arm.
- **Consumes:** `0822`.

## Context

The two §6.7 surfaces derive the same path two different ways.
`cross-tenant.ts` reduces the event's access links to the first `active: true`
slug and defaults a miss to `""`; the claim then asks
``slug === undefined ? "" : `/e/${slug}/gallery` `` (`claim.ts:117-120`), while the
list interpolated the projection's `""` unconditionally
(`route.ts:90`, `/e/${item.slug}/gallery`). One fixture — a caller's own
`subject.kind: "user"` profile on an event with no active link — therefore
answered `""` on the claim and `"/e//gallery"` on the list, a path no route
serves.

## Decision

1. **The list applies the claim's rule to the slug it already holds.** One line:

   ```ts
   galleryUrl: item.slug === "" ? "" : `/e/${item.slug}/gallery`,
   ```

   `slug` keeps the raw active slug (`""` when there is none, contract §6.7); the
   projection, the `z.string()` schema and the thirteen keys are unchanged, so no
   client learns a second shape and no key becomes nullable.

2. **The claim is not touched.** It already answers `""` (`F4c`), and it is the
   representation F4a/F4b pin the list to.
3. **The reachable arm is untouched.** A non-empty slug still answers
   `/e/{slug}/gallery`, which F4d asserts against the claim's own
   `claimed[].galleryUrl` for the same fixture.

## Evidence — measured on this branch (`OP-134-task-me-events-gallery-url-empty`)

- **RED before the change**, carried from the pin branch `320077e`:
  `Tests 2 failed | 2 passed (4)`, both `AssertionError: expected '/e//gallery'
to be ''`.
- **GREEN after the change**: the pin file `4 passed (4)`, and together with the
  two frozen neighbours `my-events.test.ts` + `attendee-claim.test.ts`,
  `3 passed (3)` files / `18 passed (18)`.
- The spec file, its helpers and every fixture are byte-identical to `320077e`
  (`git diff 320077e -- apps/web` is the one route line).

## Consequences

- The two §6.7 answers converge on one representation with one line changed; a
  client that shows "open gallery" must treat the empty string as "no gallery",
  which is exactly what the claim already requires of it.
- The list keeps deriving the path from the slug rather than from the event row,
  so the two surfaces still hold two copies of the rule; a third surface adding
  a gallery URL should reuse the claim's `galleryUrlOf` rather than a template.

## Review — round 1 (artifact lens), card `t_e9bc6c07`

**Verdict: APPROVED WITH FINDINGS.** The delivery is PR #579, reviewed at head
`b5930a0` and squash-merged as `ad5b1ce`. The reviewer made **zero edits** to the
deliverable, and this append mints no number and adds no ADR file.

**No section of this record is retracted.** §Context, §Decision, §Evidence and
§Consequences stand as written. The two findings below are prose and format
defects — one in the ledger's rendering, one in §Context's spacing — and both are
fixed by this card; the info item is an observation §Consequences already states.

### The reviewed bytes are what shipped

`git diff --stat b5930a0 ad5b1ce` over the PR's five paths
(`me/events/route.ts`, `my-events-gallery-url.test.ts`, ADR-0819, this record,
`docs/adr/README.md`) is **empty**, so a suite run at the reviewed head applies to
the squash verbatim. The spec file is byte-identical to the pin head `320077e`:
`git diff --stat 320077e b5930a0 -- apps/web/src/test` is empty.

### Re-measured at `b5930a0`

- the pin: `4 passed (4)`;
- the pin plus the two frozen neighbours (`my-events.test.ts`,
  `attendee-claim.test.ts`): **3 files / `18 passed (18)`**;
- full unit: **178 files / `2938 passed` + 3 skipped**;
- full integration: **129 files / `1326 passed`** (`TMPDIR=/root/tmp-mongo`);
- `tsc` on the three projects: exit `0`; `eslint`: clean; `prettier --check`:
  clean on the three touched files;
- `gh pr checks 579`: **14/14**.

This append re-ran the pin and its two neighbours on its own branch: **3 files /
`18 passed (18)`**, so the docs edit leaves the pinned bytes green.

### The pin is load-bearing both ways

Two mutation probes in a throwaway worktree:

- reverting the one decision line: `2 failed | 2 passed (4)`, both cases
  `expected '/e//gallery' to be ''`;
- replacing it with `galleryUrl: ""` for **every** event: `1 failed | 3 passed (4)`
  on the F4d control, whose message is
  `expected '' to be '/e/op134-f4-control000004/gallery'`.

Neither the defect the pin was written for nor the weak empty-every-URL "fix"
passes the set, so the four cases are load-bearing rather than decorative.

### Findings

- **F4-R1a (Low) — a backtick-carrying expression inside single backticks.** The
  `0822` row of `docs/adr/README.md` and the OP-134 GREEN lane paragraph printed
  the ternary as one code span; a single-backtick span cannot contain backticks,
  so GitHub rendered code, then a plain fragment, then a stray backtick. Fixed in
  words instead: `galleryUrl` is `/e/{slug}/gallery` when the slug is non-empty
  and the empty string otherwise. §Decision keeps the literal line, so the
  decision itself is unchanged.
- **F4-R1b (Low) — three missing spaces in §Context**, around
  `subject.kind: "user"`, `""` and `"/e//gallery"`. The spaces are restored here.
  They cannot simply be typed in: prettier re-prints this paragraph, and it drops
  the spaces next to inline code while the sentence above still carries an
  escaped inner backtick inside a single-backtick span — the same defect class as
  F4-R1a, and the reason the delivery shipped without them. That span now uses
  double-backtick delimiters, so the literal code and its rendering are unchanged
  (CommonMark strips the one padding space on each side). The fenced `ts` block,
  §Decision's literal line and the wording of every other sentence are untouched.
- **Info, deliberately no card — the rule has two homes.** The route keeps its
  own copy of the rule while `claim.ts` keeps `galleryUrlOf`, so a third gallery
  surface can drift again. §Consequences states it; recording it here rather than
  pinning it is deliberate, because a dedupe is a behaviour change that needs its
  own pins first.

### Numbering

This append consumes **no** number and adds no ADR file: it edits this record and
its two index blocks only. The trunk's `Next free` cells read `0824` at this
branch's base, because the OP-132 burst lane's `0821`/`0823` landed after this
record; this append leaves both cells byte-identical.
