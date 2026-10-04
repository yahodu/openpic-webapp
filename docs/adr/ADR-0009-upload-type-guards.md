# ADR-0009 — Upload type guards: extension + MIME + magic bytes, delete-and-write-nothing on mismatch

- **Status:** Accepted · **Date:** 2026-10-04
- **Relates to:** [ADR-0007](ADR-0007-platform-settings-singleton.md) (the settings singleton), [ADR-0008](ADR-0008-platform-settings-green-implementation.md) (deferred §4 to this card)
- **Card:** OP-82 follow-up RED `t_79815559` (GREEN child `t_41a594b8`)
- **Contract:** `docs/API Contract.md` §5.1.1, §5.4, §A.2; `docs/CONVENTIONS.md` §10

## Context

OP-82 §4 ("Upload type guards") deferred the upload type-guard module to this
card because the OP-82 RED specs only pinned the settings singleton. Card §4
requires the guard to read the first 64 bytes of a presigned object, check the
file type against `settings.upload.allowedTypes` using **extension + MIME +
magic bytes**, and on a mismatch return `415` while **deleting the object and
writing nothing**. The card also flags two decisions that were not pinned:

1. The exact RAW set needed "product confirmation".
2. The mismatch outcome's code was written as `unsupported_format`, which is not
   an HTTP error code in the contract.

Per `docs/CONVENTIONS.md` §10 the **API contract outranks card prose**, so this
ADR resolves both and fixes the module contract the GREEN card must implement.

## Decision

The module lives at `apps/web/src/server/settings/upload-guards.ts` (import
specifier `@/server/settings/upload-guards`) and exports `SNIFF_BYTES`,
`allowedExtensions`, `allowedMimeTypes`, `UPLOAD_FORMATS`, `sniffUploadFormat`,
`guardUploadType`, and the types `UploadFormatId`, `UploadFormat`,
`UploadContainer`, `UploadGuardInput`, `UploadGuardResult`, `UploadAccepted`,
`UploadRejected`, `UploadGuardRejectionReason`.

1. **Two allow-lists plus one format table.**
   - `allowedExtensions` is the literal set of accepted extensions:
     `.jpg .jpeg .png .webp .heic .heif .avif .tif .tiff .cr2 .cr3 .nef .arw
.dng .orf .raf .rw2`.
   - `allowedMimeTypes` is **exactly** contract §5.1.1's `supportedMimeTypes`
     (`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`,
     `image/avif`, `image/tiff`). No RAW-specific MIME is added: the contract's
     own §5.4 example sends a `.NEF` with `"mimeType": "image/tiff"`.
   - `UPLOAD_FORMATS` maps each format id to its `extensions`, `mimeTypes` and
     its magic-byte `container`, and the two allow-lists are the flattened
     columns of that table.
2. **The RAW set is `CR2 / CR3 / NEF / ARW / DNG / ORF / RAF / RW2`**, exactly as
   enumerated in card §4. The card required product confirmation before pinning
   it; the supervisor was not reachable in this headless run, so the card's own
   enumerated set is recorded here as the **chosen set and remains pending
   product sign-off** (see Consequences). The supervisor is asked to confirm via
   a card comment.
3. **Detection yields a container id, not a brand.** `sniffUploadFormat(bytes)`
   returns `"jpeg" | "png" | "webp" | "heic" | "avif" | "tiff" | "cr2" | "cr3" |
"orf" | "raf" | "rw2" | null`. `NEF`, `ARW` and `DNG` are TIFF-container
   formats whose brand marker has **no fixed offset within the first 64 bytes**
   (the `Make`/`DNGVersion` tags live in the IFD), so they sniff as `"tiff"` and
   the **extension is authoritative** for them; their `UPLOAD_FORMATS` entry
   therefore carries `container: "tiff"`. `CR2` (TIFF + `"CR"` at offset 8),
   `ORF` (`IIRO`/`MMOR`/`IIRS`), `RW2` (`IIU\0`) and `CR3` (ISO-BMFF `ftyp`
   brand `crx `) do have distinctive markers and sniff to their own id.
4. **Sniffing window is 64 bytes** (`SNIFF_BYTES = 64`), and a buffer only needs
   to carry the bytes a given signature occupies — a 3-byte JPEG prefix already
   sniffs as `"jpeg"`. Empty or truncated buffers return `null` and never throw.
5. **The mismatch outcome is the contract's 415 `unsupported_media_type`**, not
   `unsupported_format`. Contract §A.2 defines `unsupported_media_type` → `415`
   with `details: { supportedMimeTypes }`; `unsupported_format` is the image
   pipeline worker's failure code (§10.3.3, "should have been caught at
   upload") and is not an HTTP error code. Card §4's wording is superseded.
6. **Every rejection is a single discriminated shape** that both transports the
   HTTP outcome and signals the cleanup:
   ```ts
   interface UploadRejected {
     ok: false;
     status: 415;
     code: "unsupported_media_type";
     reason:
       "unsupported_extension" | "unsupported_media_type" | "type_mismatch" | "unrecognized_format";
     detectedFormat: UploadContainer | null;
     details: { supportedMimeTypes: readonly string[] };
     deleteObject: true; // the stored object must be deleted
     persist: false; // no mediaAssets/eventImages row may be written
   }
   ```
   `guardUploadType` is synchronous (the caller has already read the bytes it
   presigned) and returns `{ ok: true, format }` on success.
7. **Check precedence.** Extension ∈ `allowedExtensions` (case-insensitively)
   first → declared MIME ∈ `allowedMimeTypes` → magic detected non-null →
   detected container matches the extension's format container → declared MIME
   ∈ that format's `mimeTypes`. The first failing check decides `reason`, so an
   unknown extension is reported even when the MIME and bytes are also wrong.

## Consequences

- A renamed extension, a spoofed `Content-Type`, or bytes that disagree with
  either now fail the spec instead of silently shipping past the guard.
- The RAW set is **pending product confirmation**. If the product owner removes
  a RAW extension, exactly one entry in `EXPECTED_FORMATS`-style data changes;
  the spec fails loudly on the mismatch. This is the item the supervisor must
  confirm.
- `upload.supportedMimeTypes` in `platformSettings` (ADR-0008) and the guard's
  `allowedMimeTypes` both mirror contract §5.1.1. Wiring a settings-driven
  override into the guard is **out of scope** for this card; these specs pin the
  structural allow-list only.
- No DB or blob boundary is involved: the guard is a pure unit. The
  delete-and-write-nothing behaviour is asserted on the return shape, which the
  upload route (§5.3/§5.4) consumes; the route itself is owned by its own story.
- `NEF`/`ARW`/`DNG` sniff to `"tiff"`, so the guard cannot by itself tell a
  `.nef` from a `.dng`; every such file is a TIFF container and all are allowed,
  so this is not a security gap, but a future brand-level check must read beyond
  the first 64 bytes.

## Alternatives considered

- **HTTP 415 code `unsupported_format`** — rejected: not in the contract error
  set; `docs/CONVENTIONS.md` §10 ranks the contract above card prose.
- **One `UploadFormat` id per RAW brand with its own magic** — rejected:
  `NEF`/`ARW`/`DNG` have no reliable fixed-offset signature within 64 bytes, so
  pinning a fake magic would either be wrong or force a full IFD parse the card
  does not ask for.
- **Returning only a boolean** — rejected: the route must both answer 415 and
  delete the object; a discriminated result carrying `status`/`code`/`details`
  and the `deleteObject`/`persist` flags is consumed without re-deriving policy.
- **Requiring a full 64-byte body** — rejected: it would reject small but valid
  images and contradicts "fewer than the sniff length" being handled.
