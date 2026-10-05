import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { runTransportDriftCheck } from "@/server/adapters/novu/workflow-drift";
import { createLogger, memoryTransport } from "@/server/logging";
import {
  makeCanonicalTransportWorkflows,
  makeNovuWorkflowList,
  makeTransportWorkflow,
  makeTransportWorkflowList,
} from "@/test/factories/transport";

import { server } from "./setup";

/**
 * I5 — the drift script's engine against the mocked Novu workflow API.
 *
 * `scripts/novu/assert-no-drift.ts` is a thin CLI over
 * {@link runTransportDriftCheck}: fetch every workflow, run the pure drift
 * assertion, and exit `1` when the set is not exactly the three transport
 * workflows with one matching step each (notification design §8.3). A passing
 * set must exit `0`.
 *
 * The test drives the engine in-process, so MSW can intercept Novu's HTTP.
 */

const NOVU_BASE_URL = "https://api.novu.co";
const NOVU_API_KEY = "test-novu-api-key";
const WORKFLOWS_URL = `${NOVU_BASE_URL}/v1/workflows`;

function installLogger() {
  const sink = memoryTransport();
  const logger = createLogger({
    level: "trace",
    transports: [sink],
    service: "openpic-web",
    env: "test",
    version: "test-sha",
    base: { requestId: "req-drift-test" },
  });
  return { logger, sink };
}

describe("runTransportDriftCheck (MSW)", () => {
  it("I5a: exits 0 and fetches the workflow list with the API key when nothing drifted", async () => {
    // Arrange
    let authorization: string | null = null;
    let requestedUrl = "";
    server.use(
      http.get(WORKFLOWS_URL, ({ request }) => {
        authorization = request.headers.get("authorization");
        requestedUrl = request.url;
        return HttpResponse.json(makeNovuWorkflowList(makeCanonicalTransportWorkflows()));
      })
    );

    const { logger } = installLogger();

    // Act
    const exitCode = await runTransportDriftCheck({
      baseUrl: NOVU_BASE_URL,
      apiKey: NOVU_API_KEY,
      logger,
    });

    // Assert
    expect(exitCode).toBe(0);
    expect(requestedUrl).toBe(WORKFLOWS_URL);
    expect(authorization).toBe(`ApiKey ${NOVU_API_KEY}`);
  });

  it("I5b: exits 1 and logs at error when an unexpected workflow is present", async () => {
    // Arrange
    const drifted = makeTransportWorkflowList([
      ...makeCanonicalTransportWorkflows(),
      makeTransportWorkflow({
        workflowId: "welcome-email",
        steps: [{ active: true, channel: "email" }],
      }),
    ]);
    server.use(http.get(WORKFLOWS_URL, () => HttpResponse.json(makeNovuWorkflowList(drifted))));

    const { logger, sink } = installLogger();

    // Act
    const exitCode = await runTransportDriftCheck({
      baseUrl: NOVU_BASE_URL,
      apiKey: NOVU_API_KEY,
      logger,
    });

    // Assert
    expect(exitCode).toBe(1);
    const entry = sink.entries.find((logged) => logged.event === "transport.workflow_drift");
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("error");
  });
});
