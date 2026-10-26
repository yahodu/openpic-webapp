import { idSchema, isoDateTimeSchema } from "@openpic/contracts";
import { z } from "zod";

/**
 * The Event DTO — the shared response shape of the events routes (OP-115,
 * contract §4.1, schema §15.1).
 *
 * `serializeResponse` validates every response body strictly in development,
 * so `eventDtoSchema` declares exactly the fields the routes emit: an event
 * row projected to its wire shape (string `id`, `Z` instants, the embedded
 * `accessLinks` kept to `{slug, active}`) plus the derived `shareUrl`. The
 * create body (201) and the read body (200) are the same DTO.
 */

/** One active/revoked access link on the wire (contract §4.1). */
export const accessLinkDtoSchema = z.object({
  slug: z.string(),
  active: z.boolean(),
});

/** The Event DTO (contract §4.1). */
export const eventDtoSchema = z.object({
  id: idSchema,
  name: z.string(),
  status: z.enum(["draft", "published"]),
  startAt: isoDateTimeSchema,
  endAt: isoDateTimeSchema,
  displayTimeZone: z.string(),
  description: z.string(),
  uploadWindowEndsAt: isoDateTimeSchema.nullable(),
  retentionExpiresAt: isoDateTimeSchema.nullable(),
  accessLinks: z.array(accessLinkDtoSchema),
  shareUrl: z.string(),
  createdAt: isoDateTimeSchema,
});

/** The client-facing Event DTO. */
export type EventDto = z.infer<typeof eventDtoSchema>;

/** The stored `events` row fields the projection reads (schema §15.1). */
export interface EventRow {
  readonly _id: { toHexString(): string };
  readonly name: string;
  readonly status: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly displayTimeZone: string;
  readonly description: string;
  readonly uploadWindowEndsAt: Date | null;
  readonly retentionExpiresAt: Date | null;
  readonly accessLinks: readonly {
    readonly slug: string;
    readonly active: boolean;
  }[];
  readonly createdAt: Date;
  readonly updatedAt?: Date;
  readonly schemaVersion?: number;
}

/**
 * Project a stored `events` row onto the Event DTO.
 *
 * The `shareUrl` host is deliberately caller-supplied (the app's configured
 * base URL; tests pin only that the path contains `/e/<slug>`).
 *
 * @param row - The stored row, or `null` when the read matched nothing.
 * @param baseUrl - The app origin the public `/e/<slug>` link is served from.
 * @returns The DTO, or `null` when `row` is `null`.
 */
export function toEventDto(row: EventRow | null, baseUrl: string): EventDto | null {
  if (row === null) {
    return null;
  }
  const slug = row.accessLinks[0]?.slug ?? "";
  return {
    id: row._id.toHexString(),
    name: row.name,
    status: row.status as EventDto["status"],
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    displayTimeZone: row.displayTimeZone,
    description: row.description,
    uploadWindowEndsAt:
      row.uploadWindowEndsAt === null ? null : row.uploadWindowEndsAt.toISOString(),
    retentionExpiresAt:
      row.retentionExpiresAt === null ? null : row.retentionExpiresAt.toISOString(),
    accessLinks: row.accessLinks.map((link) => ({ slug: link.slug, active: link.active })),
    shareUrl: `${baseUrl}/e/${slug}`,
    createdAt: row.createdAt.toISOString(),
  };
}
