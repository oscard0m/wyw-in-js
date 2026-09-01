import {
  originalPositionFor,
  sourceContentFor,
  traceSegment,
  TraceMap,
  type SourceMapInput,
} from '@jridgewell/trace-mapping';
import type { RawSourceMap } from 'source-map';

import type { OxcPureCallHint } from './collectOxcTemplateDependencies';

type Position = {
  column: number;
  line: number;
};

const advancePosition = (start: Position, source: string): Position => {
  const lines = source.split('\n');
  if (lines.length === 1) {
    return { column: start.column + source.length, line: start.line };
  }

  return {
    column: lines.at(-1)?.length ?? 0,
    line: start.line + lines.length - 1,
  };
};

const collectLineOffsets = (source: string): number[] => {
  const offsets = [0];
  let cursor = 0;
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    if (newline === -1) break;
    offsets.push(newline + 1);
    cursor = newline + 1;
  }
  return offsets;
};

const offsetAt = (
  source: string,
  position: Position,
  lineOffsets: readonly number[]
): number | null => {
  if (position.line < 1 || position.column < 0) {
    return null;
  }

  const offset = lineOffsets[position.line - 1];
  if (offset === undefined) return null;
  const lineEnd = lineOffsets[position.line]
    ? lineOffsets[position.line]! - 1
    : source.length;
  const maxOffset = lineEnd === -1 ? source.length : lineEnd;
  const result = offset + position.column;
  return result <= maxOffset ? result : null;
};

const remapHint = (
  hint: OxcPureCallHint,
  map: TraceMap,
  lineOffsetsBySource: Map<string, readonly number[]>
): OxcPureCallHint | null => {
  const generatedStart = {
    column: hint.callColumn,
    line: hint.callLine,
  };
  const generatedEnd = advancePosition(generatedStart, hint.callSource);
  const startSegment = traceSegment(
    map,
    generatedStart.line - 1,
    generatedStart.column
  );
  if (!startSegment || startSegment[0] !== generatedStart.column) {
    return null;
  }
  const originalStart = originalPositionFor(map, generatedStart);
  const originalEnd = originalPositionFor(map, generatedEnd);

  if (
    originalStart.source === null ||
    originalStart.line === null ||
    originalStart.column === null ||
    (originalEnd.source !== null && originalEnd.source !== originalStart.source)
  ) {
    return null;
  }

  const originalSource = sourceContentFor(map, originalStart.source);
  if (originalSource === null) {
    return null;
  }

  let lineOffsets = lineOffsetsBySource.get(originalStart.source);
  if (!lineOffsets) {
    lineOffsets = collectLineOffsets(originalSource);
    lineOffsetsBySource.set(originalStart.source, lineOffsets);
  }

  const callStart = offsetAt(
    originalSource,
    {
      column: originalStart.column,
      line: originalStart.line,
    },
    lineOffsets
  );
  if (callStart === null) {
    return null;
  }

  // Source maps commonly have no segment at an expression's exclusive end.
  // Once the start is mapped, an exact text match is a stronger range proof
  // than extrapolating from the previous (often argument-level) segment.
  const callEnd = callStart + hint.callSource.length;
  const callSource = originalSource.slice(callStart, callEnd);
  // Besides proving the coordinates, this rejects transformed helpers such as
  // `jsx(...)` mapped back to JSX, where a PURE comment cannot be inserted at
  // the mapped range. In ambiguous maps it is safer to omit the hint entirely.
  if (callSource !== hint.callSource) {
    return null;
  }

  return {
    ...hint,
    callColumn: originalStart.column,
    callEnd,
    callFilename: originalStart.source,
    callLine: originalStart.line,
    callSource,
    callStart,
  };
};

export const remapPureCallHints = (
  hints: readonly OxcPureCallHint[],
  inputSourceMap?: RawSourceMap
): OxcPureCallHint[] => {
  if (!inputSourceMap) {
    return [...hints];
  }
  if (hints.length === 0) {
    return [];
  }

  try {
    const map = new TraceMap(
      inputSourceMap as unknown as SourceMapInput,
      hints[0]?.callFilename
    );
    const lineOffsetsBySource = new Map<string, readonly number[]>();
    return hints.flatMap((hint) => {
      const remapped = remapHint(hint, map, lineOffsetsBySource);
      return remapped ? [remapped] : [];
    });
  } catch {
    return [];
  }
};
