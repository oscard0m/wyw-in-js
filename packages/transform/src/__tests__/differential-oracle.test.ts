/* eslint-env jest */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SourceMapGenerator } from 'source-map';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import type { PluginOptions, Result } from '../types';
import { EventEmitter, isOnActionStartArgs } from '../utils/EventEmitter';
import type {
  EntrypointEvent,
  OnAction,
  OnActionFinishArgs,
  OnActionStartArgs,
} from '../utils/EventEmitter';

import {
  assertDifferentialSnapshotsEqual,
  assertDifferentialTraceEqual,
  captureDifferentialTrace,
} from './__utils__/differential-oracle';
import type {
  DifferentialSnapshot,
  DifferentialStep,
} from './__utils__/differential-oracle';

/* eslint-disable import/no-unresolved -- Bun is the package test runtime. */
// @ts-expect-error The package test runtime provides bun:test; the legacy spec
// tsconfig intentionally exposes Jest globals instead of Bun's module types.
const { describe, expect, it } = (await import('bun:test')) as {
  describe: jest.Describe;
  expect: jest.Expect;
  it: jest.It;
};
/* eslint-enable import/no-unresolved */

const CHILD_MARKER = '__WYW_DIFFERENTIAL_SNAPSHOT__=';
const CHILD_MODE = 'WYW_DIFFERENTIAL_ORACLE_CHILD';
const CHILD_ROOT = 'WYW_DIFFERENTIAL_ORACLE_ROOT';
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEST_FILE = fileURLToPath(import.meta.url);
const cssProcessorFile = join(
  TEST_DIRECTORY,
  '__fixtures__',
  'test-css-processor.js'
);
const diagnosticProcessorFile = join(
  TEST_DIRECTORY,
  '__fixtures__',
  'test-diagnostic-processor.js'
);

type CorpusEvent = {
  channel: string;
  [key: string]: unknown;
};

type CacheProjection = {
  barrelManifests: Array<[string, unknown]>;
  callbackCounts: Array<[string, number]>;
  entrypoints: Array<{
    dependencies: Array<[string, unknown]>;
    evaluated: boolean;
    evaluatedOnly: string[];
    generation: number;
    ignored: boolean;
    invalidateOnDependencyChange: string[];
    invalidationDependencies: Array<[string, unknown]>;
    key: string;
    name: string;
    only: string[];
    transformed: boolean;
  }>;
  exports: Array<[string, string[]]>;
  keySalt: string | null;
};

type SessionOptions = {
  ignore?: boolean;
  outputMetadata?: boolean;
  softErrors?: boolean;
  strategy?: 'execute' | 'hybrid' | 'static';
};

const projectDependency = (dependency: {
  loadedCode?: string;
  only: string[];
  resolved: string | null;
  source: string;
}) => ({
  ...(Object.prototype.hasOwnProperty.call(dependency, 'loadedCode')
    ? { loadedCode: dependency.loadedCode }
    : {}),
  only: [...dependency.only],
  resolved: dependency.resolved,
  source: dependency.source,
});

const projectCache = (
  cache: TransformCacheCollection,
  callbackCounts: Map<string, number>
): CacheProjection => ({
  barrelManifests: Array.from(cache.barrelManifests.entries()),
  callbackCounts: Array.from(callbackCounts.entries()),
  entrypoints: Array.from(cache.entrypoints.entries()).map(
    ([key, entrypoint]) => ({
      dependencies: Array.from(entrypoint.dependencies.entries()).map(
        ([source, dependency]) => [source, projectDependency(dependency)]
      ),
      evaluated: entrypoint.evaluated,
      evaluatedOnly: [...entrypoint.evaluatedOnly],
      generation: entrypoint.generation,
      ignored: entrypoint.ignored,
      invalidateOnDependencyChange: Array.from(
        entrypoint.invalidateOnDependencyChange
      ),
      invalidationDependencies: Array.from(
        entrypoint.invalidationDependencies.entries(),
        ([source, dependency]) => [source, projectDependency(dependency)]
      ),
      key,
      name: entrypoint.name,
      only: [...entrypoint.only],
      transformed:
        'transformed' in entrypoint
          ? entrypoint.transformed
          : entrypoint.hasTransformResult,
    })
  ),
  exports: Array.from(cache.exports.entries()).map(([key, value]) => [
    key,
    [...value],
  ]),
  keySalt: cache.getKeySalt(),
});

const resolveLocalFile = (what: string, importer: string): string | null => {
  if (!what.startsWith('.')) return null;

  const base = resolve(dirname(importer), what);
  for (const extension of ['', '.js', '.jsx', '.ts', '.tsx']) {
    if (existsSync(`${base}${extension}`)) return `${base}${extension}`;
  }
  return base;
};

