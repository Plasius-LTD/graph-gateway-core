import { describe, expect, it, vi } from "vitest";

import type { CacheEnvelope, CacheStore, ResolverRequest } from "@plasius/graph-contracts";
import { GraphGateway } from "../src/gateway.js";

class InMemoryCache implements CacheStore {
  private readonly data = new Map<string, CacheEnvelope<unknown>>();

  async get<T>(key: string): Promise<CacheEnvelope<T> | null> {
    return (this.data.get(key) as CacheEnvelope<T> | undefined) ?? null;
  }

  async mget<T>(keys: string[]): Promise<Array<CacheEnvelope<T> | null>> {
    return keys.map((key) => (this.data.get(key) as CacheEnvelope<T> | undefined) ?? null);
  }

  async set<T>(key: string, envelope: CacheEnvelope<T>): Promise<void> {
    this.data.set(key, envelope as CacheEnvelope<unknown>);
  }

  async mset<T>(entries: Array<{ key: string; envelope: CacheEnvelope<T> }>): Promise<void> {
    for (const entry of entries) {
      this.data.set(entry.key, entry.envelope as CacheEnvelope<unknown>);
    }
  }

  async invalidate(keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.data.delete(key)) {
        removed += 1;
      }
    }

    return removed;
  }

  async compareAndSet<T>(
    key: string,
    nextEnvelope: CacheEnvelope<T>,
    _expectedVersion?: string | number,
  ): Promise<boolean> {
    this.data.set(key, nextEnvelope as CacheEnvelope<unknown>);
    return true;
  }
}

