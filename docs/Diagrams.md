# 1. The three planes (the single most important rule)

Image bytes **never** transit the JSON control plane, in either direction.

```mermaid
flowchart LR
    subgraph clients["Clients"]
        WEB["Web app<br/>Next.js + React"]
        MOB["React Native<br/>phase 3"]
    end

    subgraph ctrl["CONTROL PLANE — JSON only<br/>openpic.in/api/v1 — Vercel"]
        direction TB
        C1["Auth + authorization"]
        C2["Metadata + state machines"]
        C3["URL signing<br/>HMAC + presign"]
    end

    subgraph media["MEDIA DATA PLANE — bytes out<br/>pic.openpic.in — Cloudflare Worker"]
        direction TB
        M1["Gateway entrypoint<br/>verify exp + sig — cache OFF"]
        M2["CachedMedia entrypoint<br/>cache ON — tiered"]
    end

    subgraph store["STORAGE DATA PLANE — bytes in<br/>R2 presigned PUT"]
        direction TB
        S1["images-originals<br/>PRIVATE"]
        S2["images-thumbnails<br/>PRIVATE"]
    end

    WEB -->|"session cookie / bearer"| ctrl
    MOB -->|"bearer + X-Attendee-Session"| ctrl
    ctrl -->|"returns signed URL, never bytes"| WEB
    ctrl -->|"returns presigned PUT, never accepts bytes"| WEB
    WEB -->|"img src — no Authorization header"| M1
    M1 --> M2
    M2 -->|"R2 binding on cache miss"| S2
    M2 -->|"R2 binding on cache miss"| S1
    WEB -->|"PUT bytes direct"| S1
    ctrl -. "one exception: branding assets under 2 MB" .-> ctrl

    style ctrl fill:#e8f0fe
    style media fill:#fff4e5
    style store fill:#e9f7ef
```

| Plane   | Host                | Carries         | Auth                                                                                 |
| ------- | ------------------- | --------------- | ------------------------------------------------------------------------------------ |
| Control | `openpic.in/api/v1` | JSON            | Better Auth session · bearer · attendee session · internal HMAC · provider signature |
| Media   | `pic.openpic.in`    | image bytes out | path-bound HMAC `?exp=&sig=`                                                         |
| Storage | R2 presigned        | image bytes in  | presigned S3 signature                                                               |

---

## 2. Full component map

```mermaid
flowchart TB
    subgraph CL["Clients"]
        UI["Organizer dashboard"]
        ATT["Attendee page<br/>anonymous or logged in"]
        ADM["Admin console<br/>2FA required"]
    end

    subgraph EDGE["middleware.ts — edge"]
        RL["Upstash Ratelimit<br/>sliding window"]
        CSRF["CSRF + Origin allow-list"]
        TEN["tenantId resolution<br/>alias 'current'"]
    end

    subgraph API["Next.js route handlers — /api/v1"]
        P1["Identity<br/>/me/*"]
        P2["Tenancy + invitations"]
        P3["Billing + entitlements"]
        P4["Events + access links"]
        P5["Uploads + media signing"]
        P6["Attendee /p/*"]
        P7["Notifications"]
        P8["Compliance /me/data-requests"]
        P9["Admin /admin/*"]
        P10["M2M /internal/* + /webhooks/*"]
    end

    subgraph SVC["Shared services"]
        BA["Better Auth<br/>/api/auth — library owned"]
        REPO["repo tenantId wrapper<br/>injects tenantId in every filter"]
        IDEM["Idempotency middleware"]
        ENT["checkEntitlement"]
        EMIT["emitDomainEvent"]
        NS["NotificationService<br/>resolve → render → dispatch"]
        SIGN["HMAC media signer<br/>CURRENT + PREVIOUS secret"]
    end

    DB[("MongoDB Atlas<br/>36 collections<br/>+ vectorSearch index")]

    subgraph EXT["External — all behind adapters"]
        R2[("Cloudflare R2")]
        CFW["Cloudflare Worker<br/>pic.openpic.in"]
        UP["Upstash Redis<br/>q:selfie · q:image"]
        NOVU["Novu<br/>3 pass-through workflows"]
        CF["Cashfree<br/>mandates + charges"]
    end

    PW["Python worker<br/>InsightFace — pull based"]
    CRON["Vercel Cron<br/>24 jobs"]
    THUMB["Thumbnail processor<br/>resize + watermark + WebP"]

    UI --> EDGE
    ATT --> EDGE
    ADM --> EDGE
    EDGE --> API
    API --> SVC
    UI -->|"better-auth/react"| BA
    BA --> DB
    SVC --> DB
    REPO --> DB
    P5 --> SIGN
    SIGN --> CFW
    CFW --> R2
    P5 -->|"presigned PUT"| R2
    EMIT --> DB
    NS --> NOVU
    NS --> DB
    P3 --> CF
    CF -->|"webhooks"| P10
    NOVU -->|"delivery receipts"| P10
    API -->|"enqueue"| UP
    PW -->|"claim"| UP
    PW -->|"direct: lease, faces, vectorSearch"| DB
    PW -->|"download bytes"| R2
    PW -->|"domain events + heartbeat"| P10
    THUMB --> R2
    THUMB --> P10
    CRON --> P10
    CRON --> DB

    style DB fill:#dff0d8
    style EXT fill:#fdecea
```

---

## 3. Every request goes through the same gauntlet

```mermaid
flowchart TD
    A["Incoming request"] --> B{"Rate limit<br/>by class + principal"}
    B -->|"over"| B1["429 rate_limited<br/>Retry-After + RateLimit-*"]
    B -->|"ok"| C{"Auth label satisfied?<br/>public · user · user:complete<br/>attendee · admin · internal · provider"}
    C -->|"no credential"| C1["401 authentication_required<br/>details.loginUrl"]
    C -->|"email+phone unverified"| C2["403 account_incomplete"]
    C -->|"admin without 2FA"| C3["403 admin_2fa_required"]
    C -->|"banned"| C4["423 account_banned"]
    C -->|"ok"| D{"Cookie auth AND<br/>state-changing method?"}
    D -->|"yes, header/Origin bad"| D1["403 csrf_failed"]
    D -->|"ok"| E{"Tenant-scoped route?"}
    E -->|"yes"| F["Resolve 'current' → primaryTenantId<br/>echo X-Tenant-Id<br/>verify tenantMembers / eventMembers"]
    F --> G{"Stored tenantId equals path tenantId?"}
    G -->|"no"| G1["404 not_found<br/>never 403 across tenants"]
    G -->|"yes"| H
    E -->|"no"| H{"Idempotency-Key required?"}
    H -->|"missing"| H1["400 idempotency_key_required"]
    H -->|"replay, same hash"| H2["200 + Idempotency-Replayed: true"]
    H -->|"replay, in progress"| H3["409 idempotency_in_progress"]
    H -->|"same key, different body"| H4["422 idempotency_key_reuse"]
    H -->|"fresh"| I{"ETag protected resource<br/>and PATCH?"}
    I -->|"no If-Match"| I1["428 precondition_required"]
    I -->|"mismatch"| I2["412 etag_mismatch"]
    I -->|"ok"| J["TRANSACTION"]

    subgraph TX["one transaction"]
        J --> K{"checkEntitlement"}
        K -->|"plan_limit"| K1["403 plan_limit_exceeded"]
        K -->|"payment_downgrade"| K2["402 payment_required<br/>pendingDueMinor + payNowUrl"]
        K -->|"allowed"| L["Domain write"]
        L --> M["usageCounters $inc"]
        M --> N["insert domainEvents"]
    end

    N --> O["Response<br/>+ X-Request-Id, Cache-Control: no-store"]
    K1 --> P["emit usage.action.blocked<br/>in-app, throttled 1/key/h"]
    K2 --> P

    style TX fill:#e8f0fe
```

---

## 4. The product, end to end

