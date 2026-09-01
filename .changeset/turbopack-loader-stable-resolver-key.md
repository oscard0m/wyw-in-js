---
'@wyw-in-js/turbopack-loader': patch
---

Pass a stable `asyncResolveKey` so the eval broker, and the runner child process it owns, survive across files instead of being disposed and respawned for every transformed file. The loader keeps a process-wide resolver scope mirroring webpack-loader's per-compiler scope: each invocation registers its per-file resolver by resource path, removed again when that invocation settles so finished loader contexts are not retained, and a stable dispatcher routes eval-time resolutions to the loader context of the file being transformed. Importer paths are also stripped of query and hash before deriving the resolve context, which previously produced a broken directory for `?__wyw_css` requests. This takes eval-runner spawns from one per transformed file, per pass, down to a flat handful for the whole build, which roughly halved cold compile time on a large Next.js Turbopack app.
