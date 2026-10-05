# Architecture Decision Records

Short, immutable records of decisions that are expensive to reverse. One file per
decision, numbered `ADR-NNNN-<slug>.md`. Never edit an accepted ADR — supersede it
with a new one and mark the old `Superseded by ADR-NNNN`.

| ADR                                                                                | Title                                                                                                    | Status   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| [0001](ADR-0001-ports-and-adapters.md)                                             | Ports and adapters, provider neutrality                                                                  | Accepted |
| [0002](ADR-0002-logging-port.md)                                                   | Logging behind a port; Better Stack swappable                                                            | Accepted |
| [0003](ADR-0003-mongodb-as-job-truth.md)                                           | MongoDB is the source of truth for jobs                                                                  | Accepted |
| [0004](ADR-0004-internal-route-fetch-metadata.md)                                  | Internal routes deny browser contexts by Fetch metadata                                                  | Accepted |
| [0005](ADR-0005-two-tier-rate-limiting.md)                                         | Two-tier rate limiting: coarse edge + identity pipeline                                                  | Accepted |
| [0006](ADR-0006-cursor-pagination-and-etag.md)                                     | Cursor pagination, ETag and conditional-request helpers                                                  | Accepted |
| [0007](ADR-0007-platform-settings-singleton.md)                                    | `platformSettings` singleton: create-only seed, bounds, clock-once cache                                 | Accepted |
| [0008](ADR-0008-platform-settings-green-implementation.md)                         | `platformSettings` GREEN: full §20.4 schema, defaults fallback, deferred §4                              | Accepted |
| [0009](ADR-0009-upload-type-guards.md)                                             | Upload type guards: extension + MIME + magic bytes, delete-and-write-nothing                             | Accepted |
| [0010](ADR-0010-upload-type-guards-green-implementation.md)                        | Upload type guards GREEN: sniff order, logging, extension-authoritative TIFF                             | Accepted |
| [0011](ADR-0011-heif-avif-ftyp-brand-set.md)                                       | HEIF/AVIF `ftyp` major-brand set accepted by the upload type guard                                       | Accepted |
| [0012](ADR-0012-upload-magic-byte-variant-pins.md)                                 | Upload guard: cover accepted magic-byte variants (BE TIFF, ORF `MMOR`/`IIRS`, unrecognized `ftyp`)       | Accepted |
| [0013](ADR-0013-upload-guards-dotless-extension-pin.md)                            | Upload guard: pin the `extensionOf` dotless-name branch                                                  | Accepted |
| [0014](ADR-0014-plans-catalogue-schema-and-seed.md)                                | `plans` catalogue schema and seed: unique tierRank, integer money, version-on-change                     | Accepted |
| [0015](ADR-0015-plans-seed-concurrency-atomic-upsert.md)                           | `plans` seed concurrency: atomic conditioned upsert and `{key:1}` unique index                           | Accepted |
| [0016](ADR-0016-notification-routing-matrix-as-data.md)                            | Notification routing matrix as data: frozen 81 keys, template/group mapping, version-on-change           | Accepted |
| [0017](ADR-0017-notification-routing-matrix-green-implementation.md)               | Notification routing matrix GREEN: 81-key transcription, derived fields, atomic reconcile                | Accepted |
| [0018](ADR-0018-notification-routing-follow-up-severity-and-mobile-invariant.md)   | Notification routing follow-up: `auth.account.completed` severity and enabled-mobile invariant           | Accepted |
| [0019](ADR-0019-matrix-transcription-guard-and-lint-override-removal.md)           | §4 matrix transcription guard (table-driven spec); broad test-lint override removed                      | Accepted |
| [0020](ADR-0020-better-auth-config-otp-phone-2fa.md)                               | Better Auth config: OTP + phone + 2FA, cookie policy, test-only OTP route                                | Accepted |
| [0021](ADR-0021-better-auth-config-green-implementation.md)                        | Better Auth config GREEN: hook-based policy, `__test__` rewrite, SMS-only 2FA flow                       | Accepted |
| [0022](ADR-0022-better-auth-hook-module-decomposition.md)                          | Better Auth hooks split into focused modules (OP-85 follow-up refactor)                                  | Accepted |
| [0023](ADR-0023-auth-coverage-red-otp-ip-leg-verify-cap.md)                        | Auth coverage RED: OTP IP leg, unknown-number verify 4xx, callbackURL trust, session verify cap          | Accepted |
| [0024](ADR-0024-client-ip-trust-model.md)                                          | Client-IP trust model for the auth IP leg (`TRUSTED_CLIENT_IP_HEADER` required in production)            | Accepted |
| [0025](ADR-0025-auth-guards.md)                                                    | Auth guards: one pure decision per label, resolver port, per-session 2FA fact                            | Accepted |
| [0026](ADR-0026-op86-ban-exemption-and-2fa-signin-pins.md)                         | OP-86 review-gap pins: `/me` ban exemption and the 2FA sign-in branch                                    | Accepted |
| [0027](ADR-0027-op86-ban-exemption-green.md)                                       | OP-86 follow-up GREEN: wire `/me` `allowBanned`, confirm the 2FA sign-in branch                          | Accepted |
| [0028](ADR-0028-internal-hmac-and-cron-framework.md)                               | Internal HMAC auth and the bounded cron job framework                                                    | Accepted |
| [0029](ADR-0029-domain-events-outbox.md)                                           | Domain-event outbox: one `emitDomainEvent` write point, per-consumer flags, atomic claims                | Accepted |
| [0030](ADR-0030-op85-followup-trust-verify-parity-cap.md)                          | OP-85 follow-up: trusted-header precedence, anonymous-verify error parity, cap fail-closed               | Accepted |
| [0031](ADR-0031-op88-green-review-signoff.md)                                      | OP-88 GREEN review sign-off: outbox ships; per-emit lookup + claim-lease hardening deferred              | Accepted |
| [0032](ADR-0032-op85-production-trusted-client-ip-required-red.md)                 | `TRUSTED_CLIENT_IP_HEADER` required in production (RED pins; ADR-0024 amendment)                         | Accepted |
| [0033](ADR-0033-op85-production-trusted-client-ip-required-green-signoff.md)       | OP-85 GREEN review sign-off: production-required client-IP header lands; test/coverage follow-ups        | Accepted |
| [0034](ADR-0034-op85-adr-0032-test-reference-renumber.md)                          | OP-85 follow-up: stale ADR-0031 test references renumbered to ADR-0032                                   | Accepted |
| [0035](ADR-0035-op85-instrumentation-boot-guard-red-pin.md)                        | Instrumentation production boot guard pinned by a direct spec (RED pins)                                 | Accepted |
| [0036](ADR-0036-op85-instrumentation-boot-guard-review-signoff.md)                 | OP-85 follow-up review sign-off: instrumentation boot guard coverage pin lands (PR #151)                 | Accepted |
| [0037](ADR-0037-integration-spec-ci-readiness-budget.md)                           | Integration-spec CI budget: deterministic Mongo readiness + explicit timeout (de-flake)                  | Accepted |
| [0038](ADR-0038-op89-identity-lifecycle-hooks-red.md)                              | Identity lifecycle hooks: profile defaults, lazy invites, completion, new-device and admin sign-in       | Accepted |
| [0039](ADR-0039-op89-identity-lifecycle-hooks-red-review-signoff.md)               | OP-89 RED review sign-off: routing the unpinned sections (4/5/6 + claim service) and the /me overlap     | Accepted |
| [0040](ADR-0040-op89-identity-lifecycle-hooks-red-followup.md)                     | OP-89 RED follow-up: sections 4–6 hooks, the contact-change fan-out record and the op_att claim seam     | Accepted |
| [0041](ADR-0041-op89-identity-lifecycle-hooks-green.md)                            | OP-89 GREEN: module contract, profile-precedence read, account-scope ids, `GET /me` slice                | Accepted |
| [0042](ADR-0042-op89-identity-lifecycle-hooks-green-review.md)                     | OP-89 GREEN review sign-off: index/TTL gaps, unwired sections 4–6, idempotency routing                   | Accepted |
| [0043](ADR-0043-op89-identity-lifecycle-indexes-ttls.md)                           | OP-89 follow-up: declare the identity-lifecycle collections' indexes and TTLs                            | Accepted |
| [0044](ADR-0044-op89-identity-lifecycle-indexes-ttls-review.md)                    | OP-89 follow-up review sign-off: index/TTL gaps closed, unpinned-spec coverage routed                    | Accepted |
| [0045](ADR-0045-op89-followup-red-idempotency-2fa-transition-and-surface-seams.md) | OP-89 follow-up RED: re-run idempotency, 2FA transition re-emit, section 4–6 + contact-verified seams    | Accepted |
| [0046](ADR-0046-op89-followup-red-review-signoff.md)                               | OP-89 follow-up RED review sign-off: nine pins verified RED for the right reason                         | Accepted |
| [0047](ADR-0047-op90-me-contract-decisions.md)                                     | OP-90 `/me`: caller `phoneNumber` is raw E.164; foreign `avatarAssetId` is `422 validation_failed`       | Accepted |
| [0048](ADR-0048-op89-followup-green-idempotency-and-surface-wiring.md)             | OP-89 follow-up GREEN: re-run dedupe for contact.changed / sessions.revoked + section 4–6 surface wiring | Accepted |
| [0049](ADR-0049-op89-followup-green-review-signoff.md)                             | OP-89 follow-up GREEN review sign-off: dedupe + surfaces verified; two coverage follow-ups routed        | Accepted |
| [0050](ADR-0050-op89-identity-lifecycle-indexes-ttls-red-pins.md)                  | OP-89 RED pins: identity-lifecycle index/TTL shapes and the bounded new-device read                      | Accepted |
| [0051](ADR-0051-op89-identity-lifecycle-indexes-ttls-red-pins-review.md)           | OP-89 RED pins review sign-off: pins verified, cap-guard + ADR-numbering findings routed                 | Accepted |
| [0052](ADR-0052-op90-me-projection-red.md)                                         | OP-90 RED: the full `GET`/`PATCH /me` §1.2 projection, capabilities, and forbidden/unknown fields        | Accepted |
| [0053](ADR-0053-op90-me-projection-red-review-signoff.md)                          | OP-90 RED review sign-off: pins approved; contract decisions and 2 coverage gaps routed                  | Accepted |
| [0054](ADR-0054-op90-me-projection-red-followup-review-signoff.md)                 | OP-90 RED follow-up review sign-off: the empty-PATCH 422 and pure-attendee pins land                     | Accepted |
| [0055](ADR-0055-op90-me-projection-green.md)                                       | OP-90 GREEN: the full `GET`/`PATCH /me` §1.2 projection on top of the OP-89 read slice                   | Accepted |
| [0056](ADR-0056-op90-me-projection-green-review-signoff.md)                        | OP-90 GREEN review sign-off: §1.2 projection verified; index gap and phone-only decision routed          | Accepted |
| [0057](ADR-0057-op89-identity-lifecycle-red-pins-r3-followup-review.md)            | OP-89 RED-pins R3 follow-up review sign-off: same-device >100 read-cap pin verified                      | Accepted |
| [0058](ADR-0058-op89-identity-lifecycle-indexes-green-review.md)                   | OP-89 indexes/TTLs GREEN review sign-off: device-keyed bounded new-device read verified                  | Accepted |
| [0059](ADR-0059-op90-adr-0044-test-reference-renumber.md)                          | OP-90 follow-up: stale ADR-0044 test reference renumbered to ADR-0052                                    | Accepted |
| [0060](ADR-0060-op90-me-indexes.md)                                                | OP-90 follow-up: declare the `tenantMembers` and `invitations` indexes behind `GET /me`                  | Accepted |
| [0061](ADR-0061-op90-me-email-phone-only-string-contract.md)                       | OP-90 §1.2 `me` `email` is a non-nullable string; the phone-only `""` path is unreachable/defensive-only | Accepted |
| [0062](ADR-0062-op89-followup-green-coverage-pins.md)                              | OP-89 follow-up coverage pins: contact-change fan-out on a partial failure; stale ADR reference fixed    | Accepted |
| [0063](ADR-0063-op89-followup-coverage-pins-review-signoff.md)                     | OP-89 coverage-pins review sign-off: partial-failure pin RED for the right reason; two Low refs routed   | Accepted |
| [0064](ADR-0064-op89-followup-green-partial-failure-recovery.md)                   | OP-89 follow-up GREEN: recover the contact-change fan-out after a partial insert failure                 | Accepted |
| [0065](ADR-0065-op89-followup-green-partial-failure-recovery-review-signoff.md)    | OP-89 follow-up GREEN review sign-off: fan-out recovery verified RED→GREEN; three Low references routed  | Accepted |
| [0066](ADR-0066-op89-identity-indexes-test-reference-renumber.md)                  | OP-89 follow-up: stale ADR-0046 test references in the identity pin specs renumbered to ADR-0050         | Accepted |
| [0067](ADR-0067-op91-sessions-and-account-deletion-red.md)                         | OP-91 RED: sessions & devices list/revoke and the account-deletion cancel window                         | Accepted |
| [0068](ADR-0068-op91-sessions-and-account-deletion-green.md)                       | OP-91 GREEN: the §1.3 sessions surfaces and the §1.4 deletion cancel window                              | Accepted |
| [0069](ADR-0069-op91-green-review-signoff.md)                                      | OP-91 GREEN review sign-off: §1.3/§1.4 verified; deletion-requested emission and three Low refs routed   | Accepted |

Template: Context · Decision · Consequences · Alternatives.

_`0059` remains reserved for the last OP-90 lane in the binding allocation (`t_eb61c823` / `t_93d4774b`); its row lands when that PR merges._
