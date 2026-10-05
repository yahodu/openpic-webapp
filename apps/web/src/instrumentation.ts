/**
 * Next.js instrumentation hook.
 *
 * Runs once per server boot. The Mongo shutdown hook and the MSW node server
 * are Node-only, and Next also compiles this file for the Edge runtime (as soon
 * as `middleware.ts` exists). Guarding the dynamic imports on
 * `NEXT_RUNTIME === "nodejs"` lets the bundler drop the Node-only branches from
 * the Edge build, so `mongodb` (which needs `net`/`tls`) is never traced there.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail fast in production: validate the deploy configuration at boot so a
    // process missing a required knob (e.g. TRUSTED_CLIENT_IP_HEADER, ADR-0024/
    // ADR-0032) refuses to start instead of failing at the first request.
    // Guarded to production so dev/test/e2e boot is unaffected by incomplete
    // local environments.
    if (process.env.APP_ENV === "production") {
      const { getConfig } = await import("./server/config/env");
      getConfig();
    }

    // Disposability (OP-75 §5): close the pooled Mongo client on SIGTERM/SIGINT
    // for a self-hosted process.
    const { registerMongoShutdownHook } = await import("./server/db/lifecycle");
    registerMongoShutdownHook();

    // Start MSW node handlers for third parties when running against the e2e
    // server. The import is dynamic and guarded so MSW is never bundled or
    // loaded in any other environment (development, test, production).
    if (process.env.APP_ENV === "e2e") {
      const { startE2eMswServer } = await import("./test/mocks/e2e-server");
      await startE2eMswServer();
    }
  }
}
