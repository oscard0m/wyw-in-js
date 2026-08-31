import { inspect } from 'node:util';

import { SourceMapConsumer } from 'source-map';

import type { Result } from '../../types';

export const DIFFERENTIAL_TRACE_SCHEMA_VERSION = 1 as const;

export type DifferentialOutcome =
  | { kind: 'result'; value: Result }
  | { error: unknown; kind: 'error'; phase: string };

export type DifferentialStep<TEvent = unknown, TState = unknown> = {
  events: readonly TEvent[];
  name: string;
  outcome: DifferentialOutcome;
  state: TState;
};

export type DifferentialTrace<
  TEvent = unknown,
  TState = unknown,
> = readonly DifferentialStep<TEvent, TState>[];

type EncodedDescriptor =
  | {
      configurable: boolean;
      enumerable: boolean;
      kind: 'data';
      writable: boolean;
    }
  | {
      configurable: boolean;
      enumerable: boolean;
      hasGetter: boolean;
      hasSetter: boolean;
      kind: 'accessor';
    };

type EncodedProperty = {
  descriptor: EncodedDescriptor;
  key: string;
  value?: EncodedValue;
};

type EncodedValue =
  | { kind: 'bigint'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; id: number; properties: EncodedProperty[]; value: string }
  | {
      className: string;
      fields: EncodedProperty[];
      id: number;
      kind: 'error';
      message: string;
      name: string;
    }
  | {
      entries: Array<[EncodedValue, EncodedValue]>;
      id: number;
      kind: 'map';
      properties: EncodedProperty[];
    }
  | { kind: 'null' }
  | {
      id: number;
      kind: 'object' | 'array';
      properties: EncodedProperty[];
      prototype: 'Array' | 'Object' | 'null';
    }
  | { kind: 'number'; value: string }
  | { kind: 'ref'; id: number }
  | {
      flags: string;
      id: number;
      kind: 'regexp';
      properties: EncodedProperty[];
      source: string;
    }
  | {
      id: number;
      kind: 'set';
      properties: EncodedProperty[];
      values: EncodedValue[];
    }
  | { kind: 'string'; value: string }
  | { kind: 'undefined' };

type SourceMapSnapshot = {
  decodedMappings: Array<{
    generatedColumn: number;
    generatedLine: number;
    lastGeneratedColumn: number | null;
    name: string | null;
    originalColumn: number | null;
    originalLine: number | null;
    source: string | null;
  }>;
  fields: Array<{
    descriptor: EncodedDescriptor;
    key: string;
    value?: EncodedValue;
  }>;
  kind: 'source-map';
};

type ResultSnapshot = {
  kind: 'result';
  properties: Array<{
    descriptor: EncodedDescriptor;
    key: string;
    value: EncodedValue | SourceMapSnapshot;
  }>;
  prototype: 'Object' | 'null';
};

type ErrorSnapshot = Extract<EncodedValue, { kind: 'error' }>;

export type DifferentialSnapshot = {
  schemaVersion: typeof DIFFERENTIAL_TRACE_SCHEMA_VERSION;
  steps: Array<{
    events: EncodedValue;
    name: string;
    outcome:
      | { kind: 'result'; value: ResultSnapshot }
      | { error: ErrorSnapshot; kind: 'error'; phase: string };
    state: EncodedValue;
  }>;
};

const differentialUncomparable = (path: string, reason: string): Error => {
  const error = new Error(
    `Differential artifact is uncomparable at ${path}: ${reason}`
  );
  error.name = 'DifferentialUncomparableError';
  return error;
};

const encodeNumber = (value: number): string => {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return String(value);
};

const describePrototype = (
  value: object,
  path: string
): 'Array' | 'Object' | 'null' => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return 'null';
  if (prototype === Object.prototype) return 'Object';
  if (prototype === Array.prototype) return 'Array';

  const name = (prototype as { constructor?: { name?: string } }).constructor
    ?.name;
  throw differentialUncomparable(
    path,
    `unsupported object prototype ${name ?? '<anonymous>'}`
  );
};

