# ADR-0081 — OP-93 GREEN: `resolveChannel` + `renderTemplate` implementation and the U18 fixture dispute

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-93 GREEN (`t_beda070f`) · **Implements:** [ADR-0078](ADR-0078-op93-channel-resolution-and-template-renderer-red.md) (the pinned contract) · **Relates to:** [ADR-0016](ADR-0016-notification-routing-matrix-as-data.md) (routing matrix as data), [ADR-0012](ADR-0012-upload-magic-byte-variant-pins.md) (append-only pins pattern), [ADR-0031](ADR-0031-op88-green-review-signoff.md) (precedent: disputed RED defects reconciled test-side)
- **Branch:** `OP-93-task-channel-resolution-and-template-renderer-green` (base = RED-pins tip `81c40e4`) · **Contract:** `docs/adr/ADR-0078-…-red.md`

## Context

OP-93 GREEN turns the RED pins (`apps/web/src/server/notifications/{resolve-channel,render-template}.test.ts`,
U1–U26) green with the two pure modules ADR-0078 specifies. This ADR records the
implementation decisions and one disputed RED fixture that no honest
implementation can satisfy.

## Decision

### 1. `@/server/notifications/resolve-channel` — pure resolver

Implemented exactly to the ADR-0078 contract: `resolveChannel(input)` returns one
of `{kind:"send"}`, `{kind:"skip"}`, `{kind:"defer"}` or `{kind:"digest"}`.
Resolution order: `type_disabled` → group preference (transactional forces ON;
else `byEvent[eventId] ?? byType[typeKey] ?? global ?? "on"`, `off` honoured only
when `optOutAllowed` and not `in_app`) → per-candidate eligibility + suppression
(`mobile` falls through `whatsapp`→`sms`; all-suppressed → `suppressed`) →
throttle (`deduped` passthrough → `rate limit` → `digest` bucket
`` `${typeKey}:${eventId}` ``) → quiet hours. No I/O; `now` and `eventId` are
injected.

- **Suppression semantics:** a `scope:"marketing"` row blocks only a
  non-transactional type; `scope:"all"` blocks unconditionally (U11).
- **Quiet hours:** computed with `Intl.DateTimeFormat` civil-time projection plus
  a minute-based offset — no date library — handling windows that cross
  midnight. `respectQuietHours:false` (U24) and `severity:"critical"` (U16)
  short-circuit the defer.
- `group.enabled === false` is deliberately not special-cased: the decision union
  has no no-op member and ADR-0078 assumption 1 leaves it unpinned (fan-out
  filters enabled groups upstream).

### 2. `@/server/notifications/render-template` — strict renderer

Hand-rolled renderer rather than adding `handlebars` as a direct dependency:
ADR-0078 assumption 6 explicitly permits "an equivalent escaping renderer", and
the required behaviour (HTML-escape subject **and** body, reject triple-stash /
`{{&`, reject a missing declared value, reject an undeclared supplied value,
locale fallback to `en-IN`) is a few rules not worth a dependency. Escaping uses
the Handlebars escape set (`& < > " ' \` =`).

- Triple-stash `{{{` and `{{&` are rejected outright — no partial whitelist
  exists yet (security requirement, U23).
- Locale: exact match, else `en-IN`, else `TemplateRenderError` (U21).
- `TemplateRenderError` is exported.

### 3. Dispute — U18 fixture is internally inconsistent (left RED)

`render-template.test.ts` **U18** builds
`subjectTemplate: "New photos from {{eventName}}"`,
`bodyTemplate: "<p>Hi {{displayName}}, your gallery is ready.</p>"`, then asserts
`rendered.body` contains `"&lt;script&gt;"` — but the only value carrying
`<script>` is `eventName`, which the **body** template never interpolates. The
subject/body templates are rendered independently (§19.2, ADR-0078 "escaped in
both `subject` and `body`"), so no honest renderer can put the escaped
`eventName` into `rendered.body`; the sibling U26 uses the _same_ fixture and
asserts on `rendered.subject`, which passes. U18 is therefore unsatisfiable as
written; the body-escaping behaviour it _names_ is nevertheless genuinely covered
by its `"Rahul &amp; Priya"` assertion (and my `displayName` escaping does that).

Proposed correction (Test Author, append-only): add `{{eventName}}` to
`bodyTemplate`, e.g.
`"<p>Hi {{displayName}}, your photos from {{eventName}} are ready.</p>"`, so all
three body assertions hold without weakening the escaping pin. Routed to
`openpic-webapp-testcase-writer` as a blocking parent of this card; U18 stays RED
until the fixture is reconciled — no test was edited by the implementer.

## Consequences

- The whole §5 routing decision is exercised offline; 26 of 27 new assertions
  pass (`vitest --project unit` = 1 failed | 76 passed files, 1420 passed).
- The renderer fails loudly on broken copy as required.
- One disputed RED fixture is surfaced rather than worked around; the GREEN lane
  is blocked on the test-side reconciliation (ADR-0031 precedent).

## Alternatives considered

- **Add `handlebars` as a direct dependency.** Rejected: the hand-rolled renderer
  is smaller and the tests assert behaviour, not the library (ADR-0078 §6).
- **Satisfy U18 by injecting undeclared values into `body`.** Rejected as
  dishonest: it would contradict the U20 undeclared-value guard and the
  independent-template model, i.e. special-casing a fixture.
- **Edit the U18 fixture.** Forbidden — the implementer never modifies tests.