```mermaid
flowchart LR
    subgraph ORG["Organizer side"]
        O1["Sign up<br/>email + phone OTP"] --> O2["accountCompletedAt set<br/>tenant created by hook"]
        O2 --> O3["Subscribe<br/>UPI mandate"]
        O3 --> O4["Create event<br/>materialises upload + retention windows"]
        O4 --> O5["Get share link + QR"]
        O5 --> O6["Invite co-organizers"]
        O4 --> O7["Bulk upload<br/>hash → resolve → PUT → complete"]
        O7 --> O8["Pipeline indexes faces"]
        O8 --> O9["Dashboard: counters, pipeline, stats"]
    end

    subgraph ATT["Attendee side"]
        A1["Scan QR<br/>GET /p/events/slug"] --> A2["Anonymous attendee session<br/>cookie op_att, 30d TTL"]
        A2 --> A3["Grant biometric consent<br/>hard precondition"]
        A3 --> A4["Liveness challenge"]
        A4 --> A5["Selfie upload<br/>high priority queue"]
        A5 --> A6["Poll /p/events/slug/me<br/>2s → 15s → 60s"]
        A6 --> A7["Gallery — newest first<br/>New badges, dimensions included"]
        A7 --> A8["Download originals<br/>15 min signed URL"]
        A7 --> A9["Log in → claim session<br/>no re-upload, no reprocessing"]
        A9 --> A10["GET /me/events<br/>the one cross-tenant read"]
    end

    O5 -.->|"QR / link"| A1
    O8 -.->|"faces available to match"| A5
    A5 -.->|"attendeeCount, matchCount"| O9

    subgraph WIND["Time windows drive everything"]
        W1["endAt"] --> W2["uploadWindowEndsAt<br/>= endAt + post_upload_days"]
        W2 --> W3["retentionExpiresAt<br/>= endAt + gallery_retention_days"]
        W3 --> W4["ordered, counted purge"]
    end
```

### Event timeline and the notifications each boundary fires

```mermaid
gantt
    title Event lifecycle windows and scheduled notifications
    dateFormat YYYY-MM-DD
    axisFormat %b %d

    section Event
    Draft / published        :2026-11-01, 13d
    Live — startAt to endAt  :2026-11-14, 2d
    Ended                    :milestone, 2026-11-16, 0d

    section Upload window
    Post-event uploads open  :2026-11-16, 7d
    T-72h closing warning    :milestone, 2026-11-20, 0d
    T-24h closing + mobile   :milestone, 2026-11-22, 0d
    Window closed            :milestone, 2026-11-23, 0d

    section Gallery retention
    Gallery live             :2026-11-16, 90d
    Organizer T-14d warning  :milestone, 2027-01-31, 0d
    Attendee T-7d warning    :milestone, 2027-02-07, 0d
    Organizer T-3d + mobile  :milestone, 2027-02-11, 0d
    Attendee T-1d + mobile   :milestone, 2027-02-13, 0d
    Ordered counted purge    :milestone, 2027-02-14, 0d
```

---

## 5. Tenancy, identity and authorization

<details open>
<summary><strong>Scope model — where every collection lives</strong></summary>

```mermaid
flowchart TB
    subgraph PS["PLATFORM SCOPE — no tenantId"]
        A["user · session · account · verification<br/>Better Auth owned"]
        B["userProfiles"]
        C["plans"]
        D["notificationTypes · notificationTemplates<br/>notificationSuppressions"]
        E["faceModels · platformSettings"]
    end
    subgraph TS["TENANT SCOPE — tenantId mandatory"]
        F["tenants · tenantMembers"]
        G["subscriptions · billingTransactions<br/>entitlementGrants · usageCounters"]
        H["events · eventMembers"]
        I["mediaAssets · uploadSessions · eventImages"]
        J["imageFaces — vector indexed"]
    end
    subgraph XS["TENANT + SUBJECT SCOPE"]
        K["attendeeEventProfiles · selfies<br/>faceMatches · consents"]
    end
    subgraph US["USER SCOPE"]
        L["notifications · notificationDispatches<br/>notificationPreferences · notificationDigests"]
        M["invitations · dataSubjectRequests"]
    end
    subgraph OS["OPERATIONAL"]
        N["domainEvents · providerWebhookEvents<br/>idempotencyKeys · auditLogs · analyticsDaily"]
    end

    A --> B --> F
    F --> G
    F --> H --> I
    H --> J
    H --> K
    A -.->|"data subject, not a member"| K
    A --> L
    A --> M

    style TS fill:#e8f0fe
    style XS fill:#fff4e5
```

**Why `tenantId` and not `userId`:** a co-organizer's uploads must bill the organizer. With `tenantId` on the event, cost attribution is _a field in the document being written_, not a rule someone can forget.

</details>

<details>
<summary><strong>Authorization resolution — roles are re-read every request, never cached in the session</strong></summary>

```mermaid
flowchart TD
    A["Request with principal"] --> B{"Namespace"}
    B -->|"/me/*"| C["userProfiles.status == active"]
    B -->|"/plans, /legal, /invitations/token"| D["public — IP rate limited"]
    B -->|"/p/*"| E{"attendee session or user?"}
    E --> E1["resolve accessLinks.slug<br/>where active: true"]
    E1 --> E2["profile ownership check<br/>subject.userId or attendeeSessionId"]
    B -->|"/tenants/tenantId/*"| F["read tenantMembers<br/>role owner/admin/member"]
    F --> G{"Nested under an event?"}
    G -->|"yes"| H["read eventMembers<br/>role organizer/co_organizer"]
    G -->|"no"| I["tenant role sufficient"]
    H --> J{"Billing route?"}
    J -->|"yes"| K["MUST use tenantMembers,<br/>never eventMembers<br/>co-organizers never see billing"]
    B -->|"/admin/*"| L["platformRole == admin<br/>AND twoFactorEnabled"]
    L --> M["write auditLogs row<br/>reason required if destructive"]
    B -->|"/internal/*"| N["bearer secret + X-Signature HMAC<br/>+ X-Timestamp ±300s<br/>deny if Origin header present"]
    B -->|"/webhooks/*"| O["provider signature over RAW body"]
```

</details>

<details>
<summary><strong>Core data model — ER diagram</strong></summary>

```mermaid
erDiagram
    USER ||--|| USERPROFILES : extends
    USER ||--o{ TENANTMEMBERS : member_of
    TENANTS ||--o{ TENANTMEMBERS : has
    TENANTS ||--o| SUBSCRIPTIONS : billed_by
    PLANS ||--o{ SUBSCRIPTIONS : subscribed_as
    SUBSCRIPTIONS ||--o{ BILLINGTRANSACTIONS : records
    TENANTS ||--o{ USAGECOUNTERS : consumes
    TENANTS ||--o{ ENTITLEMENTGRANTS : granted
    TENANTS ||--o{ EVENTS : owns
    EVENTS ||--o{ EVENTMEMBERS : staffed_by
    USER ||--o{ INVITATIONS : receives
    EVENTS ||--o{ EVENTIMAGES : contains
    MEDIAASSETS ||--o{ EVENTIMAGES : used_as
    MEDIAASSETS ||--o{ SELFIES : used_as
    EVENTS ||--o{ UPLOADSESSIONS : receives
    EVENTIMAGES ||--o{ IMAGEFACES : detected_in
    FACEMODELS ||--o{ IMAGEFACES : embedded_by
    EVENTS ||--o{ ATTENDEEEVENTPROFILES : attended_by
    ATTENDEEEVENTPROFILES ||--o{ SELFIES : uploads
    ATTENDEEEVENTPROFILES ||--o{ FACEMATCHES : receives
    IMAGEFACES ||--o{ FACEMATCHES : matched_as
    ATTENDEEEVENTPROFILES ||--o{ CONSENTS : records
    ATTENDEESESSIONS ||--o{ ATTENDEEEVENTPROFILES : anonymous_owner
    DOMAINEVENTS ||--o{ NOTIFICATIONS : fans_out_to
    NOTIFICATIONTYPES ||--o{ NOTIFICATIONS : instantiates
    NOTIFICATIONTYPES ||--o{ NOTIFICATIONDISPATCHES : instantiates
    USER ||--o| NOTIFICATIONPREFERENCES : configures

    TENANTS {
        ObjectId _id PK
        string slug
        ObjectId ownerUserId FK
        ObjectId billingContactUserId FK
        string status
        object counters
    }
    SUBSCRIPTIONS {
        ObjectId tenantId FK
        string subscribedPlanKey
        string activePlanKey
        string status
        string mandateStatus
        date gracePeriodEndsAt
        int pendingDueMinor
        array externalRefs
    }
    EVENTS {
        ObjectId tenantId FK
        string name
        date startAt
        date endAt
        string displayTimeZone
        date uploadWindowEndsAt
        date retentionExpiresAt
        string status
        array accessLinks
        object counters
    }
    MEDIAASSETS {
        ObjectId tenantId FK
        string contentHash
        object storage
        object derivatives
        object imageMeta
        int refCount
    }
    EVENTIMAGES {
        ObjectId eventId FK
        ObjectId assetId FK
        int sequence
        object processing
        int faceCount
    }
    IMAGEFACES {
        ObjectId eventId FK
        ObjectId imageId FK
        int faceIndex
        binData vector
        double detScore
    }
    ATTENDEEEVENTPROFILES {
        ObjectId eventId FK
        object subject
        string status
        int matchCount
        date lastMatchRunAt
        date lastSeenGalleryAt
    }
    FACEMATCHES {
        ObjectId profileId FK
        ObjectId imageId FK
        int faceIndex
        double similarity
        date seenAt
        date hiddenAt
    }
    NOTIFICATIONS {
        ObjectId userId FK
        string typeKey
        string groupKey
        int groupCount
        object actionTarget
        date readAt
        date expireAt
    }
```

