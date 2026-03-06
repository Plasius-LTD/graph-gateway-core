import type {
  CacheEnvelope,
  CachePolicy,
  CacheStore,
  GraphNodeResult,
  GraphQuery,
  GraphQueryResult,
  JsonValue,
  ResolverRequest,
  ServiceResolver,
  TelemetrySink,
} from "@plasius/graph-contracts";
import {
  DEFAULT_HARD_TTL_SECONDS,
  DEFAULT_SCHEMA_VERSION,
  DEFAULT_SOFT_TTL_SECONDS,
} from "@plasius/graph-contracts";

export interface CircuitBreakerHooks {
  canRequest?(resolver: string): boolean | Promise<boolean>;
  onSuccess?(resolver: string): void | Promise<void>;
  onFailure?(resolver: string, error: unknown): void | Promise<void>;
}

export interface GraphGatewayOptions {
  resolver: ServiceResolver;
  cacheStore?: CacheStore;
  telemetry?: TelemetrySink;
  policy?: Partial<CachePolicy>;
  now?: () => number;
  schemaVersion?: string;
  timeoutMs?: number;
  retryAttempts?: number;
  retryBudgetMs?: number;
  maxFanout?: number;
  circuitBreaker?: CircuitBreakerHooks;
}

interface ExecutedRequest {
  request: ResolverRequest;
  node: GraphNodeResult;
  error?: GraphQueryResult["errors"][number];
  staleServed: boolean;
}

class CircuitOpenError extends Error {
  public readonly resolver: string;

  public constructor(resolver: string) {
    super(`Circuit open for resolver ${resolver}`);
    this.name = "CircuitOpenError";
    this.resolver = resolver;
  }
}

export class GraphGateway {
  private readonly resolver: ServiceResolver;
  private readonly cacheStore?: CacheStore;
  private readonly telemetry?: TelemetrySink;
  private readonly now: () => number;
  private readonly schemaVersion: string;
  private readonly policy: CachePolicy;
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryBudgetMs: number;
  private readonly maxFanout: number;
  private readonly circuitBreaker?: CircuitBreakerHooks;

  public constructor(options: GraphGatewayOptions) {
    this.resolver = options.resolver;
    this.cacheStore = options.cacheStore;
    this.telemetry = options.telemetry;
    this.now = options.now ?? (() => Date.now());
    this.schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
    this.policy = {
      softTtlSeconds: options.policy?.softTtlSeconds ?? DEFAULT_SOFT_TTL_SECONDS,
      hardTtlSeconds: options.policy?.hardTtlSeconds ?? DEFAULT_HARD_TTL_SECONDS,
    };
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.retryAttempts = Math.max(1, options.retryAttempts ?? 2);
    this.retryBudgetMs = Math.max(this.timeoutMs, options.retryBudgetMs ?? this.timeoutMs * this.retryAttempts);
    this.maxFanout = Math.max(1, options.maxFanout ?? 4);
    this.circuitBreaker = options.circuitBreaker;
  }

  public async execute(query: GraphQuery): Promise<GraphQueryResult> {
    const started = this.now();
    const results: GraphQueryResult["results"] = {};
    const errors: GraphQueryResult["errors"] = [];
    let partial = false;
    let stale = false;

    const executedRequests = await this.mapWithConcurrency(
      query.requests,
      this.maxFanout,
      async (request) => this.executeRequest(request, query.traceId, started),
    );

    for (const executedRequest of executedRequests) {
      results[executedRequest.request.key] = executedRequest.node;
      if (executedRequest.error) {
        errors.push(executedRequest.error);
        partial = true;
      }
      if (executedRequest.staleServed) {
        stale = true;
      }
    }

    const completedAt = this.now();
    this.telemetry?.metric({
      name: "graph.execute.latency",
      value: completedAt - started,
      unit: "ms",
    });

    return {
      queryId: query.id,
      partial,
      stale,
      generatedAtEpochMs: completedAt,
      results,
      errors,
    };
  }