const createEventEmitter = (
  events: CorpusEvent[],
  record: (channel: string, details?: Record<string, unknown>) => void
): { assertSettled: () => void; eventEmitter: EventEmitter } => {
  const perfIds = new Map<number, number>();
  const openPerfIds = new Set<number>();
  const entrypointIds = new Map<number, number>();
  const actionIds = new Map<string, number>();
  const activeActionIds = new Set<number>();
  const fileIds = new Map<string, number>();
  const fileNamesById = new Map<string, string>();
  const fileIdsByName = new Map<string, string>();
  const evalIds = new Map<number, number>();
  let nextActionId = 0;

  const normalizeStringId = (
    ids: Map<string, number>,
    rawId: string,
    prefix: string
  ): string => {
    const known = ids.get(rawId);
    if (known !== undefined) return `${prefix}${known}`;
    const id = ids.size;
    ids.set(rawId, id);
    return `${prefix}${id}`;
  };

  const normalizeNumericId = (
    ids: Map<number, number>,
    rawId: number,
    label: string
  ): number => {
    if (!Number.isSafeInteger(rawId) || rawId < 0) {
      throw new Error(`invalid ${label}: ${rawId}`);
    }
    const known = ids.get(rawId);
    if (known !== undefined) return known;
    const id = ids.size;
    ids.set(rawId, id);
    return id;
  };

  const declareFileId = (rawId: string, filename: string): string => {
    if (!/^\d{5}$/.test(rawId)) {
      throw new Error(`invalid file id: ${rawId}`);
    }
    const knownName = fileNamesById.get(rawId);
    const knownId = fileIdsByName.get(filename);
    if (
      (knownName !== undefined && knownName !== filename) ||
      (knownId !== undefined && knownId !== rawId)
    ) {
      throw new Error(`inconsistent file id binding: ${rawId}/${filename}`);
    }
    fileNamesById.set(rawId, filename);
    fileIdsByName.set(filename, rawId);
    return normalizeStringId(fileIds, rawId, 'file:');
  };

  const referenceFileId = (rawId: string): string => {
    if (!/^\d{5}$/.test(rawId)) return rawId;
    if (!fileIds.has(rawId)) {
      throw new Error(`unknown file id reference: ${rawId}`);
    }
    return normalizeStringId(fileIds, rawId, 'file:');
  };

  const declareActionId = (rawId: string): string => {
    if (!/^[0-9a-f]{6}$/.test(rawId)) {
      throw new Error(`invalid action id: ${rawId}`);
    }
    if (actionIds.has(rawId)) {
      throw new Error(`duplicate action id: ${rawId}`);
    }
    return normalizeStringId(actionIds, rawId, 'action:');
  };

  const normalizeActionReference = (rawId: string): string => {
    const match = /^([0-9a-f]{6}):(\d+)$/.exec(rawId);
    if (!match) return rawId;
    if (!actionIds.has(match[1])) {
      throw new Error(`unknown action id reference: ${rawId}`);
    }
    return `${normalizeStringId(actionIds, match[1], 'action:')}:${match[2]}`;
  };

  const normalizeEntrypointRef = (entrypointRef: string): string => {
    const match = /^(\d{5})#(\d+)$/.exec(entrypointRef);
    if (!match) return entrypointRef;
    return `${referenceFileId(match[1])}#${match[2]}`;
  };

  const assertValidTime = (label: string, value: number): void => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid ${label}: ${value}`);
    }
  };

  const declareNumericId = (
    ids: Map<number, number>,
    rawId: number,
    label: string
  ): number => {
    if (ids.has(rawId)) throw new Error(`duplicate ${label}: ${rawId}`);
    return normalizeNumericId(ids, rawId, label);
  };

  const referenceNumericId = (
    ids: Map<number, number>,
    rawId: number,
    label: string
  ): number => {
    if (!ids.has(rawId)) throw new Error(`unknown ${label}: ${rawId}`);
    return normalizeNumericId(ids, rawId, label);
  };

  const projectEventRecord = (
    value: Record<string, unknown>,
    path: string,
    omitted: ReadonlySet<string> = new Set()
  ): Record<string, unknown> => {
    const projected: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        throw new Error(`${path} has an unsupported symbol property`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error(`${path}.${key} must be a data property`);
      }
      if (!omitted.has(key)) {
        const fieldValue = descriptor.value;
        if (key === 'evalSeq' && typeof fieldValue === 'number') {
          projected[key] = normalizeNumericId(evalIds, fieldValue, 'eval id');
        } else if (key === 'fileIdx' && typeof fieldValue === 'string') {
          projected[key] = referenceFileId(fieldValue);
        } else {
          projected[key] = fieldValue;
        }
      }
    }
    return projected;
  };

  const readDataField = (
    value: Record<string, unknown>,
    key: string,
    path: string
  ): { present: boolean; value: unknown } => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { present: false, value: undefined };
    if (!('value' in descriptor)) {
      throw new Error(`${path}.${key} must be a data property`);
    }
    return { present: true, value: descriptor.value };
  };

  const onAction = ((
    ...args: OnActionStartArgs | OnActionFinishArgs
  ): number | void => {
    if (isOnActionStartArgs(args)) {
      const [, timestamp, actionType, actionIdx, entrypointRef] = args;
      assertValidTime('action timestamp', timestamp);
      const normalizedActionIdx = normalizeActionReference(actionIdx);
      const normalizedEntrypointRef = normalizeEntrypointRef(entrypointRef);
      const id = nextActionId;
      nextActionId += 1;
      activeActionIds.add(id);
      record('action', {
        actionIdx: normalizedActionIdx,
        actionType,
        entrypointRef: normalizedEntrypointRef,
        id,
        phase: 'start',
      });
      return id;
    }

    const [phase, timestamp, id, isAsync, error] = args;
    assertValidTime('action timestamp', timestamp);
    if (!activeActionIds.delete(id)) {
      throw new Error(`unknown or already settled action id: ${id}`);
    }
    record('action', {
      ...(error === undefined ? {} : { error }),
      id,
      isAsync,
      phase,
    });
    return undefined;
  }) as OnAction;

  const eventEmitter = new EventEmitter(
    (labels, phase, event) => {
      if (event && typeof event === 'object') {
        const eventRecord = event as Record<string, unknown>;
        const eventType = readDataField(eventRecord, 'type', 'perf event');
        const span = readDataField(eventRecord, 'spanId', 'perf event');
        if (!eventType.present || typeof eventType.value !== 'string') {
          throw new Error('perf event type must be a string');
        }
        if (!span.present || typeof span.value !== 'number') {
          throw new Error('perf event spanId must be a number');
        }
        for (const timeKey of ['startedAt', 'finishedAt'] as const) {
          const field = readDataField(eventRecord, timeKey, 'perf event');
          if (field.present) {
            if (typeof field.value !== 'number') {
              throw new Error(`${timeKey} must be a number`);
            }
            assertValidTime(timeKey, field.value);
          }
        }
        const duration = readDataField(eventRecord, 'durationMs', 'perf event');
        if (duration.present) {
          if (typeof duration.value !== 'number') {
            throw new Error('durationMs must be a number');
          }
          assertValidTime('durationMs', duration.value);
        }
        const startedAt = readDataField(
          eventRecord,
          'startedAt',
          'perf event'
        ).value;
        const finishedAt = readDataField(
          eventRecord,
          'finishedAt',
          'perf event'
        ).value;
        let normalizedSpanId: number;
        if (eventType.value === 'perf-span-start') {
          if (phase !== 'start' || typeof startedAt !== 'number') {
            throw new Error('invalid perf start event');
          }
          normalizedSpanId = declareNumericId(
            perfIds,
            span.value,
            'perf span id'
          );
          openPerfIds.add(span.value);
        } else if (eventType.value === 'perf-span') {
          if (
            phase !== 'finish' ||
            typeof startedAt !== 'number' ||
            typeof finishedAt !== 'number' ||
            typeof duration.value !== 'number'
          ) {
            throw new Error('invalid perf finish event');
          }
          if (finishedAt < startedAt) {
            throw new Error('perf event finishes before it starts');
          }
          if (duration.value !== finishedAt - startedAt) {
            throw new Error('perf duration does not match its timestamps');
          }
          normalizedSpanId = referenceNumericId(
            perfIds,
            span.value,
            'perf span id'
          );
          if (!openPerfIds.delete(span.value)) {
            throw new Error(`perf span is not open: ${span.value}`);
          }
        } else {
          throw new Error(`unsupported perf event type: ${eventType.value}`);
        }
        const projectedEvent = projectEventRecord(
          eventRecord,
          'perf event',
          new Set(['durationMs', 'finishedAt', 'startedAt'])
        );
        projectedEvent.spanId = normalizedSpanId;
        record('perf', {
          event: projectedEvent,
          labels: projectEventRecord(labels, 'perf labels'),
          phase,
        });
        return;
      }

      const datetime = readDataField(labels, 'datetime', 'event labels');
      if (
        !datetime.present ||
        !(datetime.value instanceof Date) ||
        !Number.isFinite(datetime.value.getTime())
      ) {
        throw new Error('event datetime must be a valid Date data property');
      }
      record('event', {
        event,
        labels: projectEventRecord(
          labels,
          'event labels',
          new Set(['datetime'])
        ),
        phase,
      });
    },
    onAction,
    (sequenceId, timestamp, event: EntrypointEvent) => {
      assertValidTime('entrypoint timestamp', timestamp);
      const normalizedEvent = projectEventRecord(
        event as unknown as Record<string, unknown>,
        'entrypoint event'
      );
      let normalizedSequenceId: number;
      switch (event.type) {
        case 'created':
          normalizedSequenceId = declareNumericId(
            entrypointIds,
            sequenceId,
            'entrypoint id'
          );
          normalizedEvent.idx = declareFileId(event.idx, event.filename);
          if (event.parentId !== null) {
            normalizedEvent.parentId = referenceNumericId(
              entrypointIds,
              event.parentId,
              'entrypoint parent id'
            );
          }
          break;
        case 'actionCreated':
          normalizedSequenceId = referenceNumericId(
            entrypointIds,
            sequenceId,
            'entrypoint id'
          );
          normalizedEvent.actionIdx = declareActionId(event.actionIdx);
          break;
        case 'setTransformResult':
          normalizedSequenceId = referenceNumericId(
            entrypointIds,
            sequenceId,
            'entrypoint id'
          );
          break;
        case 'superseded':
          normalizedSequenceId = referenceNumericId(
            entrypointIds,
            sequenceId,
            'entrypoint id'
          );
          normalizedEvent.with = referenceNumericId(
            entrypointIds,
            event.with,
            'superseding entrypoint id'
          );
          break;
        default: {
          const exhaustive: never = event;
          throw new Error(
            `unsupported entrypoint event: ${String(exhaustive)}`
          );
        }
      }
      record('entrypoint', {
        event: normalizedEvent,
        sequenceId: normalizedSequenceId,
      });
    },
    true,
    { debugEvents: ['staticPlan'] }
  );

  return {
    assertSettled: () => {
      if (activeActionIds.size > 0 || openPerfIds.size > 0) {
        throw new Error(
          `unsettled event lifecycles: ${activeActionIds.size} actions, ${openPerfIds.size} perf spans`
        );
      }
    },
    eventEmitter,
  };
};

const createSession = (root: string, options: SessionOptions = {}) => {
  const cache = new TransformCacheCollection();
  const events: CorpusEvent[] = [];
  const callbackCounts = new Map<string, number>();

  const record = (
    channel: string,
    details: Record<string, unknown> = {}
  ): void => {
    callbackCounts.set(channel, (callbackCounts.get(channel) ?? 0) + 1);
    events.push({ channel, ...details });
  };

  const asyncResolve = async (
    what: string,
    importer: string,
    stack: string[]
  ): Promise<string | null> => {
    record('resolver:call', { importer, stack: [...stack], what });
    const resolved = resolveLocalFile(what, importer);
    record('resolver:return', { importer, resolved, what });
    return resolved;
  };

  const loadDependencyCode = async (
    resolved: string,
    importer: string,
    source: string
  ): Promise<string | undefined> => {
    record('loader:call', { importer, resolved, source });
    const code = existsSync(resolved)
      ? readFileSync(resolved, 'utf8')
      : undefined;
    record('loader:return', { code, importer, resolved, source });
    return code;
  };

  const tagResolver: NonNullable<PluginOptions['tagResolver']> = (
    source,
    tag,
    meta
  ) => {
    record('tagResolver:call', {
      source,
      sourceFile: meta.sourceFile,
      tag,
    });
    let resolved: string | null = null;
    if (source === './css-tag.js' && tag === 'css') {
      resolved = cssProcessorFile;
    } else if (source === './diagnostic-tag.js' && tag === 'css') {
      resolved = diagnosticProcessorFile;
    }
    record('tagResolver:return', { resolved, source, tag });
    return resolved;
  };

  const preprocessor = (selector: string, cssText: string): string => {
    record('preprocessor', { cssText, selector });
    return cssText;
  };

  const { assertSettled, eventEmitter } = createEventEmitter(events, record);
  const rules = options.ignore
    ? [{ action: 'ignore' as const, test: () => true }]
    : undefined;
  const pluginOptions: Partial<PluginOptions> = {
    configFile: false,
    eval: {
      onWarn: (warning) => record('eval:onWarn', { warning }),
      strategy: options.strategy ?? 'hybrid',
    },
    features: {
      dangerousCodeRemover: true,
      globalCache: true,
      happyDOM: true,
      softErrors: options.softErrors ?? false,
      useWeakRefInEval: true,
    },
    outputMetadata: options.outputMetadata ?? false,
    overrideContext: (context, filename) => {
      record('overrideContext', { filename });
      return context;
    },
    ...(rules ? { rules } : {}),
    tagResolver,
  };

  const runStep = async (
    name: string,
    filename: string,
    inputSourceMap?: Result['sourceMap']
  ): Promise<DifferentialStep<CorpusEvent, CacheProjection>> => {
    const firstEvent = events.length;
    // eslint-disable-next-line no-console -- softErrors reports through console.error.
    const originalConsoleError = console.error;
    // eslint-disable-next-line no-console -- capture the report in the ordered transcript.
    console.error = (...args: unknown[]) => record('console:error', { args });

    let outcome: DifferentialStep['outcome'];
    try {
      const result = await transform(
        {
          asyncResolveKey: 'differential-corpus:v1',
          cache,
          emitWarning: (message) => record('emitWarning', { message }),
          eventEmitter,
          loadDependencyCode,
          options: {
            filename,
            inputSourceMap: inputSourceMap ?? undefined,
            pluginOptions,
            preprocessor,
            root,
          },
        },
        readFileSync(filename, 'utf8'),
        asyncResolve
      );
      outcome = { kind: 'result', value: result };
    } catch (error) {
      outcome = { error, kind: 'error', phase: 'transform' };
    } finally {
      // eslint-disable-next-line no-console -- restore the process-global reporter.
      console.error = originalConsoleError;
    }

    await Promise.resolve();
    await new Promise<void>((resolveTick) => {
      setImmediate(resolveTick);
    });
    assertSettled();

    return {
      events: events.slice(firstEvent),
      name,
      outcome,
      state: projectCache(cache, callbackCounts),
    };
  };

  return {
    dispose: () => disposeEvalBroker(cache),
    runStep,
  };
};

const createInputSourceMap = (filename: string) => {
  const generator = new SourceMapGenerator({ file: filename });
  generator.addMapping({
    generated: { column: 0, line: 1 },
    name: 'className',
    original: { column: 0, line: 1 },
    source: 'original-entry.ts',
  });
  generator.setSourceContent(
    'original-entry.ts',
    'export const className = "from-input-map";\n'
  );
  return generator.toJSON();
};

const runWithSession = async (
  root: string,
  options: SessionOptions,
  run: (
    session: ReturnType<typeof createSession>
  ) => Promise<Array<DifferentialStep<CorpusEvent, CacheProjection>>>
) => {
  const session = createSession(root, options);
  try {
    return await run(session);
  } finally {
    session.dispose();
  }
};

const initializeCorpus = (root: string): Record<string, string> => {
  mkdirSync(root, { recursive: true });

  const files = {
    cssExecute: join(root, 'css-execute.js'),
    cssHybrid: join(root, 'css-hybrid.js'),
    cssStatic: join(root, 'css-static.js'),
    cssTag: join(root, 'css-tag.js'),
    diagnostic: join(root, 'diagnostic.js'),
    diagnosticTag: join(root, 'diagnostic-tag.js'),
    error: join(root, 'error.js'),
    ignored: join(root, 'ignored.js'),
    noArtifacts: join(root, 'no-artifacts.js'),
    token: join(root, 'token.js'),
    watch: join(root, 'watch.js'),
    warning: join(root, 'warning.js'),
  };

  const cssSource = [
    "import { css } from './css-tag.js';",
    "const color = 'red';",
    'export const className = css`',
    '  color: ${color};',
    '`;',
    '',
  ].join('\n');
  writeFileSync(files.cssStatic, cssSource);
  writeFileSync(files.cssHybrid, cssSource);
  writeFileSync(files.cssExecute, cssSource);
  writeFileSync(files.cssTag, 'export const css = () => null;\n');
  writeFileSync(files.ignored, 'export const ignored = 1;\n');
  writeFileSync(files.noArtifacts, 'export const untouched = 1 + 2;\n');
  writeFileSync(
    files.diagnostic,
    [
      "import { css } from './diagnostic-tag.js';",
      'export const warningClass = css`color: red;`;',
      '',
    ].join('\n')
  );
  writeFileSync(files.diagnosticTag, 'export const css = () => null;\n');
  writeFileSync(
    files.error,
    "import { css } from './css-tag.js';\nexport const broken = ;\n"
  );
  writeFileSync(files.token, "export const color = 'red';\n");
  const warningPackage = join(root, 'node_modules', 'oracle-warning');
  mkdirSync(warningPackage, { recursive: true });
  writeFileSync(
    join(warningPackage, 'index.js'),
    "module.exports = { color: 'orange' };\n"
  );
  writeFileSync(
    files.warning,
    [
      "import { css } from './css-tag.js';",
      "const warningDependency = require('oracle-warning');",
      'export const warningClass = css`',
      '  color: ${warningDependency.color};',
      '`;',
      '',
    ].join('\n')
  );
  writeFileSync(
    files.watch,
    [
      "import { css } from './css-tag.js';",
      "import { color } from './token.js';",
      'export const watchClass = css`color: ${color};`;',
      '',
    ].join('\n')
  );

  return files;
};

