import type { RequestHandler } from "msw";

/**
 * Shared happy-path MSW handlers for integration tests. Per-test error cases
 * are added with `server.use(...)` and cleared by the afterEach reset.
 *
 * Intentionally empty for the scaffold: the sentinel test (I1) asserts that a
 * request with no handler fails, so nothing should be mocked here yet.
 */
export const handlers: RequestHandler[] = [];