</details>

---

## 6. Upload pipeline — four phases, bytes bypass the server

```mermaid
sequenceDiagram
    autonumber
    participant U as "Client — Uppy + Web Worker"
    participant A as "API /api/v1"
    participant M as "MongoDB"
    participant R as "R2"
    participant Q as "Upstash q:image"

    Note over U: PHASE 1 — hash
    U->>U: "SHA-256 each file in a Web Worker"
    U->>A: "GET /uploads/config"
    A-->>U: "thresholds, part size, mime types, TTLs"

    Note over U,A: PHASE 2 — batch resolve, up to 500 hashes
    U->>A: "POST .../uploads/batch-resolve"
    A->>M: "mediaAssets by tenantId + contentHash"
    A->>M: "uploadSessions by tenantId + user + hash"
    A->>R: "ListParts for in-progress multipart"
    A-->>U: "per-hash: completed / in_progress / not_found / rejected + quota"

    alt "completed and linked"
        U->>U: "skip entirely — counted as duplicate skipped"
    else "completed but not linked"
        U->>A: "POST .../uploads:link with assetIds"
        A-->>U: "eventImage created, zero bytes moved"
    else "not_found and under 8 MB"
        U->>A: "POST .../uploads/params — idempotency required"
        A->>M: "upsert uploadSessions mode single"
        A-->>U: "presigned PUT, no bucket or key exposed"
        U->>R: "PUT bytes — direct, not proxied"
        R-->>U: "ETag"
        U->>A: "POST .../uploads/id/complete"
    else "not_found or in_progress and 8 MB or larger"
        U->>A: "POST .../uploads/multipart — reuse existingUploadId if valid"
        A->>R: "CreateMultipartUpload only if new"
        A-->>U: "uploadId + opaque key handle + partCount"
        loop "each missing part, 4 concurrent"
            U->>A: "GET .../parts/n/sign"
            A-->>U: "presigned part URL, 900 s"
            U->>R: "PUT part bytes"
            R-->>U: "ETag"
        end
        U->>A: "POST .../multipart/uploadId/complete"
        A->>R: "CompleteMultipartUpload"
    end

    Note over A,M: PHASE 4 — one transaction
    A->>R: "HeadObject — verify size and checksum"
    A->>M: "TX: mediaAssets upsert + eventImages insert + storage/image counters $inc"
    A->>Q: "enqueue thumbnail derivative + face pipeline"
    A-->>U: "201 EventImage, processing.status queued"

    Note over U,A: progress
    loop "every 3 s until phase complete"
        U->>A: "GET .../uploads/batches/batchId"
        A-->>U: "files, pipeline counts, failures, stalledSessions"
    end
```

<details>
<summary><strong>Upload session and batch state machines</strong></summary>

```mermaid
stateDiagram-v2
    direction LR
    [*] --> pending: "params or multipart create"
    pending --> in_progress: "first part ETag confirmed"
    in_progress --> in_progress: "more parts — resume across sessions"
    in_progress --> completed: "complete succeeds + TX written"
    in_progress --> aborted: "user cancels or DELETE"
    pending --> aborted: "TTL 5 days, before R2 7-day abort rule"
    completed --> [*]
    aborted --> [*]

    note right of in_progress
      Resume truth comes from R2 ListParts,
      never from Mongo. No upload_parts
      collection exists to fall out of sync.
    end note
```

```mermaid
stateDiagram-v2
    direction LR
    [*] --> uploading
    uploading --> processing: "all bytes landed"
    processing --> complete: "zero failures"
    processing --> complete_with_errors: "one or more failures"
    complete --> [*]
    complete_with_errors --> processing: "images:reprocess-failed"

    note right of complete
      upload.batch.completed
      email only if 100+ files
      or over 10 min runtime
    end note
    note right of complete_with_errors
      always email, carries retry action
      rejections folded into one summary,
      never one notification per file
    end note
```

</details>

---

## 7. Face recognition — the vector search runs inside MongoDB

```mermaid
sequenceDiagram
    autonumber
    participant Q as "Upstash — q:selfie then q:image"
    participant W as "Python worker — InsightFace"
    participant M as "MongoDB + Atlas Vector Search"
    participant R as "R2"
    participant A as "API /internal/*"

    W->>Q: "claim batch — pull based, controls own concurrency"
    Q-->>W: "envelope: kind, id, tenantId, eventId, priority, spaceKey"
    W->>M: "findOneAndUpdate lease<br/>queued/expired → processing, leaseExpiresAt, workerId, attempts++"
    alt "no document matched"
        W->>W: "another worker holds a live lease — skip silently"
    end
    par "download and inference pipelined"
        W->>R: "GET original bytes"
    and
        W->>W: "detect + embed previous item"
    end

    alt "kind = event_image"
        W->>M: "upsert imageFaces on imageId + faceIndex<br/>vector as BinData subtype 9, L2 normalised"
        Note over M: "Atlas builds the vectorSearch index"
    else "kind = selfie or match_incremental"
        W->>M: "$vectorSearch on imageFaces<br/>queryVector = selfie.embedding<br/>exact: true, limit 500<br/>filter eventId + createdAt > watermark"
        M-->>W: "ranked neighbours, threshold and detScore<br/>post-filtered in the SAME pipeline"
        W->>M: "bulk upsert faceMatches on profileId+imageId+faceIndex"
        W->>M: "set lastMatchRunAt = runStartedAt<br/>captured BEFORE the query, $inc matchCount"
    end

    W->>M: "processing.status = done, durationMs, modelKeys"
    W->>A: "POST /internal/domain-events — batched, max 100"
    A-->>W: "202 accepted / deduped / rejected"
    W->>A: "POST /internal/worker/heartbeat every 30 s"
    A-->>W: "config channel: activeSpaceKey, leaseMinutes, maxAttempts, pauseRequested"
```

<details open>
<summary><strong>Why selfie → imageFaces and never the reverse</strong></summary>

```mermaid
flowchart LR
    subgraph bad["REJECTED — image face searches selfies"]
        B1["5,000 images × ~3 faces<br/>= 15,000 vector queries per batch"]
        B2["A selfie uploaded seconds ago<br/>may not be indexed yet<br/>→ silently missed photo"]
    end
    subgraph good["CHOSEN — selfie searches image faces"]
        G1["~100 attendees<br/>= ~100 vector queries, incrementally filtered"]
        G2["Search targets were indexed<br/>minutes or hours earlier at upload<br/>→ no index-lag exposure"]
        G3["One vector index, half the code"]
    end
    bad -->|"~150× cheaper, structurally correct"| good

    style bad fill:#fdecea
    style good fill:#e9f7ef
```