  private async resolveWithRetry(request: ResolverRequest, traceId?: string): Promise<GraphNodeResult> {
    let lastError: unknown;
    const started = this.now();

    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      if (attempt > 1 && this.now() - started >= this.retryBudgetMs) {
        break;
      }

      if (this.circuitBreaker?.canRequest) {
        const canRequest = await this.circuitBreaker.canRequest(request.resolver);
        if (!canRequest) {
          throw new CircuitOpenError(request.resolver);
        }
      }

      const resolveStarted = this.now();
      try {
        const resolved = await this.withTimeout(
          this.resolver.resolve(request, {
            traceId,
            timeoutMs: this.timeoutMs,
            attempts: attempt,
          }),
          this.timeoutMs,
        );

        await this.circuitBreaker?.onSuccess?.(request.resolver);
        this.telemetry?.metric({
          name: "graph.resolve.latency",
          value: this.now() - resolveStarted,
          unit: "ms",
          tags: {
            resolver: request.resolver,
            attempt: String(attempt),
          },
        });
        return resolved;
      } catch (error) {
        lastError = error;
        await this.circuitBreaker?.onFailure?.(request.resolver, error);
        this.telemetry?.metric({
          name: "graph.resolve.retry",
          value: 1,
          unit: "count",
          tags: {
            resolver: request.resolver,
            attempt: String(attempt),
          },
        });

        if (error instanceof CircuitOpenError) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Resolver timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private buildCacheKey(request: ResolverRequest): string {
    const paramsJson = request.params ? JSON.stringify(request.params) : "";
    return `${request.resolver}:${request.key}:${paramsJson}`;
  }

  private toNodeResultFromCache(key: string, cached: CacheEnvelope<JsonValue>, stale: boolean): GraphNodeResult {
    return {
      key,
      data: cached.value,
      stale,
      version: cached.version,
      fetchedAtEpochMs: cached.fetchedAtEpochMs,
      tags: cached.tags,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown gateway error";
  }

  private errorCategory(error: unknown): string {
    if (error instanceof CircuitOpenError) {
      return "circuit_open";
    }

    if (error instanceof Error && error.message.startsWith("Resolver timeout")) {
      return "timeout";
    }

    return "upstream";
  }

  private async executeRequest(request: ResolverRequest, traceId: string | undefined, started: number): Promise<ExecutedRequest> {
    const cacheKey = this.buildCacheKey(request);
    const cached = this.cacheStore ? await this.cacheStore.get<JsonValue>(cacheKey) : null;
    const cachedAgeMs = cached ? started - cached.fetchedAtEpochMs : Number.POSITIVE_INFINITY;
    const softTtlMs = this.policy.softTtlSeconds * 1000;
    const hardTtlMs = this.policy.hardTtlSeconds * 1000;

    if (cached && cachedAgeMs <= softTtlMs) {
      this.telemetry?.metric({
        name: "graph.cache.outcome",
        value: 1,
        unit: "count",
        tags: {
          resolver: request.resolver,
          outcome: "fresh_hit",
        },
      });
      return {
        request,
        node: this.toNodeResultFromCache(request.key, cached, false),
        staleServed: false,
      };
    }

    this.telemetry?.metric({
      name: "graph.cache.outcome",
      value: 1,
      unit: "count",
      tags: {
        resolver: request.resolver,
        outcome: cached ? "stale_hit" : "miss",
      },
    });

    try {
      const resolved = await this.resolveWithRetry(request, traceId);
      if (this.cacheStore && resolved.error === undefined && resolved.data !== null) {
        const envelope: CacheEnvelope<JsonValue> = {
          key: cacheKey,
          value: resolved.data,
          fetchedAtEpochMs: this.now(),
          policy: this.policy,
          version: resolved.version ?? this.now(),
          schemaVersion: this.schemaVersion,
          source: request.resolver,
          tags: resolved.tags,
        };

        await this.cacheStore.set(cacheKey, envelope, {
          ttlSeconds: this.policy.hardTtlSeconds,
        });
      }

      return {
        request,
        node: resolved,
        staleServed: false,
      };
    } catch (error) {
      if (cached && cachedAgeMs <= hardTtlMs) {
        this.telemetry?.metric({ name: "graph.stale_served", value: 1, unit: "count" });
        return {
          request,
          node: this.toNodeResultFromCache(request.key, cached, true),
          error: {
            code: "UPSTREAM_FAILED_STALE_SERVED",
            message: this.errorMessage(error),
            retryable: true,
          },
          staleServed: true,
        };
      }

      const category = this.errorCategory(error);
      const message = this.errorMessage(error);
      this.telemetry?.metric({
        name: "graph.upstream.error",
        value: 1,
        unit: "count",
        tags: {
          resolver: request.resolver,
          category,
        },
      });
      this.telemetry?.error({
        message,
        source: request.resolver,
        code: "UPSTREAM_FAILED",
        tags: {
          category,
        },
      });

      return {
        request,
        node: {
          key: request.key,
          data: null,
          stale: false,
          tags: request.tags ?? [],
          error: {
            code: "UPSTREAM_FAILED",
            message,
            retryable: true,
          },
        },
        error: {
          code: "UPSTREAM_FAILED",
          message,
          retryable: true,
        },
        staleServed: false,
      };
    }
  }

  private async mapWithConcurrency<T, TResult>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<TResult>,
  ): Promise<TResult[]> {
    if (items.length === 0) {
      return [];
    }

    const results = new Array<TResult>(items.length);
    let index = 0;
    const workerCount = Math.min(concurrency, items.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const current = index;
          index += 1;
          if (current >= items.length) {
            return;
          }
          results[current] = await worker(items[current] as T, current);
        }
      }),
    );

    return results;
  }
}
