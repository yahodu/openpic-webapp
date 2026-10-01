# ADR-0001 — Ports and adapters, provider neutrality

- **Status:** Accepted · **Date:** 2026-10-01

## Context

The domain must not know which vendor provides email, storage, payments, logging
or persistence. Vendors change and are swapped per environment, and tests must
substitute them without branching on `NODE_ENV`.

## Decision

Every outbound dependency is a **port** (a TypeScript interface) satisfied by an
**adapter** in `src/server/adapters/<vendor>/`, selected from env (US-002) and
injected. Domain code imports ports only — never a vendor SDK and never an
adapter path. Third-party payloads are parsed by Zod schemas that live beside the
adapter (`src/server/adapters/<vendor>/schemas.ts`); no vendor-native type crosses
the port boundary.

## Consequences

- Swapping a provider is an adapter change plus an env change, nothing else.
- Domain fields carry no vendor names (`docs/CONVENTIONS.md` §7).
- Tests use doubles (MSW, in-memory MongoDB) on the same production code path.
- One interface and binding per dependency; accepted cost.

## Alternatives considered

- Direct SDK calls in handlers — untestable without network, couples domain to
  vendor. Rejected.
- A single god-adapter — hides vendor coupling instead of removing it. Rejected.
