/**
 * Media-signing fixtures (OP-113, CONVENTIONS §3).
 *
 * The literals here are deliberately low-entropy test strings — never a
 * credential shape the secret scanner (`gitleaks`, `secret-scan` in
 * `ci.yml`) would flag. `TEST_MEDIA_SIGNING_SECRET_CURRENT` equals the
 * `packages/contracts/fixtures/media-signing-vectors.json` secret on purpose:
 * a signer built with the factory secrets can verify the published vectors,
 * so the spec checks the implementation against the cross-implementation
 * fixture rather than against private expectations.
 */
import type { SignMediaInput } from "@/server/media/signer";

/** The current signing secret every fixture is keyed with (== the vector fixture's secret). */
export const TEST_MEDIA_SIGNING_SECRET_CURRENT = "test-media-signing-secret-v1";

/** The previous signing secret a rotated signer accepts (U5). Low entropy, on purpose. */
export const TEST_MEDIA_SIGNING_SECRET_PREVIOUS = "test-media-signing-secret-prev";

/** A lowercase hex SHA-256 — the content hash every URL fixture is built from. */
export const TEST_MEDIA_CONTENT_HASH =
  "3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff";

/**
 * Build a valid signing input.
 *
 * @param overrides - Fields to replace on the fixture default.
 * @returns A {@link SignMediaInput} the signer accepts.
 */
export function makeSignMediaInput(overrides: Partial<SignMediaInput> = {}): SignMediaInput {
  return {
    kind: "original",
    contentHash: TEST_MEDIA_CONTENT_HASH,
    ext: "jpg",
    ...overrides,
  };
}
