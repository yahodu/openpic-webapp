/**
 * Edge-runtime logging (OP-78).
 *
 * Middleware runs on the Edge runtime, where the Node-based `Logger` stack is
 * unavailable (`src/server/logging` pulls `node:async_hooks` transitively). This
 * module is the minimal, dependency-free serializer for the security events the
 * edge gate must emit: one structured JSON line, mirroring the shape of the
 * stdout transport (`level`, `ts`, `msg` plus structured fields) so edge and
 * application logs are read the same way.
 *
 * It deliberately lives under `src/server/logging` — the only folder allowed to
 * write to `console` — and carries only non-sensitive fields.
 */

/** A security warning emitted by the edge gate. */
export interface EdgeSecurityWarning {
  /** The dotted event name, e.g. `security.csrf_failed`. */
  readonly event: string;
  /** The request path (no query string); never the full URL. */
  readonly path: string;
  /** The `Origin` header's host, or `null` when the request had no Origin. */
  readonly originHost: string | null;
}

/**
 * Emit one structured security warning at `warn` level.
 *
 * Only the event name, path and origin host are written — never headers,
 * cookies, tokens or request bodies.
 *
 * @param warning - The event name and its non-sensitive fields.
 */
export function logEdgeSecurityWarning(warning: EdgeSecurityWarning): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      ts: new Date().toISOString(),
      msg: warning.event,
      event: warning.event,
      path: warning.path,
      originHost: warning.originHost,
    })
  );
}
