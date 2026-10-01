import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

import { handlers } from "../../mocks/handlers";

/**
 * MSW integration harness. Every integration test runs with outbound HTTP
 * intercepted: an unmatched request is an error (fail-closed), never a live
 * network call. Handlers reset between tests so overrides never leak.
 */
export const server = setupServer(...handlers);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
