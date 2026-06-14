# Changelog

All notable changes to this project will be documented in this file.

The format is based on **[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)**, and this project adheres to **[Semantic Versioning](https://semver.org/spec/v2.0.0.html)**.

---

## [Unreleased]

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.8] - 2026-06-14

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.7] - 2026-06-01

- **Added**
  - (placeholder)

- **Changed**
  - Added opt-in `isRetryableError` support so callers can restrict GraphGateway retries to transient failures while keeping the existing retry-budget/backoff controls.

- **Fixed**
  - Changed default retry behavior to enforce transient-only retries (`error.transient`/`error.retryable`) so non-transient resolver failures fail fast by default.
  - Added a failure-injection regression test suite to cap per-request retry amplification under transient burst conditions.

- **Security**
  - (placeholder)

## [0.1.6] - 2026-05-13

- **Added**
  - (placeholder)

- **Changed**
  - Refreshed dependencies to the latest stable published versions.
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.5] - 2026-05-13

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.4] - 2026-04-21

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.3] - 2026-04-02

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.2] - 2026-03-06

- **Added**
  - Explicit fanout control with `maxFanout` query execution concurrency.
  - Circuit breaker hook contract (`canRequest`, `onSuccess`, `onFailure`).
  - Retry budget control (`retryBudgetMs`) for bounded retry behavior.
  - Retry backoff + jitter controls (`retryBackoffMs`, `retryJitterRatio`).
  - Telemetry dimensions for cache outcome and upstream error categories.
  - Fast-fail query payload validation at gateway boundary.
  - Tests for fanout limits, circuit breaker behavior, retry budget, and telemetry tags.
  - ADR-0003 for read orchestration resilience controls.

- **Changed**
  - README now documents resilience and observability options.

- **Fixed**
  - N/A

- **Security**
  - N/A

## [0.1.1] - 2026-03-05

### Added

- Initial package scaffolding.
- Initial source implementation and baseline tests.
- CI/CD workflow baseline for GitHub Actions and npm publish path.


[0.1.1]: https://github.com/Plasius-LTD/graph-gateway-core/releases/tag/v0.1.1
[0.1.2]: https://github.com/Plasius-LTD/graph-gateway-core/releases/tag/v0.1.2
[0.1.3]: https://github.com/Plasius-LTD/graph-gateway-core/releases/tag/v0.1.3
[0.1.4]: https://github.com/Plasius-LTD/graph-gateway-core/releases/tag/v0.1.4
[0.1.5]: https://github.com/Plasius-LTD/graph-gateway-core/releases/tag/v0.1.5
[0.1.6]: https://github.com/Plasius-LTD/graph-gateway-core/releases/tag/v0.1.6
[0.1.7]: https://github.com/Plasius-LTD/graph-gateway-core/releases/tag/v0.1.7
[0.1.8]: https://github.com/Plasius-LTD/graph-gateway-core/releases/tag/v0.1.8