```mermaid
flowchart TD
    A["Selfie embedded"] --> B["$vectorSearch<br/>index: imageFaces_vec_arcface_r100_512<br/>path: vectors.arcface_r100_512"]
    B --> C["filter eventId<br/>hard tenancy + event scope"]
    B --> D["filter createdAt > lastMatchRunAt<br/>incremental watermark"]
    C --> E["ENN exact: true — 100 percent recall<br/>no numCandidates tuning"]
    D --> E
    E --> F["score → cosine = 2s - 1"]
    F --> G{"cosine >= thresholds.match<br/>AND detScore >= 0.55"}
    G -->|"no"| H["discarded — never leaves MongoDB"]
    G -->|"yes"| I["faceMatches upsert<br/>unique profileId+imageId+faceIndex<br/>makes every re-run idempotent"]
    I --> J["attendee.matches.ready — exactly once<br/>or attendee.matches.new — digested"]

    style B fill:#e8f0fe
```

**Contract:** the worker receives **decisions, not candidate sets**. Loading vectors into Python to compare them is a contract violation.

</details>

<details>
<summary><strong>Processing state machine, leases and the sweep</strong></summary>

```mermaid
stateDiagram-v2
    [*] --> queued: "API inserts work item + enqueues"
    queued --> processing: "worker claims — lease set, attempts++"
    processing --> done: "results written"
    processing --> queued: "lease expired — sweep reclaims"
    processing --> failed: "retryable false"
    queued --> failed: "attempts >= maxAttempts"
    processing --> skipped: "zero faces is done, not failed"
    failed --> queued: "organizer reprocess or admin requeue"
    done --> [*]

    note right of processing
      Lease renewed every leaseMinutes/3.
      A renewal filtered on workerId that
      matches zero docs means lease_lost —
      abandon immediately, write nothing.
      Writing after losing a lease is how
      duplicate faces appear.
    end note
```

```mermaid
flowchart LR
    S["pipeline-sweep<br/>every 2 minutes"] --> S1["1. expired leases → queued + re-enqueue"]
    S1 --> S2["2. queued over 5 min with no broker ack → re-enqueue"]
    S2 --> S3["3. attempts >= maxAttempts → failed"]
    S3 --> S4["4. profiles whose event has faces newer than<br/>lastMatchRunAt → enqueue match_incremental"]
    S4 --> N["emits pipeline.image.failed daily digest,<br/>pipeline.delayed, admin.queue.backlog"]

    style S4 fill:#fff4e5
```

Step 4 is the entire mechanism behind `attendee.matches.new` — no scheduling collection, just an indexed query.

</details>

---

## 8. Attendee experience

```mermaid
sequenceDiagram
    autonumber
    actor V as "Attendee — phone"
    participant A as "API /api/v1/p/*"
    participant M as "MongoDB"
    participant R as "R2"
    participant Q as "q:selfie — high priority"
    participant C as "pic.openpic.in"

    V->>A: "GET /p/events/slug — scanned the QR"
    A->>M: "resolve accessLinks.slug where active: true"
    A-->>V: "event, gallery state, selfie rules, consent spec, session hint<br/>page renders fully from this ONE call"

    V->>A: "POST /p/attendee-sessions"
    A-->>V: "raw token ONCE + Set-Cookie op_att, 30 d TTL<br/>server stores sha256 only"

    V->>A: "POST /p/events/slug/consent"
    A->>M: "consents row: policyVersion, policyDocumentHash,<br/>evidence ipHash/uaHash/method/locale"
    A-->>V: "201 — receipt emailed only to signed-in attendees"

    V->>A: "POST /p/events/slug/liveness/challenges"
    A-->>V: "sequence look_left, blink, look_center — 15 s"
    Note over A: "no consent → 412 consent_required"

    V->>A: "POST /p/events/slug/selfies/uploads"
    A-->>V: "presigned PUT — selfies are always single PUT"
    V->>R: "PUT selfie bytes"
    V->>A: "POST /p/events/slug/selfies — idempotency required"
    A->>M: "verify object + challenge unused<br/>upsert attendeeEventProfiles, insert selfies priority high"
    A->>Q: "enqueue — drained before q:image"
    A-->>V: "202 pollUrl + pollIntervalMs 2000 + attemptsRemaining"

    loop "server-driven adaptive polling"
        V->>A: "GET /p/events/slug/me"
        A-->>V: "status, statusDetail, matchCount, newMatchCount,<br/>indexingComplete, pollIntervalMs"
        Note over V,A: "2000 processing · 15000 ready+indexing · 60000 settled"
    end

    V->>A: "GET /p/events/slug/gallery"
    A-->>V: "matches newest first + width/height/orientation/aspectRatio<br/>confidence only, raw similarity NEVER exposed"
    V->>C: "img src with exp + sig — no Authorization header"
    C-->>V: "WebP thumbnail from Workers Cache"

    V->>A: "POST /p/events/slug/gallery:seen"
    A-->>V: "204 — explicit call, so a prefetch never clears the New badge"

    V->>A: "POST /p/events/slug/images/id/original-url"
    A-->>V: "15-minute signed original URL"

    V->>A: "POST /me/attendee-sessions:claim — after login"
    A->>M: "re-point subject.kind anonymous → user, one atomic update per profile"
    A-->>V: "claimed events — no data moved, no selfie re-upload, no reprocessing"
```

<details open>
<summary><strong>Participation status and polling cadence</strong></summary>

```mermaid
stateDiagram-v2
    [*] --> no_selfie: "session created"
    no_selfie --> selfie_pending: "bytes PUT, confirm pending"
    selfie_pending --> processing: "selfie row queued"
    processing --> ready: "matches found"
    processing --> no_match: "zero matches after window closed"
    processing --> failed: "no face / liveness fail / low quality"
    failed --> processing: "retry — attemptsRemaining above 0"
    ready --> ready: "incremental runs add matches"
    ready --> withdrawn: "consent withdrawn"
    no_match --> withdrawn: "consent withdrawn"
    withdrawn --> [*]: "selfie + embedding + all faceMatches deleted"

    note right of processing
      pollIntervalMs = 2000
    end note
    note right of ready
      15000 while indexing,
      60000 once indexingComplete
    end note
    note right of withdrawn
      X-Deleted-Counts header:
      selfies=1;embeddings=1;matches=1904
      Same counts land in DSR executionLog.
    end note
```

</details>

<details>
<summary><strong>Consent is a hard gate — no selfie endpoint is reachable without it</strong></summary>

```mermaid
flowchart TD
    A["Attendee action"] --> B{"consents row with<br/>purpose biometric_processing<br/>and current policyVersion?"}
    B -->|"missing"| C["412 consent_required<br/>details.requiredPolicyVersion + policyUrl"]
    B -->|"stale version"| D["422 policy_version_stale<br/>details.currentPolicyVersion"]
    B -->|"granted"| E["liveness challenge allowed"]
    E --> F["selfie submit allowed"]
    F --> G{"entitlement selfies.per_attendee"}
    G -->|"exhausted"| H["403 plan_limit_exceeded"]
    G -->|"ok"| I["queued at high priority"]
    I --> J["DELETE consent at any time<br/>→ withdrawn + biometric data deleted"]

    style C fill:#fdecea
    style D fill:#fdecea
```

</details>

---

## 9. Billing and entitlements

