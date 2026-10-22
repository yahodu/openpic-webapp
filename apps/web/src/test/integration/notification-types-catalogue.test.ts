import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import { GET as getCatalogue } from "@/app/api/v1/notification-types/route";
import { seedNotificationTypes } from "@/server/notifications/seed-notification-types";

import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";

/**
 * Integration / contract — `GET /api/v1/notification-types` (OP-98, contract
 * §7.6; schema §19.1; ADR-0220).
 *
 * The catalogue is served **as data** so the settings screen can be built
 * generically and never hard-codes the 81-key list. The route is `user`-guarded,
 * answers `{ data: [...] }` with the §7.6 projection of every **enabled**
 * `notificationTypes` document, and is cacheable:
 * `Cache-Control: private, max-age=600` on **every** response, filtered or not.
 *
 * The one field that must never reach the wire is `retainBody`: it governs the
 * internal dispatch ledger for OTP types (design rule 6), is not part of the §7.6
 * shape, and is an internal storage decision the client must not be able to
 * observe or build a rule on.
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/notification-types/route` exports `GET`, guarded with the `user`
 * label, reading `notification_types` (seeded by
 * `@/server/notifications/seed-notification-types`) and answering the §7.6 item
 * shape: `typeKey`, `category`, `label`, `description`, `audiences`,
 * `channelGroups`(`group`/`enabled`/`optOutAllowed`/`candidates?`/`strategy?`),
 * `transactional`, `severity`, `respectQuietHours`, `throttle`, `dedupe`,
 * `actionable`, `enabled`, `version`.
 *
 * ## Assumptions recorded in the handoff
 *
 * - The seed stores no `label`/`description` copy (they are a read-route
 *   projection — see `notification-types.values.ts`), so this spec pins only that
 *   a non-empty `label` and a `description` **of type `string`** are served; the
 *   exact prose is not a contract.
 * - An unknown `category` or `audience` value filters to an empty `data` array
 *   rather than `422` — the query is a filter, not a validated enum (contract
 *   §7.6 names no error for it).
 * - Only `enabled: true` types are served; a disabled catalogue row is a routing
 *   fact the settings screen must not offer.
 */

const CATALOGUE_PATH = "/api/v1/notification-types";

/** The contract's full catalogue size (contract §7.6). */
const CONTRACT_TYPE_COUNT = 81;

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op98-catalogue" });
  await seedNotificationTypes({ db: app.db });
}, 30_000);

afterAll(async () => {
  await app.cleanup();
});

/** One channel group as the §7.6 catalogue serves it. */
interface CatalogueChannelGroup {
  readonly group: string;
  readonly enabled: boolean;
  readonly optOutAllowed: boolean;
  readonly candidates?: string[];
  readonly strategy?: string;
}

/** One catalogue item (contract §7.6). */
interface CatalogueItem {
  readonly typeKey: string;
  readonly category: string;
  readonly label: string;
  readonly description: string;
  readonly audiences: string[];
  readonly channelGroups: CatalogueChannelGroup[];
  readonly transactional: boolean;
  readonly severity: string;
  readonly respectQuietHours: boolean;
  readonly throttle: Record<string, unknown>;
  readonly dedupe: Record<string, unknown>;
  readonly actionable: boolean;
  readonly enabled: boolean;
  readonly version: number;
}

/** The `{ data }` envelope. */
interface CatalogueBody {
  readonly data: CatalogueItem[];
}

/** A GET carrying the session cookie and an optional query string. */
function catalogueRequest(session: SignedInUser, query = ""): Request {
  return new Request(new URL(`${CATALOGUE_PATH}${query}`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie: session.cookie },
  });
}

/** A GET with no session cookie. */
function anonymousCatalogueRequest(): Request {
  return new Request(new URL(CATALOGUE_PATH, APP_ORIGIN), { method: "GET" });
}