const assertCorpusCoverage = (
  steps: Array<DifferentialStep<CorpusEvent, CacheProjection>>
): void => {
  const byName = new Map(steps.map((step) => [step.name, step]));
  const requireResult = (name: string): Result => {
    const step = byName.get(name);
    if (!step) throw new Error(`missing corpus step ${name}`);
    if (step.outcome.kind !== 'result') {
      throw new Error(`corpus step ${name} unexpectedly failed`);
    }
    return step.outcome.value;
  };
  const requireError = (name: string): Error => {
    const step = byName.get(name);
    if (!step) throw new Error(`missing corpus step ${name}`);
    if (
      step.outcome.kind !== 'error' ||
      !(step.outcome.error instanceof Error)
    ) {
      throw new Error(`corpus step ${name} unexpectedly succeeded`);
    }
    return step.outcome.error;
  };

  const ignored = requireResult('ignored');
  if (Object.keys(ignored).join(',') !== 'code,sourceMap') {
    throw new Error(
      'ignored corpus result does not preserve omission semantics'
    );
  }
  if (requireResult('no-artifacts').cssText !== undefined) {
    throw new Error('no-artifacts corpus step unexpectedly emitted CSS');
  }

  for (const strategy of ['static', 'hybrid', 'execute'] as const) {
    const result = requireResult(`css:${strategy}`);
    if (
      !result.cssText?.includes('red') ||
      !result.cssSourceMapText ||
      !result.sourceMap ||
      !result.rules
    ) {
      throw new Error(
        `css:${strategy} does not cover CSS, rules, and both maps`
      );
    }
  }

  const diagnostic = requireResult('diagnostic-css');
  if (
    !diagnostic.diagnostics?.length ||
    !diagnostic.metadata?.processors.length
  ) {
    throw new Error(
      'diagnostic corpus step does not cover diagnostics/metadata'
    );
  }
  if (!requireResult('warning:require-fallback').cssText?.includes('orange')) {
    throw new Error('warning corpus step does not contain orange');
  }
  requireError('error:strict');
  if (requireResult('error:soft').cssText !== undefined) {
    throw new Error('soft error corpus step unexpectedly emitted CSS');
  }

  for (const [name, color] of [
    ['watch:cold', 'red'],
    ['watch:unchanged', 'red'],
    ['watch:changed', 'blue'],
    ['watch:recovered', 'green'],
  ] as const) {
    if (!requireResult(name).cssText?.includes(color)) {
      throw new Error(`${name} does not contain ${color}`);
    }
  }
  requireError('watch:removed');

  const channels = new Set(
    steps.flatMap((step) => step.events.map((event) => event.channel))
  );
  for (const channel of [
    'action',
    'console:error',
    'emitWarning',
    'entrypoint',
    'eval:onWarn',
    'event',
    'loader:call',
    'overrideContext',
    'perf',
    'preprocessor',
    'resolver:call',
    'tagResolver:call',
  ]) {
    if (!channels.has(channel)) {
      throw new Error(`corpus does not exercise ${channel}`);
    }
  }

  const singleEventTypes = new Set(
    steps.flatMap((step) =>
      step.events.flatMap((event) => {
        if (event.channel !== 'event') return [];
        const labels = event.labels as Record<string, unknown> | undefined;
        return typeof labels?.type === 'string' ? [labels.type] : [];
      })
    )
  );
  for (const type of ['dependency', 'eval-file', 'staticPlan']) {
    if (!singleEventTypes.has(type)) {
      throw new Error(`corpus does not exercise ${type} event labels`);
    }
  }
};

