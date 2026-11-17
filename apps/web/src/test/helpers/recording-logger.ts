import type { LogFields, LogLevel, Logger } from "@/server/logging";

/**
 * A `Logger` that keeps every line it was given (OP-136).
 *
 * The lifecycle jobs are driven directly by the integration specs, so each run
 * receives the logger its `CronJobContext` carries. Recording that logger is
 * how a job's per-step evidence is observed without mocking a module: the
 * retention purge's `retention.purge.step` lines are a DSR artefact, so the
 * ordering and the counts they carry are part of the contract, not diagnostics.
 *
 * `child()` shares the parent's buffer — a job that derives a bound logger must
 * not lose its parent's lines.
 */

/** One recorded line: its level, message and merged fields. */
export interface RecordedLog {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: LogFields;
}

/** The recording logger surface. */
export interface RecordingLogger extends Logger {
  /** Every line written so far, oldest first. */
  readonly entries: readonly RecordedLog[];
  /** The lines whose `fields.event` equals `event`. */
  entriesForEvent(event: string): readonly RecordedLog[];
  /** Forget every line (a case runs the same job twice). */
  clear(): void;
}

/**
 * Build a fresh recording logger.
 *
 * @param bindings - Fields merged under every line (the `child()` contract).
 * @returns The logger plus its inspectable buffer.
 */
export function recordingLogger(bindings: LogFields = {}): RecordingLogger {
  return build(bindings, []);
}

/**
 * Build one logger over a shared buffer.
 *
 * @param bindings - Fields merged under this logger's lines.
 * @param entries - The buffer every sibling logger writes into.
 * @returns The logger.
 */
function build(bindings: LogFields, entries: RecordedLog[]): RecordingLogger {
  const write =
    (level: LogLevel) =>
    (msg: string, fields: LogFields = {}): void => {
      entries.push({ level, msg, fields: { ...bindings, ...fields } });
    };

  return {
    entries,
    trace: write("trace"),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    fatal: write("fatal"),
    child: (childBindings: LogFields) => build({ ...bindings, ...childBindings }, entries),
    flush: () => Promise.resolve(),
    entriesForEvent: (event: string) => entries.filter((entry) => entry.fields.event === event),
    clear: (): void => {
      entries.length = 0;
    },
  };
}
