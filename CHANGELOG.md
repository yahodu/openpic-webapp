## [1.16.0](https://github.com/yahodu/openpic-webapp/compare/v1.15.2...v1.16.0) (2026-10-05)

### Features

- **me:** OP-91 emit account.deletion.requested on POST /me/deletion ([#181](https://github.com/yahodu/openpic-webapp/issues/181)) ([681891a](https://github.com/yahodu/openpic-webapp/commit/681891a316acf8f4526b4208ae8ac7f6b103a599))
- **me:** OP-91 sessions management and account deletion cancel window ([#176](https://github.com/yahodu/openpic-webapp/issues/176)) ([844060a](https://github.com/yahodu/openpic-webapp/commit/844060ad337208b91ab81b0a9d25ea4523600a86))

## [1.15.2](https://github.com/yahodu/openpic-webapp/compare/v1.15.1...v1.15.2) (2026-10-05)

### Bug Fixes

- **auth:** OP-89 recover the contact-change fan-out after a partial insert failure ([#177](https://github.com/yahodu/openpic-webapp/issues/177)) ([33c45dd](https://github.com/yahodu/openpic-webapp/commit/33c45dd951a862948595ccb98321f1b34ae78798))

## [1.15.1](https://github.com/yahodu/openpic-webapp/compare/v1.15.0...v1.15.1) (2026-10-05)

### Bug Fixes

- **auth:** OP-89 key the bounded new-device read on the device hash ([#169](https://github.com/yahodu/openpic-webapp/issues/169)) ([04843a3](https://github.com/yahodu/openpic-webapp/commit/04843a3fc26cc4378e895e2b82c53bec93b5fef7)), closes [#166](https://github.com/yahodu/openpic-webapp/issues/166)

## [1.15.0](https://github.com/yahodu/openpic-webapp/compare/v1.14.0...v1.15.0) (2026-10-05)

### Features

- **me:** OP-90 complete GET and PATCH /api/v1/me ([#168](https://github.com/yahodu/openpic-webapp/issues/168)) ([ba431c2](https://github.com/yahodu/openpic-webapp/commit/ba431c2c538e51a13e7ec1564cd0df3fc582d96f)), closes [#164](https://github.com/yahodu/openpic-webapp/issues/164)

## [1.14.0](https://github.com/yahodu/openpic-webapp/compare/v1.13.0...v1.14.0) (2026-10-05)

### Features

- **auth:** OP-89 wire the lifecycle-hook surfaces and re-run dedupe ([#165](https://github.com/yahodu/openpic-webapp/issues/165)) ([3def12a](https://github.com/yahodu/openpic-webapp/commit/3def12a3c6cc36f831acad6cf8b7f1448c92ec63)), closes [#162](https://github.com/yahodu/openpic-webapp/issues/162)

## [1.13.0](https://github.com/yahodu/openpic-webapp/compare/v1.12.1...v1.13.0) (2026-10-05)

### Features

- **auth:** OP-89 identity lifecycle hooks (GREEN) ([#161](https://github.com/yahodu/openpic-webapp/issues/161)) ([8b85b74](https://github.com/yahodu/openpic-webapp/commit/8b85b74a481014908575846e04296a8de918ae71))

## [1.12.1](https://github.com/yahodu/openpic-webapp/compare/v1.12.0...v1.12.1) (2026-10-05)

### Performance Improvements

- **domain-events:** OP-88 follow-up cache the notification-type lookup + harden the stale-lease filter ([#152](https://github.com/yahodu/openpic-webapp/issues/152)) ([c25fa42](https://github.com/yahodu/openpic-webapp/commit/c25fa42d3df0d6ae7d1eb9ea1ee9a6161a35c33b))

## [1.12.0](https://github.com/yahodu/openpic-webapp/compare/v1.11.0...v1.12.0) (2026-10-05)

### Features

- **auth:** OP-85 require TRUSTED_CLIENT_IP_HEADER in production ([#147](https://github.com/yahodu/openpic-webapp/issues/147)) ([4651f3a](https://github.com/yahodu/openpic-webapp/commit/4651f3a27b9ee72ca206bc39131951e213f29363))

## [1.11.0](https://github.com/yahodu/openpic-webapp/compare/v1.10.1...v1.11.0) (2026-10-05)

### Features

- **domain-events:** OP-88 domain-events outbox and emitDomainEvent ([#144](https://github.com/yahodu/openpic-webapp/issues/144)) ([272ef25](https://github.com/yahodu/openpic-webapp/commit/272ef254caf05766926c22275e0ae76fcfc59448))

## [1.10.1](https://github.com/yahodu/openpic-webapp/compare/v1.10.0...v1.10.1) (2026-10-05)

### Bug Fixes

- **auth:** OP-85 close anonymous-verify enumeration oracle + export verify cap constants ([#145](https://github.com/yahodu/openpic-webapp/issues/145)) ([69847d8](https://github.com/yahodu/openpic-webapp/commit/69847d8f19c2022e98b36e07ffec403d2cb30242)), closes [#132](https://github.com/yahodu/openpic-webapp/issues/132)

## [1.10.0](https://github.com/yahodu/openpic-webapp/compare/v1.9.0...v1.10.0) (2026-10-05)

### Features

- **auth:** OP-87 internal HMAC auth and cron job framework ([#139](https://github.com/yahodu/openpic-webapp/issues/139)) ([e061771](https://github.com/yahodu/openpic-webapp/commit/e0617710f61b4fd29af8b8cb08269426a6b00045)), closes [#137](https://github.com/yahodu/openpic-webapp/issues/137)

## [1.9.0](https://github.com/yahodu/openpic-webapp/compare/v1.8.0...v1.9.0) (2026-10-05)

### Features

- **auth:** OP-86 wire /me ban exemption ([#135](https://github.com/yahodu/openpic-webapp/issues/135)) ([a51bc54](https://github.com/yahodu/openpic-webapp/commit/a51bc548cf56cbd1bec53b3e82d651e175d2bd3b))

## [1.8.0](https://github.com/yahodu/openpic-webapp/compare/v1.7.1...v1.8.0) (2026-10-05)

### Features

- **auth:** OP-86 auth guards for every auth label ([#133](https://github.com/yahodu/openpic-webapp/issues/133)) ([c2d96dc](https://github.com/yahodu/openpic-webapp/commit/c2d96dceb0f23315a7896be70f1a8838d2977683))

## [1.7.1](https://github.com/yahodu/openpic-webapp/compare/v1.7.0...v1.7.1) (2026-10-05)

### Bug Fixes

- **auth:** OP-85 client-IP trust model and authenticated verify cap ([#132](https://github.com/yahodu/openpic-webapp/issues/132)) ([15d31ba](https://github.com/yahodu/openpic-webapp/commit/15d31ba3a1e32e5a483e901d7c5ab231149ca6c6))

## [1.7.0](https://github.com/yahodu/openpic-webapp/compare/v1.6.1...v1.7.0) (2026-10-05)

### Features

- **auth:** OP-85 configure Better Auth with OTP, phone, 2FA and admin ([#128](https://github.com/yahodu/openpic-webapp/issues/128)) ([e05ed3f](https://github.com/yahodu/openpic-webapp/commit/e05ed3fdab9b7623be42fdf53562a12fe536c1fa))

## [1.6.1](https://github.com/yahodu/openpic-webapp/compare/v1.6.0...v1.6.1) (2026-10-05)

### Bug Fixes

- **notifications:** OP-84 reconcile auth.account.completed severity and tighten enabled-mobile schema ([#125](https://github.com/yahodu/openpic-webapp/issues/125)) ([604779f](https://github.com/yahodu/openpic-webapp/commit/604779f63e201610db205b378747a2871a38ebbc))

## [1.6.0](https://github.com/yahodu/openpic-webapp/compare/v1.5.1...v1.6.0) (2026-10-05)

### Features

- **notifications:** OP-84 seed notification routing matrix and templates ([#123](https://github.com/yahodu/openpic-webapp/issues/123)) ([d2ff4d2](https://github.com/yahodu/openpic-webapp/commit/d2ff4d2d8f745de90eb3d2b298a95cae4fb0b72d))

## [1.5.1](https://github.com/yahodu/openpic-webapp/compare/v1.5.0...v1.5.1) (2026-10-05)

### Bug Fixes

- **plans:** OP-83 $literal-wrap every catalogue seed field ([#121](https://github.com/yahodu/openpic-webapp/issues/121)) ([05093e8](https://github.com/yahodu/openpic-webapp/commit/05093e8f7e3b238819b0ef9e2f133a326e5415c6))

## [1.5.0](https://github.com/yahodu/openpic-webapp/compare/v1.4.0...v1.5.0) (2026-10-05)

### Features

- **plans:** OP-83 harden plans seed with atomic upsert and unique key index ([#119](https://github.com/yahodu/openpic-webapp/issues/119)) ([5cf7a97](https://github.com/yahodu/openpic-webapp/commit/5cf7a970eaf1bdbf8eeff22b090b4f8c4f371b2d))

## [1.4.0](https://github.com/yahodu/openpic-webapp/compare/v1.3.0...v1.4.0) (2026-10-05)

### Features

- **plans:** OP-83 seed plans catalogue ([#117](https://github.com/yahodu/openpic-webapp/issues/117)) ([8407bb8](https://github.com/yahodu/openpic-webapp/commit/8407bb877fe271199183dfb10e40fd7ee0e3d491))

## [1.3.0](https://github.com/yahodu/openpic-webapp/compare/v1.2.0...v1.3.0) (2026-10-05)

### Features

- **settings:** OP-82 platformSettings singleton, guards and seed ([#115](https://github.com/yahodu/openpic-webapp/issues/115)) ([bc55129](https://github.com/yahodu/openpic-webapp/commit/bc5512935fc3dfc49575982c4a18d6289a0e3f71))

## [1.2.0](https://github.com/yahodu/openpic-webapp/compare/v1.1.0...v1.2.0) (2026-10-04)

### Features

- **http:** OP-81 events strong ETag ([#114](https://github.com/yahodu/openpic-webapp/issues/114)) ([d9c6c3a](https://github.com/yahodu/openpic-webapp/commit/d9c6c3a6600fd626e8fcd5cc07b91200c7fc437d))

## [1.1.0](https://github.com/yahodu/openpic-webapp/compare/v1.0.4...v1.1.0) (2026-10-04)

### Features

- **config:** OP-70 add Zod-validated environment configuration ([#77](https://github.com/yahodu/openpic-webapp/issues/77)) ([20004ef](https://github.com/yahodu/openpic-webapp/commit/20004efe6354c3b52d6bc3cf87a5000195574c96))
- **contracts:** OP-74 build primitives, envelopes, fixtures and never-return scanner ([#85](https://github.com/yahodu/openpic-webapp/issues/85)) ([e83e834](https://github.com/yahodu/openpic-webapp/commit/e83e8343d075c6645406860d2617f7a84f942cb2))
- **db:** OP-75 add mongo client, transactions and readiness probe ([#87](https://github.com/yahodu/openpic-webapp/issues/87)) ([85fede6](https://github.com/yahodu/openpic-webapp/commit/85fede64c8de0625173a92227e094e89ed388d43))
- **db:** OP-76 declarative index bootstrap ([#88](https://github.com/yahodu/openpic-webapp/issues/88)) ([7716cb2](https://github.com/yahodu/openpic-webapp/commit/7716cb2b5874aee37a41304c28dac02ce5d19fbc))
- **http:** OP-73 error envelope, catalogue and defineRoute pipeline ([#84](https://github.com/yahodu/openpic-webapp/issues/84)) ([0d4e329](https://github.com/yahodu/openpic-webapp/commit/0d4e329f7916f1cdf0992a169b6aabb0c53c86e1))
- **http:** OP-81 cursor pagination, ETag and conditional-request helpers ([#110](https://github.com/yahodu/openpic-webapp/issues/110)) ([f1cbfe8](https://github.com/yahodu/openpic-webapp/commit/f1cbfe8e474a0d17ffdb1cc084914667d75c83aa))
- **logging:** OP-71 implement structured logging port and adapters ([#79](https://github.com/yahodu/openpic-webapp/issues/79)) ([c4f7947](https://github.com/yahodu/openpic-webapp/commit/c4f79477c9ea09552373e83e85e67b97e7f3bee8))
- OP-80 add Idempotency-Key defineRoute stage ([#103](https://github.com/yahodu/openpic-webapp/issues/103)) ([2abdcbf](https://github.com/yahodu/openpic-webapp/commit/2abdcbfbf3573ae9f820879b511958724526252a))
- **rate-limit:** OP-79 rate limiting port with Upstash adapter ([#101](https://github.com/yahodu/openpic-webapp/issues/101)) ([8e06c42](https://github.com/yahodu/openpic-webapp/commit/8e06c42c60a649a36a044c257c265a23b9756eb5))
- **repos:** OP-77 tenant-scoped repository layer and cross-tenant whitelist ([#89](https://github.com/yahodu/openpic-webapp/issues/89)) ([5043ffe](https://github.com/yahodu/openpic-webapp/commit/5043ffe85d802f98e24d0ddbc5a46a0c4c382c3b))
- **runtime:** OP-72 add request context, clock, ids and crypto primitives ([#81](https://github.com/yahodu/openpic-webapp/issues/81)) ([5aa00e9](https://github.com/yahodu/openpic-webapp/commit/5aa00e9942d6a2699fa38f1957801ad1ffc25575))
- **security:** OP-78 enforce edge CSRF, origin allowlist and internal-route shielding ([#90](https://github.com/yahodu/openpic-webapp/issues/90)) ([2ea7f11](https://github.com/yahodu/openpic-webapp/commit/2ea7f11b14fdf1f2fcef88829dd266b17b6e8a00))

### Bug Fixes

- **ci:** OP-72 restore gitleaks GITHUB_TOKEN and wire GITLEAKS_LICENSE ([#82](https://github.com/yahodu/openpic-webapp/issues/82)) ([8fe3e8f](https://github.com/yahodu/openpic-webapp/commit/8fe3e8f410e6054e4c416dd848c7f361f0c1f7ac))
- **eslint:** OP-77 close member-expression collection alias bypasses ([#96](https://github.com/yahodu/openpic-webapp/issues/96)) ([85f4dac](https://github.com/yahodu/openpic-webapp/commit/85f4dac9d56835cb8529a93870b1d792bf4cf656))
- **http:** OP-73 return 500 internal_error for unparseable prod response body ([#86](https://github.com/yahodu/openpic-webapp/issues/86)) ([a52a51d](https://github.com/yahodu/openpic-webapp/commit/a52a51ddb318c622d620f9925a5fad92762bcac7))
- **rate-limit:** OP-79 two-tier rate limiting, attendee-session trust, fail-closed redis, sliding window ([#104](https://github.com/yahodu/openpic-webapp/issues/104)) ([3957179](https://github.com/yahodu/openpic-webapp/commit/39571793acac798e9419364e22d08f3bb42b71a8)), closes [1/#2](https://github.com/1/openpic-webapp/issues/2) [1/#2](https://github.com/1/openpic-webapp/issues/2) [3/#4](https://github.com/3/openpic-webapp/issues/4)
- **repos:** OP-77 inspect aggregation-pipeline updates in assertUpdateScope ([#94](https://github.com/yahodu/openpic-webapp/issues/94)) ([56da89d](https://github.com/yahodu/openpic-webapp/commit/56da89d9b1e94d75631af598ea731e14cd0b4a66))
- **repos:** OP-77 pass platform-scope pipeline updates through unchanged ([#97](https://github.com/yahodu/openpic-webapp/issues/97)) ([f2f472b](https://github.com/yahodu/openpic-webapp/commit/f2f472bd3cc1b6c686df25b952e1df7371e41a09))
- **repos:** OP-77 refuse tenantId removal/rename on plain document updates ([#98](https://github.com/yahodu/openpic-webapp/issues/98)) ([708fa21](https://github.com/yahodu/openpic-webapp/commit/708fa214fe69d17cd2a522ed1925459e4d5f5995))
- **repos:** OP-77 refuse update-pipeline $project that de-scopes tenantId ([#99](https://github.com/yahodu/openpic-webapp/issues/99)) ([57230b7](https://github.com/yahodu/openpic-webapp/commit/57230b75d4e78f64e652eb2830ccd04037e11b9a))
- **security:** OP-78 deny internal-route browser contexts via Sec-Fetch-Site ([#93](https://github.com/yahodu/openpic-webapp/issues/93)) ([45687f3](https://github.com/yahodu/openpic-webapp/commit/45687f3b64d361a13691c04598384f4bcbc9b707))
- **security:** OP-78 recognise __Secure- session cookie and distinct internal-route denial event ([#91](https://github.com/yahodu/openpic-webapp/issues/91)) ([08929b5](https://github.com/yahodu/openpic-webapp/commit/08929b594e2ccc68ba12c2ef9aaff03cb64bc999))
- **test:** OP-70 correct NODE_ENV typings in config specs ([#78](https://github.com/yahodu/openpic-webapp/issues/78)) ([c58a2a0](https://github.com/yahodu/openpic-webapp/commit/c58a2a077833b6e8cf4c507d11147bc8393364e3))
