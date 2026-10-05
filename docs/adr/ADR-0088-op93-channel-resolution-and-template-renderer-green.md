# ADR-0088 — OP-93 GREEN: `resolveChannel` + `renderTemplate` implementation and the U18 fixture dispute

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-93 GREEN (`t_beda070f`) · **Implements:** [ADR-0085](ADR-0085-op93-channel-resolution-and-template-renderer-red.md) (the pinned contract) · **Relates to:** [ADR-0016](ADR-0016-notification-routing-matrix-as-data.md) (routing matrix as data), [ADR-0012](ADR-0012-upload-magic-byte-variant-pins.md) (append-only pins pattern), [ADR-0031](ADR-0031-op88-green-review-signoff.md) (precedent: disputed RED defects reconciled test-side)
- **Branch:** `OP-93-task-channel-resolution-and-template-renderer-green` (base = RED-pins tip `81c40e4`) · **Contract:** `docs/adr/ADR-0085-…-red.md`

## Renumbered

Authored as **ADR-0081**; renumbered to **ADR-0088** when PR #187 integrated
`origin/main` on 2026-10-05 (append-only, no content change). `origin/main` had
already claimed `0078`/`0079`/`0081` (OP-91 follow-up payload lane, PR #183) and
`0082`–`0084` (OP-92 follow-up lane, PR #186), so the five OP-93 ADRs were
renumbered `0078`–`0082 → 0085`–`0089`; `0080` is left unused on `main`.

## Context

OP-93 GREEN turns the RED pins (`apps/web/src/server/notifications/{resolve-channel,render-template}.test.ts`,
U1–U26) green with the two pure modules ADR-0085 specifies. This ADR records the
implementation decisions and one disputed RED fixture that no honest
implementation can satisfy.

## Decision

### 1. `@/server/notifications/resolve-channel` — pure resolver

Implemented exactly to the ADR-0085 contract: `resolveChannel(input)` returns one
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
  has no no-op member and ADR-0085 assumption 1 leaves it unpinned (fan-out
  filters enabled groups upstream).

### 2. `@/server/notifications/render-template` — strict renderer

Hand-rolled renderer rather than adding `handlebars` as a direct dependency:
ADR-0085 assumption 6 explicitly permits "an equivalent escaping renderer", and
the required behaviour (HTML-escape subject **and** body, reject triple-stash /
`{{&`, reject a missing declared value, reject an undeclared supplied value,
locale fallback to `en-IN`) is a few rules not worth a dependency. Escaping uses
the Handlebars escape set (`& < > " ' \` =`).

- Triple-stash `{{{` and `{{&` are rejected outright — no partial whitelist
  exists yet (security requirement, U23).
- Locale: exact match, else `en-IN`, else `TemplateRenderError` (U21).
- `TemplateRenderError` is exported.

### 3. Dispute — U18 fixture was internally inconsistent (resolved test-side)

`render-template.test.ts` **U18** builds
`subjectTemplate: "New photos from {{eventName}}"`,
`bodyTemplate: "<p>Hi {{displayName}}, your gallery is ready.</p>"`, then asserts
`rendered.body` contains `"&lt;script&gt;"` — but the only value carrying
`<script>` is `eventName`, which the **body** template never interpolates. The
subject/body templates are rendered independently (§19.2, ADR-0085 "escaped in
both `subject` and `body`"), so no honest renderer can put the escaped
`eventName` into `rendered.body`; the sibling U26 uses the _same_ fixture and
asserts on `rendered.subject`, which passes. U18 is therefore unsatisfiable as
written; the body-escaping behaviour it _names_ is nevertheless genuinely covered
by its `"Rahul &amp; Priya"` assertion (and my `displayName` escaping does that).

Correction applied (Test Author, `t_f8edb6f8`, append-only): `U18`'s
`bodyTemplate` now interpolates `{{eventName}}`
(`"<p>Hi {{displayName}}, your photos from {{eventName}} are ready.</p>"`), so all
three body assertions hold without deleting or loosening any of them. The
`variables: ["eventName", "displayName"]` declaration stays consistent with the
placeholders actually used, and `U26` (same fixture, subject assertions) is
untouched. The implementer never edited a test — the reconciliation is test-side
only and touches no production file.

## Consequences

- The whole §5 routing decision is exercised offline; all 27 OP-93 assertions now
  pass (`vitest --project unit` both OP-93 specs = 27 passed).
- The renderer fails loudly on broken copy as required.
- One disputed RED fixture was surfaced rather than worked around, then
  reconciled test-side without weakening the escaping pin (ADR-0031 precedent);
  U18 still pins HTML-escaping of body interpolation and U26 of subject
  interpolation, on the same malicious fixture.

## Alternatives considered

- **Add `handlebars` as a direct dependency.** Rejected: the hand-rolled renderer
  is smaller and the tests assert behaviour, not the library (ADR-0085 §6).
- **Satisfy U18 by injecting undeclared values into `body`.** Rejected as
  dishonest: it would contradict the U20 undeclared-value guard and the
  independent-template model, i.e. special-casing a fixture.
- **Edit the U18 fixture.** Forbidden — the implementer never modifies tests.
