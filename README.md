# valet-core

valet-core is a Bun/TypeScript plugin-based assistant platform: a headless valet process that
loads plugins from disk and orchestrates them. It provides the kernel (event bus, SQLite store,
scopes, lifecycle) and a JSON-only HTTP/WebSocket control plane. It serves no UI.

## Getting started

```sh
bun install
bun test
bun packages/core/src/cli.ts start
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the normative specification.

## Rules

- **Caller identity is stamped by core.** Every emit, hook event, store write and scope call
  carries a `Caller` whose `plugin` is set by core from the plugin's own `ctx` — a plugin can
  never forge it. Any before hook may `deny(reason)`; the denial is reported with
  `by` = the denying plugin id.
- **The control plane port is for control only.** `Bun.serve` (default `127.0.0.1:7417`)
  serves JSON/MCP/webhooks: `/` returns a JSON status doc, `/api/core/*` the core REST API,
  `/ws` the multiplexed WebSocket, `/plugins/<id>/*` plugin routes. No static files, no HTML
  (plugin `text/html` responses become 500), and every response carries
  `Content-Security-Policy: default-src 'none'`.
