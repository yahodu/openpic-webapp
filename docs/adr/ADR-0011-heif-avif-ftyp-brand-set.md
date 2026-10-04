# ADR-0011 — HEIF/AVIF `ftyp` major-brand set accepted by the upload type guard

- **Status:** Accepted · **Date:** 2026-10-04
- **Relates to:** [ADR-0009](ADR-0009-upload-type-guards.md) (module contract — detection returns a container id), [ADR-0010](ADR-0010-upload-type-guards-green-implementation.md) (GREEN implementation; its Consequences explicitly deferred this broadening to this follow-up)
- **Card:** OP-82 follow-up RED `t_536d2d35` (GREEN child `t_5ebc1717`)
- **Contract:** `docs/API Contract.md` §5.1.1 (`supportedMimeTypes`), §A.2 (`unsupported_media_type` → 415); `docs/CONVENTIONS.md` §10
- **Supersedes nothing:** ADR-0009 remains accepted; this ADR only widens the set of `ftyp` major brands that ADR-0009 §3 maps to the existing `heic`/`avif` containers.

## Context

ADR-0009/ADR-0010 fixed `sniffUploadFormat` to recognise exactly two ISO-BMFF
(`ftyp`) major brands: `heic` → `"heic"` and `avif` → `"avif"` (plus `crx ` →
`"cr3"`). A review finding on the OP-82 follow-up RED card `t_79815559`
(`t_41a594b8`, review of `c50ea12`) established that real `.heic`/`.heif` files
routinely carry a **different** major brand while still being HEIF:

- Apple/Android HEIF still images use `mif1`, `heix`, `hevc`, `hevx` or `msf1`
  (the `hev*` brands denote an HEVC-coded image, `msf1` a multiview/multi-image
  sequence, `mif1` a generic HEIF image).
- AVIF sequences use `avis`; still images use `avif`.

Under the pinned detector those files sniffed to `null` and were rejected as
`415 unsupported_media_type` with `reason: "unrecognized_format"` — i.e. a
valid user photo was refused. Card §4 ("magic bytes for … HEIC/HEIF, AVIF")
covers these brands, so per TDD the RED spec must pin the broadening before the
GREEN child (t_5ebc1717) implements it.

## Decision

`sniffUploadFormat` maps the ISO-BMFF `ftyp` **major brand** at bytes 8…12 to a
container as follows:

| Major brand (`ftyp` bytes 8…12) | Detected container |
| ------------------------------- | ------------------ |
| `heic`                          | `heic`             |
| `heix`                          | `heic`             |
| `hevc`                          | `heic`             |
| `hevx`                          | `heic`             |
| `msf1`                          | `heic`             |
| `mif1`                          | `heic`             |
| `avif`                          | `avif`             |
| `avis`                          | `avif`             |
| `crx `                          | `cr3` (unchanged)  |

1. All HEIF still-image and sequence major brands collapse to the single
   `"heic"` **container**; AVIF major brands collapse to `"avif"`. This matches
   ADR-0009 §3 ("detection yields a container id, not a brand"): the container
   is what the guard compares against an extension's `UPLOAD_FORMATS.container`,
   and the extension (`.heic`/`.heif` vs `.avif`) remains authoritative for
   which `UploadFormat.id` is returned.
2. **Only the magic detection widens.** `allowedExtensions`, `allowedMimeTypes`
   and `UPLOAD_FORMATS` are unchanged, as is the whole `guardUploadType`
   precedence (`unsupported_extension` → `unsupported_media_type` →
   `unrecognized_format` → `type_mismatch`) and the single `415
unsupported_media_type` `{ deleteObject: true, persist: false }` rejection
   shape (ADR-0009 §5–§7).
3. Detection stays a **major-brand** comparison within the 64-byte window. No
   full `ftyp` box walk, and no minor-brand (`ftyp` bytes 16…20) or
   compatible-brand list inspection: the brands above are the ones real
   `.heic`/`.heif`/`.avif` files carry as their major brand, and each is a
   fixed-offset 4-byte compare.

## Consequences

- A genuine `.heic`/`.heif` file carrying `mif1`/`heix`/`hevc`/`hevx`/`msf1`,
  and an AVIF sequence carrying `avis`, are now accepted instead of refused as
  `unrecognized_format`. Every pre-existing brand case (`heic`, `avif`, `crx `)
  stays pinned by its own spec, so a regression that narrows detection fails
  loudly.
- The rejection branch for these brands is the **tested-uncovered gap** named in
  ADR-0010's Consequences; this ADR closes it. After the GREEN child lands,
  `upload-guards.ts` branch coverage may change and the module's coverage
  numbers should be re-read rather than assumed.
- Files whose **major** brand is none of the table remain `unrecognized_format`
  → 415 (fail-closed). A file whose declared extension/MIME is `.heic`/`.heif`
  and whose bytes carry, say, `avif` still fails as `type_mismatch`, because the
  container (`avif`) does not match the extension's container (`heic`).
- The accepted brand set is now a **product-visible policy** alongside the RAW
  set (ADR-0009 §2). If the product owner wants a narrower set, the change is
  one row of the brand table and the corresponding spec fails loudly.

## Alternatives considered

- **Accept by checking the `ftyp` compatible-brands list** — rejected: this
  requires parsing the variable-length box (major brand + minor version +
  compatible brands), is more code than the card asks for, and none of the
  target brands need it — they appear as the major brand.
- **Keep `mif1`/`avif` only and treat the `hev*`/`msf1`/`avis` brands as
  out of scope** — rejected: card §1/§2 explicitly enumerate them, and a
  `.heic` produced by an Android device routinely has `hevc`/`msf1` as its
  major brand, so omitting them leaves real user photos refused.
- **Return distinct containers per brand (e.g. `"heic"`, `"mifi"`)** —
  rejected: the container feeds the extension↔bytes equality check and the
  `UploadContainer` union; a distinct container per brand would force every
  `.heic`/`.heif` extension entry to accept all of them and adds no security
  value (they are all HEIF).
- **Editing ADR-0009 in place** — rejected: `docs/adr/README.md` states accepted
  ADRs are immutable and must be superseded by a new record; ADR-0009's module
  contract is unchanged, so this ADR extends rather than supersedes it.