const runCorpus = async (
  root: string
): Promise<Array<DifferentialStep<CorpusEvent, CacheProjection>>> => {
  const files = initializeCorpus(root);
  const steps: Array<DifferentialStep<CorpusEvent, CacheProjection>> = [];

  steps.push(
    ...(await runWithSession(root, { ignore: true }, async (session) => [
      await session.runStep(
        'ignored',
        files.ignored,
        createInputSourceMap(files.ignored)
      ),
    ]))
  );
  steps.push(
    ...(await runWithSession(root, {}, async (session) => [
      await session.runStep('no-artifacts', files.noArtifacts),
    ]))
  );

  const strategyFiles = {
    execute: files.cssExecute,
    hybrid: files.cssHybrid,
    static: files.cssStatic,
  };
  for (const strategy of ['static', 'hybrid', 'execute'] as const) {
    const filename = strategyFiles[strategy];
    // Deliberately serial: unrelated scenarios must not perturb module globals.
    // eslint-disable-next-line no-await-in-loop
    const strategyStep = await runWithSession(
      root,
      { outputMetadata: strategy === 'hybrid', strategy },
      async (session) => [
        await session.runStep(
          `css:${strategy}`,
          filename,
          strategy === 'hybrid' ? createInputSourceMap(filename) : undefined
        ),
      ]
    );
    steps.push(...strategyStep);
  }

  steps.push(
    ...(await runWithSession(root, { strategy: 'execute' }, async (session) => [
      await session.runStep('warning:require-fallback', files.warning),
    ]))
  );
  steps.push(
    ...(await runWithSession(
      root,
      { outputMetadata: true },
      async (session) => [
        await session.runStep('diagnostic-css', files.diagnostic),
      ]
    ))
  );
  steps.push(
    ...(await runWithSession(root, {}, async (session) => [
      await session.runStep('error:strict', files.error),
    ]))
  );
  steps.push(
    ...(await runWithSession(root, { softErrors: true }, async (session) => [
      await session.runStep('error:soft', files.error),
    ]))
  );

  steps.push(
    ...(await runWithSession(root, {}, async (session) => {
      const watchSteps = [await session.runStep('watch:cold', files.watch)];
      watchSteps.push(await session.runStep('watch:unchanged', files.watch));
      writeFileSync(files.token, "export const color = 'blue';\n");
      watchSteps.push(await session.runStep('watch:changed', files.watch));
      unlinkSync(files.token);
      watchSteps.push(await session.runStep('watch:removed', files.watch));
      writeFileSync(files.token, "export const color = 'green';\n");
      watchSteps.push(await session.runStep('watch:recovered', files.watch));
      return watchSteps;
    }))
  );

  assertCorpusCoverage(steps);
  return steps;
};

