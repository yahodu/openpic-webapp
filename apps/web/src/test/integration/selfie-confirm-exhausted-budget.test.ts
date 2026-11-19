import { ObjectId, type ClientSession } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SELFIE_LOCATION_KEY, selfieObjectKey } from "@/server/attendee/selfie-submit";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { getObjectStorage } from "@/server/storage/get-object-storage";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  confirmSelfie,
  createAttendeeSession,
  errorBody,
  finishSelfieWorker,
  grantConsent,
  issueChallenge,
  keysOf,
  makeSelfieBytes,
  nextIp,
  seedTenant,
  submitBody,
  submitSelfie,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — what the confirmation answers when its transaction
 * spends the whole attempt budget (OP-132 review finding **F1**, Low; ADR-0878
 * records the arm and this pin).
 *
 * **Why this exists.** The arm ADR-0878 records gave
 * `POST …/selfies/{selfieId}/confirm` an exhausted-budget path: when
 * `withTransaction(…, { maxAttempts: 5 })` rejects with the wrapper's own
 * retry-limit signal, the handler waits (bounded) for the row to show
 * **everything this request owed** — the activation pointer, the `status`, the
 * cached `matchCount` and, when it had something to announce, the `dedupeKey`'s
 * outbox row — and then answers the ordinary §6.3 envelope. If the row never
 * shows all of it, the original error is rethrown and the client keeps its
 * `500`. The reviewed head covered that arm with **no** shipped case: the burst
 * pin only reds when the budget is smaller than its width, so at the delivered
 * budget the `.catch` never ran (ADR-0878 §Evidence cites the reviewed head's
 * 79.48 % statements / 63.63 % branch on `confirm/route.ts`). This file is the
 * missing pin.
 *
 * ## The seam
 *
 * A shipped spec cannot edit `CONFIRM_MAX_ATTEMPTS`, so the arm is reached
 * deterministically instead of by race: the one wrapper call the request makes
 * is handed the wrapper's **own** exhausted-budget error, produced by the wrapper
 * itself (a zero-attempt budget is the one budget it always exceeds) and thrown
 * before the callback runs. Nothing of the loser's transaction is written, which
 * is exactly the state the production arm exists to answer (ADR-0878 §Decision).
 * The seam is armed per case and one-shot, and every case asserts it fired on the
 * request under test, so a case can never pass by racing its way past the arm.
 *
 * ## What is pinned
 *
 * - **The settled answer.** A request whose outcome a rival already committed
 *   answers `200` with the §6.3 seven-key envelope, the same body the rival
 *   answered, and one `attendee.matches.new` row — not a second one.
 * - **The wait-expired rethrow.** A request whose outcome **no** rival committed
 *   keeps its `500 internal_error` and writes nothing. This is the arm ADR-0878
 *   refuses to inflate into a broad `catch`.
 * - **The outcome conditions.** One refusal per condition ADR-0878 §Decision
 *   item 4 pins: a row that names **this** selfie but still shows the
 *   pre-worker `processing`/`0` with the announcement missing (the pointer-only
 *   control), a row whose cached total is **lower** than this request's computed
 *   total, and a row that activates **another** selfie.
 *
 * ## Assumptions
 *
 * - **A rival's commit is a real request.** The settled and refusal cases let an
 *   ordinary confirm (or two) commit through the real transaction wrapper first;
 *   only the loser's own transaction is handed the exhausted signal. The
 *   repository's fake DB is the harness's, so the pin still measures HTTP status,
 *   body shape and stored effects rather than an internal call.
 * - **The worker is simulated, not stubbed**, exactly as `selfie-confirm-
 *   publication.test.ts` does it: `finishSelfieWorker` writes what the queue
 *   consumer writes and the confirm route is the only thing under test.
 * - **The refusal body is the app-wide envelope.** An unexpected error surfaces
 *   as `500 internal_error` (§0.7 "unhandled — never leak internals"); no
 *   confirm-specific error code is promised for this arm.
 */

/**
 * The state of the exhausted-budget seam.
 *
 * `vi.mock` factories are hoisted above the module's imports, so the arm the
 * mock reads has to be hoisted too — the same shape `confirmRaceGate` uses in
 * `selfie-confirm-publication.test.ts`.
 */
