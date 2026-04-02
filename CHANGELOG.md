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
