---
'@wyw-in-js/transform': patch
---

Stop reporting a false `PrevalPayload disagreement` for `styled(X)` targets whose evaluated and static values describe the same selector chain. The hybrid evaluator spells a proven opaque component as a bare function stub, while the static resolver spells it as `null`; these representations are now treated as equivalent only for helpers that the static analysis identified as opaque and for matching generated `__wyw_meta` chains. Static precedence is unchanged, and malformed metadata, extra value fields, or genuine selector drift are still reported.
