# ADR-0012 — Upload guard: cover the accepted magic-byte variants (big-endian TIFF, ORF `MMOR`/`IIRS`, unrecognized `ftyp`)

- **Status:** Accepted · **Date:** 2026-10-04
- **Relates to:** [ADR-0009](ADR-0009-upload-type-guards.md) (module contract), [ADR-0010](ADR-0010-upload-type-guards-green-implementation.md) (GREEN: big-endian TIFF accepted; ORF variants listed), [ADR-0011](ADR-0011-heif-avif-ftyp-brand-set.md) (HEIF/AVIF major-brand set)
- **Card:** OP-82 follow-up RED/coverage `t_f560b50a` (review finding on GREEN `t_41a594b8`, commit `5be0e62`)
- **Contract:** `docs/API Contract.md` §5.1.1, §A.2; `docs/CONVENTIONS.md` §9, §10

## Context

The OP-82 upload-guard GREEN (`t_41a594b8`) accepted four real-world magic-byte
variants that **no RED spec pinned**, so `tdd_required` left them as untested
production branches (coverage at `5be0e62`: statements 117/136/178/181
uncovered, branch coverage 90 %):

1. Generic **big-endian TIFF** (`4D 4D 00 2A …`) — the second `||` disjunct of
   the generic-TIFF check; the RED spec pinned only the little-endian
   `49 49 2A 00`.
2. Olympus ORF carrying `MMOR`.
3. Olympus ORF carrying `IIRS` — the RED spec pinned only `IIRO`.
4. `sniffFtypBrand` returning `null` when an `ftyp` box's major brand is one of
   none recognised (e.g. `ftypmp42`).

Each of 1–3 is the _same container_ as an already-allow-listed format reached
through a different valid magic; ADR-0010 §2 already recorded big-endian TIFF as
intended and ADR-0009 §3 enumerated `IIRO`/`MMOR`/`IIRS`. Variant 4 is the
fail-closed default already implied by ADR-0011 (a box with no recognised major
brand is not an accepted image). The defect was not the behaviour but that it
shipped without a spec.

## Decision

Keep every one of these behaviours and **pin each with a spec** in
`apps/web/src/server/settings/upload-guards.test.ts`:

1. `sniffUploadFormat` returns `"tiff"` for a big-endian `MM 00 2A` prefix, and
   `guardUploadType` accepts `.tif`/`.tiff`/`.nef`/`.arw`/`.dng` declared
   `image/tiff` with those bytes — the same container the extension-authoritative
   TIFF entries already use (ADR-0009 §3, ADR-0010 §4).
2. `sniffUploadFormat` returns `"orf"` for both `MMOR` and `IIRS`; `guardUploadType`
   accepts `.orf` declared `image/tiff` for each, exactly as for the pinned `IIRO`.
3. `sniffUploadFormat` returns `null` for an `ftyp` box whose major brand is not
   in the ADR-0011 table (pinned with `mp42`/`isom`), and `guardUploadType`
   reports `reason: "unrecognized_format"` → `415 unsupported_media_type` with
   `deleteObject: true` / `persist: false`.

No production code changes: this is a **characterization/coverage pin**, not a
RED→GREEN cycle. `allowedExtensions`, `allowedMimeTypes`, `UPLOAD_FORMATS`, the
`guardUploadType` precedence and the rejection shape are unchanged. The specs
fail loudly if any of these branches is later narrowed, so the "reject instead of
silently accept" option is now defended by a test rather than by absence.

The card also named the residual uncovered statement for `matches`' short-buffer
guard; that is pinned by a buffer truncated part-way through the PNG signature.
The remaining uncovered branch (`extensionOf`'s dotless-name ternary) is left
alone — it belongs to the extension-allow-list behaviour already pinned by value
and is out of scope for this card.

## Consequences

- `upload-guards.ts` moves to 100 % statements / 100 % lines / 97.82 % branches
  (from 93.75 %/90 % at ADR-0010 delivery); the four named branches and the
  `matches` short-buffer branch are now exercised.
- A future change that drops big-endian TIFF, `MMOR`, `IIRS`, or that makes an
  unrecognized `ftyp` major brand sniff to a container, breaks a spec instead of
  shipping silently.
- The accepted set remains a product-visible policy: if the product owner wants
  to reject these variants (e.g. big-endian TIFF is not in the product RAW set),
  the change is a narrowing of `sniffUploadFormat` and the corresponding spec
  must be rewritten — this ADR records that the current, correct choice is to
  accept them.

## Alternatives considered

- **Narrow the implementation to the originally pinned prefixes** — rejected: it
  would refuse legitimate big-endian TIFF originals and real Olympus `MMOR`/`IIRS`
  files that the extension/MIME allow-lists accept, contradicting ADR-0010 §2 and
  ADR-0009 §3.
- **Leave the branches untested** — rejected: `tdd_required` requires a spec for
  shipped behaviour, and untested acceptance branches could silently regress.
- **A separate GREEN card** — unnecessary: the implementation already matches the
  intended contract, so the spec is a pin, not a RED.
