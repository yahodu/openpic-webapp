# ADR-0540 — OP-114 RED: the branding asset upload — the single byte-accepting endpoint

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-114 RED (`t_2adaddec`) · **Branch:** `OP-114-task-branding-asset-upload` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_2adaddec`
- **Relates to:** [ADR-0520](ADR-0520-op112-object-storage-port-red.md) / [ADR-0521](ADR-0521-op112-object-storage-port-green.md) (the OP-112 storage port this route calls), [ADR-0522](ADR-0522-op113-media-url-signer-red.md) / [ADR-0523](ADR-0523-op113-media-url-signer-green.md) (the signer this route mints the URL with), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation — this card draws its **own** block `0540`–`0559`, see §8), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (RED-by-design posture)
- **Contract:** §2.1 of `docs/API Contract.md` — **"The one byte-accepting endpoint"**:

  ```
  POST /api/v1/tenants/{tenantId}/assets/branding
  Auth `user` + role `owner`|`admin` · multipart/form-data, field `file`,
  ≤ 2 MB, image/png|image/jpeg|image/svg+xml|image/webp
  201 → { "assetId": "...", "kind": "event_logo"|"watermark",
          "url": "https://pic.openpic.in/t/...", "bytes": 48120 }
  413 file_too_large / 415 unsupported_media_type
  ```

  The hard rule at §0.15: image bytes never transit the Next.js control plane in
  **either** direction — every other image endpoint returns or accepts a
  (presigned) URL — and this route is the lone, volume-negligible exception
  that may accept bytes. Schema §16.1 (`mediaAssets`), the OP-112 lane
  (ADR-0520/0521) and the OP-113 lane (ADR-0522/0523) supply the storage port,
  the `branding` location, the content-addressed key builder and the media URL
  signer this route composes.

## Context

OP-114 is the tenancy-side upload half of the branding story: _as a tenant
admin, I want to upload a logo or watermark so that events and thumbnails carry
my brand._ It depends on OP-112 (object storage port), OP-113 (media URL
signer) and OP-100 (the tenant stage/provisioning).

The RED card's test list is behaviour-only — U1 magic-byte detection for each
type and a spoofed extension, U2 the SVG sanitizer removes `script`/`onload`/
`javascript:` hrefs, I1–I7 the route-ladder integration contract, E1 the API
e2e — and names almost no module paths. The sibling GREEN card's scope notes
add the two routes (`POST /tenants/{t}/assets/branding` owner|admin and the
event-scoped `POST /events/{e}/assets/branding` so co-organizers can upload
against the organizer's tenant), a 2 MB **streaming** limit (`413
file_too_large` with `maxBytes`/`actualBytes`), **magic-byte** MIME detection
("not the client header"), SVG sanitizing ("strip scripts/foreign objects/event
handlers … or rejected if unsafe"), a sha256, an upsert on
`mediaAssets (tenantId, contentHash, kind)` in the `branding` location, the
`201 {assetId, kind, url (signed), bytes}` envelope, the JSON-content-type
exemption, and `warn upload.rejected` logging with **never** file contents.
This record fixes the executable contract the tests encode so the GREEN
(`t_73dd4924`) has one coherent spec.

## Decisions

### 1. Module layout

| Module                                                  | Exports                                                                                                        | Drives               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- |
| `@/app/api/v1/tenants/[tenantId]/assets/branding/route` | `POST`                                                                                                         | I1–I6, E1            |
| `@/app/api/v1/events/[eventId]/assets/branding/route`   | `POST`                                                                                                         | I7                   |
| `@/server/media/branding-type`                          | `BrandingFormat`, `BrandingUploadInput`, `BrandingUploadResult`, `sniffBrandingFormat`, `detectBrandingUpload` | U1 + the route's 415 |
| `@/server/media/sanitize-svg`                           | `sanitizeSvg(xml: string): string`                                                                             | U2 + I4              |
| `@/server/storage/get-object-storage`                   | `getObjectStorage(): ObjectStorage`                                                                            | I4's read-back seam  |

Both routes are declared on `defineRoute` with a **colon** template
(`"/api/v1/tenants/:tenantId/assets/branding"`,
`"/api/v1/events/:eventId/assets/branding"`), the `user` auth stage
(`userAuth()`), and **no `body` schema** — that omission is the JSON
content-type exemption: `parseJsonBody` is only ever called when a body schema
exists, so the handler reads the multipart stream itself via
`ctx.request.formData()`. The tenant route adds the reusable `tenantStage()`
(OP-100) and refuses `member` with `403 forbidden` (owner|admin only). The
event route resolves the event from the `{eventId}` segment, authorises an
**active** `event_organizers` row for the caller and attributes the asset to the
event's `tenantId` — the probe's denial status for a non-organizer is `404
not_found` (non-oracle), left unpinned.

### 2. The bytes are the only type evidence (U1, I2, I2b, I3)

`sniffBrandingFormat(bytes)` recognises exactly `png` (8-byte magic), `jpeg`
(`FF D8 FF`), `webp` (`RIFF` … `WEBP`) and `svg` (a text root `<svg` or an
`<?xml` declaration, after leading whitespace) and returns `null` otherwise.
`detectBrandingUpload({bytes, fileName, declaredMimeType})` maps a detection to
`{ ok: true, format, mimeType, extension }` (`png → image/png/.png`,
`jpeg → image/jpeg/.jpg`, `webp → image/webp/.webp`,
`svg → image/svg+xml/.svg`) or `{ ok: false, reason: "unsupported_media_type",
detectedFormat: null }`. **The `fileName` and the declared `Content-Type` are
deliberately not consulted for acceptance** — that is what makes a PNG named
`.svg` a PNG (I2), a PNG declared `application/octet-stream` still accepted
(I2b), and an exe pretending to be `image/png` a `415` (I3). The route's
refusal is `415 unsupported_media_type` with `details.supportedMimeTypes`
exactly the four branding MIME types (contract Appendix A.2).

### 3. SVG sanitization and the content hash (U2, I4)

`sanitizeSvg(xml)` strips `<script>` elements (contents included),
`<foreignObject>` elements, `on*` event-handler attributes and `javascript:`
hrefs (`href` **and** `xlink:href`), while keeping benign markup and harmless
`https` links. It applies to `svg`-detected uploads only; raster bytes pass
through untouched.

The `mediaAssets.contentHash` is the lowercase hex SHA-256 of the **original
uploaded bytes** (schema §16.1 — "SHA-256 of the original bytes. Doubles as the
object key"), so the R2 object key the OP-112 builder mints
(`images/<contentHash>.<ext>`, `buildObjectKey`) names the original while the
stored SVG object's bytes are the sanitized copy. I4 pins both facts: the row's
`contentHash` equals the hash of the raw upload, and the bytes fetched from the
memory store (`getObjectStorage().getObject("branding", key)`) are sanitized
and their length is the response's `bytes`.

### 4. The storage composition root must be stable (I4's read-back seam)

`@/server/storage/get-object-storage` mirrors `getPaymentProvider()` /
`getMessageTransport()`: it selects through the validated `STORAGE_PROVIDER`
config (`memory` for tests/e2e — `makeEnv`'s default — and the OP-112 R2
adapter for `s3`; anything else fails closed with `ConfigError`). On the
`memory` path it must return a **memoized** instance — I4 fetches the stored
object through the same public function the route called, so a fresh store per
call would fail the pin for the wrong reason. With the `memory` selection the
integration suite needs no MSW: the adapter is in-process.

### 5. The response and the signed URL (I2, I4, I6, E1)

`201` carries exactly `{assetId, kind, url, bytes}` (asserted key-for-key):

- `assetId` — the `mediaAssets` document id (hex);
- `kind` — echoes the multipart `kind` form field (`event_logo` provided;
  `watermark` accepted but unpinned — A2 below);
- `bytes` — the **stored** byte count (the sanitized length for an SVG);
- `url` — a `createMediaSigner` signature over `{ kind: "thumbnail",
contentHash, ext }`, so the contract's own `https://pic.openpic.in/t/...`
  example holds: `/t/<contentHash>.<ext>?exp=<unix>&sig=…` with the 24 h
  thumbnail TTL (A3). The tests verify the signature with the same
  `MEDIA_SIGNING_SECRET_CURRENT` the route reads (the `makeEnv` fixture
  default), and the event route's row carries the organizer's tenant (I7).

