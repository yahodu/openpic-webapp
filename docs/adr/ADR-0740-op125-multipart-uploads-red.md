# ADR-0740 — OP-125 RED: the multipart upload endpoints behind Uppy's `@uppy/aws-s3` hooks

- **Status:** Accepted
- **Date:** 2026-11-11
- **Card:** `t_bbd746d9` (OP-125, `tdd_stage: RED`)
- **Lane:** OP-125 uploads lane — reserved range `0740`–`0759`, `Next free` → `0741`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_bbd746d9`
- **Branch:** `OP-125-task-multipart-uploads-red` (based on the **OP-124 GREEN head** `b211632`)
- **Gated GREEN:** `t_a20d4ae2`
- **Consumes:** [ADR-0580](ADR-0580-op112-object-storage-port-red.md) /
  [ADR-0581](ADR-0581-op112-object-storage-port-green.md) (the `ObjectStorage`
  port and the handle service), [ADR-0700](ADR-0700-op123-upload-config-batch-resolve-red.md)
  (batch-resolve), [ADR-0720](ADR-0720-op124-single-put-complete-link-only-red.md) /
  [ADR-0721](ADR-0721-op124-single-put-complete-link-only-green.md) (the single
  PUT, the registration transaction, the upload-window rule)
- **Consumers:** the OP-125 multipart endpoints and the specs that pin them —
  specs `apps/web/src/test/integration/uploads-multipart.test.ts`,
  `apps/web/src/test/unit/uploads-multipart-handle.test.ts`,
  `apps/web/src/test/unit/uploads-multipart-part-count.test.ts`,
  `apps/web/src/test/unit/uploads-multipart-resume.test.ts`.

## Context

The card asks for the **six endpoints that map 1:1 onto Uppy's `@uppy/aws-s3`
hooks** (§5.4 of the API contract), behind a resumable multipart upload for
100 MB photos. Three of the ingredients already exist on the lane's base:

- the port (`createMultipart`, `presignPart`, `listParts`, `completeMultipart`,
  `abortMultipart`) with the R2 adapter and the OP-112 MSW contract test;
- the opaque handle service (`createHandleService`, ADR-0520 §5) with its
  user binding and signature verification;
- the registration half of a completion (`attachImage`, `allocateSequence`,
  `sizeWithinTolerance`, `uploadWindowClosed`, `toEventImage`).

What does not exist is the surface itself: no route module, no part-count rule,
no resume decision, no multipart-specific handle binding, and no error code for
either multipart refusal. That is exactly the RED this card owes.

**Base-branch decision.** The card's dependency (OP-124) is _complete on the
board_ but its PR **#425 is still open**, so `origin/main` does not carry
`@/server/uploads/{registration,single-put,upload-window,event-image-dto}`.
Branching off `origin/main` would make the spec unpinnable, so this branch is
cut from `origin/OP-124-task-single-put-complete-link-only-green` (`b211632`),
mirroring what OP-124 itself did on OP-123 (`ADR-0720` §lane note). **The GREEN
must base its branch on this pins branch, not on bare `origin/main`.**

## Decision

### D1 — Three pure rules, each in its own module surface

| Unit | Module                              | Export                                                                                           |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| U1   | `@/server/uploads/multipart`        | `partCountFor({ size, partSizeBytes }): number`                                                  |
| U2   | `@/server/uploads/multipart-handle` | `resolveMultipartHandle({ service, handle, presentingUserId, uploadSessionId }): ResolvedHandle` |
| U3   | `@/server/uploads/multipart`        | `reuseUploadDecision({ existingUploadId, session, now }): "reuse" \| "create"`                   |

- **U1** is `ceil(size / partSizeBytes)` with the partial-last-part edge pinned
  (one byte past a boundary needs the next part), the exact-multiple edge (no
  phantom part), the zero-byte claim (`0` parts — nothing to sign) and the
  contract's own worked example (40 MB at 8 MB/part → `5`, §5.4). The part size
  is an **input**, so the value `GET /uploads/config` publishes is the value the
  count is computed with; the integration spec pins the two answers agreeing.
- **U2** is the one refusal _mapping_ the surface needs. `resolveHandle` already
  refuses a foreign presenter, a tampered signature and a token from another
  secret, but it answers `400 bad_request`, while §5.4 requires **`404`** for
  every handle that does not prove ownership ("tamper -> 404"). The helper adds
  the third binding the service cannot know — _this_ handle is for _this_
  upload session — and maps all four refusals to `not_found`. The session
  binding is load-bearing, not decorative: without it a client holding two
  uploads can sign parts into the _other_ upload's object key.
- **U3** decides reuse from the session the route's query already scoped to the
  caller and the content hash: reuse only when the named id **is** the observed
  id, the status is `pending` and `expireAt` is strictly in the future. The
  boundary is exclusive (at `expireAt` the provider's lifecycle rule may already
  have aborted the series). `existingUploadId` is `undefined`-typed (not
  optional) so the "no id" case is explicit — `exactOptionalPropertyTypes` is on.

### D2 — Five route modules under the contract's templates

`apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/multipart/`

| Hook                      | File                                          | Method   | Event id from end |
| ------------------------- | --------------------------------------------- | -------- | ----------------- |
| `createMultipartUpload`   | `route.ts`                                    | `POST`   | 3                 |
| `listParts`               | `[uploadId]/parts/route.ts`                   | `GET`    | 4                 |
| `signPart`                | `[uploadId]/parts/[partNumber]/sign/route.ts` | `GET`    | 6                 |
| `completeMultipartUpload` | `[uploadId]/complete/route.ts`                | `POST`   | 4                 |
| `abortMultipartUpload`    | `[uploadId]/route.ts`                         | `DELETE` | 4                 |

The offsets are pinned through the **behaviour** (a stranger is `404`, a member
is admitted) rather than by asserting a stage's options: a hard-coded `2`
(`admitEventActor`'s default) reads `multipart`, `{uploadId}` or `sign` as the
event id and every case fails `404`. The sixth hook, `getUploadParameters`, is
OP-124's `POST …/uploads/params` and is out of scope here.

### D3 — The wire contract the spec pins

- **create** → `201` with **exactly** `{ uploadSessionId, uploadId, key,
partSizeBytes, partCount, resumed }`. `key` is opaque: the spec asserts it
  contains neither the content hash, nor `images/`, nor the physical bucket
  (§0.15). The session is `mode: "multipart"`, `status: "pending"`,
  `declaredSize`/`declaredMimeType`/`batchId` recorded, `expireAt` five days
  out, and the provider id inside `externalRefs[{ kind: "multipart_upload" }]`
  — the shape OP-123's reader already consumes, asserted **by field**
  (`filter(kind).map(id)`) rather than by whole-element equality, so a neutral
  `provider`/`env`/`linkedAt` on the ref does not fail the pin.
- **listParts** → `200 { parts: [{ PartNumber, ETag, Size }] }`, S3-shaped keys
  because Uppy consumes them verbatim. An empty upload answers `parts: []`.
- **sign** → `200 { url, expiresAt }`; the URL carries `partNumber` and
  `uploadId` and a real SigV4 signature, and the TTL is the contract's 900 s.
- **complete** → `201` `EventImage` DTO (the OP-124 schema, exact key set),
  `sequence: 1`, `bytes` = the assembled object (`25 165 824` for three 8 MB
  parts), `processing: { status: "queued", attempts: 0 }`, then the registration
  consequences: one `media_assets` row (`refCount` 1, `objectKey`
  `images/<hash>.jpg`, `checksum` = hash), one `event_images` row, event
  `counters.imageCount`/`counters.storageBytes`, `events.sequence` advanced,
  tenant `usageCounters` `storage.bytes`, the session `completed` with its
  `assetId`, and one `event_image` envelope on `q:image`.
- **abort** → `204` with an **empty** body, twice, leaving the session
  `aborted` and nothing else written.
- **refusals**: `409 parts_missing` with `details.missingPartNumbers` (`[2]` for
  parts 1 and 3 of a three-part file), `409 upload_expired` when the provider
  answers `NoSuchUpload`, `404 not_found` for any handle that does not prove
  ownership of the addressed session, `404` for a caller with no relationship to
  the event, `401 authentication_required` for all five endpoints without a
  session, `409 upload_window_closed` (with `canExtend`/`uploadWindowEndsAt`) for
  a claim made after the window closed — with **no** provider call in the
  refused cases.

### D4 — The suite boots `STORAGE_PROVIDER=s3` against MSW, and the part PUT is real

The card's suite label is `vitest_msw_mongodb_memory_server`; as in OP-124 that
means the real R2 adapter over MSW, not a stub adapter. The mock implements
`CreateMultipartUpload` (`POST ?uploads`), `ListParts` (`GET ?uploadId`), the
**presigned part PUT**, `CompleteMultipartUpload` (`POST ?uploadId`), `Abort`
(`DELETE ?uploadId`), `HeadObject` and a ranged `GetObject`, and it assembles
the parts a completion names into the object the later `HEAD`/`GET` reads.

The part `PUT` is the design point: the spec takes the URL the **sign** endpoint
minted and `fetch`es the bytes to it. A sign URL that does not carry
`partNumber`/`uploadId`, or a route that signs the wrong key, cannot land a
part, and a completion that never assembled bytes cannot `HeadObject` them. This
is what makes "sign ×3" a journey rather than three status codes. A throwaway
probe confirmed MSW intercepts the integration harness's global `fetch`
(1 passed, deleted).

The completion is deliberately implementation-agnostic about _where_ the byte
total comes from: the mock's `ListParts` sizes and the assembled object's length
agree, so an implementation may `HeadObject` (the OP-124 shape), sum
`ListParts`, or both.

One mock detail matters for the GREEN: the `ListParts` answer always carries
`<NextPartNumberMarker>`, including for an empty upload. OP-123 recorded that a
response _without_ it makes the OP-112 adapter's `Number(undefined)` a `NaN` and
Zod calls the shape drift (`ADR-0700` finding F1), so the empty-parts answer
could not be expressed at all. This suite's create case asserts
`parts: []` — the mock is faithful to a provider that emits the marker, and the
finding stays with OP-123 rather than being re-litigated here.

### D5 — Extras beyond the card's list (X1–X5), and why

The card lists I1–I7. Five pins were added because the mandate (and the GREEN
card's own `security_and_logging_requirements`) demand them, each as one
observable behaviour:

- **X1** the `401 authentication_required` ladder over all five endpoints, as one
  `it.each` table (no DB read happens before `auth`, so the ids need not exist);
- **X2** a signed-in outsider is `404` on create and nothing is created;
- **X3** a closed upload window is `409 upload_window_closed` with no provider
  call — the create is a _write_, so the §5.2 window rule must gate it exactly as
  `batch-resolve` and `params` are gated;
- **X4** the presigned part URL is never logged (asserted on the log sink, plus
  the `X-Amz-Signature`/`X-Amz-Credential` non-containment);
- **X5** a handle minted for session A cannot sign for session B of the same
  user (the integration half of U2's third binding).

## Assumptions

- **A1** — `create` does **not** require an idempotency key: §5.4 marks only
  `complete` ("Idempotency required"), and a resume deliberately repeats the
  create with `existingUploadId`. The spec sends no key on create.
- **A2** — `partSizeBytes` is the contract's fixed `8 388 608` (§5.1) and
  `partCount = ceil(size / partSizeBytes)`.
- **A3** — `409 parts_missing` and `409 upload_expired` are **new** media codes
  the GREEN owes the contracts union (`MEDIA_ERROR_CODES`) and the catalogue
  (`MEDIA_ERROR_TRANSPORT`), in the append-only per-domain shape
  ADR-0540/0701/0721 established. Only `parts_missing` carries `details`
  (`{ missingPartNumbers: number[] }`); `upload_expired` carries none.
- **A4** — the recorded `media_assets.storage.bytes` is the assembled object's
  size (the sum of the uploaded parts).
- **A5** — `resumed: true` means the provider's `CreateMultipartUpload` was
  **not** called: the spec counts the upstream call (`initiateCalls`), not a
  Mongo field, so an implementation may still upsert the session row.
- **A6** — `parts_missing` is derived from the file's **expected** part count
  (from `declaredSize`, A2) against what the client acknowledged: a three-part
  file completed with parts 1 and 3 names `[2]`, even though the provider holds
  exactly those two. This is the card's rule and it is what stops a truncated
  object from being registered (S3 itself would happily concatenate a subset).
- **A7** — the handle service has no composition root yet. The GREEN adds one
  (`getHandleService()` or equivalent) keyed from a deployment secret; reusing
  `MEDIA_SIGNING_SECRET_CURRENT` (already a required 32+ character secret, and
  the media signer's own source) needs no new env var. **The spec never names
  that secret or the module.** If a new env var is unavoidable it belongs in
  `apps/web/src/test/factories/env.ts` defaults, not in the spec.
- **A8** — the memory adapter's `createMultipart`/`presignPart`/`listParts`/
  `completeMultipart`/`abortMultipart` stay `not_implemented`: the card has no
  e2e, and nothing here drives them.

## RED evidence

| Step                                                  | Result                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No implementation (`tsc` + both projects)             | `tsc` reports exactly the 8 new `TS2307`s; unit `3 failed (3)` / integration `1 failed (1)`, each `Cannot find package '@/server/uploads/multipart'`, `'…/multipart-handle'`, `'@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/multipart/route'` |
| Throwaway stubs (two pure modules, five `500` routes) | `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; **unit `20 failed                                                                                                                                                                                       | 8 passed (28)`**, **integration `16 failed (16)`**, every integration failure assertion-level (`expected 500 to be 201 / 409 / 404 / 204 / 200 / 401`) |
| MSW ↔ global `fetch` probe                            | `1 passed (1)` — a `PUT` to the mocked storage host is intercepted, its body readable, its `ETag` returned                                                                                                                                                 |
| Stubs deleted                                         | `git status --short` shows the four spec files (plus this ADR and the ledger) only                                                                                                                                                                         |

