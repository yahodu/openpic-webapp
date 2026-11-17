# ADR-0585 — OP-113 follow-up TEST: pin "signed URLs are never logged" at the seams that exist, and keep the signer's assumptions assumptions

- **Status:** Accepted · **Date:** 2026-11-03
- **Lane:** OP-113 / OP-112 media foundations, reserved range `0580`–`0599`
- **Card:** `t_c469c799` (follow-up TEST — characterisation pins + composition-boundary
  acquisition), worktree `/root/openpic/openpic-webapp/.worktrees/t_c103668d`, branch
  `OP-113-task-signer-logging-pins`, off `origin/main` `c055cac` (the `1.47.0`
  release chore on top of the OP-113 squash `f6782a3`)
- **Consumes:** `0585`
- **Fixes:** the round-1 review findings on PR #370 — **Pin 1 (Medium):** the
  "signed URLs are never logged" property is recorded but unpinned; **Pin 2 (Low):**
  the signer's recorded assumptions are prose only.
- **Supersedes nothing.** [ADR-0582](ADR-0582-op113-media-url-signer-red.md) (the RED
  contract) and [ADR-0583](ADR-0583-op113-media-url-signer-green.md) (the GREEN) are
  unchanged. This record adds pins over the shipped implementation and records **no
  new contract**.

## Context

ADR-0582 §"Assumptions and open questions" and ADR-0583 record two properties that
nothing in the tree pinned:

1. **"Never log full signed URLs; log counts of URLs signed at debug."** The pure
   signer (`apps/web/src/server/media/signer.ts`) has no logging seam and imports no
   logger; `acceptBrandingUpload` (the only caller of `sign` on the trunk) holds a
   request-scoped logger from `requestLogger(...)`. Neither surface had a pin, so a
   future edit could add `logger.info(url)` and no spec would notice.
2. **`export → /o/` (no `/e/` segment) and `contentHash`/`ext` unvalidated by the
   signer** (the OP-112 key builder, `buildObjectKey`, owns the 64-hex shape and the
   extension allowlist). Both were prose, so a lane could silently assume the signer
   validated — or that a distinct `/e/` segment already existed.

## Decision

Four new spec files, no production change. The card's preferred "add a minimal
composition-root seam" option is **deliberately not taken**: the seam that exists is
`requestLogger` at the route/service boundary that signs today, and adding a
`MediaSigner` wrapper would be production code written to suit a test. The pins
therefore land on the two surfaces that can actually break the property (the signer
module and the signing caller) plus the repository's real lint config.

### Pin 1 — signed URLs are never logged (three lenses)

