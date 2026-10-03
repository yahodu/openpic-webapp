# ADR-0004 — Internal routes deny browser contexts by Fetch metadata

- **Status:** Accepted · **Date:** 2026-10-03

## Context

`/api/v1/internal/**` is server-to-server only and must never be reachable from
a browser. The edge gate (`decideCsrf`) originally denied an internal route only
when an `Origin` header was present. That misses browser requests that send no
`Origin`: a top-level navigation, an `<img>`/`<script>` load, or a same-origin
`fetch`/GET form all reached the route unchallenged. The `Origin` header is an
unreliable browser signal; it is omitted on many browser-initiated requests.

Browsers always attach Fetch metadata (`Sec-Fetch-*`); server HTTP clients —
Node `fetch`, `curl`, SDKs — send none. That makes `Sec-Fetch-Site` a better
discriminator for "is this a browser?" than `Origin`, while preserving the
server-to-server path that sends no Fetch metadata at all.

## Decision

A request to `/api/v1/internal/**` is **denied** (`403 forbidden`) when it
carries either browser-context signal:

- an `Origin` header (as before), or
- `Sec-Fetch-Site: same-origin`, or
- `Sec-Fetch-Site: cross-site`.

A request with **no `Sec-Fetch-Site` header at all** is server-to-server and
passes. A request whose `Sec-Fetch-Site` is any other value — notably `none`
(typed-URL / bookmark top-level navigation) and `same-site` (another origin on
the same site) — is **not** denied by this rule and passes, matching the
chosen signal set.

This check runs before the safe-method and `Authorization: Bearer` exemptions
on internal routes, so it applies to every method and credential.

## Consequences

- A same-origin browser `fetch`/navigation to an internal route is now rejected
  even though it sends no `Origin`.
- Internal-route denial still answers `403` with the shared `forbidden` envelope
  and the distinct `security.internal_origin_denied` warn event.
- **Residual gap:** a browser top-level navigation with `Sec-Fetch-Site: none`
  (typed URL or bookmark) and no `Origin` still passes. The decided deny set was
  deliberately limited to `same-origin` and `cross-site`; widening it to `none`
  / `same-site`, or denying on any `Sec-Fetch-*` header, is a future decision.
- Server-to-server callers must not synthesize `Sec-Fetch-*` headers.

## Alternatives considered

- **Deny when any `Sec-Fetch-*` header is present** — strongest browser
  discriminator, but rejects callers that send partial Fetch metadata and makes
  the server-to-server contract depend on header absence across all `Sec-Fetch-*`
  keys. Broader than the decided set.
- **Deny on `Sec-Fetch-Mode: navigate | no-cors | cors`** — also flags browser
  contexts, but couples the gate to a second header and overlaps `Sec-Fetch-Site`.
  Rejected in favour of one signal.
- **Keep `Origin`-only detection** — leaves the same-origin navigation hole this
  ADR exists to close. Rejected.
