---
'@wyw-in-js/transform': patch
---

Keep later static interpolations resolvable after read-only calls consume local object values or constructed arguments containing primitive imports. Specific opaque calls and constructors can now be declared side-effect-free with a `/*#__PURE__*/` or `/*@__PURE__*/` annotation; static evaluation errors point to eligible call sites and show the exact placement.