```mermaid
sequenceDiagram
    autonumber
    actor O as "Organizer — owner role"
    participant A as "API /billing/*"
    participant M as "MongoDB"
    participant CF as "Cashfree"
    participant WH as "/webhooks/cashfree"

    O->>A: "POST /billing/checkout — idempotency required"
    A->>M: "subscriptions insert, status incomplete"
    A->>CF: "create mandate on plan price"
    CF-->>A: "subReferenceId + authLink"
    A->>M: "store in externalRefs — never a cashfreeSubscriptionId field"
    A-->>O: "201 opaque checkout.url + expiresAt"
    O->>CF: "approve mandate in UPI app"
    CF-->>O: "redirect to returnUrl"
    Note over O,A: "returnUrl is UX ONLY.<br/>Client must never treat landing as proof of success."

    CF->>WH: "SUBSCRIPTION_AUTH_STATUS success"
    Note over WH: "steps 1-5 before any domain work"
    WH->>WH: "1. verify signature over RAW bytes<br/>2. timestamp within 300 s<br/>3. extract providerEventId or payloadHash"
    WH->>M: "4. insertOne providerWebhookEvents<br/>duplicate key error IS the dedupe"
    WH-->>CF: "5. 200 received within 5 seconds"
    WH->>M: "6. TX: billingTransactions insert + subscriptions update"
    WH->>M: "7. processedAt + processResult applied"
    WH->>M: "8. emitDomainEvent billing.subscription.activated"

    loop "2 s interval, 60 s ceiling"
        O->>A: "GET /subscription"
    end
    A-->>O: "status active + banner null + actions"
```

<details open>
<summary><strong>Subscription state machine — and the invariant that content is never deleted</strong></summary>

```mermaid
stateDiagram-v2
    [*] --> none: "tenant created — NO subscriptions document"
    none --> incomplete: "checkout, mandate created"
    incomplete --> active: "auth + first charge succeed"
    incomplete --> none: "abandoned, auth failed, link expired"
    active --> active: "renewal succeeds"
    active --> past_due: "charge failed or cancelled at bank"
    past_due --> active: "late payment inside 14-day grace"
    past_due --> downgraded: "grace elapsed, still unpaid"
    downgraded --> active: "dues cleared — SAME document, full history"
    active --> cancelled: "user cancels or provider reports cancellation"
    downgraded --> cancelled: "cancelled while downgraded"
    cancelled --> [*]

    note right of downgraded
      activePlanKey = "free"
      subscribedPlanKey unchanged
      pendingDueMinor retained
      NOTHING in events, mediaAssets,
      eventImages, imageFaces, faceMatches
      or selfies is touched. Ever.
    end note
    note right of past_due
      Paid entitlements still apply.
      banner.reassurance is MANDATORY:
      "Nothing has been deleted."
    end note
```

```mermaid
flowchart LR
    subgraph guard["Invariant C6 — enforced three ways"]
        G1["Structural<br/>billing collections hold ZERO<br/>references into media/event collections"]
        G2["Code rule<br/>dunning module may write only<br/>status, activePlanKey, statusHistory"]
        G3["Lint<br/>no-restricted-imports on the dunning module<br/>forbids events, eventImages, mediaAssets,<br/>imageFaces, faceMatches, selfies repos"]
        G4["Test<br/>run dunning against a tenant with content,<br/>assert zero writes outside subscriptions"]
    end
    guard --> R["402 blocks CREATION only.<br/>Read, list, gallery, download and export<br/>are unaffected by subscriptions.status.<br/>Any deviation is a P0 bug."]

    style guard fill:#e9f7ef
    style R fill:#dff0d8
```

</details>

<details open>
<summary><strong>Entitlement check — fully generic, zero plan-name branches</strong></summary>

```mermaid
flowchart TD
    A["checkEntitlement tenantId, key, amount"] --> B["read subscriptions → activePlanKey<br/>absent document = free"]
    B --> C["read plans.entitlements[key]"]
    C --> D{"spec exists?"}
    D -->|"no"| E["allowed — not gated"]
    D -->|"yes"| F{"enforcement"}
    F -->|"feature and limit null"| G{"enabled?"}
    G -->|"false"| G1["403 feature_not_available"]
    G -->|"true"| E
    F -->|"hard / soft / policy"| H["effectiveLimit =<br/>overrideLimit OR plan.limit + sum of active grants"]
    H --> I{"limit null?"}
    I -->|"yes"| E2["allowed — unlimited"]
    I -->|"no"| J["periodKey from resetPeriod<br/>monthly → YYYY-MM · yearly → YYYY · else lifetime"]
    J --> K["read usageCounters<br/>tenantId + entitlementKey + periodKey"]
    K --> L{"used + amount > limit?"}
    L -->|"no"| M["allowed, remaining returned"]
    L -->|"yes, status downgraded"| N["402 payment_required<br/>reason payment_downgrade<br/>pendingDueMinor + payNowUrl"]
    L -->|"yes, otherwise"| O["403 plan_limit_exceeded<br/>reason plan_limit + upgradePath"]
    N --> P["emit usage.action.blocked<br/>in-app only, throttled 1/key/h"]
    O --> P

    style E fill:#e9f7ef
    style E2 fill:#e9f7ef
    style M fill:#e9f7ef
    style N fill:#fdecea
    style O fill:#fdecea
```

Adding a new limit is a **data edit in `plans.entitlements` with zero code change**. Clients render unknown keys generically from `display` — never a hard-coded key list.

</details>

<details>
<summary><strong>Dunning and the grace clock</strong></summary>

```mermaid
sequenceDiagram
    autonumber
    participant CF as "Cashfree"
    participant WH as "Webhook handler"
    participant M as "MongoDB"
    participant CR as "Cron — dunning + reminders"
    participant N as "Notification fan-out"

    CF->>WH: "SUBSCRIPTION_PAYMENT_FAILED"
    WH->>M: "TX: transaction failed with failure.category<br/>status past_due<br/>gracePeriodEndsAt = now + platformSettings.dunning.gracePeriodDays<br/>pendingDueMinor = price, dunning.attemptCount++"
    WH->>N: "billing.payment.failed — in_app + email + MOBILE"
    Note over N: "highest-value mobile message in the product<br/>it starts the 14-day clock"

    loop "grace days 1, 5, 7, 11, 13 — 4x daily cron"
        CR->>M: "reminderDays from platformSettings<br/>remindersSent[] makes it idempotent"
        CR->>N: "billing.grace.reminder — mobile ONLY on day 13"
    end

    alt "user pays inside grace"
        CF->>WH: "SUBSCRIPTION_PAYMENT_SUCCESS"
        WH->>M: "status active, pendingDueMinor 0, gracePeriodEndsAt null, dunning reset"
        WH->>N: "billing.subscription.reactivated + usage.limit.restored"
    else "grace elapses"
        CR->>M: "findOneAndUpdate past_due AND gracePeriodEndsAt < now<br/>→ downgraded, activePlanKey free, append statusHistory<br/>WRITES NOTHING ELSE, EVER"
        CR->>N: "billing.subscription.downgraded<br/>must state: nothing has been deleted"
    end
```

</details>

---

## 10. Notifications — one source of truth, Novu holds nothing

```mermaid
flowchart LR
    subgraph ours["OURS — the only source of truth"]
        BIZ["Business code<br/>calls emitDomainEvent ONCE"]
        DE[("domainEvents<br/>outbox + business log")]
        NT["notificationTypes<br/>81 keys — the routing matrix AS DATA"]
        NP["notificationPreferences<br/>global / byType / byEvent / quietHours / digest"]
        SUP["notificationSuppressions<br/>bounce, complaint, unsubscribe, DND"]
        TPL["notificationTemplates<br/>per typeKey × channel × locale"]
        RES["resolveChannel<br/>PURE function — zero network"]
        FEED[("notifications<br/>in-app feed")]
        DISP[("notificationDispatches<br/>ledger INCLUDING skips")]
        DIG[("notificationDigests<br/>open buckets awaiting flush")]
    end
    subgraph transport["Transport adapter — swappable"]
        MT["MessageTransport.send<br/>fully rendered by us"]
        NOVU["Novu<br/>transport-email · transport-sms · transport-whatsapp<br/>ONE step each, pure pass-through"]
    end

    BIZ --> DE
    DE -->|"dispatch.notifications pending"| RES
    NT --> RES
    NP --> RES
    SUP --> RES
    RES -->|"in_app"| FEED
    RES -->|"email / sms / whatsapp"| TPL
    TPL --> MT
    MT --> NOVU
    RES -->|"every decision, including skips"| DISP
    RES -->|"digest strategy"| DIG
    DIG -->|"flush cron"| MT
    NOVU -->|"delivery + bounce receipts"| DISP
    DE -->|"dispatch.analytics pending"| AN[("analyticsDaily")]
    DE -->|"dispatch.queue pending"| Q["Upstash"]

    style ours fill:#e8f0fe
    style NOVU fill:#fdecea
```