const confirmExhaustedArm = vi.hoisted(() => {
  let pending = 0;
  let calls = 0;
  let before: (() => Promise<void>) | null = null;
  let rivalRunning = false;

  return {
    /**
     * Arm the next `withTransaction` call to answer with the exhausted signal.
     *
     * @param beforeExhaust - Work a rival performs at the lost transaction
     *   boundary, after this request has read its inputs and before the
     *   exhausted signal is raised.
     */
    arm(beforeExhaust?: () => Promise<void>): void {
      pending = 1;
      calls = 0;
      before = beforeExhaust ?? null;
    },
    /** Disarm, whatever is left. */
    disarm(): void {
      pending = 0;
      before = null;
    },
    /**
     * Consume the arm for one wrapper call.
     *
     * @returns `true` when this call must be answered with the exhausted signal.
     */
    take(): boolean {
      if (!rivalRunning) {
        calls += 1;
      }
      if (pending === 0) {
        return false;
      }
      pending = 0;
      return true;
    },
    /**
     * Run the rival work registered for the armed call, once.
     */
    async runRivalWork(): Promise<void> {
      const work = before;
      before = null;
      if (work === null) {
        return;
      }
      rivalRunning = true;
      try {
        await work();
      } finally {
        rivalRunning = false;
      }
    },
    /** How many wrapper calls were taken since the last {@link arm}. */
    calls(): number {
      return calls;
    },
  };
});

vi.mock("@/server/db/transaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/transaction")>();
  return {
    ...actual,
    withTransaction: async <T>(
      fn: (session: ClientSession) => Promise<T>,
      options?: Parameters<typeof actual.withTransaction>[1]
    ): Promise<T> => {
      if (confirmExhaustedArm.take()) {
        // The rival's work, for the case that needs the row to move while this
        // request is spending its budget.
        await confirmExhaustedArm.runRivalWork();
        // The wrapper's own retry-limit error, raised by the wrapper: a
        // zero-attempt budget is the one budget it always exceeds, so this
        // throws the real `TransactionRetryLimitError` without running `fn` and
        // without editing the production constant.
        await actual.withTransaction(() => Promise.resolve(undefined), { maxAttempts: 0 });
      }
      return actual.withTransaction(fn, options);
    },
  };
});

/* ───────────────────────────── contract constants ────────────────────────── */

/** The seven keys the confirm's `200` carries, sorted (§6.3/§6.4). */
const CONFIRM_KEYS = [
  "attemptsRemaining",
  "attemptsUsed",
  "pollIntervalMs",
  "pollUrl",
  "profileId",
  "selfieId",
  "status",
];

/** The one event key the "new photos of you" arrival is recorded under (§7.6). */
const MATCHES_NEW_EVENT = "attendee.matches.new";

/** How many photos the first selfie's worker run finds. */
const FIRST_RUN_MATCHES = 3;

/** How many *additional* photos the second selfie's worker run finds. */
const SECOND_RUN_NEW_MATCHES = 2;

let app: TestApp;

/* ─────────────────────────────── row shapes ──────────────────────────────── */

/** A stored `attendee_event_profiles` row, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly subject: Record<string, unknown>;
  readonly status: string;
  readonly activeSelfieId?: ObjectId | null;
  readonly matchCount: number;
}

/** A stored `domainEvents` row, as these cases read it (§7.7). */
interface DomainEventRow {
  readonly _id: ObjectId;
  readonly payload?: Record<string, unknown>;
}

/** A submitted selfie, as the `202` body names it. */
interface SubmittedSelfie {
  readonly selfieId: string;
  readonly profileId: string;
}

/** The caller's credential and client address. */
interface Caller {
  readonly cookie: string;
  readonly ip: string;
}

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-confirm-exhausted" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  confirmExhaustedArm.disarm();
  for (const name of [
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.mediaAssets,
    COLLECTIONS.attendeeSessions,
    COLLECTIONS.attendeeEventProfiles,
    COLLECTIONS.faceMatches,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
    COLLECTIONS.consents,
    COLLECTIONS.selfies,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

afterEach(() => {
  confirmExhaustedArm.disarm();
  vi.restoreAllMocks();
});

/* ──────────────────────────────── readers ────────────────────────────────── */

/**
 * The single stored `attendee_event_profiles` row these cases expect.
 *
 * @returns The profile row.
 */
async function profileRow(): Promise<ProfileRow> {
  const rows = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({})
    .toArray()) as unknown as ProfileRow[];
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`expected one attendee profile, received ${String(rows.length)}`);
  }
  return row;
}

