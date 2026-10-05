import { describe, expect, it } from "vitest";

import { channelGroupSchema } from "@/server/notifications/notification-types";

/**
 * Unit contract — the enabled-`mobile` channel-group invariant (OP-84,
 * schema §19.1, design §1.1; ADR-0018 §2).
 *
 * `channelGroupSchema` must reject an **enabled** `mobile` group that does not
 * declare at least one `candidates` provider and `strategy: "first_eligible"`.
 * Without both, the resolver has no route to attempt, so the schema is the
 * reusable gate an admin template/type editor passes (ADR-0016 module contract,
 * ADR-0018 "Alternatives considered").
 *
 * This is a **characterisation / regression guard, not a RED-first spec**: the
 * behaviour already exists on `main` (landed with PR #125). It is written here
 * so that removing or loosening the `superRefine` fails loudly instead of
 * silently re-admitting an un-routable mobile group.
 *
 * The cases are deliberately fixture-free: each table row is a literal group
 * shape, because the unit under test is the schema alone (no seed, no factory).
 */

/** Parse an arbitrary group shape; input is `unknown` because these rows feed the schema invalid values. */
function parseGroup(group: unknown) {
  return channelGroupSchema.safeParse(group);
}

/** The dotted issue paths a failed parse reports, or `[]` when it parsed. */
function issuePaths(result: ReturnType<typeof parseGroup>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("channelGroupSchema — accepted shapes", () => {
  it.each([
    {
      label: "an enabled mobile group with candidates and first_eligible strategy",
      group: {
        group: "mobile",
        enabled: true,
        optOutAllowed: false,
        candidates: ["whatsapp", "sms"],
        strategy: "first_eligible",
      },
    },
    {
      label: "a bare disabled mobile group with neither routing field",
      group: { group: "mobile", enabled: false, optOutAllowed: false },
    },
    {
      label: "a bare in_app group",
      group: { group: "in_app", enabled: true, optOutAllowed: false },
    },
    {
      label: "a bare email group",
      group: { group: "email", enabled: true, optOutAllowed: false },
    },
  ])("accepts $label", ({ group }) => {
    expect(parseGroup(group).success).toBe(true);
  });
});

describe("channelGroupSchema — enabled mobile invariant (ADR-0018 §2)", () => {
  it.each([
    {
      label: "an enabled mobile group missing candidates",
      group: {
        group: "mobile",
        enabled: true,
        optOutAllowed: false,
        strategy: "first_eligible",
      },
      path: "candidates",
    },
    {
      label: "an enabled mobile group missing strategy",
      group: {
        group: "mobile",
        enabled: true,
        optOutAllowed: false,
        candidates: ["whatsapp"],
      },
      path: "strategy",
    },
    {
      label: "an enabled mobile group with an empty candidates array",
      group: {
        group: "mobile",
        enabled: true,
        optOutAllowed: false,
        candidates: [],
        strategy: "first_eligible",
      },
      path: "candidates",
    },
    {
      label: "an enabled mobile group with a strategy other than first_eligible",
      group: {
        group: "mobile",
        enabled: true,
        optOutAllowed: false,
        candidates: ["whatsapp"],
        strategy: "round_robin",
      },
      path: "strategy",
    },
  ])("rejects $label and reports the $path path", ({ group, path }) => {
    const result = parseGroup(group);

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(path);
  });
});