The tenant route echoes `X-Tenant-Id` (the tenant stage does), asserted in I2.

### 6. Dedupe is the `{tenantId, contentHash}` unique index (I6)

Two uploads of identical bytes into the same tenant answer `201` twice with the
**same `assetId`** and leave exactly one `media_assets` row — the GREEN must
upsert on `{tenantId, contentHash}` (or map the duplicate-key error to the
existing row) rather than blind-insert, or I6's second call regresses to a
`409`/`500`. Dedupe is tenant-scoped (schema §16.1) — the event route shares
the same mechanics under the event's tenantId.

### 7. The size limit and the `file_too_large` code (I1)

The 2 MB limit is **2 MiB = `2_097_152` bytes** (A1), enforced while streaming,
refused as `413 file_too_large` with `details = { maxBytes: 2_097_152,
actualBytes: <file byte count> }` and nothing persisted. `file_too_large` is a
documented contract code (Appendix A.2 — `413, no, { maxBytes, actualBytes }`)
but is **not yet** in the code: the GREEN must append it in the
`cannot_demote_owner` shape — a new closed list in `packages/contracts` joined
into `API_ERROR_CODES`/`AppErrorCode`, plus a transport row in the server
`catalog` (`413`, non-retryable) spread into `TRANSPORT`. Until then the route
cannot even typecheck `appError("file_too_large", …)`.

