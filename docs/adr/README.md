# Architecture Decision Records

Short, immutable records of decisions that are expensive to reverse. One file per
decision, numbered `ADR-NNNN-<slug>.md`. Never edit an accepted ADR — supersede it
with a new one and mark the old `Superseded by ADR-NNNN`.

| ADR                                                                              | Title                                                                                              | Status   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| [0001](ADR-0001-ports-and-adapters.md)                                           | Ports and adapters, provider neutrality                                                            | Accepted |
| [0002](ADR-0002-logging-port.md)                                                 | Logging behind a port; Better Stack swappable                                                      | Accepted |
| [0003](ADR-0003-mongodb-as-job-truth.md)                                         | MongoDB is the source of truth for jobs                                                            | Accepted |
| [0004](ADR-0004-internal-route-fetch-metadata.md)                                | Internal routes deny browser contexts by Fetch metadata                                            | Accepted |
| [0005](ADR-0005-two-tier-rate-limiting.md)                                       | Two-tier rate limiting: coarse edge + identity pipeline                                            | Accepted |
| [0006](ADR-0006-cursor-pagination-and-etag.md)                                   | Cursor pagination, ETag and conditional-request helpers                                            | Accepted |
| [0007](ADR-0007-platform-settings-singleton.md)                                  | `platformSettings` singleton: create-only seed, bounds, clock-once cache                           | Accepted |
| [0008](ADR-0008-platform-settings-green-implementation.md)                       | `platformSettings` GREEN: full §20.4 schema, defaults fallback, deferred §4                        | Accepted |
| [0009](ADR-0009-upload-type-guards.md)                                           | Upload type guards: extension + MIME + magic bytes, delete-and-write-nothing                       | Accepted |
| [0010](ADR-0010-upload-type-guards-green-implementation.md)                      | Upload type guards GREEN: sniff order, logging, extension-authoritative TIFF                       | Accepted |
| [0011](ADR-0011-heif-avif-ftyp-brand-set.md)                                     | HEIF/AVIF `ftyp` major-brand set accepted by the upload type guard                                 | Accepted |
| [0012](ADR-0012-upload-magic-byte-variant-pins.md)                               | Upload guard: cover accepted magic-byte variants (BE TIFF, ORF `MMOR`/`IIRS`, unrecognized `ftyp`) | Accepted |
| [0013](ADR-0013-upload-guards-dotless-extension-pin.md)                          | Upload guard: pin the `extensionOf` dotless-name branch                                            | Accepted |
| [0014](ADR-0014-plans-catalogue-schema-and-seed.md)                              | `plans` catalogue schema and seed: unique tierRank, integer money, version-on-change               | Accepted |
| [0015](ADR-0015-plans-seed-concurrency-atomic-upsert.md)                         | `plans` seed concurrency: atomic conditioned upsert and `{key:1}` unique index                     | Accepted |
| [0016](ADR-0016-notification-routing-matrix-as-data.md)                          | Notification routing matrix as data: frozen 81 keys, template/group mapping, version-on-change     | Accepted |
| [0017](ADR-0017-notification-routing-matrix-green-implementation.md)             | Notification routing matrix GREEN: 81-key transcription, derived fields, atomic reconcile          | Accepted |
| [0018](ADR-0018-notification-routing-follow-up-severity-and-mobile-invariant.md) | Notification routing follow-up: `auth.account.completed` severity and enabled-mobile invariant     | Accepted |
| [0019](ADR-0019-matrix-transcription-guard-and-lint-override-removal.md)         | §4 matrix transcription guard (table-driven spec); broad test-lint override removed                | Accepted |
| [0020](ADR-0020-better-auth-config-otp-phone-2fa.md)                             | Better Auth config: OTP + phone + 2FA, cookie policy, test-only OTP route                          | Accepted |
| [0021](ADR-0021-better-auth-config-green-implementation.md)                      | Better Auth config GREEN: hook-based policy, `__test__` rewrite, SMS-only 2FA flow                 | Accepted |
| [0022](ADR-0022-better-auth-hook-module-decomposition.md)                        | Better Auth hooks split into focused modules (OP-85 follow-up refactor)                            | Accepted |
| [0023](ADR-0023-auth-coverage-red-otp-ip-leg-verify-cap.md)                      | Auth coverage RED: OTP IP leg, unknown-number verify 4xx, callbackURL trust, session verify cap    | Accepted |
| [0024](ADR-0024-client-ip-trust-model.md)                                        | Client-IP trust model for the auth rate-limit IP leg (configurable edge header)                    | Accepted |
| [0025](ADR-0025-auth-guards.md)                                                  | Auth guards: one pure decision per label, resolver port, per-session 2FA fact                      | Accepted |
| [0026](ADR-0026-op86-ban-exemption-and-2fa-signin-pins.md)                       | OP-86 review-gap pins: `/me` ban exemption and the 2FA sign-in branch                              | Accepted |
| [0027](ADR-0027-op86-ban-exemption-green.md)                                     | OP-86 follow-up GREEN: wire `/me` `allowBanned`, confirm the 2FA sign-in branch                    | Accepted |
| [0028](ADR-0028-internal-hmac-and-cron-framework.md)                             | Internal HMAC auth and the bounded cron job framework                                              | Accepted |

Template: Context · Decision · Consequences · Alternatives.
