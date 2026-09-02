---
'@wyw-in-js/transform': patch
---

Run actions and entrypoint lifecycle updates with the services of the transform run that created them, instead of the services captured when an entrypoint first entered a shared cache. This prevents reused entrypoints from applying an earlier importer's filename, source map, output path, warning handler, or event emitter to the current file. Nested actions inherit their parent's run services by default, while internal analysis actions can retain their intentionally isolated cache and telemetry scope.