const snapshotDescriptor = (
  descriptor: PropertyDescriptor
): EncodedDescriptor => {
  if ('value' in descriptor) {
    return {
      configurable: descriptor.configurable ?? false,
      enumerable: descriptor.enumerable ?? false,
      kind: 'data',
      writable: descriptor.writable ?? false,
    };
  }

  return {
    configurable: descriptor.configurable ?? false,
    enumerable: descriptor.enumerable ?? false,
    hasGetter: descriptor.get !== undefined,
    hasSetter: descriptor.set !== undefined,
    kind: 'accessor',
  };
};

class ArtifactEncoder {
  private nextId = 0;

  private readonly seen = new Map<object, number>();

  public encode(value: unknown, path: string): EncodedValue {
    if (value === null) return { kind: 'null' };

    switch (typeof value) {
      case 'undefined':
        return { kind: 'undefined' };
      case 'boolean':
        return { kind: 'boolean', value };
      case 'string':
        return { kind: 'string', value };
      case 'number':
        return { kind: 'number', value: encodeNumber(value) };
      case 'bigint':
        return { kind: 'bigint', value: value.toString(10) };
      case 'function':
      case 'symbol':
        throw differentialUncomparable(path, `unsupported ${typeof value}`);
      case 'object':
        return this.encodeObject(value, path);
      default:
        throw differentialUncomparable(path, `unsupported ${typeof value}`);
    }
  }

  private encodeObject(value: object, path: string): EncodedValue {
    const knownId = this.seen.get(value);
    if (knownId !== undefined) return { id: knownId, kind: 'ref' };

    const id = this.nextId;
    this.nextId += 1;
    this.seen.set(value, id);

    if (value instanceof Error) return this.encodeError(value, id, path);
    if (value instanceof Date) {
      return {
        id,
        kind: 'date',
        properties: this.encodeProperties(value, path),
        value: value.toISOString(),
      };
    }
    if (value instanceof RegExp) {
      return {
        flags: value.flags,
        id,
        kind: 'regexp',
        properties: this.encodeProperties(value, path),
        source: value.source,
      };
    }
    if (value instanceof Map) {
      const entries = Array.from(
        value.entries(),
        ([key, entryValue], index) =>
          [
            this.encode(key, `${path}.entries[${index}].key`),
            this.encode(entryValue, `${path}.entries[${index}].value`),
          ] as [EncodedValue, EncodedValue]
      );
      return {
        entries,
        id,
        kind: 'map',
        properties: this.encodeProperties(value, path),
      };
    }
    if (value instanceof Set) {
      return {
        id,
        kind: 'set',
        properties: this.encodeProperties(value, path),
        values: Array.from(value, (entryValue, index) =>
          this.encode(entryValue, `${path}.values[${index}]`)
        ),
      };
    }

    const prototype = describePrototype(value, path);
    return {
      id,
      kind: Array.isArray(value) ? 'array' : 'object',
      properties: this.encodeProperties(value, path),
      prototype,
    };
  }

  private encodeError(error: Error, id: number, path: string): ErrorSnapshot {
    return {
      className: error.constructor.name,
      fields: ['code', 'cause'].flatMap((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(error, key);
        if (!descriptor) return [];
        if (!('value' in descriptor)) {
          throw differentialUncomparable(
            `${path}.${key}`,
            'error accessor cannot be compared without executing it'
          );
        }
        return [
          {
            descriptor: snapshotDescriptor(descriptor),
            key,
            value: this.encode(descriptor.value, `${path}.${key}`),
          },
        ];
      }),
      id,
      kind: 'error',
      message: error.message,
      name: error.name,
    };
  }

  private encodeProperties(
    value: object,
    path: string,
    excluded = new Set<string>()
  ): EncodedProperty[] {
    const keys = Reflect.ownKeys(value);
    const symbol = keys.find((key): key is symbol => typeof key === 'symbol');
    if (symbol) {
      throw differentialUncomparable(
        path,
        `symbol property ${String(symbol.description ?? symbol)}`
      );
    }

    return (keys as string[])
      .filter((key) => !excluded.has(key))
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) {
          throw differentialUncomparable(
            `${path}.${key}`,
            'property disappeared while being observed'
          );
        }

        const encodedDescriptor = snapshotDescriptor(descriptor);
        if (!('value' in descriptor)) {
          throw differentialUncomparable(
            `${path}.${key}`,
            'accessor properties cannot be observed without executing code'
          );
        }

