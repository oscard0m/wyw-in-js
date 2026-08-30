import { SourceMapGenerator, type RawSourceMap } from 'source-map';

import { remapPureCallHints } from '../pureCallHintSourceMap';

describe('PURE call hint source maps', () => {
  it('does not reuse an earlier mapping for an unmapped call on the same line', () => {
    const callSource = 'factory()(space)';
    const originalSource = `${callSource}; ${callSource};`;
    const generatedSource = originalSource;
    const secondCallStart = generatedSource.lastIndexOf(callSource);
    const sourceMap = new SourceMapGenerator({ file: '/generated.js' });
    sourceMap.addMapping({
      generated: { column: 0, line: 1 },
      original: { column: 0, line: 1 },
      source: '/source.ts',
    });
    sourceMap.setSourceContent('/source.ts', originalSource);

    expect(
      remapPureCallHints(
        [
          {
            callColumn: secondCallStart,
            callEnd: secondCallStart + callSource.length,
            callFilename: '/generated.js',
            callLine: 1,
            callSource,
            callStart: secondCallStart,
            expressionName: '_exp',
            expressionSource: 'space.medium',
          },
        ],
        sourceMap.toJSON() as RawSourceMap
      )
    ).toEqual([]);
  });
});
