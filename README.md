# @plasius/graph-gateway-core

[![npm version](https://img.shields.io/npm/v/@plasius/graph-gateway-core.svg)](https://www.npmjs.com/package/@plasius/graph-gateway-core)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Plasius-LTD/graph-gateway-core/ci.yml?branch=main&label=build&style=flat)](https://github.com/Plasius-LTD/graph-gateway-core/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/codecov/c/github/Plasius-LTD/graph-gateway-core)](https://codecov.io/gh/Plasius-LTD/graph-gateway-core)
[![License](https://img.shields.io/github/license/Plasius-LTD/graph-gateway-core)](./LICENSE)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-yes-blue.svg)](./CODE_OF_CONDUCT.md)
[![Security Policy](https://img.shields.io/badge/security%20policy-yes-orange.svg)](./SECURITY.md)
[![Changelog](https://img.shields.io/badge/changelog-md-blue.svg)](./CHANGELOG.md)

[![CI](https://github.com/Plasius-LTD/graph-gateway-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Plasius-LTD/graph-gateway-core/actions/workflows/ci.yml)
[![CD](https://github.com/Plasius-LTD/graph-gateway-core/actions/workflows/cd.yml/badge.svg)](https://github.com/Plasius-LTD/graph-gateway-core/actions/workflows/cd.yml)

Read-path graph gateway orchestration core with stale-serving, retry, and timeout controls.

Apache-2.0. ESM + CJS builds. TypeScript types included.

---

## Requirements

- Node.js 24+ (matches `.nvmrc` and CI/CD)
- `@plasius/graph-contracts`

---

## Installation

```bash
npm install @plasius/graph-gateway-core
```

---

## Exports

```ts
import { GraphGateway, type GraphGatewayOptions } from "@plasius/graph-gateway-core";
```

---

## Quick Start

```ts
import { GraphGateway } from "@plasius/graph-gateway-core";

const gateway = new GraphGateway({
  resolver: {
    async resolve(request) {
      return {
        key: request.key,
        data: { id: request.key },
        stale: false,
        tags: request.tags ?? [],
      };
    },
  },
  maxFanout: 8,
  timeoutMs: 750,
  retryAttempts: 2,
  retryBudgetMs: 1_500,
  circuitBreaker: {
    canRequest: async (resolver) => resolver !== "disabled.resolver",
  },
});

const result = await gateway.execute({
  requests: [{ resolver: "user.profile", key: "user:1" }],
});

console.log(result.partial, result.stale);
```

---

## Development

```bash
npm run clean
npm install
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

---

## Resilience and Observability

- Query planning/fanout control via `maxFanout`.
- Retry policy controls:
  - `timeoutMs`
  - `retryAttempts`
  - `retryBudgetMs`
- Circuit breaker hooks:
  - `canRequest`
  - `onSuccess`
  - `onFailure`
- Telemetry events:
  - `graph.execute.latency`
  - `graph.cache.outcome`
  - `graph.resolve.latency`
  - `graph.upstream.error`

---

## Architecture

- Package ADRs: [`docs/adrs`](./docs/adrs)
- Cross-package ADRs: `plasius-ltd-site/docs/adrs/adr-0020` to `adr-0024`

---

## License

Licensed under the [Apache-2.0 License](./LICENSE).
