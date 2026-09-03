import { SourceMapConsumer, SourceMapGenerator } from 'source-map';

import { remapSourceMapLines } from '../source-map';

const buildMap = (sourceRoot?: string) => {
  const generator = new SourceMapGenerator({ file: 'entry.css', sourceRoot });
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 3, column: 14 },
    source: 'entry.tsx',
    name: '.a',
  });
  generator.addMapping({
    generated: { line: 3, column: 0 },
    original: { line: 7, column: 15 },
    source: 'entry.tsx',
    name: '.b',
  });
  generator.setSourceContent('entry.tsx', 'const a = 1;');
  return generator.toString();
};

const mappings = async (sourceMapText: string) => {
  const consumer = await new SourceMapConsumer(JSON.parse(sourceMapText));
  try {
    const result: unknown[] = [];
    consumer.eachMapping((mapping) => {
      result.push({
        generatedLine: mapping.generatedLine,
        originalLine: mapping.originalLine,
        source: mapping.source,
        name: mapping.name,
      });
    });
    return result;
  } finally {
    consumer.destroy();
  }
};

describe('remapSourceMapLines', () => {
  it('shifts generated lines and keeps everything else', async () => {
    const remapped = await remapSourceMapLines(buildMap(), [
      { delta: 2, line: 1 },
    ]);
    const raw = JSON.parse(remapped);

    expect(raw.file).toBe('entry.css');
    expect(raw.sources).toEqual(['entry.tsx']);
    expect(raw.sourcesContent).toEqual(['const a = 1;']);
    expect(await mappings(remapped)).toEqual([
      { generatedLine: 1, originalLine: 3, source: 'entry.tsx', name: '.a' },
      { generatedLine: 5, originalLine: 7, source: 'entry.tsx', name: '.b' },
    ]);
  });

  it('does not apply sourceRoot twice', async () => {
    const remapped = await remapSourceMapLines(buildMap('/root'), [
      { delta: 1, line: 1 },
    ]);
    const raw = JSON.parse(remapped);

    expect(raw.sourceRoot).toBeUndefined();
    expect(raw.sources).toEqual(['/root/entry.tsx']);
    expect(raw.sourcesContent).toEqual(['const a = 1;']);
  });

  it('returns the input unchanged when there is nothing to remap', async () => {
    const map = buildMap();
    const sections = JSON.stringify({ version: 3, sections: [] });
    const sourceless = JSON.stringify({
      version: 3,
      file: 'a.css',
      sources: ['entry.tsx'],
      sourcesContent: ['const a = 1;'],
      names: [],
      mappings: 'A',
    });
    const deltas = [{ delta: 1, line: 1 }];

    expect(await remapSourceMapLines(map, [])).toBe(map);
    expect(await remapSourceMapLines('', deltas)).toBe('');
    expect(await remapSourceMapLines(sections, deltas)).toBe(sections);
    expect(await remapSourceMapLines(sourceless, deltas)).toBe(sourceless);
  });
});
