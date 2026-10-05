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
