# ADR-0808 — OP-132 decision: the pipeline publishes a match result that lands after the confirmation

- **Status:** Accepted
- **Consumers:** `apps/web/src/test/integration/selfie-confirm-publication.test.ts` — case
  (i), "announces the late result exactly once, whichever publisher writes first", and its
  `activationDeliveryKey` helper — and
  `apps/web/src/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route.ts` — the
  handler's `dedupeKey` / `willPublish` block and the docblock paragraph that names this
  record.
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity lane`) is
  exhausted; the records above it draw from `unallocated (future lanes)`, whose cell read
  `0807` at this cut. `0807` is **in flight** — `ADR-0807-op132-refusal-edge-pins.md` is
  committed at `a49d3d9` on branch `OP-132-task-refusal-edge-pins` (open PR #558) — so this
  record draws **`0808`** and both cells advance to `0809`. `0809` is reserved for this lane's
  GREEN sibling (`t_29382bcc`), which consumes it only if a production change turns out to be
  needed. No new lane row is minted, and no number outside `0808` is consumed.
- **Amends:** [ADR-0805](ADR-0805-op132-confirm-publication-pins.md) §3 — the reading that the
  pins constrain _who_ publishes (superseded in §2 below) — and
  [ADR-0806](ADR-0806-op132-confirm-publication-green.md) §1 and its `§Consequences`
  "Known limit, recorded deliberately" bullet (corrected in the same card).
- **Consumes:** `0808`.

## Context

GREEN item 3 of the OP-132 confirmation card said that a worker result arriving **after** the
confirm must become visible "without requiring the client to call confirm again". It was not
delivered, and the record that closed the GREEN (`ADR-0806` §1) justified that with two claims
that do not survive measurement at `fa350d3`:

1. **"The pin forbids it."** `selfie-confirm-publication.test.ts` read `matchesNewRows()` right
   after `runWorker`, but `runWorker` → `finishSelfieWorker`
   (`apps/web/src/test/helpers/selfie-flow.ts:638`) writes the embedding and the
   `face_matches` rows with **raw driver calls** on `app.db`. No production code runs between
   those writes and the read, so that assertion could not fail whatever a future publisher
   did. It observed an absence; it never constrained one.
2. **"The client's poll re-issues the confirmation."** The confirm's own `200` body points at
   `pollUrl: /api/v1/p/events/{slug}/me`, and `GET …/me` is read-only (contract §6.4, "the
   single polling endpoint", `read.hot`, `Cache-Control: no-store`); it never emits a domain
   event. There is no shipped path that re-issues a confirm.

The measured state at that head:

- `apps/` holds only `web`. There is **no worker application in this repository**, and
  `apps/web/src/app/api/v1/internal/` holds only `cron/`.
- The confirm route is the only emitter of `attendee.matches.new`:
  `grep -rn 'attendee.matches.new' apps packages --include=*.ts | grep -v /test/` returns the
  catalogue entry (`notification-types.values.ts`) and `confirm/route.ts` (twice), and nothing
  else in application source.
- The worker's publication transport and the profile projection writer are **specified but
  unbuilt**: `POST /api/v1/internal/domain-events` (OP-135 §1), the projection writer
  `POST /api/v1/internal/worker/report` (OP-135 §3) and `pipeline-sweep` step 4's
  `match_incremental` enqueue (OP-136 §2) all live on `todo` cards
  (`t_ca95e452`/`t_4a280d94`, `t_b25b384f`/`t_d18a6e9e`).

So a result that lands after the activation is announced only by a second, client-initiated
confirm, and no client-facing text asks for one. The question `t_b0bf2ff2` had to settle is
**who publishes it**.

## Decision

### 1. The pipeline publishes a result that lands after the confirmation

The owner is the **pipeline**, not the client and not the route:

- the event: the worker's `POST /api/v1/internal/domain-events` (OP-135 §1 — internal, max 100
  per batch, `dedupeKey` honoured), the only publication transport the worker is designed to
  have;
- the projection: `POST /api/v1/internal/worker/report` (OP-135 §3), which owns
  `status`/`matchCount`/`lastMatchRunAt` — the three fields `GET …/me` projects (§6.4). Without
  that write a profile whose confirm raced the worker polls `processing` for ever, so the
  report is the **visibility** half of this decision, not only the notification half;
- the rows: `pipeline-sweep` step 4 (`match_incremental`, OP-136 §2), which is what produces a
  match after the attendee's confirm in the first place.

**Neither endpoint ships at this head**, and OP-135/OP-136 are `todo`. This record assigns the
ownership; it does not claim a delivered path, and the API contract must not describe one
until those cards land. Until they do, a late result is announced only by a second,
client-initiated confirm — and no shipped client-facing text asks the attendee for one.

### 2. The pins constrain the number of deliveries, never the identity of the publisher

ADR-0805 §3 read "the pins would not forbid a worker-side publisher … as long as one
confirmation still yields one row" and then relied on case 3's emptiness assertion as if it
forbade one. It cannot (Context 1): `finishSelfieWorker` writes with raw driver calls, so the
assertion measured nothing about a publisher. The revised reading, and the one case (i) now
pins: for one **activation result** there is exactly one delivery, **whoever writes it**.
Whether that writer is the route, the worker or a future consumer is not a property the pins
measure — and the outbox being unchanged right after `runWorker` is recorded in the case as an
observation, not as a prohibition.

### 3. One delivery identity per activation result, and a different one per arrival

The activation identity is `attendee.matches.new:<eventId>:<profileId>:<selfieId>` — already
minted by the confirm (`confirm/route.ts:114`) and read before the insert (`:115-119`),
because a colliding insert inside a transaction aborts it (ADR-0806 §3). Any second publisher
must use the **same** shape, so whoever writes first wins and the other is a no-op; that is
what case (i) pins: it publishes the pipeline's row first through `emitDomainEvent` with that
key, then confirms, and asserts one row — the pipeline's own id — with `count: 3`,
`status: "ready"` and `matchCount: 3`.

A later **arrival** for an already-announced selfie is a _different_ delivery and must carry a
run discriminator in its key (the incremental run's id, or its `createdAt`). A `selfieId`-only
key is silently swallowed by `domain_events_dedupe_unique`, so a run that reused the activation
key would announce nothing at all. That key belongs to OP-136's incremental run.

### 4. Rejected alternatives

- **(b) The client re-confirms as the documented recovery.** Rejected on three measured facts:
  the poll is a `GET` and cannot `POST`; §6.4 projects no "unannounced matches" field, so a
  client cannot tell _when_ to re-confirm without re-confirming on every ready poll; and it
  makes an announcement depend on a client action, which leaves the anonymous attendee —
  deliberately unreachable by notifications (notification §2) — uncovered by design.
- **(c) The confirmation stays the only publisher and the contract records the gap.** Rejected
  as the _architectural_ answer: it leaves §7.6's "additional matches later" with no producer
  and `attendee.matches.ready`/`firstMatchNotifiedAt` (§15.3) owned by nobody, and it leaves a
  raced selfie polling `processing` indefinitely. It remains the accurate description of
  **this** head, and §1 says so.
- **(a′) A new publication seam inside `apps/web` (a match-write service the worker would
  call).** Rejected: the worker is a separate component whose only designed interface is the
  internal HTTP surface, so a TypeScript module in this repo would be code with no caller.

### 5. Scope of the OP-132 follow-up

No production change is required in this repository for the decision: the confirm's pre-read
already makes the two publishers mutually exclusive. The in-repo work is the pin revision (§2,
§3), this record, the ADR-0806 §1 correction, and one comment-only docblock alignment in the
confirm route (the GREEN sibling `t_29382bcc`). The publisher itself lands with OP-135 and
OP-136.

## Consequences

- A `face_matches` row that lands after the activation is announced by the pipeline, once per
  arrival, and the confirmation is not required again — but only once OP-135/OP-136 ship.
- The confirmation remains a correct publisher for the non-raced case, and a repeat confirm
  stays a no-op; the two paths cannot double-announce because they share the activation key.
- A profile whose confirm raced the worker leaves `processing` only when the worker report
  lands; that is OP-135 §3's obligation, and it is now recorded as the visibility requirement.
- `firstMatchNotifiedAt` (§15.3) keeps a single writer: the first delivery, whichever publisher
  makes it. The confirm's stamp (ADR-0806 §4) and the worker's must not both move it.
- `docs/adr/README.md` stays the shared-ledger hotspot: both `Next free` cells move `0807` →
  `0809`, and the row plus the note merge as a union keeping the highest value.

## Verification (this head)

Branch `OP-132-task-late-match-publication-pins` off `origin/main` `70ae5ec` (the release
commit above `fa350d3`). Test-only plus ADR/ledger: no production, fixture or helper file is
modified.

| gate                                                         | result                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `selfie-confirm-publication` (2 unchanged + 2 revised cases) | 4 passed (4)                                             |
| the five frozen neighbour files                              | 5 files, 50 passed (50)                                  |
| `tsc -p apps/web/tsconfig.json --noEmit`                     | no errors, exit `0`                                      |
| `eslint --max-warnings=0` on the touched TypeScript file     | 0 errors, 0 warnings, exit `0`                           |
| `prettier --check` on the four touched files                 | all files formatted                                      |
| the five ADR guard specs                                     | `adr-numbering`, `adr-lane-ranges`, `adr-record-links`,  |
|                                                              | `adr-source-references`, `adr-consumers` — 218 passed    |
| mutation probe on the load-bearing arm (case (i))            | reddens; the route restored byte-identically — see below |

The frozen neighbours are `liveness-selfie-submit`, `selfie-reuse`,
`selfie-reuse-attempt-cap`, `attendee-participation-status` and `selfie-upload-collision` — the
files that drive the confirm route.

**Mutation probe, case (i).** One throwaway edit to `…/confirm/route.ts` changed the
handler's identity to a second shape (`attendee.matches.new:v2:<eventId>:<profileId>:
<selfieId>`). With that edit the confirmation no longer recognised the pipeline's row and
inserted a second delivery for one activation result:

```
× announces the late result exactly once, whichever publisher writes first
AssertionError: expected [ { …(10) }, { …(10) } ] to have a length of 1 but got 2
Tests  1 failed | 3 skipped (4)
```

The file was restored byte-identically — `sha256 57f5343a89209124ca05cfc4f9267642d0276b80de3eb2f79e200b0c035fdd8f`
before and after, `git status` clean for that path — so the pin discriminates the key shape
and nothing else.

**Measured for the Context and the lane paragraph:** `ls apps` → `web`; `ls
apps/web/src/app/api/v1/internal` → `cron/`; the emitter grep above; the newest record on
`origin/main` is `0806`; `ADR-0807-op132-refusal-edge-pins.md` is committed at `a49d3d9` on
`OP-132-task-refusal-edge-pins` with PR #558 open; and no `ADR-0808*`/`ADR-0809*` file exists
in any worktree under `.worktrees/`, in any local or remote branch, or in any open PR
(`git log --all --name-only -- 'docs/adr/ADR-0808*' 'docs/adr/ADR-0809*'` is empty). Both
`Next free` cells read `0807` before this change.

## Alternatives

See §4; this section is kept as a pointer so the record matches the surrounding house style.
The one alternative §4 does not list is _doing nothing at all_: it is option (c), rejected
there, and it is also the accurate description of this head, which §1 records explicitly.
