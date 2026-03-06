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
});