describe("authorization — /api/v1/notification-types is user-scoped", () => {
  it("returns 401 when the session cookie is missing", async () => {
    const response = await getCatalogue(anonymousCatalogueRequest());

    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/notification-types (§7.6) — the §7.6 projection", () => {
  it("serves every seeded catalogue type with the §7.6 field set and a non-empty label", async () => {
    const session = await app.signIn(makeIdentity("op98-catalogue-shape"));

    const response = await getCatalogue(catalogueRequest(session));

    expect(response.status).toBe(200);
    const body = (await response.json()) as CatalogueBody;

    expect(body.data).toHaveLength(CONTRACT_TYPE_COUNT);

    for (const item of body.data) {
      expect(typeof item.typeKey).toBe("string");
      expect(typeof item.category).toBe("string");
      expect(typeof item.label).toBe("string");
      expect(item.label.length).toBeGreaterThan(0);
      expect(typeof item.description).toBe("string");
      expect(Array.isArray(item.audiences)).toBe(true);
      expect(Array.isArray(item.channelGroups)).toBe(true);
      expect(typeof item.transactional).toBe("boolean");
      expect(typeof item.severity).toBe("string");
      expect(typeof item.respectQuietHours).toBe("boolean");
      expect(typeof item.throttle).toBe("object");
      expect(typeof item.dedupe).toBe("object");
      expect(typeof item.actionable).toBe("boolean");
      expect(item.enabled).toBe(true);
      expect(typeof item.version).toBe("number");
    }
  });

  it("filters by category", async () => {
    const session = await app.signIn(makeIdentity("op98-catalogue-category"));

    const response = await getCatalogue(catalogueRequest(session, "?category=billing"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as CatalogueBody;

    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.category).toBe("billing");
    }
  });

  it("filters by audience", async () => {
    const session = await app.signIn(makeIdentity("op98-catalogue-audience"));

    const response = await getCatalogue(catalogueRequest(session, "?audience=platform_admin"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as CatalogueBody;

    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.audiences).toContain("platform_admin");
    }
  });

  it("applies the category and audience filters together", async () => {
    const session = await app.signIn(makeIdentity("op98-catalogue-both"));

    const response = await getCatalogue(
      catalogueRequest(session, "?category=billing&audience=billing_contact")
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as CatalogueBody;

    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.category).toBe("billing");
      expect(item.audiences).toContain("billing_contact");
    }
  });

  it("returns an empty page for an unknown filter value rather than an error", async () => {
    const session = await app.signIn(makeIdentity("op98-catalogue-unknown"));

    const response = await getCatalogue(catalogueRequest(session, "?category=not_a_category"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as CatalogueBody;

    expect(body.data).toEqual([]);
  });
});

describe("GET /api/v1/notification-types (§7.6) — I4: never exposes retainBody", () => {
  it("omits retainBody from every catalogue item", async () => {
    const session = await app.signIn(makeIdentity("op98-catalogue-retainbody"));

    const response = await getCatalogue(catalogueRequest(session));

    expect(response.status).toBe(200);
    const body = (await response.json()) as CatalogueBody;

    for (const item of body.data) {
      expect(Object.prototype.hasOwnProperty.call(item, "retainBody")).toBe(false);
    }
    expect(JSON.stringify(body)).not.toContain("retainBody");
  });

  it("carries no never-return field in the response body", async () => {
    const session = await app.signIn(makeIdentity("op98-catalogue-never-return"));

    const response = await getCatalogue(catalogueRequest(session));
    const body: unknown = await response.json();

    expect(findForbiddenFields(body, "default")).toEqual([]);
  });

  it("sets the §7.6 Cache-Control header", async () => {
    const session = await app.signIn(makeIdentity("op98-catalogue-cache"));

    const response = await getCatalogue(catalogueRequest(session));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=600");
  });

  it.each(["?category=billing", "?audience=platform_admin"])(
    "keeps the §7.6 Cache-Control header on the filtered response %s",
    async (query) => {
      const session = await app.signIn(makeIdentity("op98-catalogue-cache-filtered"));

      const response = await getCatalogue(catalogueRequest(session, query));

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, max-age=600");
    }
  );
});
