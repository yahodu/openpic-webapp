import { PDFDocument } from "pdf-lib";
import { toBuffer, toString } from "qrcode";

import type { QrFormat, QrQuery } from "./access-links";

/**
 * QR image rendering (OP-118 §2, contract §4.2, ADR-0620).
 *
 * One symbol per `(payload, format, size)`: PNG comes straight from the
 * `qrcode` renderer, SVG is its vector twin, and PDF embeds the same raster in
 * a one-page document of the requested edge length (`pdf-lib`). The renderer is
 * **pure** — same input, same bytes — which is what makes the content hash a
 * sound cache key (§16.1) and lets the route answer a byte-identical body on a
 * repeat request.
 */

/** Quiet zone around the symbol, in modules — one module keeps it phone-scannable. */
const QUIET_ZONE_MODULES = 1;

/** One rendered QR image. */
export interface RenderedQr {
  /** The exact bytes stored content-addressed under the `exports` location. */
  readonly bytes: Uint8Array;
  /** The file extension, which is also the media data-plane path suffix. */
  readonly extension: QrFormat;
  /** The MIME type the stored object is written with. */
  readonly contentType: string;
}

/**
 * Render one QR image for `payload`.
 *
 * @param payload - The URL the symbol encodes (the public share link).
 * @param query - The validated format and edge length in pixels.
 * @returns The bytes, extension and content type of the image.
 */
export async function renderQrCode(payload: string, query: QrQuery): Promise<RenderedQr> {
  const { format, size } = query;

  if (format === "svg") {
    const svg = await toString(payload, { type: "svg", width: size, margin: QUIET_ZONE_MODULES });
    return {
      bytes: new TextEncoder().encode(svg),
      extension: "svg",
      contentType: "image/svg+xml",
    };
  }

  const png = await toBuffer(payload, { type: "png", width: size, margin: QUIET_ZONE_MODULES });
  if (format === "png") {
    return { bytes: new Uint8Array(png), extension: "png", contentType: "image/png" };
  }

  // PDF: the same raster symbol on a square page of the requested edge length.
  const document = await PDFDocument.create();
  const image = await document.embedPng(png);
  const page = document.addPage([size, size]);
  page.drawImage(image, { x: 0, y: 0, width: size, height: size });
  return { bytes: await document.save(), extension: "pdf", contentType: "application/pdf" };
}