/**
 * Every stored `attendee.matches.new` outbox row, in the order it was written.
 *
 * §7.7: every notification originates from a `domainEvents` row, so the row
 * count is the notification count.
 *
 * @returns The outbox rows for that event key, oldest first.
 */
async function matchesNewRows(): Promise<DomainEventRow[]> {
  return await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: MATCHES_NEW_EVENT })
    .sort({ _id: 1 })
    .toArray();
}

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/**
 * Seed a published event, mint an attendee session on it and grant consent.
 *
 * @param prefix - The suite-local prefix for the seeded organizer.
 * @returns The event and the caller's handles.
 */
async function readyEvent(
  prefix: string
): Promise<{ readonly tenantKey: string; readonly event: SeededEvent } & Caller> {
  const { tenantKey, events } = await seedTenant(app, prefix);
  const [event] = events;
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  const ip = nextIp();
  const session = await createAttendeeSession(app, ip);
  await grantConsent(event.slug, { cookie: session.cookie, ip });
  return { tenantKey, event, cookie: session.cookie, ip };
}

/**
 * Put one selfie's bytes where the presigned `PUT` would have written them.
 *
 * The key is content-addressed (§16.1), and writing through the storage port
 * keeps this file inside the `selfie.submit` budget the submits need.
 *
 * @param tag - A per-case tag folded into the bytes, so each selfie is distinct.
 * @returns The object's content hash.
 */
async function prepareSelfie(tag: string): Promise<{ readonly hash: string }> {
  const bytes = makeSelfieBytes(tag);
  await getObjectStorage().putObject(
    SELFIE_LOCATION_KEY,
    selfieObjectKey(bytes.hash),
    bytes.bytes,
    "image/jpeg"
  );
  return { hash: bytes.hash };
}

/**
 * Issue a challenge and submit one already-uploaded selfie (the §6.3 `202`).
 *
 * @param slug - The event's active access-link slug.
 * @param caller - The caller's credential and client address.
 * @param tag - The per-selfie tag whose bytes were prepared.
 * @returns The stored selfie's id and its profile's id.
 */
async function submitOne(slug: string, caller: Caller, tag: string): Promise<SubmittedSelfie> {
  const upload = await prepareSelfie(tag);
  const challenge = await issueChallenge(slug, caller);
  const response = await submitSelfie(slug, {
    cookie: caller.cookie,
    ip: caller.ip,
    body: submitBody(upload, challenge),
  });
  const body = await bodyOf(response, 202, `POST selfies on ${slug}`);
  const selfieId = body.selfieId;
  const profileId = body.profileId;
  if (typeof selfieId !== "string" || typeof profileId !== "string") {
    throw new Error(
      `expected the 202 body to carry selfieId and profileId: ${JSON.stringify(body)}`
    );
  }
  return { selfieId, profileId };
}

/**
 * Play the worker for one submitted selfie: write its vector and `count` new
 * `faceMatches` rows for the profile.
 *
 * @param selfie - The submitted selfie the worker claims.
 * @param eventContext - The tenant and event the rows belong to.
 * @param count - How many photos this run found.
 */
async function runWorker(
  selfie: SubmittedSelfie,
  eventContext: { readonly tenantKey: string; readonly eventId: string },
  count: number
): Promise<void> {
  const profile = await profileRow();
  await finishSelfieWorker(app, {
    selfieId: selfie.selfieId,
    profileId: selfie.profileId,
    eventId: eventContext.eventId,
    tenantKey: eventContext.tenantKey,
    subject: profile.subject,
    matches: count,
  });
}

/**
 * Confirm one selfie and parse its `200` envelope.
 *
 * @param slug - The event's active access-link slug.
 * @param selfieId - The selfie to confirm.
 * @param caller - The caller's credential and client address.
 * @returns The parsed §6.3 envelope.
 */
async function confirm(
  slug: string,
  selfieId: string,
  caller: Caller
): Promise<Record<string, unknown>> {
  const response = await confirmSelfie(slug, selfieId, {
    cookie: caller.cookie,
    ip: caller.ip,
  });
  return bodyOf(response, 200, `POST selfie ${selfieId} confirm`);
}

