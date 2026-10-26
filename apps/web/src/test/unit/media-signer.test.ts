import { describe, expect, it } from "vitest";

import { createMediaSigner, MEDIA_URL_TTL_SECONDS } from "@/server/media/signer";
import type { MediaDerivativeKind } from "@/server/media/signer";
import { fixedClock } from "@/server/runtime/clock";

import {
  TEST_MEDIA_CONTENT_HASH,
  TEST_MEDIA_SIGNING_SECRET_CURRENT,
  TEST_MEDIA_SIGNING_SECRET_PREVIOUS,
  makeSignMediaInput,
} from "../factories/media";

import mediaSigningVectorsData from "../../../../../packages/contracts/fixtures/media-signing-vectors.json";

/**
 * U1–U7 — the path-bound HMAC media URL signer (OP-113; API Contract §5.6, §5.7).
 *
 * The data plane (`pic.openpic.in`) is a Cloudflare Worker with the control
 * plane kept out of the byte path: the platform signs a URL and the Worker
 * authorizes image delivery purely from the URL. The contract's signature
 * scheme (API Contract §5.7) is
 *
 * ```
 * payload   = METHOD + "\n" + PATH + "\n" + EXPIRY
 * signature = base64url(HMAC-SHA256(secret, payload))
 * ```
 *
 * where `PATH` is the URL **pathname** only (never the query) and `EXPIRY` is
 * the decimal `?exp=` value verbatim, so a one-character change to the path,
 * a token replayed on the wrong derivative segment (`/t/`, `/o/`, `/p/`), a
 * changed method or an expired `exp` all recompute to a different signature.
 *
 * The signer is a **pure module**: secrets, clock and (implicitly) the fixed
 * `https://pic.openpic.in` base are injected through
 * `createMediaSigner({ currentSecret, previousSecret?, clock? })`, and the
 * shared vector fixture in
 * `packages/contracts/fixtures/media-signing-vectors.json` is the
 * cross-implementation parity contract for the Worker team — U1 pins that our
 * `sign` reproduces the published signatures byte-for-byte and that `verify`
 * accepts the published URLs.
 */

/** A deterministic instant, at an exact second so `exp` truncation is exact. */
const T0 = new Date("2040-01-01T00:00:00.000Z");

/** The URL-shape table: kind → data-plane segment → extension. */
const KIND_SEGMENTS: ReadonlyArray<readonly [MediaDerivativeKind, string, string]> = [
  ["thumbnail", "t", "webp"],
  ["original", "o", "jpg"],
  ["export", "o", "jpg"],
  ["preview", "p", "webp"],
];

/** One row of the shared test-vector fixture. */
interface MediaSigningVector {
  readonly label: string;
  readonly kind: MediaDerivativeKind;
  readonly contentHash: string;
  readonly ext: string;
  readonly path: string;
  readonly exp: number;
  readonly ttlSeconds: number;
  readonly sig: string;
  readonly url: string;
}

/** The fixture's top-level shape (the `scheme` block is documentation). */
interface MediaSigningFixtures {
  readonly secret: string;
  readonly vectors: readonly MediaSigningVector[];
}

const FIXTURE = mediaSigningVectorsData as unknown as MediaSigningFixtures;

/**
 * Return `value` with the character at `index` replaced by a different one
 * from the URL-safe alphabet.
 *
 * @param value - A string a signer emitted (a path, a signature).
 * @param index - The character position to alter.
 * @returns A same-length, different string.
 */
function alterAt(value: string, index: number): string {
  const existing = value.charAt(index);
  return `${value.slice(0, index)}${existing === "a" ? "b" : "a"}${value.slice(index + 1)}`;
}

/** Parse a signed URL and return its `exp` query value as a number. */
function expOf(url: string): number {
  return Number(new URL(url).searchParams.get("exp"));
}

