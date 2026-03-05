import { describe, expect, it } from "vitest";

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
});
