import { setupServer } from "msw/node";

import { handlers } from "./handlers";

/** MSW server used by the e2e Next server for third-party calls only. */
export const e2eServer = setupServer(...handlers);

/**
 * Boot the e2e MSW server. Called from `instrumentation.ts` only when
 * `APP_ENV === 'e2e'`. Unknown outbound requests fail closed.
 *
 * @returns Resolves once the interceptor is listening.
 */
export function startE2eMswServer(): Promise<void> {
  e2eServer.listen({ onUnhandledRequest: "error" });
  return Promise.resolve();
}