/**
 * Fire the confirm under test with its own transaction handed the exhausted
 * budget signal, then disarm.
 *
 * @param slug - The event's active access-link slug.
 * @param selfieId - The selfie to confirm.
 * @param caller - The caller's credential and client address.
 * @param beforeExhaust - Work a rival performs at the lost transaction boundary,
 *   after this request has read its inputs.
 * @returns The route's response, whatever its status.
 */
async function confirmWithExhaustedBudget(
  slug: string,
  selfieId: string,
  caller: Caller,
  beforeExhaust?: () => Promise<void>
): Promise<Response> {
  confirmExhaustedArm.arm(beforeExhaust);
  try {
    return await confirmSelfie(slug, selfieId, { cookie: caller.cookie, ip: caller.ip });
  } finally {
    confirmExhaustedArm.disarm();
  }
}

/**
 * Assert the exhausted-budget seam fired on the request under test.
 *
 * A case that reached the response without the arm being consumed would be
 * measuring the ordinary transaction path, so the guard is a correctness check
 * on the pin rather than on the implementation.
 *
 * @param label - The case's own description, used in the failure message.
 */
function expectTheArmFired(label: string): void {
  expect(
    { calls: confirmExhaustedArm.calls() },
    `${label}: the confirm must make exactly one transaction call, and it must be the one given the exhausted signal`
  ).toEqual({ calls: 1 });
}

/* ──────── F1.1: the settled outcome answers the ordinary 200 envelope ────── */

describe("when a confirm spends its budget after a rival committed its outcome", () => {
  it("answers the seven-key 200 and leaves one attendee.matches.new row", async () => {
    const ready = await readyEvent("op132-f4-settled");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f4-settled");
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

    // The rival is an ordinary confirm request that commits this activation
    // result, so the profile row already carries everything the request under
    // test owed.
    const rival = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(rival.status).toBe("ready");

    const response = await confirmWithExhaustedBudget(ready.event.slug, submitted.selfieId, ready);
    expectTheArmFired("settled outcome");
    expect(
      response.status,
      `a confirm that spent its budget after a rival committed the same outcome answered ${String(response.status)}; it must answer 200`
    ).toBe(200);

    const body = await bodyOf(response, 200, "settled confirm");
    expect(keysOf(body)).toEqual(CONFIRM_KEYS);
    expect(body.selfieId).toBe(submitted.selfieId);
    expect(body.profileId).toBe(submitted.profileId);
    expect(body.status).toBe("ready");
    // One activation result, one answer: the loser reports the same result as
    // the rival that committed it, attempt counters included.
    expect(body).toEqual(rival);

    // The settled answer announces nothing new (§7.7: the row count is the
    // notification count).
    const notifications = await matchesNewRows();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({
      eventId: eventContext.eventId,
      count: FIRST_RUN_MATCHES,
    });

    // §6.4's cached total, once.
    expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES);
  });
});

/* ───── F1.2: an unsettled race keeps the 500 (the arm is not a blanket 200) ───── */

describe("when a confirm spends its budget and no rival committed its outcome", () => {
  it("keeps its 500 internal_error and writes nothing", async () => {
    const ready = await readyEvent("op132-f4-unsettled");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f4-unsettled");
    // The result is publishable, so this request owed the profile its
    // activation, its total and its announcement — none of which landed.
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

    const response = await confirmWithExhaustedBudget(ready.event.slug, submitted.selfieId, ready);
    expectTheArmFired("unsettled outcome");
    expect(
      response.status,
      `a confirm whose spent budget nobody settled answered ${String(response.status)}; it must keep its 500`
    ).toBe(500);

    // The app-wide refusal envelope (§0.7), not a leaked internal error.
    expect((await errorBody(response)).code).toBe("internal_error");

    // Nothing of the loser's attempt was written: no activation, no total, no
    // announcement (§6.3/§6.4).
    const profile = await profileRow();
    expect(profile.activeSelfieId ?? null).toBeNull();
    expect(profile.matchCount).toBe(0);
    expect(await matchesNewRows()).toHaveLength(0);
  });
});

/* ─── F1.3: the pointer alone is not the outcome (the pointer-only control) ─── */

