# ADR-0061 — OP-90 `/me` §1.2: `email` is a non-nullable string; the phone-only `email: ""` path is unreachable and defensive-only

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** `t_be6fc653` (docs-only recording) · decision owner `openpic-orchestrator` on `t_01e10481`
- **Contract:** API contract §1.2 (Current user, `GET`/`PATCH /me`) · §0.13 (data types) · Appendix A.2
- **Schema:** `apps/web/src/server/me/schema.ts` (`meSchema`) · `apps/web/src/server/me/projection.ts` (`buildMe`)
- **Related:** `ADR-0056-op90-me-projection-green-review-signoff.md` (finding 2, Low — routed this decision) · `ADR-0047-op90-me-contract-decisions.md` · `ADR-0020-better-auth-config-otp-phone-2fa.md` §11 · the RED pin card `t_ab479dde`

## Context

The OP-90 GREEN review (`t_43a20f13`, recorded in ADR-0056, finding 2) observed
that `projection.ts` builds the §1.2 `email` field as
`email: asString(user?.email, "")` and raised the question: does a phone-only
(no-email) Better Auth account yield `email: ""` rather than `null`, and should
the contract / schema therefore be relaxed to a nullable string?

`meSchema` (`apps/web/src/server/me/schema.ts`) declares `email: z.string()`
(non-nullable), `phoneNumber: z.string().nullable()`, and `avatarUrl`,
`displayName`, `accountCompletedAt` and `deletionScheduledAt` as nullable. The
body is enforced strictly by `serializeResponse`, so the choice of type is a real
contract decision rather than a cosmetic one.

The decision card `t_01e10481` resolved it and this record locks the outcome into
the ADR set. No production code, contract text, projection, or test is changed by
this card.

## Decision

**`email` stays a non-nullable `string` in contract §1.2 and in `meSchema`.
`projection.ts` keeps `email: asString(user?.email, "")`. No schema, contract, or
projection change.**

The `""` produced by the fallback is a **defensive-only** value: it can only
appear for a dangling or missing `user` document (an `_id` with no corresponding
row), never for a phone-only account, because no auth path can create a `user`
document without an email.

### Rationale and evidence

- **Better Auth requires `email`.** The core sign-up user schema lists `email` in
  `required` (better-auth@1.7.7, `api/routes/sign-up.mjs`), so a `user` document
  written by any Better Auth flow carries an email.
- **Email is the app's only identity.** `emailAndPassword` is disabled
  (`apps/web/src/server/auth/index.ts:130`) and accounts are created solely
  through the `emailOTP` plugin.
- **Phone verification never creates an account.** `signUpOnVerification` is
  intentionally omitted from the `phoneNumber` plugin (`auth/index.ts:182`,
  ADR-0020 §11), and `phone-hook.ts` refuses an anonymous phone `send-otp` to a
  number with no verified owning user (`403 phone_not_verified`) and an anonymous
  `verify` for a number with no user (`400 INVALID_OTP`). There is therefore no
  phone-first sign-up path.
- **Conclusion.** A phone-only account (`user` document without `email`) is
  **unreachable**; every account is email-created, so `email` is always present
  in practice. `asString(user?.email, "")` guards only the dangling-user-document
  case, and a contract field should not be declared nullable to model an
  unreachable state.

### Revisit trigger

If phone-only sign-up is ever enabled — e.g. `signUpOnVerification` turned on for
the `phoneNumber` plugin, or a phone-first sign-up flow introduced — revisit §1.2
and make `email` nullable (`z.string().nullable()`), mirroring the already
nullable `phoneNumber`. Until then this ADR stands.

## Consequences

- §1.2 `email` remains the string the shell consumes; clients never have to
  branch on `null` for a reachable payload, and strictly-typed consumers are
  unaffected.
- The `""` fallback remains, documented here as defensive-only for a dangling
  `user` document — consistent with the other projection fallbacks
  (`asString(..., "")`, `asString(..., DEFAULT_LOCALE)`).
- The distinct question of whether the phone-only / missing-email shape should be
  pinned is handled by the Test Author on card `t_ab479dde` (a green-but-red-capable
  spec pinning `email === ""` + `emailVerified === false` for a `user` document
  that lacks an email). This ADR records the decision only; it neither writes nor
  edits tests (AGENTS.md §2.1/§3.2).
- **No docs follow-through in `docs/API Contract.md`.** §1.2 already declares
  `email` a non-nullable string; there is no semantic change to annotate.
- **Numbering coordination.** The card pre-allocated **0057**, but it collided with
  the dense `0001`–`0058` range already on `main` (`origin/main@21a1a93`): the OP-89
  lane consumed 0057 and 0058 (`ADR-0057-op89-identity-lifecycle-red-pins-r3-followup-review.md`,
  `ADR-0058-op89-identity-lifecycle-indexes-green-review.md`, PR #169). The
  orchestrator's binding allocation on `t_eb61c823` then assigned this record
  **ADR-0061** (merge order 3; 0059/0060 go to sibling cards `t_f2b2f2b4` /
  `t_8599578e`). The content is otherwise unchanged from the 0057 proposal.

## Alternatives considered

- **Option (b): make `email` nullable (`email: null`).** Rejected. It models an
  **unreachable** state, changes a declared non-nullable contract field, and
  loosens the strict `meSchema` for no reachable payload. It would also force
  every consumer to handle a `null` that the auth model cannot produce.
- **Return `email: ""` and document it as a phone-only-account possibility.**
  Rejected as a framing: the `""` branch is not a phone-only path — it is the
  dangling-user-document guard. Describing it as phone-only would document an
  account shape the identity flows cannot create.
- **Add a dedicated nullable shape or a separate "phone-only" schema variant.**
  Rejected: it adds a contract surface and type complexity for a state the auth
  model precludes, and no test or client demands it.
- **Pin either behaviour in a new/edited test.** Rejected here: the RED suite is
  the Test Author's artefact; the implementer neither writes nor edits tests. The
  pin is routed on card `t_ab479dde`.