**Zero drift is structural:** Novu knows nothing about the 81 types, the channel routing, the copy, the locales, the digests, the preferences, the quiet hours or the throttles. There is nothing in Novu that _can_ disagree. A CI assertion fails the build unless exactly three workflows exist with one step each.

<details open>
<summary><strong>Channel resolution — the pure function every send passes through</strong></summary>

```mermaid
flowchart TD
    A["fan-out: recipient × typeKey"] --> B{"type enabled?"}
    B -->|"no"| Z1["skip: type_disabled"]
    B -->|"yes"| C["read type.channelGroups"]
    C --> D{"transactional?"}
    D -->|"yes"| G["ignore user preference entirely"]
    D -->|"no"| E{"preference off?<br/>precedence: byEvent > byType > global > default"}
    E -->|"yes"| Z2["skip: user_opt_out"]
    E -->|"no"| G
    G --> H["first eligible candidate in group order<br/>mobile = whatsapp then sms"]
    H --> I{"verified contact exists?"}
    I -->|"no"| J["next candidate"]
    J --> K{"any candidates left?"}
    K -->|"yes"| I
    K -->|"no"| Z3["skip: no_verified_contact"]
    I -->|"yes"| L{"contact suppressed?"}
    L -->|"yes"| J
    L -->|"no"| M{"throttle budget?"}
    M -->|"digest strategy"| Z4["accumulate in notificationDigests"]
    M -->|"over rate limit"| Z5["skip: throttled"]
    M -->|"dedupeKey exists"| Z6["skip: deduped<br/>enforced by UNIQUE INDEX, not code"]
    M -->|"ok"| N{"quiet hours AND severity not critical?"}
    N -->|"yes"| O["defer — skipReason quiet_hours_deferred"]
    N -->|"no"| P["insert notificationDispatches: queued"]
    O --> P

    Z1 --> W[("EVERY skip is persisted.<br/>'Why didn't my co-organizer get the invite?'<br/>is answerable from MongoDB alone,<br/>without opening a provider dashboard.")]
    Z2 --> W
    Z3 --> W
    Z5 --> W
    Z6 --> W

    style W fill:#dff0d8
```

</details>

<details open>
<summary><strong>Cross-channel action idempotency — the hardest requirement, solved without locks</strong></summary>

```mermaid
stateDiagram-v2
    [*] --> pending: "organizer invites"
    pending --> accepted: "accept via in_app OR email OR sms OR api"
    pending --> rejected: "reject via any channel"
    pending --> revoked: "organizer revokes or removes member"
    pending --> expired: "TTL reached"
    accepted --> revoked: "organizer removes member later"
    accepted --> [*]
    rejected --> [*]
    revoked --> [*]
    expired --> [*]

    note right of pending
      Terminal transition = ONE conditional
      findOneAndUpdate with status "pending"
      AND expiresAt greater than now in the filter.
      Second attempt matches 0 docs →
      read current state, return HTTP 200.
      NEVER 409.
    end note
    note right of revoked
      Acceptance is structurally impossible:
      the filter can never match.
      No permission check to forget.
    end note
```

```mermaid
sequenceDiagram
    autonumber
    actor I as "Invitee"
    participant A as "API"
    participant M as "MongoDB"

    Note over I: "clicks the email link"
    I->>A: "POST /invitations/token/accept"
    A->>M: "findOneAndUpdate on tokenHash<br/>filter status pending + not expired"
    M-->>A: "matched → accepted, resolvedVia email"
    A->>M: "TX: eventMembers insert"
    A->>M: "notifications.updateMany on actionTarget<br/>actions.$[].state = unavailable<br/>actionTarget.state = resolved"
    A-->>I: "200 alreadyResolved false + redirectUrl"

    Note over I: "later, clicks Accept in the in-app feed"
    I->>A: "POST /me/notifications/id/actions/accept"
    A->>M: "same conditional update"
    M-->>A: "matched 0 documents"
    A->>M: "read current state"
    A-->>I: "200 outcome already_resolved,<br/>alreadyResolved true, resolvedVia email<br/>UI renders 'Already accepted' — not an error toast"

    Note over A: "The notification OWNS NO STATE.<br/>It is a pointer; invitations is the source of truth.<br/>410 only for revoked/expired, where the<br/>affordance should disappear, not report success."
```

</details>

<details>
<summary><strong>In-app feed mechanics — aggregation, rendering, polling</strong></summary>

```mermaid
flowchart TD
    A["attendee.matches.new arrives"] --> B["findOneAndUpdate upsert<br/>filter: userId, typeKey, groupKey, readAt NULL"]
    B --> C["$inc groupCount<br/>$set updatedAt → feed re-sorts"]
    C --> D{"user reads the row?"}
    D -->|"yes"| E["readAt set — next arrival starts a FRESH row<br/>so the unread badge never under-counts"]
    D -->|"no"| B

    F["title and body are PRE-RENDERED at write time"] --> G["client displays VERBATIM<br/>must NOT re-render from typeKey + data"]
    G --> H["a notification says what it said when sent,<br/>even if the template changed since"]

    I["Unknown typeKey / category / severity"] --> J["render generically from title/body/severity<br/>new types ship with NO client deploy"]

    K["OTP types"] --> L["in_app false at catalogue level<br/>retainBody false on dispatch<br/>codes never enter a durable, session-readable feed"]

    style L fill:#fdecea
```

```mermaid
flowchart LR
    A["Bell badge"] -->|"GET /me/notifications/unread-count<br/>every 30 s, honour pollIntervalSeconds"| B["countDocuments against<br/>idx_user_unread PARTIAL index<br/>where readAt: null"]
    B --> C["ETag: unreadCount-severity-epoch"]
    C --> D{"If-None-Match matched?"}
    D -->|"yes"| E["304 — no change, no re-render"]
    D -->|"no"| F["200 unreadCount, byCategory, highestSeverity"]
    G["tab hidden"] -->|"MUST pause"| A
    H["Panel opened"] -->|"GET /me/notifications every 15 s"| I["cursor feed, 20 per page"]

    style B fill:#dff0d8
```

</details>

<details>
<summary><strong>The 81-key catalogue, by category</strong></summary>

```mermaid
pie showData
    title "81 notification typeKeys across 10 categories"
    "billing" : 16
    "event" : 11
    "authentication" : 9
    "matching" : 9
    "collaboration" : 8
    "pipeline" : 8
    "platform_ops" : 7
    "account" : 5
    "usage" : 4
    "compliance" : 4
```

Channel budget: **in_app 92 percent · email 80 percent · mobile 23 percent**. Mobile is rationed to money, access and secrets — a deliverability decision as much as a cost one, because users who get frequent transactional SMS start blocking them, which breaks OTP.

</details>

---

## 11. Media delivery — signed capability, cached bytes

```mermaid
sequenceDiagram
    autonumber
    participant B as "Browser"
    participant N as "Next.js — control plane"
    participant G as "Worker Gateway — cache OFF"
    participant CM as "CachedMedia entrypoint — cache ON"
    participant WC as "Workers Cache — tiered"
    participant R as "Private R2"

    B->>N: "GET gallery or POST /media/signed-urls"
    N->>N: "authorize PER ITEM<br/>thumbnail: event member OR attendee with a faceMatch<br/>original: member with originals.download OR matched attendee"
    N->>N: "sign: base64url HMAC-SHA256 of METHOD + PATH + EXPIRY"
    N-->>B: "urls[] + denied[] — whole request still 200<br/>403 only if EVERY item is denied"
    Note over N: "thumbnails 24 h · originals 15 min. Never invert."

    B->>G: "GET /t/sha256.webp?exp=...&sig=...<br/>plain img src, NO Authorization header"
    G->>G: "validate method, path shape, expiry, HMAC over exact path"
    alt "invalid or expired"
        G-->>B: "403 → client calls /media/signed-urls once, retries ONCE<br/>never retry-loop on 403"
    else "valid"
        G->>G: "strip exp and sig → canonical cache key = pathname"
        G->>CM: "ctx.exports.CachedMedia.fetch"
        CM->>WC: "cache lookup"
        alt "HIT"
            WC-->>B: "cached WebP — CachedMedia never executes"
        else "MISS"
            CM->>R: "R2 binding get"
            R-->>CM: "bytes"
            CM->>WC: "store with Cloudflare-CDN-Cache-Control<br/>thumbnails 31 d · originals 7 d + Cache-Tag"
            WC-->>B: "200 image/webp"
        end
    end
```