The 8 unit cases that pass against the stubs are the ones whose expectation the
stub's constant happens to match (`partCountFor` returning `1`, the three
"one part" rows; `reuseUploadDecision` returning `"create"`, the five create
rows). With the stubs gone every one of the 28 unit cases and all 16 integration
cases is red — the RED this card hands over.

## Open items handed to the GREEN

1. **`partNumber` bounds.** §5.4 fixes `partNumber ∈ 1–10000` but not the error
   for an out-of-range value, and a path segment is not body-validated. Nothing
   is pinned. Recommended: `422 validation_failed` with
   `details.fields[].field === "partNumber"` (the shape the pipeline uses for a
   bad body field), and never a signed URL.
2. **An idempotent re-complete.** The spec exercises `complete` once. A replay
   with the same `Idempotency-Key` should follow OP-124's `200`-replay
   behaviour, but the multipart body carries no `bytes`, so the second attempt
   must not re-`Pass`/re-assemble. Not pinned; the operator should decide
   whether a replay answers the stored `201` body with `200`.
3. **`upload_expired` classification.** The R2 adapter currently classifies a
   `NoSuchUpload` 404 as a transport failure. The route must distinguish it; the
   spec only pins the route's `409 upload_expired`, so the mechanism (a
   normalized `AppError` in the adapter, or a name check in the route) is the
   implementer's choice.
