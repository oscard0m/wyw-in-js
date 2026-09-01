# `@wyw-in-js/turbopack-loader`

Turbopack-compatible loader for WyW-in-JS.

This package is designed to be used via Next.js `turbopack.rules`.

## Eval resolver modes

`eval.resolver: 'native'` and the native step of `eval.resolver: 'hybrid'` use `oxc-resolver` with automatic
`tsconfig.json` discovery.

When this loader is configured through `@wyw-in-js/nextjs`, string aliases from `turbopack.resolveAlias` or
`experimental.turbo.resolveAlias` are forwarded into native resolver options. Direct `turbopack.rules` usage should mirror
Turbopack-only aliases in `oxcOptions.resolver.alias` or use `hybrid` so the bundler fallback can resolve them.

By default the loader reuses the eval child process but isolates transform
caches, resolver results, WyW-managed evaluated modules, and top-level globals
created in their VM context for every invocation. This is necessary because
Turbopack's loader API does not expose a compilation identity that
distinguishes server, client, and edge resolver graphs. Node host state remains
process-scoped, including built-ins, `process.env`, external CommonJS
`require.cache` entries, and external ESM module instances.

`resolverScopeKey` opts into transform-cache, evaluated-module, and VM-context
reuse. Use it only when every invocation with that key has identical complete
transform and eval configuration, aliases, conditions, and graph semantics.
Use different keys for scopes such as server, client, and edge builds, and use
a finite, stable set of keys because their state lives for the loader module's
lifetime.

## Output strategy

When a file produces CSS, the loader:

- writes `*.wyw-in-js.module.css` next to the source file (only if content changed, atomically);
- injects `import './<file>.wyw-in-js.module.css'` into the transformed module;
- wraps selectors in `:global(...)` so Next's CSS Modules pipeline does not rename WyW-generated class names.
