/**
 * Starts MSW node handlers for third parties when running against the e2e
 * server. The import is dynamic and guarded so MSW is never bundled or loaded
 * in any other environment (development, test, production).
 */
export async function register(): Promise<void> {
  if (process.env.APP_ENV !== "e2e") {
    return;
  }

  const { startE2eMswServer } = await import("./mocks/e2e-server");
  await startE2eMswServer();
}