const runCorpusInChild = async (
  root: string
): Promise<{ pid: number; snapshot: DifferentialSnapshot }> =>
  new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [TEST_FILE], {
      env: {
        ...process.env,
        [CHILD_MODE]: '1',
        [CHILD_ROOT]: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', rejectChild);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        rejectChild(
          new Error(
            `Differential child ${
              child.pid ?? '<unknown>'
            } exited ${code}:\n${errorOutput}\n${output}`
          )
        );
        return;
      }
      if (errorOutput.trim().length > 0) {
        rejectChild(
          new Error(
            `Differential child ${
              child.pid ?? '<unknown>'
            } emitted unexpected stderr:\n${errorOutput}`
          )
        );
        return;
      }

      const markerLine = output
        .split('\n')
        .find((line) => line.startsWith(CHILD_MARKER));
      if (!markerLine) {
        rejectChild(
          new Error(
            `Differential child ${
              child.pid ?? '<unknown>'
            } emitted no snapshot:\n${errorOutput}\n${output}`
          )
        );
        return;
      }

      resolveChild({
        pid: child.pid ?? -1,
        snapshot: JSON.parse(markerLine.slice(CHILD_MARKER.length)),
      });
    });
  });

const createSourceMap = ({
  column = 0,
  content = 'const value = 1;\n',
  extension = 'stable',
  name = 'value',
  source = 'source.ts',
}: {
  column?: number;
  content?: string;
  extension?: string;
  name?: string;
  source?: string;
} = {}) => {
  const generator = new SourceMapGenerator({ file: 'output.js' });
  generator.addMapping({
    generated: { column, line: 1 },
    name,
    original: { column: 6, line: 1 },
    source,
  });
  generator.setSourceContent(source, content);
  return {
    ...generator.toJSON(),
    x_oracle_extension: extension,
  };
};

class OracleError extends Error {
  public readonly code = 'E_ORACLE';

  public readonly cause = new TypeError('root cause');
}

function AlternativeOracleError() {
  return undefined;
}

