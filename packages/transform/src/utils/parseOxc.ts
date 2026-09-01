import { parseSync } from 'oxc-parser';
import type { Program } from 'oxc-parser';

import {
  recordPipelineCachedParseMiss,
  recordPipelineCachedParseHit,
} from '../debug/pipelineTelemetry';

type OxcSourceType = 'module' | 'unambiguous';

type ParsedOxc = {
  jsxFallback: boolean;
  module: {
    hasModuleSyntax: boolean;
  };
  pipelineMeasurement: { bytes: number; revision: string } | undefined;
  program: Program;
};

// 200 evicts under sustained pressure on large monorepos — the
// removeUnusedAfterReplacement cleanup loop reparses on every iteration
// (new content -> new key) and applyOxcProcessors reparses after extraction.
// 1000 is still bounded (~50-100 MB worst case for an enormous build) and
// keeps every entry hot across the actions for a single file.
const MAX_PARSE_CACHE_ENTRIES = 1000;
const parseCache = new Map<string, ParsedOxc>();

const getAstType = (filename: string): 'js' | 'ts' =>
  filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';

const getJsxFallbackFilename = (filename: string): string | null => {
  if (filename.endsWith('.js')) return `${filename}x`;

  return null;
};

const makeCacheKey = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): string => `${sourceType}\0${filename}\0${code}`;

const setCachedParse = (key: string, value: ParsedOxc): ParsedOxc => {
  parseCache.set(key, value);
  if (parseCache.size > MAX_PARSE_CACHE_ENTRIES) {
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey) {
      parseCache.delete(oldestKey);
    }
  }

  return value;
};

export const parseOxcCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): ParsedOxc => {
  const cacheKey = makeCacheKey(filename, code, sourceType);
  const cached = parseCache.get(cacheKey);
  if (cached) {
    const knownMeasurement = cached.pipelineMeasurement;
    const measurement = recordPipelineCachedParseHit(
      cached,
      filename,
      code,
      sourceType,
      cached.jsxFallback,
      knownMeasurement
    );
    if (measurement && measurement !== knownMeasurement) {
      cached.pipelineMeasurement = measurement;
    }
    return cached;
  }

  const astType = getAstType(filename);
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code, {
      astType,
      range: true,
      sourceType,
    });
  } catch (error) {
    recordPipelineCachedParseMiss(
      filename,
      code,
      sourceType,
      astType,
      false,
      true
    );
    throw error;
  }
  let fatalError = parsed.errors.find((error) => error.severity === 'Error');
  const jsxFallbackFilename = getJsxFallbackFilename(filename);
  let jsxFallback = false;
  if (fatalError?.message.includes('JSX') && jsxFallbackFilename) {
    // Some bundlers pass .js files with JSX to WyW before a later JSX transform.
    jsxFallback = true;
    try {
      parsed = parseSync(jsxFallbackFilename, code, {
        astType: getAstType(jsxFallbackFilename),
        range: true,
        sourceType,
      });
    } catch (error) {
      recordPipelineCachedParseMiss(
        filename,
        code,
        sourceType,
        astType,
        jsxFallback,
        true
      );
      throw error;
    }
    fatalError = parsed.errors.find((error) => error.severity === 'Error');
  }

  if (fatalError) {
    recordPipelineCachedParseMiss(
      filename,
      code,
      sourceType,
      astType,
      jsxFallback,
      true
    );
    throw new Error(fatalError.message);
  }

  const cachedParse = setCachedParse(cacheKey, {
    jsxFallback,
    module: {
      hasModuleSyntax: parsed.module.hasModuleSyntax,
    },
    pipelineMeasurement: undefined,
    program: parsed.program as Program,
  });
  const telemetryMeasurement = recordPipelineCachedParseMiss(
    filename,
    code,
    sourceType,
    astType,
    jsxFallback,
    false,
    cachedParse
  );
  if (telemetryMeasurement) {
    cachedParse.pipelineMeasurement = telemetryMeasurement;
  }
  return cachedParse;
};

export const parseOxcProgramCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): Program => parseOxcCached(filename, code, sourceType).program;