### 8. Number allocation — OP-114 is its own lane

A dependent ticket does not continue its parent's range (ADR-0300 §7): OP-114
depends on OP-112/113 but is the **first card of its own lane** (epic
"Tenancy", phase 3), so it draws the next free 20-number block from the
`unallocated (future lanes)` pool. The in-flight OP-112 media lane's branch
holds the `0520`–`0539` block (its pool edit reads `0540`+), and under
ADR-0300 §7 an in-flight allocation counts as taken — so this card takes
**`0540`–`0559`**, writes the lane row `OP-114 branding upload lane |
`0540`–`0559`| Next free`0541``, and advances the pool cell to **`0560`+**.
The shared-ledger union at merge keeps every cell at its highest value (the
media lane's `0524` next-free and this lane's `0541` both stand; the pool
settles at `0560`+). The GREEN successor `t_73dd4924` consumes `0541` next.

## Evidence (RED)

- **Unit** — `branding-type.test.ts` (16 cases) and `sanitize-svg.test.ts`
  (5 cases): **21 passed** against throwaway stubs at the exact pinned paths;
  `npx tsc -p apps/web/tsconfig.json --noEmit` exited `0`. At handoff both
  specs are red as `Cannot find package '@/server/media/branding-type'` /
  `'@/server/media/sanitize-svg'`.
- **Integration** — `branding-upload.test.ts` (11 cases): **11 failed** at
  assertion level against 501 route stubs (`AssertionError: expected 501 to be
201/413/403/415/401/404` — the requests, sessions, seeding and multipart
  construction all drive the real path), and **11/11 passed** against a
  throwaway faithful implementation of both routes reusing the real
  `defineRoute`/`userAuth`/`tenantStage` pipeline — proving every exact-shape
  pin (error `details`, `/t/` URL + signature verification, key sets, dedupe
  identity, sanitized storage, tenant attribution) is satisfiable. Run 4×,
  stable 4×. At handoff the file is red as module-not-found.
- **E2E** — `branding-upload.spec.ts` (E1) ran against a standalone build with
  the stubs present: the OTP sign-in and tenant provisioning succeed and the
  journey fails at its own assertion (`expect(uploaded.status()).toBe(201)` →
  `Received: 501`). At handoff (routes absent) the build stays green — the spec
  imports nothing missing — and E1 is red at the final POST.
- The two temporarily-touched production files (contracts `errors.ts`, server
  `catalog.ts`) were restored **byte-identical** (`sha256` verified); `git
status` at handoff shows the four spec files plus this ADR and the ledger.
- `eslint` 0 errors, `prettier --check` clean on all four spec files; the RED
  branch is red-CI by design under ADR-0306.

## Consequences / open items (handed to the GREEN)

- **Unpinned for the GREEN to decide (tests never assert them):** the default
  / rejection behaviour for an omitted or unknown `kind` form field; the exact
  `Location` header of the `201`; the event-route denial status for a caller
  with no organizer row (probe uses `404`); whether `watermark` uploads are
  covered by a dedicated case (kind is echoed generically); the choice between
  sanitizing and rejecting an unparseable SVG ("or rejected if unsafe" is
  allowed — U2/I4's payloads must be **sanitized**, not rejected); file-level
  fields beyond `{tenantId, contentHash, kind, createdAt}` on the
  `mediaAssets` row (OP-127's image pipeline will extend it).
- The `event_organizers` unique partial index at this head allows **one**
  active row per `(tenantId, eventId)` — the I7 fixture seeds only the
  co-organizer's row; the event→organizer-row convention belongs to the OP-115
  lane and may widen the index there.
- The signed URL uses the **thumbnail** derivative (`/t/`, 24 h) per the
  contract's response example, not `/o/` — do not "fix" the segment.
- `upload.rejected` warnings must carry the reason and **never** the file
  contents (logging requirement).
- The GREEN must base its branch on this pins branch, and the OP-112/113 lanes'
  modules (`@/server/storage/*`, `@/server/adapters/memory-object-storage`,
  `@/server/media/signer`) must be in the base — they are not on `origin/main`
  at this writing.