const createAlternativeOracleError = (message: string): OracleError => {
  const error = new OracleError(message);
  Object.setPrototypeOf(
    error,
    Object.create(OracleError.prototype, {
      constructor: { value: AlternativeOracleError },
    })
  );
  return error;
};

type SyntheticState = {
  alias: Array<{ value: string }>;
  cache: { entries: string[]; salt: string };
  callbacks: { resolver: number; tagResolver: number };
  graph: { edges: string[][] };
  invalidation: string[];
  special: {
    holey: Array<string | undefined>;
    negativeZero: number;
    notANumber: number;
    orderedMap: Map<string, number>;
    orderedSet: Set<string>;
    positiveZero: number;
    veryLarge: bigint;
  };
};

type SyntheticEvent = { channel: string; [key: string]: unknown };
type SyntheticStep = DifferentialStep<SyntheticEvent, SyntheticState>;
type SyntheticTrace = SyntheticStep[];
type ExtendedResult = Result & { futureOptional?: unknown };

const createSyntheticResult = (color: string): ExtendedResult => {
  const rules = {
    '.first': {
      className: 'first',
      cssText: `color:${color};`,
      displayName: 'first',
      start: { column: 0, line: 1 },
    },
    '.second': {
      className: 'second',
      cssText: 'display:block;',
      displayName: 'second',
      start: null,
    },
  };
  const sourceMap = createSourceMap();
  const result: ExtendedResult = {
    code: `export const className = "${color}";\n`,
    cssSourceMapText: JSON.stringify(sourceMap),
    cssText: `.first{color:${color};}\n.second{display:block;}\n`,
    dependencies: ['/root/tokens.js', '/root/theme.js'],
    dependencyResolutions: [
      { resolved: '/root/tokens.js', source: './tokens.js' },
      { resolved: '/root/theme.js', source: './theme.js' },
    ],
    diagnostics: [
      {
        category: 'oracle/warning',
        className: 'first',
        displayName: 'first',
        end: null,
        filename: '/root/entry.js',
        message: 'synthetic warning',
        severity: 'warning',
        start: { column: 0, line: 1 },
      },
    ],
    metadata: {
      dependencies: ['/root/tokens.js'],
      processors: [
        {
          artifacts: [['css', ['.first', `color:${color};`]]],
          className: 'first',
          displayName: 'first',
          start: { column: 0, line: 1 },
        },
      ],
      replacements: [
        {
          length: 5,
          original: {
            end: { column: 5, line: 1 },
            start: { column: 0, line: 1 },
          },
        },
      ],
      rules,
    } as Result['metadata'],
    replacements: [
      {
        length: 5,
        original: {
          end: { column: 5, line: 1 },
          start: { column: 0, line: 1 },
        },
      },
    ],
    rules,
    sourceMap,
  };
  Object.defineProperty(result, 'futureOptional', {
    configurable: true,
    enumerable: true,
    value: undefined,
    writable: true,
  });
  return result;
};

const createSyntheticState = (): SyntheticState => {
  const shared = { value: 'shared' };
  const holey = new Array<string | undefined>(2);
  holey[1] = 'present';
  return {
    alias: [shared, shared],
    cache: { entries: ['entry.js', 'tokens.js'], salt: 'stable' },
    callbacks: { resolver: 2, tagResolver: 1 },
    graph: { edges: [['entry.js', 'tokens.js']] },
    invalidation: ['tokens.js'],
    special: {
      holey,
      negativeZero: -0,
      notANumber: Number.NaN,
      orderedMap: new Map([
        ['first', 1],
        ['second', 2],
      ]),
      orderedSet: new Set(['first', 'second']),
      positiveZero: 0,
      veryLarge: 9007199254740993n,
    },
  };
};

const createSyntheticTrace = (): SyntheticTrace => [
  {
    events: [
      { channel: 'warning', value: 'one' },
      { channel: 'callback', value: 'two' },
      {
        actionIdx: 'action:0:1',
        channel: 'action',
        entrypointRef: 'file:0#1',
      },
      {
        actionIdx: '/root/entry.js\0import\0package',
        channel: 'action',
        entrypointRef: '/root/entry.js',
      },
    ],
    name: 'cold',
    outcome: { kind: 'result', value: createSyntheticResult('red') },
    state: createSyntheticState(),
  },
  {
    events: [{ channel: 'callback', value: 'rebuild' }],
    name: 'rebuild',
    outcome: { kind: 'result', value: createSyntheticResult('blue') },
    state: createSyntheticState(),
  },
  {
    events: [],
    name: 'error',
    outcome: {
      error: new OracleError('synthetic failure'),
      kind: 'error',
      phase: 'transform',
    },
    state: createSyntheticState(),
  },
];

const getResult = (trace: SyntheticTrace, step = 0): ExtendedResult => {
  const { outcome } = trace[step];
  if (outcome.kind !== 'result')
    throw new Error(`step ${step} is not a result`);
  return outcome.value as ExtendedResult;
};

const getErrorOutcome = (
  trace: SyntheticTrace
): Extract<SyntheticStep['outcome'], { kind: 'error' }> => {
  const { outcome } = trace[2];
  if (outcome.kind !== 'error') throw new Error('error step is not an error');
  return outcome;
};

