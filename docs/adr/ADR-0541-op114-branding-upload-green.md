# ADR-0541 — OP-114 GREEN: the branding asset upload implemented — the single byte-accepting endpoint

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-114 GREEN (`t_73dd4924`) · **Branch:** `OP-114-task-branding-asset-upload` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_2adaddec`, stacked on the RED head `a9b39ed` with the OP-112 (`OP-112-feature-object-storage-port`) and OP-113 (`OP-113-feature-media-url-signer`) lanes merged into the base
- **Relates to:** [ADR-0540](ADR-0540-op114-branding-upload-red.md) (the RED contract this card turns green), [ADR-0520](ADR-0520-op112-object-storage-port-red.md)/[ADR-0521](ADR-0521-op112-object-storage-port-green.md) (the storage port + `branding` location + key builder this route calls), [ADR-0522](ADR-0522-op113-media-url-signer-red.md)/[ADR-0523](ADR-0523-op113-media-url-signer-green.md) (the signer this route mints the URL with), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation — this card takes the lane's next free `0541`), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (RED-by-design posture)

## Context

ADR-0540 fixed the executable contract the RED's four specs encode: U1
magic-byte detection and U2 the SVG sanitizer (unit), I1–I7 the route ladder
(integration), E1 the API e2e. This GREEN implements the two routes and the
three modules the ADR's module table names — `@/server/media/branding-type`,
`@/server/media/sanitize-svg`, `@/server/storage/get-object-storage` — plus
the shared upload service (`@/server/media/branding-upload`) and response
schema (`@/server/media/branding-schema`) both routes compose, and the new
`file_too_large` error code (Appendix A.2) in the `cannot_demote_owner`
shape. All four RED spec files ship byte-unchanged.

## Decisions

### 1. Route layout — the ADR module table, verbatim

`apps/web/src/app/api/v1/tenants/[tenantId]/assets/branding/route.ts` exports
`POST` declared on `defineRoute({ route: "/api/v1/tenants/:tenantId/assets/branding",
response: brandingUploadResponseSchema, auth: userAuth(), tenant: tenantStage() })`
with **no `body` schema** — that omission is the JSON content-type exemption:
`parseJsonBody` only runs when a body schema exists, so the handler reads the
multipart stream itself via `ctx.request.formData()` (verified by I2's `x-tenant-id`
echo, which only the tenant stage emits). The handler reads the scope the stage
published and refuses `member` with `403 forbidden` (owner|admin pass, I5/I5b).

`apps/web/src/app/api/v1/events/[eventId]/assets/branding/route.ts` exports
`POST` on `defineRoute({ route: "/api/v1/events/:eventId/assets/branding",
response: brandingUploadResponseSchema, auth: userAuth() })` — no tenant stage,
because I7's co-organizer is NOT a member of the organizer's workspace (A4).
The handler resolves the `{eventId}` segment by position (mirroring
`tenantIdFromRequest`), loads the `events` row, authorises an **active**
`event_organizers` row (`{ tenantId, eventId, userId, revokedAt: null }`) for
the caller, and attributes the asset to `String(event.tenantId)`. A malformed
id, a missing event or a missing organizer row are all `404 not_found` (the
probe's non-oracle denial, unpinned in ADR-0540).

### 2. The upload service — one shared implementation for both routes

`@/server/media/branding-upload` (`acceptBrandingUpload({ tenantId, request,
route })`) holds the byte-path mechanics both routes share, so the contract's
refusal ladder lives in exactly one place:

1. `ctx.request.formData()` → the `file` field; a missing/non-file entry is
   `422 validation_failed` naming `file` (unpinned shape, never asserted);
2. the file is streamed chunk-by-chunk against the 2 MiB cap (`2_097_152`,
   assumption A1) — only the first cap bytes are ever retained, so the size
   limit is enforced **without buffering unbounded data**, while the count
   keeps running to the end so `actualBytes` is the file's true length (I1
   pins the exact `{ maxBytes: 2097152, actualBytes: 2100000 }`);
   `actualBytes > maxBytes` → `413 file_too_large` (nothing hashed/stored);
3. `detectBrandingUpload` — bytes only; `null` → `415 unsupported_media_type`
   with `details.supportedMimeTypes` exactly the four branding MIME types (I3);
4. SHA-256 of the **original** bytes (schema §16.1) before any sanitizing;
5. an `svg` upload is stored **sanitized** (`sanitizeSvg`), every raster format
   stored byte-identical — the response `bytes` is the stored (sanitized)
   length (I4); the object key is the OP-112 `buildObjectKey(contentHash,
ext)` under `images/…`, written with `putObject("branding", key, …)`;
6. the `mediaAssets` row is upserted on the unique `{ tenantId, contentHash }`
   via `findOneAndUpdate(…, { $setOnInsert: { tenantId, contentHash, kind,
createdAt } }, { upsert: true, returnDocument: "after" })` — a re-upload of
   the same bytes answers the same `assetId` and leaves one row (I6);
7. the signed URL comes from OP-113's `createMediaSigner` over
   `{ kind: "thumbnail", contentHash, ext }` — `/t/…` with the 24 h thumbnail
   TTL (assumption A3), verified by the tests with the same
   `MEDIA_SIGNING_SECRET_CURRENT` the route reads validated config from.

`kind` is read from the multipart `kind` field: absent → `"event_logo"`,
anything outside `event_logo|watermark` → `422 validation_failed` naming
`kind` (the ADR's unpinned "default or reject" choice; the tests always send
`event_logo`, which is echoed into the row and the response).

### 3. The `file_too_large` code — the `cannot_demote_owner` shape

Appendix A.2 documents `file_too_large` (`413`, `{ maxBytes, actualBytes }`)
but the code had no member for it until now. Following the precedent set by
`TENANCY_ERROR_CODES`/`ENTITLEMENT_ERROR_CODES`/`BILLING_ERROR_CODES`:

- `packages/contracts/src/errors.ts` gains a new closed list
  `MEDIA_ERROR_CODES = ["file_too_large"]` (+ `MediaErrorCode`), joined into
  `API_ERROR_CODES` and the `AppErrorCode` union (and so into
  `errorCodeSchema`), so `appError("file_too_large", …)` typechecks and the
  wire code is a closed enum member;
- `apps/web/src/server/http/catalog.ts` gains `MEDIA_ERROR_TRANSPORT`
  (`file_too_large` → `413`, non-retryable, generic message) spread into the
  `TRANSPORT` table — deliberately not into `ERROR_CATALOG`, which the
  HTTP-pipeline spec pins to exactly the base Appendix A rows.

`ERROR_CATALOG`'s exact-key pin and every existing catalogue/contract spec
stay green (verified: full unit suite passes with the new member).

### 4. `getObjectStorage()` — the memoized composition root

`@/server/storage/get-object-storage` mirrors `getPaymentProvider()`: it reads
the validated `STORAGE_PROVIDER` and returns the memory adapter **memoized**
(`cachedMemoryStorage ??= memoryObjectStorage()`) — I4 fetches the stored
bytes back through the very store the route wrote to — or, for `s3`, the
OP-112 R2 adapter built from the deployment's `R2_*` wiring (a new
`getStorageRuntimeConfig()` in `@/server/config/env`, sibling of
`getPaymentsRuntimeConfig`); a selection with no adapter is a `ConfigError`
naming `STORAGE_PROVIDER`. The `R2_*` keys are appended to `.env.example`
(environment changes documented in the PR body).

### 5. Media-signer composition reads validated config, never `process.env`

The route's signer is built from `getConfig().media.signingSecretCurrent`
(plus `signingSecretPrevious` when set) — the same validated values the
integration suite's `makeEnv` fixture defaults to, so I2/I4/I6/I7's
`createMediaSigner({ currentSecret: SIGNING_SECRET }).verify(url)` answers
`true`. The e2e server mints a throwaway secret per boot and E1 verifies the
URL structurally (origin, `/t/` segment, 64-hex hash, `exp`/`sig`).

## Evidence (GREEN)

- **Unit** — the two RED specs pass unedited: `branding-type.test.ts`
  (16 cases) + `sanitize-svg.test.ts` (5 cases) = **21 passed (21)**; full
  unit **126 files · 2145 passed | 3 skipped** (the two new files now green).
- **Integration** — `branding-upload.test.ts` (11 cases) **11 passed (11)**;
  full integration **87 files · 736 passed** (`TMPDIR=/root/tmp-mongo`).
- **Coverage** — `vitest run --project unit --project integration --coverage`
  exit `0`: statements `91.87 %`, branches `80.71 %`, functions `95.15 %`,
  lines `92.23 %` — all above the 80 % bars (branch margin is the event
  route's denial branches, which the RED pins never drive — I7 is the only
  event-route case and it is the happy path).
- **E2E** — `branding-upload.spec.ts` (E1) green against the standalone
  build (OTP sign-in → provisioning → 201 with `/t/<sha256>.png?exp=&sig=`).
- **Static gates** — `tsc -p apps/web/tsconfig.json --noEmit` exit `0` on all
  three projects; `eslint .` 0 errors (the six new
  `security/detect-object-injection` warnings are the same class as the
  pre-existing baseline — `TRANSPORT[code]` at catalog.ts:410 warned before
  this lane); `prettier --check` clean on every touched file (`.env.example`
  excluded — prettier has no parser for it, matching the pre-existing lane
  practice); the `adr-numbering` guard green; gitleaks clean.
- Four RED files carry byte-unchanged; no test, mock, fixture or factory
  written or edited.

## Consequences / open items (handed forward)

- Unpinned decisions taken here: missing `kind` defaults to `event_logo`,
  unknown `kind` is `422 validation_failed`; a missing `file` field is `422`;
  the event route denies a non-organizer with `404 not_found`; no `Location`
  header is emitted (unpinned; the 201 envelope carries the asset id the
  client needs). The `watermark` kind is accepted generically (kind is echoed,
  no format differs); OP-127's image pipeline will add per-kind storage
  differences if the contract requires them.
- The `event_organizers` one-active-row unique partial index (ADR-0540's open
  item) is untouched — the OP-115 lane owns widening it.
- `getObjectStorage()` only ever exercises the `memory` path under tests/e2e;
  the `s3` path is constructed but not driven by any spec (the production e2e
  server selects `s3` but the branding journey runs on the `e2e` server).
  A follow-up TEST card could pin the R2 adapter selection through MSW.
- The signed URL stays the **thumbnail** `/t/` derivative per the contract's
  own example — the OP-113 lane's `/o/` and `/p/` segments exist for later
  image-pipeline lanes, not for branding.
- **Sanitizer implementation (follow-up):** `sanitizeSvg` was shipped as a
  regex-based rewriter and GitHub's default-setup CodeQL (a merge gate via the
  `code_quality: warnings` rule) rejected it — `Bad HTML filtering regexp`
  (the `</script\s*>` end-tag pattern misses `</script\n  bar>`) and
  `Incomplete multi-character sanitization` (the chained `replace` can leave
  a bare `<script` fragment from nesting). The GREEN rewrote the module as a
  **quote-aware XML tokenizer** — each `<…>` construct is classified
  (start/end tag, comment, CDATA, PI, declaration), element and attribute
  names are lexed with correct value scanning, and the output is rebuilt from
  original slices so benign markup stays byte-identical. The four payload
  classes are unchanged (script/foreignObject subtrees removed, `on*` stripped,
  `javascript:`-class hrefs dropped, all case-insensitive); the stored output for a
  given input differs from the regex version only by fixing those bypasses.
  No dependency was added (the contract's DOMPurify/jsdom suggestion was
  considered; a tokenizer keeps the module dependency-free and never throws).
  CodeQL re-scan of the final head reports **0 alerts**.
