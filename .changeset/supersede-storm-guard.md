---
'@wyw-in-js/transform': patch
---

Prevent an unbounded supersede loop from growing a bundler process until it runs out of memory without weakening dependency invalidation. If an entrypoint replacement is evicted while it is still processing, retain the last complete dependency snapshot. When no complete graph exists, keep invalidating conservatively and restart transform and evaluation caches before rebuilding, so a warm evaluated module can never hide a changed transitive dependency.

As a final fail-closed safeguard, stop more than 100 identical-source, non-widening supersedes within a true sliding 10 second window with a diagnostic error. Unchanged retries remain blocked instead of reusing stale output; the guard resets after a successful transform, a real source edit, or a quiet window, and cleans up inactive filename counters.
