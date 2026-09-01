---
'@wyw-in-js/transform': patch
---

Reload invalidated evaluation modules even when their importing module's source is unchanged. Evaluation diagnostics now use schema version 2 to distinguish invalidation-driven resends from initial module loads and count module reset signals.