        return {
          descriptor: encodedDescriptor,
          key,
          value: this.encode(descriptor.value, `${path}.${key}`),
        };
      });
  }
}

const snapshotSourceMap = async (
  value: unknown,
  path: string
): Promise<SourceMapSnapshot> => {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw differentialUncomparable(
      path,
      `invalid source map JSON: ${(error as Error).message}`
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw differentialUncomparable(path, 'source map is not an object');
  }

  describePrototype(parsed, path);

  const keys = Reflect.ownKeys(parsed);
  const symbol = keys.find((key): key is symbol => typeof key === 'symbol');
  if (symbol) {
    throw differentialUncomparable(
      path,
      `source map has symbol property ${String(symbol.description ?? symbol)}`
    );
  }

  const descriptors = new Map<string, PropertyDescriptor>();
  const safeMap: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(parsed, key);
    if (!descriptor) {
      throw differentialUncomparable(
        `${path}.${key}`,
        'source-map property disappeared while being observed'
      );
    }
    if (!('value' in descriptor)) {
      throw differentialUncomparable(
        `${path}.${key}`,
        'source-map accessor cannot be compared without executing it'
      );
    }
    descriptors.set(key, descriptor);
    Object.defineProperty(safeMap, key, descriptor);
  }

  const fieldsEncoder = new ArtifactEncoder();
  const fields = (keys as string[]).sort().map((key) => {
    const descriptor = descriptors.get(key);
    if (!descriptor || !('value' in descriptor)) {
      throw differentialUncomparable(
        `${path}.${key}`,
        'source-map descriptor invariant failed'
      );
    }
    return {
      descriptor: snapshotDescriptor(descriptor),
      key,
      ...(key === 'mappings'
        ? {}
        : {
            value: fieldsEncoder.encode(descriptor.value, `${path}.${key}`),
          }),
    };
  });

  let decodedMappings: SourceMapSnapshot['decodedMappings'];
  try {
    decodedMappings = await SourceMapConsumer.with(
      safeMap as unknown as Parameters<typeof SourceMapConsumer.with>[0],
      null,
      (consumer) => {
        const mappings: SourceMapSnapshot['decodedMappings'] = [];
        consumer.eachMapping(
          (mapping) => {
            mappings.push({
              generatedColumn: mapping.generatedColumn,
              generatedLine: mapping.generatedLine,
              lastGeneratedColumn: mapping.lastGeneratedColumn,
              name: mapping.name ?? null,
              originalColumn: mapping.originalColumn ?? null,
              originalLine: mapping.originalLine ?? null,
              source: mapping.source ?? null,
            });
          },
          null,
          SourceMapConsumer.GENERATED_ORDER
        );
        return mappings;
      }
    );
  } catch (error) {
    throw differentialUncomparable(
      path,
      `cannot decode source map: ${(error as Error).message}`
    );
  }

  return { decodedMappings, fields, kind: 'source-map' };
};

const snapshotResult = async (
  result: Result,
  path: string
): Promise<ResultSnapshot> => {
  const prototype = describePrototype(result, path);
  if (prototype === 'Array') {
    throw differentialUncomparable(path, 'Result cannot be an array');
  }

  const keys = Reflect.ownKeys(result);
  const symbol = keys.find((key): key is symbol => typeof key === 'symbol');
  if (symbol) {
    throw differentialUncomparable(
      path,
      `Result has symbol property ${String(symbol.description ?? symbol)}`
    );
  }

  const encoder = new ArtifactEncoder();
  const properties = await Promise.all(
    (keys as string[]).map(async (key) => {
      const descriptor = Object.getOwnPropertyDescriptor(result, key);
      if (!descriptor) {
        throw differentialUncomparable(
          `${path}.${key}`,
          'Result property disappeared while being observed'
        );
      }
      if (!('value' in descriptor)) {
        throw differentialUncomparable(
          `${path}.${key}`,
          'Result accessor cannot be compared without executing it'
        );
      }

      const fieldValue = descriptor.value;
      let value: EncodedValue | SourceMapSnapshot;
      if (
        key === 'sourceMap' &&
        fieldValue !== null &&
        fieldValue !== undefined
      ) {
        value = await snapshotSourceMap(fieldValue, `${path}.${key}`);
      } else if (
        key === 'cssSourceMapText' &&
        typeof fieldValue === 'string' &&
        fieldValue.length > 0
      ) {
        value = await snapshotSourceMap(fieldValue, `${path}.${key}`);
      } else {
        value = encoder.encode(fieldValue, `${path}.${key}`);
      }

      return {
        descriptor: snapshotDescriptor(descriptor),
        key,
        value,
      };
    })
  );

  return { kind: 'result', properties, prototype };
};