/* eslint-disable no-param-reassign -- each case deliberately mutates one candidate axis. */
const mutationCases: Array<{
  expectedPath: string;
  mutate: (trace: SyntheticTrace) => void;
  name: string;
}> = [
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      delete getResult(trace).futureOptional;
    },
    name: 'absent versus present undefined field',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      getResult(trace).futureOptional = null;
    },
    name: 'null versus undefined field',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      const result = getResult(trace);
      Object.defineProperty(result, 'code', {
        ...Object.getOwnPropertyDescriptor(result, 'code'),
        enumerable: false,
      });
    },
    name: 'Result property descriptor',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      const result = getResult(trace);
      const descriptor = Object.getOwnPropertyDescriptor(
        result,
        'dependencies'
      );
      if (!descriptor) throw new Error('dependencies descriptor is missing');
      delete result.dependencies;
      Object.defineProperty(result, 'dependencies', descriptor);
    },
    name: 'Result own-key order',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      getResult(trace).code += ' ';
    },
    name: 'JavaScript byte',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      getResult(trace).cssText = getResult(trace).cssText?.replace(
        'red',
        'RED'
      );
    },
    name: 'CSS byte',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      const { rules } = getResult(trace);
      if (!rules) throw new Error('rules are missing');
      const descriptors = Object.entries(
        Object.getOwnPropertyDescriptors(rules)
      ).reverse();
      for (const [key] of descriptors) Reflect.deleteProperty(rules, key);
      for (const [key, descriptor] of descriptors) {
        Object.defineProperty(rules, key, descriptor);
      }
    },
    name: 'CSS rule order',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      const rule = getResult(trace).rules?.['.second'];
      if (rule) rule.cssText = 'display:inline;';
    },
    name: 'CSS rule content',
  },
  {
    expectedPath: 'decodedMappings',
    mutate: (trace) => {
      getResult(trace).sourceMap = createSourceMap({ column: 1 });
    },
    name: 'decoded JavaScript mapping',
  },
  {
    expectedPath: 'decodedMappings',
    mutate: (trace) => {
      getResult(trace).cssSourceMapText = JSON.stringify(
        createSourceMap({ column: 1 })
      );
    },
    name: 'decoded CSS mapping',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      getResult(trace).sourceMap = createSourceMap({ source: 'other.ts' });
    },
    name: 'source-map sources',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      getResult(trace).sourceMap = createSourceMap({ content: 'changed\n' });
    },
    name: 'source-map sourcesContent',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      getResult(trace).sourceMap = createSourceMap({ name: 'renamed' });
    },
    name: 'source-map names',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      getResult(trace).sourceMap = createSourceMap({ extension: 'changed' });
    },
    name: 'unknown source-map extension',
  },
  {
    expectedPath: 'descriptor.writable',
    mutate: (trace) => {
      const sourceMap = getResult(trace).sourceMap as unknown as Record<
        string,
        unknown
      >;
      const descriptor = Object.getOwnPropertyDescriptor(sourceMap, 'mappings');
      if (!descriptor) throw new Error('source-map mappings are missing');
      Object.defineProperty(sourceMap, 'mappings', {
        ...descriptor,
        writable: false,
      });
    },
    name: 'source-map field descriptor',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      getResult(trace).dependencies?.reverse();
    },
    name: 'dependency order',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      getResult(trace).dependencies?.push('/root/tokens.js');
    },
    name: 'duplicate dependency',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      const resolution = getResult(trace).dependencyResolutions?.[0];
      if (resolution) resolution.resolved = '/root/other.js';
    },
    name: 'dependency resolution',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.graph.edges[0][1] = 'other.js';
    },
    name: 'dependency graph edge',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      const processor = getResult(trace).metadata?.processors[0];
      if (processor) processor.className = 'changed';
    },
    name: 'metadata artifact',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      const diagnostic = getResult(trace).diagnostics?.[0];
      if (diagnostic) diagnostic.message = 'changed';
    },
    name: 'diagnostic',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      const replacement = getResult(trace).replacements?.[0];
      if (replacement) replacement.length += 1;
    },
    name: 'replacement',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].events[0].value = 'changed';
    },
    name: 'warning event',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].events[2].actionIdx = 'action:1:1';
    },
    name: 'action reference',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].events[3].actionIdx = '/root/entry.js\0import\0other-package';
    },
    name: 'semantic eval action argument',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      (trace[0].events as SyntheticEvent[]).reverse();
    },
    name: 'callback event order',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      (trace[0].events as SyntheticEvent[]).pop();
    },
    name: 'missing callback event',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      (trace[0].events as SyntheticEvent[]).push({
        channel: 'callback',
        value: 'two',
      });
    },
    name: 'duplicate callback event',
  },
  {
    expectedPath: 'className',
    mutate: (trace) => {
      getErrorOutcome(trace).error =
        createAlternativeOracleError('synthetic failure');
    },
    name: 'error class',
  },
  {
    expectedPath: 'steps[2]',
    mutate: (trace) => {
      getErrorOutcome(trace).error = new OracleError('changed');
    },
    name: 'error message',
  },
  {
    expectedPath: '.name',
    mutate: (trace) => {
      (getErrorOutcome(trace).error as OracleError).name = 'ChangedErrorName';
    },
    name: 'error name',
  },
  {
    expectedPath: 'steps[2]',
    mutate: (trace) => {
      const error = getErrorOutcome(trace).error as OracleError;
      Object.defineProperty(error, 'code', {
        ...Object.getOwnPropertyDescriptor(error, 'code'),
        value: 'E_CHANGED',
      });
    },
    name: 'error code',
  },
  {
    expectedPath: 'steps[2]',
    mutate: (trace) => {
      const error = getErrorOutcome(trace).error as OracleError;
      error.cause.message = 'changed cause';
    },
    name: 'error cause',
  },
  {
    expectedPath: 'steps[2]',
    mutate: (trace) => {
      getErrorOutcome(trace).phase = 'collect';
    },
    name: 'error phase',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.cache.salt = 'changed';
    },
    name: 'cache state',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.callbacks.resolver += 1;
    },
    name: 'callback count',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.invalidation.push('other.js');
    },
    name: 'invalidation state',
  },
  {
    expectedPath: 'steps[1]',
    mutate: (trace) => {
      getResult(trace, 1).code += '// changed rebuild\n';
    },
    name: 'warm rebuild result',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.special.holey[0] = undefined;
    },
    name: 'array hole versus undefined',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.special.negativeZero = 0;
    },
    name: 'negative zero',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.special.notANumber = Number.POSITIVE_INFINITY;
    },
    name: 'non-finite number',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.special.veryLarge += 1n;
    },
    name: 'bigint',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.special.orderedMap = new Map([
        ['second', 2],
        ['first', 1],
      ]);
    },
    name: 'Map insertion order',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.special.orderedSet = new Set(['second', 'first']);
    },
    name: 'Set insertion order',
  },
  {
    expectedPath: 'steps[0]',
    mutate: (trace) => {
      trace[0].state.alias[1] = { value: 'shared' };
    },
    name: 'shared reference identity',
  },
];
/* eslint-enable no-param-reassign */

