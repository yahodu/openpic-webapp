import { appError } from "@/server/http/errors";

/**
 * Access-link URL building and QR query validation (OP-118, contract §4.2,
 * schema §15.1/§16.1, ADR-0620).
 *
 * The public event link is `${APP_BASE_URL}/e/${slug}` and the QR image encodes
 * exactly that link, so the two builders share one normalisation: a configured
 * base URL with a trailing slash never produces a doubled separator. Both are
 * **pure** — the base URL is an argument, which is what lets the unit suite pin
 * them without a clock, a database or the config module (ADR-0620 §A1/§A2).
 *
 * `parseQrQuery` is the `?format=png|svg|pdf&size=256..2048` validator. Both
 * parameters are optional (defaults `png` / `1024`, ADR-0620 §A3); anything
 * outside the domain is a `422 validation_failed` whose
 * `details.fields[].path` names the offending query parameter, in the same
 * `{path, code, message}` shape the body validator emits.
 */

/** The closed QR image formats §4.2 documents, in contract order. */
export const QR_FORMATS = ["png", "svg", "pdf"] as const;

/** A QR image format a download may request. */
export type QrFormat = (typeof QR_FORMATS)[number];

/** The smallest accepted QR edge, in pixels (contract §4.2). */
export const QR_MIN_SIZE = 256;

/** The largest accepted QR edge, in pixels (contract §4.2). */
export const QR_MAX_SIZE = 2048;

/** The size a request that omits `?size=` gets (ADR-0620 §A3). */
export const QR_DEFAULT_SIZE = 1024;

/** The format a request that omits `?format=` gets (ADR-0620 §A3). */
export const QR_DEFAULT_FORMAT: QrFormat = "png";

/** A validated QR download query. */
export interface QrQuery {
  readonly format: QrFormat;
  readonly size: number;
}

/** Narrow a raw query value to the contract's format vocabulary. */
function isQrFormat(value: string): value is QrFormat {
  return (QR_FORMATS as readonly string[]).includes(value);
}

/** Refuse one query parameter as a `422 validation_failed` naming it. */
function refuseField(path: "format" | "size", message: string): never {
  throw appError("validation_failed", {
    details: { fields: [{ path, code: "invalid", message }] },
  });
}

/**
 * Collapse trailing slashes so a base URL never doubles the separator.
 *
 * @param baseUrl - The configured absolute base URL, with or without a slash.
 * @returns The same URL without a trailing slash.
 */
function withoutTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Build the public share link of one access link.
 *
 * @param baseUrl - The configured public base URL (`APP_BASE_URL`).
 * @param slug - The link's 8-character slug.
 * @returns `${baseUrl}/e/${slug}`.
 * @example
 * buildAccessLinkShareUrl("https://openpic.in", "k7m2xq9p");
 * // "https://openpic.in/e/k7m2xq9p"
 */
export function buildAccessLinkShareUrl(baseUrl: string, slug: string): string {
  return `${withoutTrailingSlash(baseUrl)}/e/${slug}`;
}

/**
 * Build the string a QR image encodes.
 *
 * The attendee scans it with a phone camera, so it is the public share link
 * built from the configured base URL — never a hardcoded host and never the
 * requesting origin. It is a separate function so a per-channel tracking
 * parameter later has one seam to grow into (ADR-0620 §A2).
 *
 * @param baseUrl - The configured public base URL (`APP_BASE_URL`).
 * @param slug - The link's 8-character slug.
 * @returns The public share link the image encodes.
 */
export function buildQrPayloadUrl(baseUrl: string, slug: string): string {
  return buildAccessLinkShareUrl(baseUrl, slug);
}

/**
 * Validate the QR download query.
 *
 * @param searchParams - The request's query parameters.
 * @returns The requested format and edge length.
 * @throws An `AppError` with code `validation_failed` (422) when `format` is
 *   outside `png|svg|pdf` or `size` is not a whole number in `256..2048`; its
 *   `details.fields[].path` names the offending parameter.
 */
export function parseQrQuery(searchParams: URLSearchParams): QrQuery {
  const rawFormat = searchParams.get("format");
  const format = rawFormat === null || rawFormat === "" ? QR_DEFAULT_FORMAT : rawFormat;
  if (!isQrFormat(format)) {
    refuseField("format", `Must be one of: ${QR_FORMATS.join(", ")}.`);
  }

  const rawSize = searchParams.get("size");
  if (rawSize === null || rawSize === "") {
    return { format, size: QR_DEFAULT_SIZE };
  }
  if (!/^[0-9]+$/.test(rawSize)) {
    refuseField(
      "size",
      `Must be a whole number between ${String(QR_MIN_SIZE)} and ${String(QR_MAX_SIZE)}.`
    );
  }
  const size = Number(rawSize);
  if (size < QR_MIN_SIZE || size > QR_MAX_SIZE) {
    refuseField("size", `Must be between ${String(QR_MIN_SIZE)} and ${String(QR_MAX_SIZE)}.`);
  }
  return { format, size };
}
