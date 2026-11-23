# ADR-0947 — OP-140: an `attendee.*` row reaches its subject (`attendee_subject`)

- **Status:** Accepted (TEST half RED by design; the GREEN `t_5039edaa` implemented §Decision D5 and landed as `2ea6e1cd`, PR #838)
- **Date:** 2026-11-23
- **Card:** `t_f26559df` (OP-140 TEST, Low, phase 6-M2M · epic Notifications) — the RED half of finding **F1** in [ADR-0962](ADR-0962-op140-attendee-selfie-slug-resolver-and-rejected-producer.md) §3. The routing decision is card `t_f6f20d62` (`openpic-orchestrator`); the producer GREEN is the parent `t_c38a626a` ([ADR-0963](ADR-0963-op140-attendee-selfie-rejected-and-active-slug-resolver-green.md)).
- **Branch:** `OP-140-task-attendee-subject-recipient` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op140-attendee-subject-recipient` · **Base:** `origin/main` `942a31e5` (the squash of PR #835, `b6cad7ea`, plus the release commit).
- **ADR number:** `0947` — **`Consumes: 0947`**, reserved for this card by `t_f6f20d62`. The GREEN writes **no** ADR (`Consumes: none`) and leaves `docs/adr/README.md` byte-identical to this commit.
- **Consumes:** [ADR-0962](ADR-0962-op140-attendee-selfie-slug-resolver-and-rejected-producer.md) §3 (the measured F1 table and the code cause), [ADR-0963](ADR-0963-op140-attendee-selfie-rejected-and-active-slug-resolver-green.md) (the emit shape this card takes as fixed input), [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §2 (the deferred `selfie × retry` action row, which owns the affordance this card does **not** add).
- **Consumers:** `apps/web/src/server/notifications/fan-out.test.ts` (U1–U6), `apps/web/src/server/notifications/notification-types.test.ts` (the catalogue pin), `apps/web/src/test/integration/notification-recipients.test.ts` (R1–R4), `apps/web/src/test/integration/selfie-rejected-recipient.test.ts` (E1–E3, new).
- **Touches:** those four spec files, this record, one `docs/adr/README.md` table row plus the `OP-140 notifications lane` cell (`0945` → `0948`), and exactly one row in the §2 audience table of `docs/Notification and Database Design.md`. **No production file is in the diff.**

## Context

ADR-0962 §3 measured the recipient gap against the **real** repository, not by reading code:

| Arm                                                                                        | Recipients                                                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `subjectRef.kind: "selfie"` (the producer's emit), two identified profiles                 | **both** identified users — the selfie's owner and the unrelated attendee               |
| `subjectRef.kind: "user"`, `subjectUserId` = the owner, same two profiles                  | **still both** — `add(subjectUserId)` cannot narrow what the audience already broadcast |
| the ordinary anonymous profile a real selfie fixture creates (`subject.kind: "anonymous"`) | **`[]`** — nobody                                                                       |

The cause is three lines of routing:

- `fan-out.ts:340-345` expands the `attendee_identified` audience through `listIdentifiedAttendeeUserIds` (`server/repos/notification-recipients.ts:118-137`), which lists **every** `attendeeEventProfiles` row of the event whose `subject.kind === "user"`;
- the single-recipient path `add(subjectUserId)` (`fan-out.ts:363`) only fills when the emit's `subjectRef.kind` is `user` (`fan-out.ts:1239`), and this row's subject **must** be the selfie (ADR-0963 §2: `actionTarget.kind` is the emit's subject kind, and the action endpoint needs a 24-hex target);
- so `attendee.selfie.rejected` — a row about **one** attendee's own photo — is addressed to the event's whole attendee audience, and the ordinary anonymous uploader reaches nobody.

That is not a missing producer (ADR-0963 shipped it) and not a rendering gap: it is the routing vocabulary. There is no audience token that means _the one attendee this row is about_, so the only reachable choice today is the broadcast.

## Decision

### D1 — An `attendee.*` row addresses its **subject**

A row about one attendee's own action or outcome is delivered to that attendee, never to the event's attendee audience. The vocabulary gains one token, **`attendee_subject`**.

### D2 — `attendee_subject` resolves the row's `payload.profileId`

`payload.profileId` already **is** the `attendeeEventProfiles._id`: the submit route writes `_id: attempt.profileId` (`apps/web/src/app/api/v1/p/events/[slug]/selfies/route.ts:168`) and answers the same hex in its `202`, and the producer copies it into the payload. So the token resolves that one profile to `subject.userId`, only when `subject.kind === "user"`, and only inside the row's own `tenantId` + `eventId`. The audience never unions with, and never falls back to, `attendee_identified`.

### D3 — `attendee_identified` stays the genuine event-wide broadcast

`attendee_identified` keeps its meaning and its only reader. After this change **no shipped `attendee.*` row uses it**: `attendee.selfie.rejected` moves off the `ATTENDEE` constant (`notification-types.values.ts:49`) onto a new `ATTENDEE_SUBJECT = ["attendee_subject"]`. `attendee.selfie.accepted` and `attendee.matches.ready` stay catalogue-only and unchanged; when their producers ship they carry `payload.profileId` and use `attendee_subject` (the rule this record fixes for the family).

### D4 — The anonymous subject stays poll-only, and that is not a new gap

`attendee_subject` resolves to **nobody** when the profile's `subject.kind === "anonymous"`. An anonymous attendee learns the rejection from the §6.4 poll — `GET /api/v1/p/events/[slug]/me`, which publishes `processing.status` and the `rejectionReason` through `apps/web/src/server/attendee/status-detail.ts`. Design §2 already states this is deliberate:

> `attendee_anonymous` — pre-login selfie uploader (cookie-bound) — **none** — No verified contact, no account → deliberately unreachable. Their UI state is polled from the same API using the anonymous session token. This is a privacy feature, not a gap.

No out-of-app channel is added: the anonymous subject carries only `attendeeSessionId` and no verified contact, so there is nothing to send to.

### D5 — The exact interface shape (the GREEN implements this; the pins assert the behaviour)

| Site                                                         | Change                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notificationAudienceSchema` (`notification-types.ts:36-43`) | gains `"attendee_subject"`; `NotificationAudience` follows the schema                                                                                                                                                                                           |
| `RecipientRepository` (`fan-out.ts:111-123`)                 | gains `getAttendeeProfileUserId(input: { tenantId: string; eventId: string; profileId: string }): Promise<string \| null>`                                                                                                                                      |
| `ResolveRecipientsInput` (`fan-out.ts:126-133`)              | gains `readonly attendeeProfileId: string \| null`                                                                                                                                                                                                              |
| `processEvent` (`fan-out.ts` ~`:1237`, beside `eventId`)     | extracts `const attendeeProfileId = typeof event.payload.profileId === "string" ? event.payload.profileId : null;` and passes it to `resolveRecipients`                                                                                                         |
| `resolveRecipients`                                          | gains `case "attendee_subject":`, which calls the port only when `eventId !== null && attendeeProfileId !== null`; a missing `attendeeProfileId` is **not** an error and resolves to nobody                                                                     |
| `mongoRecipientRepository` (`notification-recipients.ts`)    | implements the method: `null` for a non-24-hex `profileId`; otherwise `findOne({ _id: <ObjectId>, tenantId: idMatch(tenantId), eventId: idMatch(eventId) })`, answering `idHex(subject.userId)` only when `subject.kind === "user"`, else `null`, never a throw |

The port method is deliberately **not** optional: every fake of `RecipientRepository` gains a compile-time checklist item, which is the point — a fake that cannot answer for a subject cannot silently route a row to a broadcast.

### D6 — Catalogue propagation, no migration

`audiences` is in the seed's `ROUTING_FIELDS` (`seed-notification-types.ts`), so the boot seed reconciles the stored row and bumps its `version` by exactly one. No migration is written.

### D7 — Numbers

`Consumes: 0947`, used as given. `docs/adr/README.md` gains this row (rows ascend; at the time of writing it sits after `0944` and before `0962`) and the `OP-140 notifications lane` cell moves `0945` → **`0948`** (the higher of the trunk value and `max(consumed)+1`). No other cell moves, no cell is lowered, and the pool cursor is untouched.

## Evidence

### RED — the four spec files, against the branch's production tree

```
pnpm vitest run --project unit \
  apps/web/src/server/notifications/fan-out.test.ts \
  apps/web/src/server/notifications/notification-types.test.ts

 Test Files  2 failed (2)
      Tests  5 failed | 40 passed (45)
```

```
× U1: resolves attendee_subject to the profile's own user through the port
  AssertionError: expected [] to deeply equal [ 'u_owner' ]
× U3: attendee_subject never reads the identified-attendee broadcast arm
  AssertionError: expected [] to deeply equal [ 'u_owner' ]
× U4: an anonymous, unknown or foreign subject resolves to nobody
  AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
× U6: the audience schema accepts attendee_subject and still refuses an unknown token
  ZodError: [{ "code": "invalid_value", "values": ["organizer", …] }]
× routes attendee.selfie.rejected to attendee_subject and to no other audience
  AssertionError: expected [ 'attendee_identified' ] to deeply equal [ 'attendee_subject' ]
```

```
pnpm vitest run --project integration \
  apps/web/src/test/integration/notification-recipients.test.ts \
  apps/web/src/test/integration/selfie-rejected-recipient.test.ts

 Test Files  2 failed (2)
      Tests  6 failed | 11 passed (17)
```

```
× R1–R4   TypeError: repository.getAttendeeProfileUserId is not a function
× E1      AssertionError: expected [ { …(18) }, { …(18) } ] to have a length of 1 but got 2
× E3      AssertionError: expected [ { …(18) } ] to deeply equal []
```

Each red is the reason this card names: a missing audience token (`U1`, `U3`, `U6`, the catalogue), a missing port method (`U4`, `R1`–`R4`), or the broadcast result (`E1` = owner **and** neighbour, `E3` = the neighbour alone).

Two arms are **green on arrival** and are recorded as such rather than dressed up: `U2` (a null `attendeeProfileId` already resolves to nobody because the unknown token hits the `default` arm) and `E2` (an anonymous-only event already resolves to nobody) — plus `U5`, whose union is already right for the same reason. Their load-bearing proof is the mutation arms below, not the trunk's red.

`tsc -p tsconfig.json` on the same tree: **28 errors, all in the two touched unit/integration spec files**, every one of them about `attendee_subject`, `getAttendeeProfileUserId` or `attendeeProfileId` (`TS2322` ×5, `TS2339` ×11, `TS2353` ×12). No unrelated type error is introduced. `eslint` clean, `prettier --check` clean on the four files.

### Satisfiability — the pins go green under D5, then the production tree is restored

A throwaway implementation of exactly D5 (the schema token, the `ATTENDEE_SUBJECT` constant, the port method, the input field, the `processEvent` extraction, the `case` arm) takes the packs to **`45 passed (45)`** unit and **`17 passed (17)`** integration. The four production files were then restored with `git checkout --` and re-hashed:

| File                           | sha256 (before **and** after the probes) |
| ------------------------------ | ---------------------------------------- |
| `fan-out.ts`                   | `8a6cf389…d5e5db`                        |
| `notification-types.ts`        | `2e505017…d17e29`                        |
| `notification-types.values.ts` | `d1c89430…9c910a`                        |
| `notification-recipients.ts`   | `e7ba55b8…8d1854`                        |

### Mutation arms (each restored before the next)

| Arm                             | Mutation                                                                                   | Measured                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — broadcast fallback**      | `case "attendee_subject"` implemented as `listIdentifiedAttendeeUserIds`                   | `fan-out.test.ts` **`3 failed \| 26 passed (29)`** — `U1`, `U3`, `U4`; `selfie-rejected-recipient.test.ts` **`1 failed \| 2 passed (3)`** — `E1` (`expected … to have a length of 1 but got 2`) |
| **B — no null-profile guard**   | guard reduced to `eventId === null`, port called with `profileId: attendeeProfileId ?? ""` | `fan-out.test.ts` **`1 failed \| 28 passed (29)`** — `U2` alone; `selfie-rejected-recipient.test.ts` **`3 passed (3)`** — **`E3` does not red**, see below                                      |
| **C — no tenant/event scoping** | port lookup reduced to `findOne({ _id })`                                                  | `notification-recipients.test.ts` **`1 failed \| 13 passed (14)`** — `R3` alone (`expected '6b048874…0e' to be null`)                                                                           |

**B does not redden `E3`, measured, and the card's prediction is corrected here.** Dropping the guard makes the fan-out call the port with `""`; the production port answers `null` for a non-24-hex id, so the delivered set is still empty and `E3` stays green. The guard's only observable is _the port is not called_, which a unit fake can see and a real Mongo run cannot — so `U2` is the arm that owns it, and that is why `U2` exists as a separate case. `E3`'s job is different and it is load-bearing: it reds under **A** (and at RED on the trunk) because a broadcast reaches the event's identified attendee.

## Alternatives

- **(a) Keep the broadcast.** One attendee's failed selfie is not another attendee's news; the row names one person's own outcome, and telling every identified attendee about it is both noise and a small privacy leak. It also still reaches nobody for the anonymous uploader, so keeping it fixes nothing.
- **(b) Resolve the selfie → profile inside the fan-out from `subjectRef.id`.** Rejected: it adds a `selfies` read and a cross-tenant projection to the notifications module (which today depends on no non-notification collection), for an id the payload already carries. The emit also had to keep `subjectRef.kind: "selfie"` (D3 of ADR-0963), so the fan-out would have to grow a second identity hop.
- **(c) Emit `subjectRef.kind: "user"` + `subjectUserId`.** Rejected: measured inert (ADR-0962 §3 — `add(subjectUserId)` cannot narrow a broadcast already in the list) and it breaks `actionTarget.kind: "selfie"`, which the OP-140 action endpoint needs for its 24-hex target.
- **(d) Call the anonymous case a delivery gap and add an out-of-app channel.** Rejected: design §2 already answers it (polled with the session token; a privacy feature), and the anonymous subject carries only `attendeeSessionId`, so there is no destination to add.

## Reversal condition

When the catalogue row carries `attendee_subject` and an emitted rejection reaches **only** the selfie's owner, F1 is closed. The reference pin is `E1` of `selfie-rejected-recipient.test.ts`.

## Consequences

- **F1 is closed** for `attendee.selfie.rejected`: one row, one recipient, the owner.
- **Anonymous delivery stays poll-only**, and that is now the _contract_, not an accident of the broadcast resolving to nobody. The §6.4 poll is the only channel for an anonymous attendee, and `E2` keeps it that way.
- **A rule for the family:** an `attendee.*` row about one person carries `payload.profileId` and uses `attendee_subject`; `attendee_identified` is reserved for a genuine event-wide announcement. `attendee.selfie.accepted` and `attendee.matches.ready` follow it when their producers land.
- **The port method is a compile-time checklist.** Every `RecipientRepository` fake must now answer `getAttendeeProfileUserId`, so a new fake cannot quietly route an `attendee.*` row to a broadcast.
- **The feed row still carries no affordance.** `attendee.selfie.rejected` ships `actionable: false` (`build()`'s default; its §4.8 spec has no `actionable` key), so `buildActions` returns a `null` target and the row has no `actionTarget` even though the emit's subject is the selfie. Giving it the `selfie × retry` action is the delegate arm ADR-0942 §2 deferred (ADR-0963 §Follow-ups F-3). `E1` pins today's `null` deliberately, so that arm reds it by design — recorded as **F-1** of this card rather than smuggled into a routing record.
- **No migration, no seed edit for the audience:** `audiences` is a `ROUTING_FIELDS` member, so the boot seed reconciles the stored row and bumps its `version` by one (D6).

## Review — round 1 (card `t_f26559df`, reviewer)

**Verdict: APPROVED** as a RED pin delivery; the draft PR #838 carried the pins and the GREEN `t_5039edaa` completed the branch. No code change was requested, and nothing the record decides changes: the only edit inside a decision section is the §D7 parenthetical corrected as F1 below, and the header's `Status:` line now names the landing squash instead of "on this branch".

What this review measured itself, at the reviewed head `3dcefbbd` and again on the merged trunk `bd2dbb39`:

- the four spec files are RED for the named reasons — unit `2 failed | 40 passed (45)` (`U1` `expected [] to deeply equal [ 'u_owner' ]`, `U3` the same, `U4` the port not called, `U6` the `ZodError`, the catalogue still `[ 'attendee_identified' ]`) and integration `2 failed | 11 passed (17)` (`R1`–`R4` `repository.getAttendeeProfileUserId is not a function`, `E1` `expected … to have a length of 1 but got 2`, `E3` `expected [ … ] to deeply equal []`).
- the pins go green under D5: `45 passed (45)` unit and `17 passed (17)` integration, measured in a throwaway worktree at `3dcefbbd` and again at the merged trunk `bd2dbb39` — the production tree the branch now carries is the one both packs accept.
- the three mutation arms reproduce on the merged trunk, each restored and `sha256`-checked afterwards: **A** an `attendee_subject` that resolves through `listIdentifiedAttendeeUserIds` (the null-profile guard kept) → `3 failed | 26 passed (29)` (`U1`, `U3`, `U4`) plus `E1` `1 failed | 2 passed (3)` and `E3` green, because a row without a `profileId` still breaks on the guard; **B** the guard reduced to the event id with the port called on `""` → `1 failed | 28 passed (29)` (`U2` alone) with `E3` `3 passed (3)`, so the card's prediction that B would red `E3` is correctly corrected — the real port answers `null` for `""` and the guard's only observable is that the port is not called; **C** `findOne({ _id })` without the tenant and event match → `1 failed | 13 passed (14)` (`R3` alone).
- no production file in the RED diff: the four production blobs are byte-identical to the branch point `942a31e5` — one OID each for `fan-out.ts` (`b65d3c25`), `notification-types.ts` (`29a08811`), `notification-types.values.ts` (`c3b464e7`) and `notification-recipients.ts` (`41298fd2`) at both commits — `tsc` red only in the two touched spec files (28 errors, all about the token, the method and the field), `eslint` exit `0`, `prettier --check` clean, and the `adr-*` guards `191 passed (191)`.
- whole `unit` `2 failed | 192 passed (194)` files (`5 failed | 3263 passed | 3 skipped (3271)`) — the two red files are the two this card touches, and the CI `unit_test` and `test_coverage` jobs name the same two.

Findings:

- F1 (Low, corrected above in §D7): the clause said the ledger row "follows `0962`"; the row sits **before** it. Measured at `3dcefbbd`, at `2ea6e1cd` and at the trunk `bd2dbb39`, the order is `0944` → `0947` → `0962`.
- F2 (Info, coupling): `E1` pins `actionTarget: null`, because `attendee.selfie.rejected` ships `actionable: false` — the catalogue row (`notification-types.values.ts:805-813`) carries no `actionable` key, so `build()`'s default `actionable: spec.actionable ?? false` (`:145`) applies and `fan-out.ts:477` returns the `null` target. The card's `actionTarget.kind === "selfie"` arm is unsatisfiable without the deferred affordance. **When the `selfie × retry` delegate arm lands (ADR-0942 §2 / ADR-0963 F-3) that assertion must flip** — the arm's card must update it rather than delete it.
- F3 (Info): D6 (the boot seed reconciling `audiences` and bumping the stored row's `version` by one) is not pinned; pre-existing seed behaviour, outside the card's scope.
- F4 (Info, post-merge record accuracy): once the GREEN landed as `2ea6e1cd`, the header's `Status:` line still read "implements §Decision D5 on this branch"; it is corrected in the header. The `0947` ledger row's status cell carries the same staleness and is out of this record's scope (`docs/adr/README.md` stays byte-identical to the trunk) — it is card `t_a2cbb922`.
