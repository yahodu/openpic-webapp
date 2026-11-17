# ADR-0584 — OP-112 follow-up: the handle-registry durability boundary and the secret-source composition seam pinned (characterisation)

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-112 follow-up TEST (`t_48a8e8ce`) · **Branch:** `OP-112-task-handle-durability-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_48a8e8ce`, off `origin/main` `c055cac`
- **Relates to:** [ADR-0580](ADR-0580-op112-object-storage-port-red.md) (the object-storage port contract; §5 the opaque handle, §"Assumptions and open questions" the unpinned signing-secret source), [ADR-0581](ADR-0581-op112-object-storage-port-green.md) (the GREEN; §3 the per-instance registry and its "open for the upload-route lane" durability note), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation — this record takes the lane's next free `0584`), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (RED-by-design; characterisation pins are green on the trunk, so this PR is not draft)

## Context

Round-1 review of PR #367 (OP-112 object storage port) routed two open items to
the Test Author. Both are _documented_ open items whose **boundary** was
unpinned — nothing asserted the boundary that exists today, so a future change
to the open item could land silently:

- **Pin 1 (Medium) — handle-registry cross-restart durability.** ADR-0581 §3
  records that `resolveHandle` only answers for the life of the issuing
  process: the object key is unrecoverable from the token, so the service
  resolves it from a **per-instance registry** keyed by the issued token, and
  "a deployment that must resolve handles across restarts or instances moves
  this map behind a shared store (the existing Upstash Redis) — the refusal
  surface is identical." No test asserted that a handle issued by one
  `createHandleService()` instance is refused by a fresh instance with the
  **same secret** — i.e. that durability is genuinely process-scoped today.
- **Pin 2 (Low) — secret-source composition.** ADR-0580 records that "the
  handle signing secret's source is unpinned. The service takes `{ secret }`
  explicitly; the composition root may reuse the existing
  `MEDIA_SIGNING_SECRET_CURRENT` env or add a storage-specific secret — no
  test names the environment variable." Nothing asserted that
  `createHandleService` / `createMediaSigner` read **no** environment at
  module load (pure constructors), with the composition root deciding where
  the secrets come from.

## Decisions

### 1. Pin the cross-instance durability boundary — the registry is per-instance today

Two new unit specs pin the boundary ADR-0581 §3 claims:

- `apps/web/src/test/unit/handle-registry-durability.test.ts` — a handle
  issued by one `createHandleService({ secret })` instance is refused by a
  **fresh** instance constructed with the **same secret**; the refusal is the
  documented `bad_request` `AppError` (`code: "bad_request"`, `status: 400`,
  non-retryable) — the "refusal surface is identical" claim made executable —
  and the issuing instance still resolves the very same handle (so the
  boundary is the registry, not a broken token).
- `apps/web/src/test/unit/secret-source-composition.test.ts` — importing the
  two modules performs no env read and the constructors are pure (see §2).

The future shared-store lane (Upstash Redis) that moves the registry behind a
shared store turns these pins **red by design** — they are the executable
statement of the open item, so the durability change cannot land without
deciding to flip the pins.

### 2. Pin the secret-source composition seam — pure constructors, env injected at the composition root

`createHandleService({ secret })` and `createMediaSigner({ currentSecret,
previousSecret?, clock? })` are pure constructors; the composition root (e.g.
`branding-upload.ts`, which reads `getConfig().media.*` at **call** time)
decides where the current/previous secrets come from. The new pins assert:

- importing `@/server/storage/handles` and `@/server/media/signer` with the
  candidate secret-source env vars (`MEDIA_SIGNING_SECRET_CURRENT`,
  `MEDIA_SIGNING_SECRET_PREVIOUS`) **unset** succeeds and a service built with
  an explicit secret works — an import-time env read (a module-scope
  `getConfig()`, a bare `process.env.MEDIA_SIGNING_SECRET_CURRENT` that throws
  when unset) fails here before any assertion runs;
- a **poisoned** `MEDIA_SIGNING_SECRET_CURRENT` never leaks into a signer
  built with an explicit secret: the signer keyed by the explicit secret
  verifies its own URL while a signer built with the env value does not — the
  constructor argument is the only secret source.

