# ADR-0003 — MongoDB is the source of truth for jobs

- **Status:** Accepted · **Date:** 2026-10-01

## Context

Background work (billing projections, notifications, syncs) is triggered by
webhooks and cron. We must not lose a job, double-process it, or depend on the
queue broker to remember what happened. One durable, queryable record of job
state is needed.

## Decision

**MongoDB is the authoritative store for job truth.** Every job is a document
holding identity, tenant, status, attempts, lease and timestamps. The queue
broker is a _delivery_ mechanism only: it may be swapped, drained or lost without
losing intent or outcome. State transitions are persisted in Mongo inside a
transaction — hence integration tests run `mongodb-memory-server` as a **replica
set** (conventions §2) — and are idempotent, keyed on the job's natural
idempotency key. Workers claim jobs with a lease and write transitions back
before acknowledging.

## Consequences

- On broker loss, unacknowledged jobs are re-derived from Mongo.
- Exactly-once comes from idempotent transactional transitions, not broker
  guarantees.
- Every job query is tenant-scoped (`tenantId` in every filter, conventions §8).
- Job documents are the audit trail; logs reference them by id.
- Requires a transaction-capable Mongo everywhere, including tests (ReplSet).

## Alternatives considered

- Broker as source of truth — loses history, vendor-specific recovery, cannot
  answer "what happened to job X". Rejected.
- A separate relational job table — a second datastore for no gain at this scale.
  Rejected.
