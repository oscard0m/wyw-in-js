---
'@wyw-in-js/transform': patch
---

Keep answering resolve and load requests from a fire-and-forget dynamic import after its evaluation has finished. The eval broker scoped request liveness to the entrypoint that was active when the request arrived, so a `RESOLVE` sent right before `EVAL_RESULT` and delivered in the same stdout chunk was silently dropped once the eval completed. The runner then waited for that answer forever and the next load for the same semantic session never started, which surfaced as sporadic eval timeouts on busy machines. Liveness is now scoped by the semantic session (runner, session id, request epoch, services and cache generation); the next entrypoint still invalidates stale continuations through the request epoch.