describe("GraphGateway", () => {
  it("caches successful resolver responses", async () => {
    const cache = new InMemoryCache();
    let calls = 0;

    const resolver = {
      async resolve(request: ResolverRequest) {
        calls += 1;
        return {
          key: request.key,
          data: { name: "alice" },
          stale: false,
          version: 1,
          tags: ["user"],
        };
      },
    };

    const gateway = new GraphGateway({ resolver, cacheStore: cache, timeoutMs: 100 });
    const query = {
      requests: [{ resolver: "user.profile", key: "user:1" }],
    };

    await gateway.execute(query);
    await gateway.execute(query);

    expect(calls).toBe(1);
  });

  it("serves stale cache on resolver failure within hard ttl", async () => {
    const now = 1_000_000;
    const cache = new InMemoryCache();

    await cache.set("user.profile:user:1:", {
      key: "user.profile:user:1:",
      value: { name: "cached" },
      fetchedAtEpochMs: now,
      policy: { softTtlSeconds: 1, hardTtlSeconds: 60 },
      version: 1,
      schemaVersion: "1",
      source: "user.profile",
      tags: ["user"],
    });

    const resolver = {
      async resolve() {
        throw new Error("service unavailable");
      },
    };

    const gateway = new GraphGateway({
      resolver,
      cacheStore: cache,
      now: () => now + 5_000,
      policy: { softTtlSeconds: 1, hardTtlSeconds: 60 },
      timeoutMs: 100,
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(result.stale).toBe(true);
    expect(result.results["user:1"]?.data).toEqual({ name: "cached" });
    expect(result.errors[0]?.code).toBe("UPSTREAM_FAILED_STALE_SERVED");
  });

  it("limits resolver concurrency using max fanout controls", async () => {
    let inFlight = 0;
    let peakConcurrency = 0;

    const resolver = {
      async resolve(request: ResolverRequest) {
        inFlight += 1;
        peakConcurrency = Math.max(peakConcurrency, inFlight);
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
        inFlight -= 1;

        return {
          key: request.key,
          data: { id: request.key },
          stale: false,
          tags: request.tags ?? [],
        };
      },
    };

    const gateway = new GraphGateway({
      resolver,
      maxFanout: 2,
      timeoutMs: 100,
    });

    const result = await gateway.execute({
      requests: [
        { resolver: "profile", key: "1" },
        { resolver: "profile", key: "2" },
        { resolver: "profile", key: "3" },
        { resolver: "profile", key: "4" },
      ],
    });

    expect(result.partial).toBe(false);
    expect(Object.keys(result.results)).toHaveLength(4);
    expect(peakConcurrency).toBeLessThanOrEqual(2);
  });

  it("honors circuit breaker hooks before resolver calls", async () => {
    const resolver = {
      resolve: vi.fn(async (request: ResolverRequest) => ({
        key: request.key,
        data: { id: request.key },
        stale: false,
        tags: request.tags ?? [],
      })),
    };
    const circuitBreaker = {
      canRequest: vi.fn(async () => false),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
    };

    const gateway = new GraphGateway({
      resolver,
      timeoutMs: 10,
      retryAttempts: 1,
      circuitBreaker,
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(result.partial).toBe(true);
    expect(result.errors[0]?.code).toBe("UPSTREAM_FAILED");
    expect(result.errors[0]?.message).toContain("Circuit open");
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(circuitBreaker.onSuccess).not.toHaveBeenCalled();
    expect(circuitBreaker.onFailure).not.toHaveBeenCalled();
  });

  it("stops retrying when retry budget is exhausted", async () => {
    const resolver = {
      resolve: vi.fn(async (): Promise<never> => {
        return await new Promise(() => {
          // intentionally unresolved to force timeout
        });
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      timeoutMs: 1,
      retryAttempts: 5,
      retryBudgetMs: 1,
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(result.partial).toBe(true);
    expect(result.errors[0]?.message).toContain("Resolver timeout");
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it("emits cache outcome and upstream error telemetry categories", async () => {
    const telemetry = {
      metric: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };

    const gateway = new GraphGateway({
      resolver: {
        async resolve() {
          throw new Error("service unavailable");
        },
      },
      telemetry,
      retryAttempts: 1,
      timeoutMs: 10,
    });

    await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "graph.cache.outcome",
        tags: expect.objectContaining({ outcome: "miss", resolver: "user.profile" }),
      }),
    );
    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "graph.upstream.error",
        tags: expect.objectContaining({ category: "upstream", resolver: "user.profile" }),
      }),
    );
    expect(telemetry.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "UPSTREAM_FAILED",
        tags: expect.objectContaining({ category: "upstream" }),
      }),
    );
  });

  it("fails fast on invalid query payload", async () => {
    const gateway = new GraphGateway({
      resolver: {
        async resolve() {
          throw new Error("should not run");
        },
      },
    });

    await expect(
      gateway.execute({
        requests: "bad",
      } as unknown as any),
    ).rejects.toThrow("Invalid graph query payload");
  });

  it("applies bounded retry backoff with jitter metric emission", async () => {
    const telemetry = {
      metric: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };
    const gateway = new GraphGateway({
      resolver: {
        async resolve() {
          const error = new Error("transient");
          Object.assign(error, { transient: true });
          throw error;
        },
      },
      telemetry,
      timeoutMs: 5,
      retryAttempts: 2,
      retryBudgetMs: 100,
      retryBackoffMs: 1,
      retryJitterRatio: 0,
    });

    await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({ name: "graph.resolve.backoff_ms", value: 1 }),
    );
  });

  it("retries transient failures by default", async () => {
    const telemetry = {
      metric: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };
    const resolver = {
      resolve: vi.fn(async () => {
        const error = new Error("retryable failure");
        Object.assign(error, { transient: true });
        throw error;
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      telemetry,
      timeoutMs: 5,
      retryAttempts: 2,
      retryBudgetMs: 100,
      retryBackoffMs: 0,
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(result.partial).toBe(true);
    expect(result.errors[0]?.message).toContain("retryable failure");
    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "graph.resolve.retry",
        tags: expect.objectContaining({ attempt: "1" }),
      }),
    );
    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({ name: "graph.upstream.error", value: 1 }),
    );
  });

  it("does not retry non-transient failures by default", async () => {
    const resolver = {
      resolve: vi.fn(async () => {
        throw new Error("permanent failure");
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      timeoutMs: 5,
      retryAttempts: 3,
      retryBudgetMs: 100,
      retryBackoffMs: 0,
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(result.partial).toBe(true);
    expect(result.errors[0]?.message).toContain("permanent failure");
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(result.errors[0]?.retryable).toBe(true);
  });

  it("bounds retry amplification under failure injection across a request batch", async () => {
    const telemetry = {
      metric: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };
    const resolver = {
      resolve: vi.fn(async () => {
        const error = new Error("failure injection");
        Object.assign(error, { transient: true });
        throw error;
      }),
    };
    const requestCount = 5;
    const retryAttempts = 3;

    const gateway = new GraphGateway({
      resolver,
      telemetry,
      timeoutMs: 5,
      retryAttempts,
      retryBudgetMs: 100,
      retryBackoffMs: 0,
      maxFanout: 4,
    });

    await gateway.execute({
      requests: Array.from({ length: requestCount }, (_value, index) => ({
        resolver: "user.profile",
        key: `user:${index}`,
      })),
    });

    expect(resolver.resolve).toHaveBeenCalledTimes(requestCount * retryAttempts);
    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "graph.resolve.retry",
      }),
    );
    expect(
      telemetry.metric.mock.calls.filter((call) => {
        const event = call[0];
        return event.name === "graph.resolve.retry";
      }),
    ).toHaveLength(requestCount * (retryAttempts - 1));
  });

  it("does not retry when default error object marks transient=false", async () => {
    const resolver = {
      resolve: vi.fn(async () => {
        const error = new Error("permanent flag") as Error & { transient?: boolean };
        error.transient = false;
        throw error;
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      timeoutMs: 5,
      retryAttempts: 3,
      retryBudgetMs: 100,
      retryBackoffMs: 0,
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(result.partial).toBe(true);
    expect(result.errors[0]?.message).toContain("permanent flag");
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it("retries when default error object marks retryable=true", async () => {
    const resolver = {
      resolve: vi.fn(async () => {
        const error = new Error("retryable flag") as Error & { retryable?: boolean };
        error.retryable = true;
        throw error;
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      timeoutMs: 5,
      retryAttempts: 2,
      retryBudgetMs: 100,
      retryBackoffMs: 0,
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(result.partial).toBe(true);
    expect(result.errors[0]?.message).toContain("retryable flag");
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
  });

  it("does not retry primitive default errors", async () => {
    const resolver = {
      resolve: vi.fn(async () => {
        // Intentionally throw a non-object to exercise the non-boolean branch.
        throw "primitive failure";
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      timeoutMs: 5,
      retryAttempts: 3,
      retryBudgetMs: 100,
      retryBackoffMs: 0,
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(result.partial).toBe(true);
    expect(result.errors[0]?.message).toContain("Unknown gateway error");
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the retry budget is exhausted", async () => {
    let nowTicks = 0;
    const now = vi.fn(() => {
      nowTicks += 1;
      return nowTicks;
    });
    const resolver = {
      resolve: vi.fn(async () => {
        const error = new Error("budget exhausted failure") as Error & { transient?: boolean };
        error.transient = true;
        throw error;
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      now,
      timeoutMs: 3,
      retryAttempts: 3,
      retryBudgetMs: 3,
      retryBackoffMs: 0,
    });

    await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it("halts retries when no remaining budget can cover the next backoff", async () => {
    const now = vi.fn(() => 0);
    const resolver = {
      resolve: vi.fn(async () => {
        const error = new Error("budget prevented retry") as Error & { transient?: boolean };
        error.transient = true;
        throw error;
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      now,
      timeoutMs: 2,
      retryAttempts: 2,
      retryBudgetMs: 1,
      retryBackoffMs: 20,
      retryJitterRatio: 0,
    });

    await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it("adds jitter when retry jitter amplitude is positive", async () => {
    const telemetry = {
      metric: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };
    const resolver = {
      resolve: vi.fn(async () => {
        const error = new Error("jitter retry") as Error & { transient?: boolean };
        error.transient = true;
        throw error;
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      telemetry,
      now: () => 0,
      timeoutMs: 5,
      retryAttempts: 2,
      retryBudgetMs: 100,
      retryBackoffMs: 10,
      retryJitterRatio: 0.5,
      random: () => 0.5,
    });

    await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(telemetry.metric).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "graph.resolve.backoff_ms",
        value: 13,
      }),
    );
  });

  it("rethrows explicit CircuitOpenError instances from resolver", async () => {
    const probe = new GraphGateway({
      resolver: {
        async resolve() {
          throw new Error("probe");
        },
      },
      circuitBreaker: {
        async canRequest() {
          return false;
        },
      },
      timeoutMs: 5,
      retryAttempts: 1,
    });

    let circuitOpen: Error;
    await (probe as any).resolveWithRetry({ resolver: "user.profile", key: "user:1" }).catch((error: Error) => {
      circuitOpen = error;
    });

    const openError = Object.create(Object.getPrototypeOf(circuitOpen!));
    const resolver = {
      resolve: vi.fn(async () => {
        throw openError;
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      timeoutMs: 5,
      retryAttempts: 1,
    });

    await expect((gateway as any).resolveWithRetry({ resolver: "user.profile", key: "user:1" })).rejects.toBe(
      openError,
    );
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it("returns empty results for queries with no requests", async () => {
    const gateway = new GraphGateway({
      resolver: {
        async resolve() {
          throw new Error("should not execute");
        },
      },
      timeoutMs: 10,
      retryAttempts: 1,
    });

    const result = await gateway.execute({ requests: [] });

    expect(result.results).toEqual({});
    expect(result.errors).toHaveLength(0);
    expect(result.partial).toBe(false);
    expect(result.stale).toBe(false);
  });

  it("retries transient failures when the caller marks them retryable", async () => {
    const resolver = {
      resolve: vi.fn(async (request: ResolverRequest) => {
        if (resolver.resolve.mock.calls.length === 1) {
          const error = new Error("temporary upstream failure");
          Object.assign(error, { transient: true });
          throw error;
        }

        return {
          key: request.key,
          data: { id: request.key },
          stale: false,
          tags: request.tags ?? [],
        };
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      timeoutMs: 5,
      retryAttempts: 2,
      retryBudgetMs: 100,
      retryBackoffMs: 0,
      isRetryableError: (error) =>
        typeof error === "object" && error !== null && "transient" in error,
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(result.partial).toBe(false);
    expect(result.results["user:1"]?.data).toEqual({ id: "user:1" });
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
  });

  it("fails fast on non-retryable resolver errors when a retry predicate is provided", async () => {
    const telemetry = {
      metric: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };
    const resolver = {
      resolve: vi.fn(async (): Promise<never> => {
        const error = new Error("validation failed");
        Object.assign(error, { retryable: false });
        throw error;
      }),
    };

    const gateway = new GraphGateway({
      resolver,
      telemetry,
      timeoutMs: 5,
      retryAttempts: 3,
      retryBudgetMs: 100,
      retryBackoffMs: 0,
      isRetryableError: (error) =>
        typeof error === "object"
        && error !== null
        && "retryable" in error
        && Boolean((error as { retryable?: boolean }).retryable),
    });

    const result = await gateway.execute({
      requests: [{ resolver: "user.profile", key: "user:1" }],
    });

    expect(result.partial).toBe(true);
    expect(result.errors[0]?.message).toContain("validation failed");
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(telemetry.metric).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "graph.resolve.retry" }),
    );
  });
});