describe("when the row names this selfie but still shows the pre-worker result", () => {
  it("answers 500 because the status, total and announcement never landed", async () => {
    const ready = await readyEvent("op132-f4-pointer-only");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f4-pointer-only");

    // The I9b arm: the selfie is activated before the worker has written
    // anything, so the row shows `processing`, a `0` total and no announcement.
    const early = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(early.status).toBe("processing");
    // The late worker result lands on the already-active row; the pipeline has
    // not announced it (ADR-0808 §1 — this tree ships no such transport).
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

    const response = await confirmWithExhaustedBudget(ready.event.slug, submitted.selfieId, ready);
    expectTheArmFired("pointer-only row");
    // The activation pointer names this selfie, but a pointer-only predicate
    // would answer a success for an outcome whose notification was dropped
    // (ADR-0878 §Decision item 4).
    expect(
      response.status,
      `a confirm whose row only moved the pointer answered ${String(response.status)}; the undelivered outcome must keep its 500`
    ).toBe(500);
    expect((await errorBody(response)).code).toBe("internal_error");

    // The row is still the pre-worker result: the refusal wrote nothing, and
    // the never-announced result stays unannounced.
    const profile = await profileRow();
    expect(profile.activeSelfieId?.toHexString()).toBe(submitted.selfieId);
    expect(profile.status).toBe("processing");
    expect(profile.matchCount).toBe(0);
    expect(await matchesNewRows()).toHaveLength(0);
  });
});

/* ───── F1.4: a lower cached total is a different outcome, not a settlement ───── */

describe("when the row's cached total is lower than this request's own total", () => {
  it("answers 500 because matchCount never reached the computed total", async () => {
    const ready = await readyEvent("op132-f4-total");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };

    // Both selfies are submitted before either is confirmed: a submit marks the
    // profile `processing` (selfie-submit §6.3), so submitting later would move
    // the very condition this case wants to hold still.
    const first = await submitOne(ready.event.slug, ready, "f4-total-a");
    const second = await submitOne(ready.event.slug, ready, "f4-total-b");

    await runWorker(first, eventContext, FIRST_RUN_MATCHES);
    const committed = await confirm(ready.event.slug, first.selfieId, ready);
    expect(committed.status).toBe("ready");
    expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES);

    // The second selfie's worker run lands its own photos. Only a confirmation
    // writes the cached total (§6.4), so the row still carries the total the
    // earlier confirm committed while this request computes the higher one.
    await runWorker(second, eventContext, SECOND_RUN_NEW_MATCHES);
    const settled = await profileRow();
    expect(settled.matchCount).toBe(FIRST_RUN_MATCHES);
    expect(settled.status).toBe("ready");
    expect(settled.activeSelfieId?.toHexString()).toBe(first.selfieId);

    const response = await confirmWithExhaustedBudget(ready.event.slug, first.selfieId, ready);
    expectTheArmFired("stale total");
    // This request computed the higher total while the pointer, the status and
    // the announcement all still hold; only the cached total refuses it.
    expect(
      response.status,
      `a confirm whose row showed matchCount ${String(FIRST_RUN_MATCHES)} for a computed ${String(FIRST_RUN_MATCHES + SECOND_RUN_NEW_MATCHES)} answered ${String(response.status)}; it must keep its 500`
    ).toBe(500);
    expect((await errorBody(response)).code).toBe("internal_error");

    // The refusal wrote nothing and announced nothing.
    expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES);
    const notifications = await matchesNewRows();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({ count: FIRST_RUN_MATCHES });
  });
});

/* ───── F1.5: a row that activates another selfie is another outcome ─────────── */

describe("when the row activates a different selfie", () => {
  it("answers 500 and leaves the other selfie active", async () => {
    const ready = await readyEvent("op132-f4-other-selfie");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };

    // Both selfies are submitted before the first confirmation, for the reason
    // the case above names.
    const active = await submitOne(ready.event.slug, ready, "f4-other-a");
    const other = await submitOne(ready.event.slug, ready, "f4-other-b");

    await runWorker(active, eventContext, FIRST_RUN_MATCHES);
    const committed = await confirm(ready.event.slug, active.selfieId, ready);
    expect(committed.status).toBe("ready");

    // The newer selfie's worker run finds no photos: it publishes the vector,
    // so this request's outcome is a `ready` activation of the same cached
    // total and nothing to announce. Only the activation pointer differs.
    await runWorker(other, eventContext, 0);
    const settled = await profileRow();
    expect(settled.status).toBe("ready");
    expect(settled.matchCount).toBe(FIRST_RUN_MATCHES);
    expect(settled.activeSelfieId?.toHexString()).toBe(active.selfieId);

    const response = await confirmWithExhaustedBudget(ready.event.slug, other.selfieId, ready);
    expectTheArmFired("other selfie active");
    expect(
      response.status,
      `a confirm whose row activated another selfie answered ${String(response.status)}; it must keep its 500`
    ).toBe(500);
    expect((await errorBody(response)).code).toBe("internal_error");

    // The refusal did not swap the activation, did not rewrite the total and did
    // not announce anything for the newer selfie.
    expect((await profileRow()).activeSelfieId?.toHexString()).toBe(active.selfieId);
    const notifications = await matchesNewRows();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({
      eventId: eventContext.eventId,
      count: FIRST_RUN_MATCHES,
    });
  });
});

