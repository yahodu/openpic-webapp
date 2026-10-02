/**
 * Starts MSW node handlers for third parties when running against the e2e
 * server. The import is dynamic and guarded so MSW is never bundled or loaded
 * in any other environment (development, test, production).
 */
export async function register(): Promise<void> {
  // Disposability (OP-75 §5): close the pooled Mongo client on SIGTERM/SIGINT
  // for a self-hosted process. Next.js calls `register()` once per server boot.
  const { registerMongoShutdownHook } = await import("./server/db/lifecycle");
  registerMongoShutdownHook();

  if (process.env.APP_ENV !== "e2e") {
    return;
  }

  const { startE2eMswServer } = await import("./test/mocks/e2e-server");
  await startE2eMswServer();
}