4. **`listParts` truncation.** The mock answers `IsTruncated: false`. A
   paginated provider response (more than 1000 parts) is impossible under
   §5.1's 100 MB ceiling and 8 MB part size (13 parts), so it is not pinned.
5. **Rate limit.** `upload.sign` is a configured class (900/min) and is _not_
   asserted: driving 901 requests to observe a `429` is a rate-limit-stage test,
   already covered by `rate-limit-*` specs.
6. **Base branch.** The GREEN must branch from this pins branch (D1 of the
   Context above) — `origin/main` has no `@/server/uploads/*` modules because
   PR #425 is open.

## Consequences

- The multipart surface gains a **third** handle binding (session) on top of the
  service's user and signature bindings; any future route that takes a `key`
  query parameter should reuse `resolveMultipartHandle` rather than calling
  `resolveHandle` and mapping `400`→`404` by hand.
- `parts_missing` makes the multipart completion refuse a subset that S3 would
  accept. That is deliberate (A6) and it is the only guard between a flaky
  network and a silently truncated photo.
- Two new media error codes land in the append-only domain table, so the
  client-facing enum grows by two; nothing is renumbered.
- The lane takes `0740`–`0759` from the allocator pool (`Next free 0741`, pool
  → `0760`+). `docs/adr/README.md` is the shared-ledger hotspot; the pool cell
  merges as a union keeping the highest value.

## Number allocation

| Number        | Holder                   | Use                |
| ------------- | ------------------------ | ------------------ |
| `0740`        | this card (`t_bbd746d9`) | OP-125 RED         |
| `0741`        | gated GREEN `t_a20d4ae2` | lane's `Next free` |
| `0742`–`0759` | OP-125 lane              | later cards        |