const registerTests = (): void => {
  describe('differential transform oracle', () => {
    it('accepts equivalent full traces and semantic source-map formatting', async () => {
      const authoritative = createSyntheticTrace();
      const candidate = createSyntheticTrace();
      const cssMap = JSON.parse(
        getResult(candidate).cssSourceMapText ?? '{}'
      ) as Record<string, unknown>;
      getResult(candidate).cssSourceMapText = JSON.stringify(
        Object.fromEntries(Object.entries(cssMap).reverse()),
        null,
        2
      );

      await expect(
        assertDifferentialTraceEqual(authoritative, candidate)
      ).resolves.toBeUndefined();
    });

    it.each(mutationCases)(
      'rejects a single $name mutation at $expectedPath',
      async ({ expectedPath, mutate }) => {
        const authoritative = createSyntheticTrace();
        const candidate = createSyntheticTrace();
        mutate(candidate);

        await expect(
          assertDifferentialTraceEqual(authoritative, candidate)
        ).rejects.toThrow(expectedPath);
      }
    );

    it.each([
      ['function', () => () => 'unsupported'],
      ['symbol', () => Symbol('unsupported')],
      ['exotic object', () => new URL('https://example.test/')],
    ])(
      'fails closed for an unsupported %s artifact',
      async (_name, factory) => {
        const trace = createSyntheticTrace();
        (trace[0].state as unknown as Record<string, unknown>).unsupported =
          factory();
        await expect(captureDifferentialTrace(trace)).rejects.toThrow(
          'uncomparable'
        );
      }
    );

    it('fails closed on a source-map accessor without invoking it', async () => {
      const trace = createSyntheticTrace();
      const sourceMap = getResult(trace).sourceMap as unknown as Record<
        string,
        unknown
      >;
      const descriptor = Object.getOwnPropertyDescriptor(sourceMap, 'mappings');
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('source-map mappings are missing');
      }
      let reads = 0;
      Object.defineProperty(sourceMap, 'mappings', {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: () => {
          reads += 1;
          return descriptor.value;
        },
      });

      await expect(captureDifferentialTrace(trace)).rejects.toThrow(
        'source-map accessor'
      );
      expect(reads).toBe(0);
    });

    it('normalizes only declared synthetic event ids and keeps semantic ids', () => {
      const events: CorpusEvent[] = [];
      const { assertSettled, eventEmitter } = createEventEmitter(
        events,
        (channel, details = {}) => events.push({ channel, ...details })
      );
      eventEmitter.entrypointEvent(41, {
        class: 'Entrypoint',
        evaluatedOnly: [],
        filename: '/root/entry.js',
        generation: 1,
        idx: '00042',
        isExportsInherited: false,
        only: [],
        parentId: null,
        type: 'created',
      });
      eventEmitter.entrypointEvent(41, {
        actionIdx: '00abcd',
        actionType: 'processEntrypoint',
        type: 'actionCreated',
      });
      eventEmitter.action(
        'processEntrypoint',
        '00abcd:1',
        '00042#1',
        () => undefined
      );
      const semanticActionIdx = '/root/entry.js\0import\0oracle-warning';
      eventEmitter.action(
        'eval:resolveImport',
        semanticActionIdx,
        '/root/entry.js',
        () => undefined
      );
      eventEmitter.single({
        file: '/root/entry.js',
        fileIdx: '00042',
        imports: [],
        only: [],
        type: 'dependency',
      });
      eventEmitter.perf('oracle-method', () => undefined);
      assertSettled();

      const actionStarts = events.filter(
        (event) => event.channel === 'action' && event.phase === 'start'
      );
      expect(actionStarts).toHaveLength(2);
      expect(actionStarts[0]).toMatchObject({
        actionIdx: 'action:0:1',
        entrypointRef: 'file:0#1',
      });
      expect(actionStarts[1]).toMatchObject({
        actionIdx: semanticActionIdx,
        entrypointRef: '/root/entry.js',
      });

      const single = events.find(
        (event) =>
          event.channel === 'event' &&
          (event.labels as Record<string, unknown>).type === 'dependency'
      );
      expect(single?.labels).toEqual({
        file: '/root/entry.js',
        fileIdx: 'file:0',
        imports: [],
        only: [],
        type: 'dependency',
      });

      const perf = events.filter((event) => event.channel === 'perf');
      expect(perf).toEqual([
        {
          channel: 'perf',
          event: {
            method: 'oracle-method',
            spanId: 0,
            type: 'perf-span-start',
          },
          labels: { method: 'oracle-method' },
          phase: 'start',
        },
        {
          channel: 'perf',
          event: {
            isAsync: false,
            method: 'oracle-method',
            spanId: 0,
            status: 'finished',
            type: 'perf-span',
          },
          labels: { method: 'oracle-method' },
          phase: 'finish',
        },
      ]);
    });

    it('rejects an unknown synthetic action reference', () => {
      const events: CorpusEvent[] = [];
      const { eventEmitter } = createEventEmitter(
        events,
        (channel, details = {}) => events.push({ channel, ...details })
      );
      expect(() =>
        eventEmitter.action(
          'processEntrypoint',
          'ffffff:1',
          '/root/entry.js',
          () => undefined
        )
      ).toThrow('unknown action id reference');
    });

    it('compares the complete transform corpus in separate processes', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-differential-oracle-'));
      try {
        const authoritative = await runCorpusInChild(root);
        const candidate = await runCorpusInChild(root);

        expect(authoritative.pid).not.toBe(candidate.pid);
        expect(authoritative.snapshot.steps.map((step) => step.name)).toEqual([
          'ignored',
          'no-artifacts',
          'css:static',
          'css:hybrid',
          'css:execute',
          'warning:require-fallback',
          'diagnostic-css',
          'error:strict',
          'error:soft',
          'watch:cold',
          'watch:unchanged',
          'watch:changed',
          'watch:removed',
          'watch:recovered',
        ]);
        assertDifferentialSnapshotsEqual(
          authoritative.snapshot,
          candidate.snapshot
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }, 120_000);
  });
};

const runChild = async (): Promise<void> => {
  const root = process.env[CHILD_ROOT];
  if (!root) throw new Error(`${CHILD_ROOT} is required in child mode`);
  const resolvedRoot = resolve(root);
  const allowedPrefix = join(resolve(tmpdir()), 'wyw-differential-oracle-');
  if (!resolvedRoot.startsWith(allowedPrefix)) {
    throw new Error(
      `${CHILD_ROOT} must be an oracle-owned temporary directory`
    );
  }
  const snapshot = await captureDifferentialTrace(
    await runCorpus(resolvedRoot)
  );
  process.stdout.write(`${CHILD_MARKER}${JSON.stringify(snapshot)}\n`);
};

if (process.env[CHILD_MODE] === '1') {
  await runChild();
} else {
  registerTests();
}
