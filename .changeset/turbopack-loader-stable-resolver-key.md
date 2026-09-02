---
'@wyw-in-js/turbopack-loader': minor
'@wyw-in-js/transform': minor
---

Reuse the Turbopack eval child process across files without sharing resolver or transform-cache semantics between loader invocations. Switching resolver semantics now recreates the runner's VM context and clears its WyW-managed modules and broker caches while retaining the child process, so concurrent server/client transforms of the same file cannot resolve through each other's loader context or observe top-level globals created by the other's evaluated modules. Node built-ins, environment values, and external module instances remain process-scoped. Advanced integrations can opt into full cache, module, and VM-context reuse with a `resolverScopeKey` only when the complete transform and eval configuration, aliases, conditions, and compilation graph semantics match. Importer paths are also stripped of query and hash before deriving the resolve context.
