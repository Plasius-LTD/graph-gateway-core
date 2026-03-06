# ADR-0003: Read Orchestration Resilience Controls

## Status

- Accepted
- Date: 2026-03-06
- Version: 1.0

## Context

The gateway core must coordinate read fanout across services while protecting upstream dependencies and preserving stale-read availability under failures.

## Decision

- Add explicit fanout concurrency controls (`maxFanout`) for query orchestration.
- Add bounded retry policy with timeout plus retry budget (`retryBudgetMs`).
- Add circuit breaker hooks at the resolver boundary (`canRequest`, `onSuccess`, `onFailure`).
- Emit telemetry for:
  - cache outcomes (fresh hit, stale hit, miss),
  - resolver latency,
  - upstream error category.

## Consequences

- Read behavior is predictable under high fanout and upstream degradation.
- Hosts can plug in environment-specific circuit breaker implementations without infra coupling.
- Observability coverage improves for stale serving and upstream incident triage.
