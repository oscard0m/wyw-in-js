---
'@wyw-in-js/webpack-loader': patch
---

Keep extracted CSS available when Webpack or Rspack rebuilds generated CSS from persistent cache, when Rspack evaluates loaders in separate or parallel module graphs, when multiple object cache providers process the same resource, and when Windows reports the same file with different path spellings.
