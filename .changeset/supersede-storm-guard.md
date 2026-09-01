---
'@wyw-in-js/transform': patch
---

Break an unbounded supersede loop that can grow a bundler process until it runs out of memory. When a dependency's entrypoint is evicted while it is still processing, no dependency snapshot is taken and the file is left with a content hash but no known graph. `didDependencyChange` then reports that file as changed on every check, which invalidates its parents, supersedes them with an identical `only`, and re-arms the same check on the next root request. Nothing in the loop requires a byte on disk to change.

Three changes. An unknown dependency graph is now reported as changed only once and afterwards falls back to content-hash verification of the file itself. Evicting an entrypoint mid-processing no longer discards a complete snapshot taken at an earlier eviction, since a stale but complete graph still answers dependency checks. And `Entrypoint.create` carries a defensive rate guard that stops non-widening supersedes past 100 within a sliding 10s window, logging loudly instead of looping. The guard only reuses the cached entrypoint while the requested code is byte-identical to it, so genuinely changed code keeps superseding and can never be served stale.