describe("media URL signer", () => {
  it.each(FIXTURE.vectors.map((vector) => [vector.label, vector] as const))(
    "U1: sign reproduces the published %s vector byte-for-byte",
    (_label, vector) => {
      // Arrange — freeze the clock so `now + ttl` lands exactly on the vector's exp.
      const signer = createMediaSigner({
        currentSecret: FIXTURE.secret,
        clock: fixedClock(new Date((vector.exp - vector.ttlSeconds) * 1000)),
      });

      // Act — same inputs the Worker team's fixture was computed from.
      const signed = signer.sign(
        { kind: vector.kind, contentHash: vector.contentHash, ext: vector.ext },
        vector.ttlSeconds
      );
      const parsed = new URL(signed.url);

      // Assert — identical path, expiry and signature ⇒ identical HMAC output,
      // so the web signer and the Worker agree on the same secret.
      expect(parsed.pathname).toBe(vector.path);
      expect(parsed.searchParams.get("exp")).toBe(String(vector.exp));
      expect(parsed.searchParams.get("sig")).toBe(vector.sig);
      expect(signed.expiresAt).toBe(new Date(vector.exp * 1000).toISOString());
    }
  );

  it.each(FIXTURE.vectors.map((vector) => [vector.label, vector] as const))(
    "U1: verify accepts the published %s vector URL",
    (_label, vector) => {
      // Arrange / Act — a signer keyed with the fixture's own secret.
      const signer = createMediaSigner({ currentSecret: FIXTURE.secret });

      // Assert — the cross-implementation fixture must verify out of the box.
      expect(signer.verify(vector.url)).toBe(true);
    }
  );

  it("U2: refuses a URL whose path was altered by one character", () => {
    // Arrange
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });
    const signed = signer.sign(makeSignMediaInput(), 300);

    // Act — flip one character inside the content hash of the pathname; every
    // other part (exp, sig, host) is unchanged.
    const tampered = new URL(signed.url);
    const changedHash = alterAt(TEST_MEDIA_CONTENT_HASH, 12);
    tampered.pathname = `/o/${changedHash}.jpg`;

    // Assert
    expect(signer.verify(tampered.toString())).toBe(false);
  });

  it("U2: refuses a URL whose signature was altered by one character", () => {
    // Arrange
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });
    const signed = signer.sign(makeSignMediaInput(), 300);

    // Act — alter the sig itself, so a verifier that never checked the MAC
    // (or compared non-constant-time) would still answer true.
    const tampered = new URL(signed.url);
    const sig = tampered.searchParams.get("sig");
    if (sig === null) {
      throw new Error("the signed URL must carry a sig parameter");
    }
    tampered.searchParams.set("sig", alterAt(sig, 0));

    // Assert
    expect(signer.verify(tampered.toString())).toBe(false);
  });

  it("U3: refuses a thumbnail token presented on an /o/ path", () => {
    // Arrange
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });
    const signed = signer.sign(makeSignMediaInput({ kind: "thumbnail", ext: "webp" }), 300);

    // Act — replay the thumbnail token on the originals segment.
    const tampered = new URL(signed.url);
    tampered.pathname = tampered.pathname.replace(/^\/t\//, "/o/");

    // Assert
    expect(signer.verify(tampered.toString())).toBe(false);
  });

  it("U7: refuses a preview token presented on an /o/ path", () => {
    // Arrange
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });
    const signed = signer.sign(makeSignMediaInput({ kind: "preview", ext: "webp" }), 300);

    // Act — replay the preview token on the originals segment.
    const tampered = new URL(signed.url);
    tampered.pathname = tampered.pathname.replace(/^\/p\//, "/o/");

    // Assert
    expect(signer.verify(tampered.toString())).toBe(false);
  });

  it("U4: refuses an expired URL at and after exp", () => {
    // Arrange — sign at T0 with a 300-second TTL ⇒ exp = T0 + 300s.
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });
    const signed = signer.sign(makeSignMediaInput(), 300);

    // Act / Assert — valid through the last second before exp…
    const lastSecond = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(new Date(T0.getTime() + 299_000)),
    });
    expect(lastSecond.verify(signed.url)).toBe(true);

    // …expired the moment now reaches exp, and forever after.
    const atExp = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(new Date(T0.getTime() + 300_000)),
    });
    expect(atExp.verify(signed.url)).toBe(false);

    const afterExp = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(new Date(T0.getTime() + 301_000)),
    });
    expect(afterExp.verify(signed.url)).toBe(false);
  });

  it("U5: a URL signed under the previous secret verifies while it is configured, and fails after removal", () => {
    // Arrange — mint a URL while the old secret is still *current*.
    const beforeRotation = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_PREVIOUS,
      clock: fixedClock(T0),
    });
    const signed = beforeRotation.sign(makeSignMediaInput(), 300);

    // Act / Assert — after rotation the signer accepts both secrets…
    const rotated = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      previousSecret: TEST_MEDIA_SIGNING_SECRET_PREVIOUS,
      clock: fixedClock(T0),
    });
    expect(rotated.verify(signed.url)).toBe(true);

    // …and once the previous secret is removed from config, the same URL is
    // refused — rotation is a config change, not a re-signing of every URL.
    const afterRemoval = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });
    expect(afterRemoval.verify(signed.url)).toBe(false);
  });

  it("U6: the default TTLs keep thumbnail > original — 24 h vs 15 min, never inverted", () => {
    // The contract (API Contract §5.6, media doc §8) fixes the lifetimes:
    // thumbnails 24 h, originals 15 min, and they must never be inverted.
    expect(MEDIA_URL_TTL_SECONDS.thumbnail).toBe(24 * 60 * 60);
    expect(MEDIA_URL_TTL_SECONDS.original).toBe(15 * 60);
    // The preview derivative sits strictly between the two (GREEN card §5).
    expect(MEDIA_URL_TTL_SECONDS.preview).toBeGreaterThan(MEDIA_URL_TTL_SECONDS.original);
    expect(MEDIA_URL_TTL_SECONDS.preview).toBeLessThan(MEDIA_URL_TTL_SECONDS.thumbnail);
    // The map is complete over exactly the four derivative kinds.
    expect(Object.keys(MEDIA_URL_TTL_SECONDS).sort()).toEqual([
      "export",
      "original",
      "preview",
      "thumbnail",
    ]);
  });

  it("U6: signing without an explicit TTL applies the per-kind default, keeping the invariant", () => {
    // Arrange
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });

    // Act — no ttlSeconds argument: the kind's default applies.
    const original = signer.sign(makeSignMediaInput());
    const thumbnail = signer.sign(makeSignMediaInput({ kind: "thumbnail", ext: "webp" }));
    const preview = signer.sign(makeSignMediaInput({ kind: "preview", ext: "webp" }));
    const baseSeconds = Math.floor(T0.getTime() / 1000);

    // Assert — each exp is exactly `now + {kind's TTL}`, so the ordering of
    // the rendered expiries mirrors the constant invariant.
    expect(expOf(original.url) - baseSeconds).toBe(MEDIA_URL_TTL_SECONDS.original);
    expect(expOf(thumbnail.url) - baseSeconds).toBe(MEDIA_URL_TTL_SECONDS.thumbnail);
    expect(expOf(thumbnail.url)).toBeGreaterThan(expOf(original.url));
    expect(expOf(preview.url)).toBeGreaterThan(expOf(original.url));
    expect(expOf(preview.url)).toBeLessThan(expOf(thumbnail.url));
  });

  it.each(KIND_SEGMENTS)(
    "signs then verifies a %s URL on its own segment",
    (kind, _segment, ext) => {
      // Arrange / Act
      const signer = createMediaSigner({
        currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
        clock: fixedClock(T0),
      });
      const signed = signer.sign(makeSignMediaInput({ kind, ext }), 300);

      // Assert — the round trip is self-consistent for every derivative.
      expect(signer.verify(signed.url)).toBe(true);
    }
  );

  it.each(KIND_SEGMENTS)("emits the §5.7 URL shape for %s", (kind, segment, ext) => {
    // Arrange / Act
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });
    const signed = signer.sign(makeSignMediaInput({ kind, ext }), 300);
    const parsed = new URL(signed.url);

    // Assert — `https://pic.openpic.in/{t|o|p}/<sha256>.<ext>?exp=<unix>&sig=…`
    expect(parsed.protocol).toBe("https:");
    expect(parsed.host).toBe("pic.openpic.in");
    expect(parsed.pathname).toBe(`/${segment}/${TEST_MEDIA_CONTENT_HASH}.${ext}`);
    expect(parsed.searchParams.has("exp")).toBe(true);
    expect(parsed.searchParams.get("sig")).toMatch(/^[A-Za-z0-9_-]+$/);
    // The ISO `expiresAt` output is the same instant as `?exp=` (Unix seconds).
    expect(signed.expiresAt).toBe(new Date(expOf(signed.url) * 1000).toISOString());
  });

  it("binds the signature to the method — a GET-signed URL fails a POST check", () => {
    // Arrange / Act
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });
    const signed = signer.sign(makeSignMediaInput(), 300);

    // Assert — the preimage starts with the method, so `verify` must default
    // to the data plane's GET and refuse any other method.
    expect(signer.verify(signed.url)).toBe(true);
    expect(signer.verify(signed.url, "GET")).toBe(true);
    expect(signer.verify(signed.url, "POST")).toBe(false);
  });

  it("refuses to sign an unknown derivative kind, naming it", () => {
    // Arrange
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });

    // Act / Assert — fail closed on a kind outside the closed vocabulary.
    expect(() =>
      signer.sign(
        { kind: "bogus" as MediaDerivativeKind, contentHash: TEST_MEDIA_CONTENT_HASH, ext: "jpg" },
        300
      )
    ).toThrow(/bogus/);
  });

  it("verify answers false (never throws) for a malformed or incomplete URL", () => {
    // Arrange
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });

    // Assert — the Worker treats any unparseable input as an invalid token
    // (403), so `verify` must answer `false`, never throw.
    expect(signer.verify("")).toBe(false);
    expect(signer.verify("not a url")).toBe(false);
    expect(
      signer.verify(
        "https://pic.openpic.in/o/3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff.jpg"
      )
    ).toBe(false);
    expect(
      signer.verify(
        "https://pic.openpic.in/o/3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff.jpg?exp=4102444800"
      )
    ).toBe(false);
  });
});