const snapshotError = (error: unknown, path: string): ErrorSnapshot => {
  if (!(error instanceof Error)) {
    throw differentialUncomparable(path, 'thrown value is not an Error');
  }

  const encoded = new ArtifactEncoder().encode(error, path);
  if (encoded.kind !== 'error') {
    throw differentialUncomparable(path, 'error encoder invariant failed');
  }
  return encoded;
};

export const captureDifferentialTrace = async <TEvent, TState>(
  trace: DifferentialTrace<TEvent, TState>
): Promise<DifferentialSnapshot> => ({
  schemaVersion: DIFFERENTIAL_TRACE_SCHEMA_VERSION,
  steps: await Promise.all(
    trace.map(async (step, index) => {
      const path = `steps[${index}]`;
      return {
        events: new ArtifactEncoder().encode(step.events, `${path}.events`),
        name: step.name,
        outcome:
          step.outcome.kind === 'result'
            ? {
                kind: 'result' as const,
                value: await snapshotResult(
                  step.outcome.value,
                  `${path}.outcome.result`
                ),
              }
            : {
                error: snapshotError(
                  step.outcome.error,
                  `${path}.outcome.error`
                ),
                kind: 'error' as const,
                phase: step.outcome.phase,
              },
        state: new ArtifactEncoder().encode(step.state, `${path}.state`),
      };
    })
  ),
});

type Difference = { actual: unknown; expected: unknown; path: string };

const findFirstDifference = (
  expected: unknown,
  actual: unknown,
  path = '$'
): Difference | null => {
  if (Object.is(expected, actual)) return null;
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object'
  ) {
    return { actual, expected, path };
  }

  const expectedArray = Array.isArray(expected);
  if (expectedArray !== Array.isArray(actual)) {
    return { actual, expected, path };
  }

  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    return {
      actual: actualKeys,
      expected: expectedKeys,
      path: `${path}.[keys]`,
    };
  }

  for (const key of expectedKeys) {
    const keyPath = expectedArray ? `${path}[${key}]` : `${path}.${key}`;
    const difference = findFirstDifference(
      (expected as Record<string, unknown>)[key],
      (actual as Record<string, unknown>)[key],
      keyPath
    );
    if (difference) return difference;
  }

  return null;
};

export const assertDifferentialSnapshotsEqual = (
  authoritative: DifferentialSnapshot,
  candidate: DifferentialSnapshot
): void => {
  if (
    authoritative.schemaVersion !== DIFFERENTIAL_TRACE_SCHEMA_VERSION ||
    candidate.schemaVersion !== DIFFERENTIAL_TRACE_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported differential snapshot schema: ${authoritative.schemaVersion}/${candidate.schemaVersion}`
    );
  }

  const difference = findFirstDifference(authoritative, candidate);
  if (!difference) return;

  throw new Error(
    [
      `Differential trace mismatch at ${difference.path}`,
      `authoritative: ${inspect(difference.expected, { depth: 3 })}`,
      `candidate: ${inspect(difference.actual, { depth: 3 })}`,
    ].join('\n')
  );
};

export const assertDifferentialTraceEqual = async <TEvent, TState>(
  authoritative: DifferentialTrace<TEvent, TState>,
  candidate: DifferentialTrace<TEvent, TState>
): Promise<void> => {
  const [authoritativeSnapshot, candidateSnapshot] = await Promise.all([
    captureDifferentialTrace(authoritative),
    captureDifferentialTrace(candidate),
  ]);
  assertDifferentialSnapshotsEqual(authoritativeSnapshot, candidateSnapshot);
};
