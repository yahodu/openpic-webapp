import { randomBytes, randomUUID } from "node:crypto";

/**
 * The `IdGenerator` port (OP-72, epic Runtime Primitives).
 *
 * Injectable so tests can pin ids deterministically and domain code never
 * reaches for an ambient generator.
 */
export interface IdGenerator {
  /** A 24-character lowercase hex string (Mongo `ObjectId` shape). */
  objectIdHex(): string;
  /** A RFC 4122 version-4 UUID. */
  uuidV4(): string;
  /** A 26-character Crockford base32 ULID (monotonic-friendly, sortable). */
  ulid(): string;
}

/** Crockford base32 alphabet: no `I`, `L`, `O` or `U`. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID time component width in characters (48-bit millisecond timestamp). */
const ULID_TIME_LENGTH = 10;

/** ULID randomness component width in characters (80 bits). */
const ULID_RANDOM_LENGTH = 16;

/** Encode a non-negative integer as fixed-width Crockford base32. */
function encodeBase32(value: number, length: number): string {
  let remaining = value;
  let encoded = "";

  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD.charAt(remaining % 32) + encoded;
    remaining = Math.floor(remaining / 32);
  }

  return encoded;
}

/** Encode `length` cryptographically-random characters of Crockford base32. */
function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let encoded = "";

  for (let index = 0; index < length; index += 1) {
    encoded += CROCKFORD.charAt(bytes.readUInt8(index) % 32);
  }

  return encoded;
}

/**
 * The production id generator.
 *
 * @example
 * idGenerator.objectIdHex(); // "652f1a3b4c5d6e7f8091a2b3"
 * idGenerator.uuidV4();      // "2b1d…-…-4…-…-…"
 * idGenerator.ulid();        // "01J…"
 */
export const idGenerator: IdGenerator = {
  objectIdHex: () => randomBytes(12).toString("hex"),
  uuidV4: () => randomUUID(),
  ulid: () => encodeBase32(Date.now(), ULID_TIME_LENGTH) + randomBase32(ULID_RANDOM_LENGTH),
};