| Spec                                                     | Surface                                                 | Assertion                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/media-signer-never-logs.test.ts`              | the signer module                                       | with a `debug`-floored memory transport installed through the process logging port, signing all four derivative kinds and verifying (valid + tampered) emits **zero** entries; and none of `console.{log,info,warn,error,debug,trace}` is called                                                    |
| `test/integration/media-signed-url-never-logged.test.ts` | the composition boundary (branding upload route)        | the real `POST /api/v1/tenants/{tenantId}/assets/branding` handler returns `201` with a `/t/<sha256>.png?exp=…&sig=…` URL that OP-113's own signer verifies, and **no emitted entry at any level, under any field** contains the URL, the `sig` value, the data-plane path, or matches `/[?&]sig=/` |
| `test/unit/eslint/media-signer-no-logging-lint.test.ts`  | the repository's resolved ESLint config for `signer.ts` | `console.log(url)` reports `no-console`; `import … from "@/server/logging/create-logger"` reports `no-restricted-imports`                                                                                                                                                                           |

The integration capture is proven live rather than assumed: T2 drives the same route
to `415 unsupported_media_type` and asserts the `upload.rejected` **warn** entry
reaches the sink, and T3 asserts a `debug` entry reaches it. Neither can pass
vacuously.

**Honest boundary (why lint is only half a guard).** The resolved config
_permits_ the `@/server/logging` barrel — that is the import the route legitimately
uses — so lint cannot forbid "any logger at all" in the signer. The behavioural unit
spec is what reddens a barrel-shaped leak. Conversely, lint is what reddens a
`console.*` leak in a module no test happens to execute.

### Pin 2 — the signer's recorded assumptions stay assumptions

`test/unit/media-signer-assumptions.test.ts` (append-only; the 25 OP-113 assertions
in `media-signer.test.ts` are byte-identical):

- `sign({ kind: "export", … })` yields the pathname `/o/<hash>.<ext>` exactly,
  does not match `^/e/`, and verifies — so a lane that adds a distinct `/e/` segment
  must replace this pin, not discover it.
- an `it.each` over nine shapes — non-hex, uppercase, 63-char, 65-char
  `contentHash`, and `svg`/`tiff`/`exe`/`PNG`/`tar.gz` `ext` — asserts the signer
  **binds the path verbatim and verifies it**, i.e. it neither refuses nor
  normalises. Validation, if a lane wants it, becomes a deliberate contract change
  with a pin that has to be rewritten.

## Evidence (every pin bites — mutation probes, files restored byte-identical)

| Probe | Mutation                                                                          | Observed failure                                                                                                                         |
| ----- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | `signer.ts`: `console.log(<full url>)` before `return`                            | `AssertionError: expected "log" to not be called at all, but actually been called 1 times`                                               |
| P2    | `signer.ts`: `getLogger().debug("media url signed", { url })`                     | `AssertionError: expected [ …(4) ] to deeply equal []`                                                                                   |
| P3    | `branding-upload.ts`: `logger.info("branding asset ready", { url })` after `sign` | `AssertionError: expected [ Array(1) ] to deeply equal []` — the received entry carries `"url":"https://pic.openpic.in/t/…?exp=…&sig=…"` |
| P4    | `signer.ts`: throw on a non-`^[0-9a-f]{64}$` `contentHash`                        | `4 failed                                                                                                                                | 6 passed (10)` — the four shape cases red, the other five green |
| P5    | `signer.ts`: `export` segment `"o"` → `"e"`                                       | `AssertionError: expected '/e/3f2c…' to be '/o/3f2c…'`                                                                                   |

The four mutation targets were restored byte-identically after each run (`sha256`
compared before/after, `git diff` empty); `git status` at handoff shows the four
spec files only. Each probe was applied with a throwaway `python3 <script.py>` from
the scratch dir, not by editing the tree in place.

## What a future route lane must add (recorded, not pinned — nothing calls `sign` but the upload service)

Neither behavioural pin sees a **new** caller of `sign`: a route that signs and then
logs is a fresh seam, and pinning it before it exists would need production code. The
lane that adds a media upload/URL route (`GET …/assets/{id}/url`, the originals
export route, the event-scoped twin) owes:

1. Never pass a signed URL, its `sig`, its `exp`, or its data-plane path to
   `requestLogger` / `getLogger` — in the message **or** under a field, including a
   nested context object.
2. Log **counts** of URLs signed, at `debug` only (`{ event: "media.urls_signed",
count }`), never one entry per URL.
3. Add a pin of the integration shape proven here — install a memory transport
   through `setLogger`, drive the handler, assert no entry contains the URL / `sig`
   / path — and prove the capture live with a refusal or debug-probe case.

## Out of scope

- A `MediaSigner` composition-root wrapper (deliberate: production code for a
  test-only card; see Decision).
- Pinning the signer's **TTL** or **rotation** behaviour further — ADR-0582's
  U5/U6 cover it.
- `verify`'s tolerance of malformed input — ADR-0582/ADR-0583 pin it.
- Anything about the Cloudflare Worker (out of this repository).

## Consequences

- The "never log signed URLs" property is now observable at both surfaces that
  exist, and a regression reddens with a message naming the URL, not an opaque
  assertion.
- The two recorded assumptions are characterisation pins: they are **green on the
  trunk today** and become the thing an implementer must replace to change the
  contract.
- No production behaviour changes; no seam is added; the route obligation is
  recorded here and in the lane note, so the future lane cannot claim the property
  was already pinned end to end.
- Residual risk: the lint lens depends on `eslint.config.mjs` keeping `no-console`
  on and `@/server/logging/*` restricted. If a lane loosens either, the two
  behavioural pins still hold, and the lint spec reddens on the config change.
