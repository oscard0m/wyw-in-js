---
'@wyw-in-js/transform': patch
---

Treat opaque calls as capability-bounded during mutation analysis, keeping later static interpolations eligible when direct imported member arguments resolve to immutable primitives. Calls can still invalidate object-valued arguments; ambient writes through globals, closures, or the callee's own imports remain the application author's responsibility.