/* ── F1.6: an activation whose announcement never landed is not settled ─────── */
describe("when the activation is settled but its announcement never landed", () => {
  it("answers 500 because the dedupeKey has no outbox row", async () => {
    const ready = await readyEvent("op132-f4-dropped-announcement");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f4-dropped-announcement");
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);
    const committed = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(committed.status).toBe("ready");

    // The state a dropped announcement leaves: the activation result committed
    // its pointer, status and total, but its outbox row is not there. §7.7
    // makes every notification originate from that row, so this result was
    // never delivered — the state ADR-0878 §Decision item 4 refuses to answer
    // as success. No shipped path produces it (the confirm writes both in one
    // transaction), which is exactly why the arm has to be seen refusing it.
    await app.db.collection(COLLECTIONS.domainEvents).deleteMany({ eventKey: MATCHES_NEW_EVENT });
    expect(await matchesNewRows()).toHaveLength(0);

    const response = await confirmWithExhaustedBudget(ready.event.slug, submitted.selfieId, ready);
    expectTheArmFired("dropped announcement");
    // Every other condition of this request's outcome is already true below, so
    // the only thing refusing it is the missing announcement.
    expect(
      response.status,
      `a confirm whose announcement never landed answered ${String(response.status)}; an undelivered result must keep its 500`
    ).toBe(500);
    expect((await errorBody(response)).code).toBe("internal_error");

    const profile = await profileRow();
    expect(profile.activeSelfieId?.toHexString()).toBe(submitted.selfieId);
    expect(profile.status).toBe("ready");
    expect(profile.matchCount).toBe(FIRST_RUN_MATCHES);
    // The refusal wrote no replacement announcement either.
    expect(await matchesNewRows()).toHaveLength(0);
  });
});

/* ── F1.7: a row that moved past this request's own status is another outcome ─ */

describe("when a rival settles the same selfie at a status this request did not compute", () => {
  it("answers 500 because the row moved to ready after this request read it", async () => {
    const ready = await readyEvent("op132-f4-stale-status");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f4-stale-status");

    // This request reads the selfie before the worker has written the vector, so
    // its own outcome is the I9b arm's: `processing`, a `0` total, nothing to
    // announce. Both values are fixed before the transaction opens, which is the
    // real interleaving a client confirm and a finishing worker produce.
    //
    // The rival then finishes the worker's run (zero photos, so the total stays
    // `0`) and confirms: the row is `ready` with the same pointer and the same
    // total. Only the status is different.
    const response = await confirmWithExhaustedBudget(
      ready.event.slug,
      submitted.selfieId,
      ready,
      async () => {
        await runWorker(submitted, eventContext, 0);
        const rival = await confirm(ready.event.slug, submitted.selfieId, ready);
        expect(rival.status).toBe("ready");
      }
    );
    expectTheArmFired("stale status");

    // The row's pointer and total both satisfy this request; the status does
    // not, so the outcome it owes was never committed.
    const settled = await profileRow();
    expect(settled.activeSelfieId?.toHexString()).toBe(submitted.selfieId);
    expect(settled.status).toBe("ready");
    expect(settled.matchCount).toBe(0);
    expect(
      response.status,
      `a confirm whose row showed status ready for a computed processing answered ${String(response.status)}; it must keep its 500`
    ).toBe(500);
    expect((await errorBody(response)).code).toBe("internal_error");

    // The refusal changed neither the row nor the outbox.
    expect((await profileRow()).matchCount).toBe(0);
    expect(await matchesNewRows()).toHaveLength(0);
  });
});
