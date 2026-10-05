# ADR-0010 — Upload type guards GREEN implementation: sniff order, logging, and the extension-authoritative TIFF containers

- **Status:** Accepted · **Date:** 2026-10-04
- **Relates to:** [ADR-0009](ADR-0009-upload-type-guards.md) (the module contract this implements), [ADR-0008](ADR-0008-platform-settings-green-implementation.md) (the same RED→GREEN pairing pattern)
- **Card:** OP-82 follow-up GREEN `t_41a594b8` (RED parent `t_79815559`)
- **Contract:** `docs/API Contract.md` §5.1.1, §A.2; `docs/CONVENTIONS.md` §9, §10

## Context

ADR-0009 fixed the _contract_ of `apps/web/src/server/settings/upload-guards.ts`
from the RED specs: module path, exports, the two allow-lists, the per-format
table, the 64-byte window, and the single `415 unsupported_media_type`
`deleteObject`/`persist:false` rejection shape. The GREEN card then had to write
the implementation, and a few details ADR-0009 left to the code had to be
settled:

1. The exact **order** of the magic-byte checks (several signatures share a
   prefix: CR2 begins with a TIFF-LE header, and ORF/RW2 begin with `II`).
2. How to **log** a refusal without violating the card's "log through the
   `Logger` port — no `console.*`" constraint (ADR-0009 never named a log line).
3. Which TIFF/ORF endianness and brand variants to accept when the RED spec
   pins only one representative prefix each.
4. Where the still-pending **product sign-off** on the RAW set is recorded.

## Decision

1. **Check order in `sniffUploadFormat`** is: JPEG, PNG, WebP, ISO-BMFF
   `ftyp` brand, **CR2**, ORF (`IIRO`/`MMOR`/`IIRS`), RW2 (`IIU\0`), RAF
   (`FUJIFILM`), then generic TIFF. CR2 is tested **before** TIFF because a CR2
   file's first four bytes are the TIFF-LE header; a bare TIFF-LE header that
   lacks Canon's `CR` marker at offset 8 falls through to `"tiff"`. ORF/RW2
   cannot be confused with TIFF (their bytes 2–3 are not `2a 00`) but are
   listed explicitly for clarity.
2. **Generic TIFF accepts both endiannesses** (`II*\0` little-endian and
   `MM\0*` big-endian). The RED spec pins only the little-endian prefix; the
   big-endian form is the same container and accepting it is the general
   behaviour the spec exemplifies rather than a fixture-specific special case.
   `NEF`/`ARW`/`DNG` therefore sniff as `"tiff"`, per ADR-0009 §3.
3. **A refusal is logged at `debug` through the `Logger` port** as
   `upload.rejected` with `{ event, reason, detectedFormat }`. The guard returns
   a value; it never throws and never writes to `console`. Production's default
   `info` floor drops the line unless an operator raises `LOG_LEVEL`, so the
   hot path stays quiet by default. Tests call the guard many times, so the line
   must not carry the raw bytes or the fileName — only the derived reason and
   container are logged.
4. **`guardUploadType` returns the extension's `UploadFormat.id`** (not the
   detected container) on acceptance, because several extensions share the
   `tiff` container; the extension is what disambiguates `NEF` from `DNG`.
5. **The RAW set remains pending product sign-off.** The card's enumerated set
   (`CR2/CR3/NEF/ARW/DNG/ORF/RAF/RW2`) ships as chosen by ADR-0009 §2; this ADR
   does not change it. If the product owner removes an extension, exactly one
   row of `UPLOAD_FORMATS` changes and the RED spec that pins it fails loudly.

## Consequences

- The global coverage gate still reports below 80 % because many
  `apps/web/src/server/**` modules outside this card are at 0 % (pre-existing;
  the coverage run is currently commented out in CI). **This module clears the
  door on its own**: 93.75 % lines / 90 % branches / 100 % functions at
  delivery.
- The guard is a pure, synchronous unit: no DB, blob or network boundary. The
  delete-and-write-nothing behaviour is a return-shape signal consumed by the
  upload route (§5.3/§5.4), owned by its own story.
- A raw upload with `.nef`, `.arw` or `.dng` cannot be told apart by container
  alone; all three are allowed TIFF containers, so this is not a security gap,
  but a future brand check must read past the first 64 bytes (ADR-0009).
- HEIF/AVIF brand coverage remains deliberately narrow (`heic`, `avif`,
  `crx `): the follow-up RED `t_536d2d35` broadens it (`mif1`/`heix`/`hevc`/
  `hevx`/`msf1`, AVIF `avis`), so the branch that rejects those brands is the
  intended, tested-uncovered gap rather than an oversight.

## Alternatives considered

- **Sniff TIFF first, then refine to CR2** — rejected: it would need a second
  pass and a special case to un-detect the already-returned `"tiff"`; ordering
  the specific signature first is simpler and branch-free.
- **No logging in the guard** — rejected: the card's constraint asks for the
  `Logger` port, and a rejection is the one event worth observing without the
  route duplicating it. Logging at `debug` keeps it off the production floor.
- **Accepting only the pinned little-endian TIFF prefix** — rejected: it would
  reject legitimate big-endian TIFF originals the allow-list accepts, and the
  RED spec's `it.each` table is representative, not exhaustive.
- **Lower-casing the extension but not the MIME** — accepted as-is: the
  contract's MIME values are lower-case literals and the declared type is
  compared exactly; only the extension is documented as case-insensitive.
