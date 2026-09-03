---
'@wyw-in-js/turbopack-loader': patch
---

Emit every member of a selector list as its own `:global()` rule. lightningcss resolves `:global(a), :global(b)` into `:is(a, b)` ([lightningcss#1032](https://github.com/parcel-bundler/lightningcss/issues/1032), [#1079](https://github.com/parcel-bundler/lightningcss/issues/1079), proposed fix in [#1231](https://github.com/parcel-bundler/lightningcss/pull/1231)), which is not equivalent to the list: pseudo-elements are invalid inside `:is()` (every `&::before, &::after { ... }` rule was silently dropped by browsers) and `:is()` takes the specificity of its most specific member, which changed the cascade for lists with unequal members.

Narrowing browserslist is not a workaround: the fold happens for any target with `:is()` support (Chrome 88+). There is no toggle either, because the split output stays valid once the fold is fixed upstream, and lightningcss already merges identical adjacent rules back into a list under `minify` - returning to the list form is a size optimisation, not a correctness fix.
