import { afterEach, describe, expect, it, vi } from "vitest";

import { upstashRateLimiter } from "./adapters/upstash";

/**
 * Unit pins for the Upstash sliding-window adapter (contract §0.11, "Upstash
 * Ratelimit, sliding window").
 *
 * The adapter speaks the Upstash Redis REST wire: one `EVAL` whose result is
 * `[currentFields, previousFields, success]`. The window is two adjacent fixed
 * buckets, the previous bucket weighted by `1 - elapsed/window`, so a burst
 * that straddles a window boundary is admitted only when
 *
 *     Math.floor(previousCount * weight) + currentCount  <=  limit.
 *
 * The integration suite (`test/integration/rate-limit-upstash.test.ts`) only
 * ever returns an empty `previousFields`, so the weighted branch and the
 * non-numeric guard are never executed there. These pins drive the adapter
 * directly through an injected `fetch` and a fixed clock with a non-empty
 * previous bucket, and pin the Zod response validation at the unit level.
 */

const URL = "https://upstash.example.test/ratelimit";
const TOKEN = "unit-upstash-token";
const KEY = "write.normal:user:bucket_under_test";
const RULE = { limit: 60, windowSeconds: 60 } as const;

/**
 * A fixed instant 30s into a 60s window: `elapsed = 30_000`, so the previous
 * bucket carries `weight = 1 - 30_000/60_000 = 0.5` and the window resets in
 * 30s. Chosen so the weighted contribution is a non-trivial fraction — an
 * adapter that ignored `previousFields` would report a materially different
 * `remaining`.
 */
const NOW = 1_530_000;

/** A captured `EVAL` request: the raw input, init and parsed body. */
interface CapturedRequest {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit;
  readonly body: unknown;
}

/**
 * Build an injected `fetch` that answers every call with `payload` and records
 * the request it received, so the wire shape (bearer token, EVAL args, the
 * single clock read) is assertable.
 */
function stubFetch(payload: unknown): {
  readonly fetch: typeof fetch;
  readonly requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
    requests.push({ input, init: init ?? {}, body });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  });

  return { fetch: fetchImpl, requests };
}

/** A limiter whose transport returns one fixed Upstash result tuple. */
function limiterWith(result: readonly unknown[]) {
  return upstashRateLimiter({ url: URL, token: TOKEN, fetch: stubFetch({ result }).fetch });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("upstashRateLimiter — weighted sliding window", () => {
  it("admits a request whose weighted total is just under the limit and reports the weighted remaining", async () => {
    vi.useFakeTimers({ now: NOW });
    // previous 60 * weight 0.5 = 30, current 29 -> weighted 59 <= 60 (admitted).
    // Ignoring the previous bucket would report remaining 31, not 1.
    const limiter = limiterWith([["cur", "29"], ["prev", "60"], 1]);

    const result = await limiter.limit(KEY, RULE);

    expect(result).toEqual({ success: true, limit: 60, remaining: 1, resetSeconds: 30 });
  });

  it("denies a boundary-straddling burst whose weighted total exceeds the limit", async () => {
    vi.useFakeTimers({ now: NOW });
    // previous 60 * weight 0.5 = 30, current 31 -> weighted 61 > 60 (denied).
    // Ignoring the previous bucket would report remaining 29, not 0.
    const limiter = limiterWith([["cur", "31"], ["prev", "60"], 0]);

    const result = await limiter.limit(KEY, RULE);

    expect(result).toEqual({ success: false, limit: 60, remaining: 0, resetSeconds: 30 });
  });

  it("weights the previous bucket by the elapsed fraction of the window", async () => {
    // At the very start of a window (elapsed 0) the previous bucket carries its
    // full weight: previous 60 * 1.0 = 60, current 1 -> weighted 61 (denied).
    vi.useFakeTimers({ now: 1_500_000 });
    const limiter = limiterWith([["cur", "1"], ["prev", "60"], 0]);

    const result = await limiter.limit(KEY, RULE);

    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
    // elapsed is 0, so the window resets a full window from now.
    expect(result.resetSeconds).toBe(60);
  });

  it("treats an empty previous bucket as zero rather than failing", async () => {
    vi.useFakeTimers({ now: NOW });
    // previousFields `[]` is the documented "no previous bucket yet" result;
    // the weighted total is then just the current count.
    const limiter = limiterWith([["cur", "5"], [], 1]);

    const result = await limiter.limit(KEY, RULE);

    expect(result).toEqual({ success: true, limit: 60, remaining: 55, resetSeconds: 30 });
  });
});

describe("upstashRateLimiter — non-numeric and malformed responses fail, never silently allow", () => {
  it("throws when the previous bucket count is non-numeric", async () => {
    vi.useFakeTimers({ now: NOW });
    const limiter = limiterWith([["cur", "1"], ["prev", "not-a-number"], 1]);

    await expect(limiter.limit(KEY, RULE)).rejects.toThrow(/non-numeric/);
  });

  it("throws when the current bucket count is non-numeric", async () => {
    vi.useFakeTimers({ now: NOW });
    const limiter = limiterWith([["cur", "not-a-number"], ["prev", "3"], 1]);

    await expect(limiter.limit(KEY, RULE)).rejects.toThrow(/non-numeric/);
  });

  it("throws when the response does not match the Upstash result shape", async () => {
    vi.useFakeTimers({ now: NOW });
    const limiter = upstashRateLimiter({
      url: URL,
      token: TOKEN,
      fetch: stubFetch({ not: "an-upstash-envelope" }).fetch,
    });

    await expect(limiter.limit(KEY, RULE)).rejects.toThrow(/did not match the expected shape/);
  });
});

describe("upstashRateLimiter — wire contract", () => {
  it("sends one authenticated EVAL with the class key, rule and clock reading", async () => {
    vi.useFakeTimers({ now: NOW });
    const stub = stubFetch({ result: [["cur", "1"], [], 1] });
    const limiter = upstashRateLimiter({ url: URL, token: TOKEN, fetch: stub.fetch });

    await limiter.limit(KEY, RULE);

    expect(stub.requests).toHaveLength(1);
    const [request] = stub.requests;
    expect(request?.input).toBe(URL);
    expect(request?.init.method).toBe("POST");
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);

    const command = request?.body as readonly unknown[];
    expect(command[0]).toBe("EVAL");
    // The script must implement the two-bucket weighted window, not a plain
    // fixed-window INCR: both bucket keys and the elapsed weight are present.
    expect(String(command[1])).toContain("previousKey");
    expect(String(command[1])).toContain("weight");
    // KEYS[1] is the namespaced key; ARGV carry limit, window seconds and now.
    expect(command[3]).toBe(KEY);
    expect(command[4]).toBe("60");
    expect(command[5]).toBe("60");
    expect(command[6]).toBe(String(NOW));
  });
});