```mermaid
flowchart LR
    subgraph key["Why the token is stripped from the cache key"]
        A["User A: /t/abc.webp?exp=1000&sig=AAA"]
        B["User B: /t/abc.webp?exp=2000&sig=BBB"]
        C["User C: /t/abc.webp?exp=3000&sig=CCC"]
        A --> D["canonical /t/abc.webp"]
        B --> D
        C --> D
        D --> E["ONE cache object<br/>Clients must not treat the URL as identity —<br/>imageId + contentHash are the identity"]
    end
    subgraph sig["Why the signature is per path"]
        S["one shared secret"] --> S1["sig for /t/A.webp"]
        S --> S2["sig for /t/B.webp"]
        S --> S3["sig for /o/C.jpg"]
        S1 --> S4["swapping A for B while keeping A's sig<br/>→ recomputed HMAC mismatches → 403.<br/>This is the defence against key guessing."]
    end

    style E fill:#dff0d8
    style S4 fill:#dff0d8
```

---

## 12. Machine-to-machine

<details open>
<summary><strong>Webhook inbox — the 8 steps, no reordering permitted</strong></summary>

```mermaid
flowchart TD
    A["POST /webhooks/provider"] --> B["1. verify signature over the RAW body<br/>never the parsed body — JSON re-serialisation breaks HMAC"]
    B -->|"invalid"| B1["401 invalid_signature — NO write"]
    B --> C["2. timestamp within 300 s"]
    C -->|"stale"| C1["401 stale_signature"]
    C --> D["3. extract providerEventId,<br/>else payloadHash = sha256 rawBody"]
    D --> E["4. insertOne providerWebhookEvents<br/>with provider, env, eventType, rawPayload"]
    E -->|"duplicate key error"| E1["200 duplicate_ignored — do nothing else.<br/>THE UNIQUE INDEX IS THE DEDUPE.<br/>No application-level 'have I seen this?' check."]
    E --> F["5. respond 200 within 5 SECONDS,<br/>before any projection work"]
    F --> G["6. project AFTER responding —<br/>TRANSACTION: billingTransactions + subscriptions<br/>money and access move together"]
    G --> H["7. set processedAt + processResult<br/>applied / ignored / error"]
    H -->|"failure leaves processedAt null"| H1["webhook-projection-sweep retries every 5 min<br/>never a non-200 to the provider"]
    H --> I["8. emitDomainEvent for every state change.<br/>The handler NEVER calls the notification service."]
    G -->|"env mismatch"| J["422 env_mismatch, processResult ignored<br/>a sandbox event must never touch production"]

    style E1 fill:#dff0d8
    style F fill:#fff4e5
```

</details>

<details open>
<summary><strong>Cron — 24 idempotent, bounded, concurrency-safe jobs</strong></summary>

```mermaid
flowchart LR
    subgraph fast["Every 2–5 minutes"]
        A1["pipeline-sweep — 4 steps"]
        A2["webhook-projection-sweep"]
        A3["pipeline-indexed-check"]
        A4["notification-digest-flush"]
        A5["notification-dispatch-retry"]
    end
    subgraph qh["Every 15 min / hourly"]
        B1["quiet-hours-release"]
        B2["dunning"]
        B3["scheduled-plan-changes"]
        B4["upload-session-sweep"]
        B5["event-window-sweep"]
        B6["usage-threshold-check — LATCHED per threshold per period"]
        B7["invitation-expiry + reminder"]
        B8["verification-nudge — max 2 EVER"]
        B9["attendee-no-match-check"]
    end
    subgraph day["4x daily / every 4 h / daily"]
        C1["dunning-reminders — days 1,5,7,11,13"]
        C2["billing-reconcile — the webhook-miss safety net"]
        C3["renewal-reminders — T-3d"]
        C4["retention-warnings — T-14/7/3/1d"]
        C5["retention-purge — ordered, counted, NEVER a TTL"]
        C6["account-deletion-purge"]
        C7["dsr-sla-check"]
        C8["analytics-rollup 02:00 IST"]
        C9["counter-reconcile 02:30 IST"]
        C10["tenant-isolation-audit"]
    end

    R["Mandatory rules for every job"] --> R1["1. conditional single-document updates only —<br/>expected prior state in the filter, never read-then-write"]
    R --> R2["2. bounded work — ?limit= and returns hasMore,<br/>completes inside the Vercel timeout"]
    R --> R3["3. NEVER emit notifications inline —<br/>write domainEvents, the fan-out consumer delivers"]
    R --> R4["4. structured result body: scanned, affected,<br/>skipped, errors, hasMore, details"]

    style C5 fill:#fdecea
    style R fill:#e8f0fe
```

</details>

<details>
<summary><strong>Queue envelope — the broker is transport only</strong></summary>

```mermaid
flowchart LR
    A["Upstash Redis"] --> B["q:selfie — HIGH<br/>drained strictly first"]
    A --> C["q:image — NORMAL"]
    B --> D["an attendee is staring at a spinner"]
    C --> E["an organizer's batch can wait"]

    F["Envelope = a POINTER, never state"] --> G["v, kind, id, tenantId, eventId,<br/>priority, spaceKey, enqueuedAt, attempt, traceId"]
    G --> H["All state is re-read from MongoDB at claim time,<br/>so a message sitting for an hour is never stale"]
    G --> I["spaceKey differs from worker config<br/>→ re-read config before processing<br/>mid-flight model promotion"]
    J["Broker message id lives ONLY in<br/>processing.queueRef.messageId"] --> K["Upstash → SQS = queueRef.provider<br/>plus one adapter. ZERO schema change."]
    L["A lost broker message is a non-event"] --> M["MongoDB holds durable job state;<br/>the sweep re-enqueues anything queued<br/>past its ack window"]

    style H fill:#dff0d8
    style M fill:#dff0d8
```

</details>

---

## 13. Compliance, admin and operations

<details open>
<summary><strong>Data subject requests — deletion becomes evidence</strong></summary>

```mermaid
sequenceDiagram
    autonumber
    actor S as "Data subject — user or attendee"
    participant A as "API"
    participant M as "MongoDB"
    participant AD as "Admin"

    S->>A: "POST /me/data-requests — idempotency required, 5/day"
    A->>M: "dataSubjectRequests: requestType, regulation gdpr/dpdpa,<br/>scope, slaDueAt"
    A-->>S: "202 acknowledgement with the statutory SLA date"
    A->>M: "emit privacy.dsr.received"

    Note over M: "within 48 h of slaDueAt → admin.dsr.sla_risk"
    AD->>A: "POST /admin/data-requests/id/execute"

    rect rgb(232, 240, 254)
        Note over A,M: "Bounded, COUNTED purge — vectors live only on<br/>imageFaces and selfies, both carrying<br/>tenantId + eventId + subject refs"
        A->>M: "deleteMany faceEmbeddings → count 412"
        A->>M: "deleteMany faceMatches → count 1904"
        A->>M: "deleteMany selfies → count 3"
        A->>M: "delete storageObjects → count 3"
    end

    A->>M: "append each step to executionLog with count + timestamp"
    A-->>S: "GET /me/data-requests/id → executionLog is THE EVIDENCE"
    A->>M: "emit privacy.erasure.completed — EMAIL ONLY,<br/>in-app may no longer exist"

    Note over A: "access / portability instead produce export:<br/>short-lived signed URL, capped downloadsRemaining"
```

</details>

<details>
<summary><strong>Admin surface and the deliverability forensics screen</strong></summary>

