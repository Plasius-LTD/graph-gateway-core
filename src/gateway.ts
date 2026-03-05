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

export interface GraphGatewayOptions {
  resolver: ServiceResolver;
  cacheStore?: CacheStore;
  telemetry?: TelemetrySink;
  policy?: Partial<CachePolicy>;
  now?: () => number;
  schemaVersion?: string;
  timeoutMs?: number;
  retryAttempts?: number;
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
  }

  public async execute(query: GraphQuery): Promise<GraphQueryResult> {
    const started = this.now();
    const results: GraphQueryResult["results"] = {};
    const errors: GraphQueryResult["errors"] = [];
    let partial = false;
    let stale = false;

    for (const request of query.requests) {
      const cacheKey = this.buildCacheKey(request);
      const cached = this.cacheStore ? await this.cacheStore.get<JsonValue>(cacheKey) : null;
      const cachedAgeMs = cached ? started - cached.fetchedAtEpochMs : Number.POSITIVE_INFINITY;
      const softTtlMs = this.policy.softTtlSeconds * 1000;
      const hardTtlMs = this.policy.hardTtlSeconds * 1000;

      if (cached && cachedAgeMs <= softTtlMs) {
        results[request.key] = this.toNodeResultFromCache(request.key, cached, false);
        continue;
      }

      try {
        const resolved = await this.resolveWithRetry(request, query.traceId);
        results[request.key] = resolved;
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
      } catch (error) {
        if (cached && cachedAgeMs <= hardTtlMs) {
          stale = true;
          partial = true;
          results[request.key] = this.toNodeResultFromCache(request.key, cached, true);
          errors.push({
            code: "UPSTREAM_FAILED_STALE_SERVED",
            message: this.errorMessage(error),
            retryable: true,
          });
          this.telemetry?.metric({ name: "graph.stale_served", value: 1, unit: "count" });
          continue;
        }

        partial = true;
        const message = this.errorMessage(error);
        errors.push({
          code: "UPSTREAM_FAILED",
          message,
          retryable: true,
        });
        results[request.key] = {
          key: request.key,
          data: null,
          stale: false,
          tags: request.tags ?? [],
          error: {
            code: "UPSTREAM_FAILED",
            message,
            retryable: true,
          },
        };
        this.telemetry?.error({
          message,
          source: request.resolver,
          code: "UPSTREAM_FAILED",
        });
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

    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await this.withTimeout(
          this.resolver.resolve(request, {
            traceId,
            timeoutMs: this.timeoutMs,
            attempts: attempt,
          }),
          this.timeoutMs,
        );
      } catch (error) {
        lastError = error;
        this.telemetry?.metric({
          name: "graph.resolve.retry",
          value: 1,
          unit: "count",
          tags: {
            resolver: request.resolver,
            attempt: String(attempt),
          },
        });
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
}
