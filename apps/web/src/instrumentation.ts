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