```mermaid
flowchart TD
    A["Admin — platformRole admin AND 2FA"] --> B["every POST/PATCH/DELETE writes auditLogs<br/>actor ipHash/uaHash, action, target, before, after, reason"]
    B --> C{"destructive or financially material?"}
    C -->|"yes, no reason"| C1["422 reason_required"]

    A --> D["Tenants and users<br/>NOTE: tenants.status is NOT subscriptions.status.<br/>Suspension = abuse. Downgrade = billing.<br/>Separate controls."]
    A --> E["Plans — If-Match, version bump,<br/>amounts IMMUTABLE, plans NEVER deleted"]
    A --> F["Notification catalogue —<br/>/impact is a MANDATORY read before a routing change"]
    A --> G["Dispatch forensics<br/>filter by userId, typeKey, channel, status, skipReason"]
    A --> H["Queue and pipeline health — poll 30 s"]
    A --> I["Billing ops — PATCH restricted;<br/>touching an event/media field → 422 forbidden_field.<br/>C6 as a request validator."]
    A --> J["Face model promotion —<br/>flips platformSettings.face.activeSpaceKey,<br/>requires backfill coverage >= 99.9 percent"]
    A --> K["Audit logs — READ ONLY.<br/>No write, update or delete endpoint exists, by design."]

    G --> L["'Why didn't my co-organizer get the invite?'<br/>answered from MongoDB alone.<br/>This endpoint is the entire justification<br/>for persisting skips."]

    style L fill:#dff0d8
    style I fill:#fff4e5
```

</details>

<details>
<summary><strong>Model swap — zero downtime, zero schema change</strong></summary>

```mermaid
flowchart LR
    A["1. insert faceModels row<br/>status shadow, NEW spaceKey + vectorPath"] --> B["2. create the second Atlas vector index<br/>on the new path"]
    B --> C["3. backfill — worker writes<br/>vectors.newSpace ALONGSIDE vectors.oldSpace"]
    C --> D["4. evaluate both spaces on a labelled set,<br/>compare precision and recall"]
    D --> E["5. flip platformSettings.face.activeSpaceKey<br/>THE ONLY PRODUCTION SWITCH"]
    E --> F["worker learns via heartbeat response —<br/>no redeploy"]
    F --> G["6. after a hold period: $unset the old path,<br/>drop the old index, mark retired"]

    H["Thresholds live in faceModels.thresholds<br/>and are applied in the AGGREGATION PIPELINE"] --> I["changing a threshold must NEVER<br/>require an index rebuild"]

    style E fill:#dff0d8
    style I fill:#dff0d8
```

</details>

---

## 14. Polling is the transport, and the server owns its cadence

There is no realtime transport — Vercel means no long-lived connections.

```mermaid
flowchart LR
    subgraph surfaces["Poll cadence — server-driven where a field exists"]
        A["Notification badge<br/>30 s · pollIntervalSeconds"]
        B["Notification panel open<br/>15 s"]
        C["Attendee status processing<br/>2 s · pollIntervalMs"]
        D["Attendee status ready+indexing<br/>15 s · pollIntervalMs"]
        E["Attendee status settled<br/>60 s · pollIntervalMs"]
        F["Upload batch<br/>3 s until phase complete"]
        G["Event pipeline<br/>10 s until indexed"]
        H["Checkout return<br/>2 s, 60 s ceiling"]
        I["Download job<br/>3 s · pollIntervalMs"]
        J["Admin pipeline health<br/>30 s"]
    end

    subgraph rules["Mandatory client behaviour"]
        R1["pause when visibilityState is not visible"]
        R2["honour the server interval —<br/>hard-coded intervals are a contract violation"]
        R3["exponential backoff on 5xx, x2 to 5 min, reset on success"]
        R4["on 429 obey Retry-After EXACTLY"]
        R5["If-None-Match on unread-count, 304 = no re-render"]
        R6["ONE shared poller per surface per tab"]
    end

    surfaces --> rules
    rules --> F1["A future SSE/Pusher transport changes only<br/>HOW the client learns to refetch.<br/>Endpoints, indexes, DTOs and components<br/>stay identical. Do not design around WebSockets."]

    style F1 fill:#dff0d8
```

```mermaid
flowchart TD
    A["Cache-Control by endpoint"] --> B["GET /plans → public, max-age=300 + ETag"]
    A --> C["GET /legal/policies/current → public, max-age=3600"]
    A --> D["GET /notification-types → private, max-age=600"]
    A --> E["GET /uploads/config → private, max-age=300"]
    A --> F["GET /p/events/slug → private, max-age=30"]
    A --> G["EVERYTHING ELSE → no-store"]
    A --> H["pic.openpic.in/t/* → CDN 31 d, browser 1 h"]
    A --> I["pic.openpic.in/o/* → CDN 7 d, browser 5 min"]

    style G fill:#fff4e5
```

---

## 15. The seams that make every vendor swappable

```mermaid
flowchart TB
    subgraph rule["One rule: no vendor name in any field name"]
        A["externalRefs: provider, env, kind, id, meta, linkedAt"]
        B["storage.locationKey → resolved by config to bucket/region"]
        C["processing.queueRef.provider + messageId"]
        D["notificationDispatches.providerRef"]
        E["plans.prices[].externalRefs — the ONLY place a payment vendor appears"]
    end

    subgraph swaps["Adapter-only swaps"]
        S1["Cashfree → any PSP<br/>createMandate, chargeOnce, cancelMandate,<br/>fetchStatus, verifyWebhook,<br/>normalizeStatus, normalizeFailureCategory"]
        S2["Novu → SendGrid + Twilio + Meta<br/>MessageTransport.send — ONE method.<br/>Suppressions already first-party."]
        S3["Upstash → SQS<br/>enqueue, claim, ack, nack"]
        S4["R2 → S3<br/>flip the locationKey map, copy objects.<br/>Not one of millions of mediaAssets docs changes."]
        S5["InsightFace variant → anything<br/>new spaceKey, dual-write, flip activeSpaceKey"]
    end

    rule --> swaps
    swaps --> Z["Schema changes required: ZERO, in all five cases.<br/>Both providers can legitimately coexist during a migration<br/>because nothing ever selects externalRefs[0]."]

    style Z fill:#dff0d8
```

---

## 16. What the whole system guarantees

```mermaid
mindmap
  root(("OpenPic<br/>invariants"))
    Never destroy
      ::icon(fa fa-shield)
      Billing state never deletes, hides or degrades content
      402 blocks creation only
      Reads, gallery, download, export unaffected by subscription status
      Dunning writes only status, activePlanKey, statusHistory
      Retention purge is user-visible, warned, ordered and counted
      Only one content-destroying endpoint exists, and it is user-initiated
    Never leak
      Face vectors returned by no endpoint, to no caller, ever
      Raw tokens issued exactly once, sha256 at rest
      Cross-tenant reads: exactly ONE whitelisted path
      Nested resource in another tenant returns 404, never 403
      Another user's full contact is always masked
      Raw similarity scores never reach attendees
    Never drift
      Routing lives only in notificationTypes
      Novu holds no templates, routing, preferences or digests
      CI asserts exactly 3 transport workflows, 1 step each
      Every number read from platformSettings, none hard-coded
      Plan limits are data, so a new limit is a data edit
    Never double-apply
      Unique indexes ARE the dedupe, not application checks
      Terminal transitions are one conditional findOneAndUpdate
      Repeated action returns 200, never 409
      Match upserts idempotent on profileId+imageId+faceIndex
      Webhook replay fails to insert and returns 200
    Never lose work
      MongoDB is job truth, the broker is transport
      Leases plus a 2-minute sweep recover any crash
      Abandon on lease_lost, write nothing
      Watermark set to runStartedAt, captured before the query
      Outbox means a notification failure cannot block analytics
```

---

### How to read this set

1. **Diagrams 1–4** are the system. If you only read those, you know what OpenPic is and how a request moves through it.
2. **Sections 5–9** are the four domains that carry real complexity: tenancy, uploads, faces, billing.
3. **Sections 10–12** are the machinery most likely to surprise you: notifications hold no state, webhooks respond before projecting, cron is idempotent and bounded.
4. **Sections 13–16** are the operational and non-functional guarantees — what you must not break.
