---
'@wyw-in-js/transform': minor
---

Keep later static interpolations resolvable when opaque calls receive immutable primitive values or fresh containers built only from them. Specific calls and constructors can also be declared side-effect-free with a `/*#__PURE__*/` or `/*@__PURE__*/` annotation; static evaluation errors point to eligible call sites and show the exact placement.
