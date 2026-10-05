# ADR-0013 — Upload guard: pin the `extensionOf` dotless-name branch

- **Status:** Accepted · **Date:** 2026-10-05
- **Relates to:** [ADR-0009](ADR-0009-upload-type-guards.md) (module contract), [ADR-0010](ADR-0010-upload-type-guards-green-implementation.md) (GREEN implementation), [ADR-0012](ADR-0012-upload-magic-byte-variant-pins.md) (residual magic-byte coverage pins)
- **Card:** OP-82 residual coverage `t_0cde968c` (review finding on terminal card `t_f560b50a`, merged `bc55129`)
- **Contract:** `docs/API Contract.md` §5.1.1, §A.2; `docs/CONVENTIONS.md` §9, §10

## Context

At the OP-82 merge head (`bc55129`) every branch of
`apps/web/src/server/settings/upload-guards.ts` was exercised except one: the
dotless-name arm of `extensionOf` (`fileName.lastIndexOf(".") === -1`), which
resolves the extension to the empty string when the client-supplied `fileName`
contains no dot. The merged module reported 100 % statements/lines/functions and
97.82 % branches (45/46); the sole uncovered branch was this one.

The behaviour is already correct and intentional — a name with no dot cannot
name an allow-listed format, so `guardUploadType` must reject it as
`unsupported_extension` (the first claim in ADR-0009 §7's precedence order)
rather than guessing a container from the bytes. What was missing was a spec
that would fail loudly if this arm were later changed (for example, to throw, to
fall back to the declared MIME, or to sniff the bytes first).

## Decision

Keep the current behaviour and **pin it with one characterization spec** in
`apps/web/src/server/settings/upload-guards.test.ts`:

- `guardUploadType({ bytes: <PNG prefix>, fileName: "photo", declaredMimeType:
"image/png" })` returns `reason: "unsupported_extension"`,
  `detectedFormat: null`, `status: 415`, `code: "unsupported_media_type"`,
  `deleteObject: true`, `persist: false`.

No production code changes: this is a **coverage pin**, not a RED→GREEN cycle.
The empty-string extension is not itself allow-listed, so the first lookup in
`guardUploadType` misses and decides the outcome before the MIME or byte claims
are consulted. The declared MIME and the bytes are deliberately valid for an
allow-listed format so the spec proves the _extension_ — not a downstream
check — is what refuses the upload.

## Consequences

- `upload-guards.ts` moves to **100 % branches** (46/46) from 97.82 % (45/46);
  statements/lines/functions remain at 100 %.
- A future change to the dotless-name arm (throw, MIME fallback, byte-first
  sniffing, or silently accepting) breaks this spec instead of shipping
  unnoticed.
- The refusal contract for an extension-less upload is now explicit rather than
  inferred from the extension-allow-list specs.

## Alternatives considered

- **Leave the branch untested** — rejected: `tdd_required` asks for a spec on
  shipped behaviour, and an untested refusal arm could silently regress to an
  accept.
- **Treat the branch as unreachable** — rejected: a dotless `fileName` is a
  trivially reachable hostile-client input (any upload whose name has no dot),
  not dead code.
- **Make `extensionOf` throw on a dotless name** — rejected: it would turn a
  clean `415 unsupported_extension` into an internal error and contradict the
  guard's documented "every failure returns the same 415 shape" contract
  (ADR-0009 §7).