### 3. No production change — the durability open item stays open

This card pins the boundary; it does not close the open item. The diff is two
new test files, this ADR and the README ledger cells. No production file, no
existing test, mock, fixture or factory is touched.

## Number allocation

The OP-112 media foundations lane (`0580`–`0599`) holds `0580` (OP-112 RED),
`0581` (OP-112 GREEN), `0582`/`0583` (OP-113 RED/GREEN). This record takes the
lane's next free **`0584`** — the cell's value re-read on `origin/main`
(`c055cac`) immediately before committing — and advances the cell to `0585`.
No number outside the lane range `0580`–`0599` is touched. The sibling
follow-up cards `t_630fbbd8` (OP-114, `0540`–`0559`) and `t_c469c799`
(OP-113, same `0580`–`0599` block) run concurrently; the shared
`docs/adr/README.md` is the known serialization hotspot and must be
union-resolved at merge keeping every cell at its highest value.

## Evidence

At the pin head (`c055cac` + the two new specs), with a **fresh** `pnpm
install --frozen-lockfile --offline` (the shared node_modules symlink in the
original worktree resolves `@openpic/contracts` to a pre-OP-114 copy and is
not usable here):

- The two new specs are **green on the trunk** (characterisation — no GREEN
  sibling is created): `handle-registry-durability.test.ts` **3 passed (3)**,
  `secret-source-composition.test.ts` **3 passed (3)**.
- **Mutation probes** (throwaway copies mutated via a script, restored
  byte-identical — `sha256` matched, `git diff` empty afterwards):
  - Probe 1 (Pin 1): the registry moved from the per-instance closure to a
    module-level `Map` → the durability pins redden
    (`AssertionError: expected function to throw an error, but it didn't`,
    3/3 failed), exactly the "shared module-level store" mutation the card
    names.
  - Probe 2 (Pin 2): `createMediaSigner` prefers
    `process.env.MEDIA_SIGNING_SECRET_CURRENT` over its constructor argument →
    the poisoned-env pin reddens
    (`AssertionError: expected true to be false`, 1/3 failed).
- Existing storage-lane assertions **byte-identical and green**: the four
  storage unit specs **50/50** and the R2 integration spec **10/10** are
  untouched and pass; full unit project **134 files / 2221 passed | 3
  skipped** (trunk 132 files / 2215 passed | 3 skipped + exactly this card's
  2 files / 6 tests).
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint **0 problems** on
  both new files; `prettier --check` clean; the `adr-numbering` guard green.

## Assumptions and open questions

- **The card's "ADR-0520/0521/0522" references map to the trunk's
  ADR-0580/0581/0582.** The OP-112 lane was renumbered `0520`–`0539` →
  `0580`–`0599` at integration (OP-115 claimed `0520`/`0521` first); the open
  items quoted live in ADR-0580 §"Assumptions" and ADR-0581 §3.
- **Pin 3 is out of scope here.** The card's informational Pin 3 (the
  `export → /o/` mapping and the unvalidated `contentHash`/`ext` assumptions,
  ADR-0582) is left to the OP-113 follow-up card `t_c469c799` unless it lands
  naturally; it did not.
- **Scope of the import-purity pin.** The "import with the secret-source env
  unset" assertion detects an import-time env read that throws or validates
  (the realistic shape — this repo's `getConfig()` throws `ConfigError` on a
  missing required secret). A hypothetical silent `?? fallback` read that also
  ignores the constructor argument is caught for the signer by the
  poisoned-env pin; for the handle service the constructor argument is not
  observable outside the issuing instance (the per-instance registry), so the
  import-with-env-unset + same-instance round-trip is the honest boundary
  there.
- **Worktree deviation.** The card's primary worktree
  (`/root/openpic/openpic-webapp/.worktrees/t_c103668d`, branch
  `wt/t_c103668d`) is being written concurrently by the sibling follow-up
  card `t_630fbbd8`, so — per the card's own fallback ("or a fresh worktree
  of the same SHA") — this card used a fresh worktree
  `/root/openpic/openpic-webapp/.worktrees/t_48a8e8ce` off `origin/main`
  `c055cac`.
