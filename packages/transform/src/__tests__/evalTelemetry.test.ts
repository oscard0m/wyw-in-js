import { EventEmitter } from '../utils/EventEmitter';
import {
  beginEvalTelemetry,
  EVAL_TELEMETRY_SCHEMA,
  measureCanonicalImportMapBytes,
  recordEvalBrokerLifecycle,
  registerEvalTelemetryReporter,
  type EvalTelemetryRecord,
} from '../debug/evalTelemetry';
import { serializeEvalTelemetryJSONl } from '../debug/evalTelemetry.jsonl';
import { EVAL_PREPARATION_ARTIFACT_LIMIT } from '../debug/evalTelemetry.types';

const createEmitter = () =>
  new EventEmitter(
    () => {},
    (() => 0) as never,
    () => {}
  );

describe('eval telemetry', () => {
  const captureRoot = (entrypoint: string): EvalTelemetryRecord => {
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const token = beginEvalTelemetry(emitter, {}, () => ({ entrypoint }));
    token!.start({ batchIndex: 0, batchSize: 1 });
    token!.finish('success');
    unregister();
    return records[0];
  };

  it('does not evaluate lazy metadata without a registered reporter', () => {
    const emitter = createEmitter();
    const broker = {};
    let rootMetadataCalls = 0;
    let lifecycleMetadataCalls = 0;

    const token = beginEvalTelemetry(emitter, broker, () => {
      rootMetadataCalls += 1;
      throw new Error('root metadata must stay lazy');
    });
    recordEvalBrokerLifecycle(emitter, broker, () => {
      lifecycleMetadataCalls += 1;
      throw new Error('lifecycle metadata must stay lazy');
    });

    expect(token).toBeUndefined();
    expect(rootMetadataCalls).toBe(0);
    expect(lifecycleMetadataCalls).toBe(0);
  });

  it('keeps root counters isolated and emits exact cache denominators', () => {
    const emitter = createEmitter();
    const broker = {};
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });

    const first = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: '/repo/a.ts',
    }));
    const second = beginEvalTelemetry(emitter, broker, () => ({
      entrypoint: '/repo/b.ts',
    }));
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    first!.start({ batchIndex: 0, batchSize: 2 });
    first!.recordLoadRequest();
    first!.recordLoadCacheOutcome('miss');
    const preparation = first!.beginPreparation('/repo/dep.ts', ['value']);
    const shaken = preparation.measureStage('shake', () => 'shaken');
    const stripped = preparation.measureStage('strip', () => `${shaken}!`);
    preparation.finish({
      code: 'export const value = "λ";',
      imports: new Map([['./nested.ts', ['nested']]]),
      only: ['value'],
      outputRevision: 'revision-a',
    });
    expect(stripped).toBe('shaken!');
    first!.finish('success', {
      entries: 1,
      knownCodeBytes: 26,
      unknownByteEntries: 0,
    });

    second!.start({ batchIndex: 1, batchSize: 2 });
    second!.recordLoadRequest();
    second!.recordLoadCacheOutcome('hit');
    second!.finish('no-values', {
      entries: 1,
      knownCodeBytes: 26,
      unknownByteEntries: 0,
    });
    unregister();

    const roots = records.filter((record) => record.type === 'eval-root');
    expect(roots).toHaveLength(2);
    expect(roots[0]).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        root: expect.objectContaining({
          batchIndex: 0,
          batchSize: 2,
          entrypoint: '/repo/a.ts',
          status: 'success',
        }),
        loads: expect.objectContaining({
          requests: 1,
          cache: expect.objectContaining({
            hits: 0,
            misses: 1,
          }),
          preparation: expect.objectContaining({
            calls: 1,
            errors: 0,
            preparedCodeBytes: Buffer.byteLength('export const value = "λ";'),
            shakeCalls: 1,
            stripCalls: 1,
          }),
        }),
      })
    );
    if (roots[0].type !== 'eval-root') {
      throw new Error('expected eval-root record');
    }
    expect(roots[0].loads.preparation.artifacts).toEqual([
      expect.objectContaining({
        calls: 1,
        id: '/repo/dep.ts',
        onlyShape: 'named',
        outputRevision: 'revision-a',
      }),
    ]);

    expect(roots[1]).toEqual(
      expect.objectContaining({
        root: expect.objectContaining({
          batchIndex: 1,
          entrypoint: '/repo/b.ts',
          status: 'no-values',
        }),
        loads: expect.objectContaining({
          requests: 1,
          cache: expect.objectContaining({
            hits: 1,
            misses: 0,
          }),
          preparation: expect.objectContaining({ calls: 0 }),
        }),
      })
    );
  });

  it('measures synchronous stage success and throw exactly', () => {
    let clock = 0;
    const now = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const failure = new Error('strip failed');

    try {
      const token = beginEvalTelemetry(emitter, {}, () => ({
        entrypoint: '/repo/root.ts',
      }));
      clock = 5;
      token!.start({ batchIndex: 0, batchSize: 1 });
      clock = 10;
      const preparation = token!.beginPreparation('/repo/dep.ts', ['value']);

      clock = 20;
      expect(
        preparation.measureStage('shake', () => {
          clock = 26;
          return 'shaken';
        })
      ).toBe('shaken');

      clock = 30;
      expect(() =>
        preparation.measureStage('strip', () => {
          clock = 39;
          throw failure;
        })
      ).toThrow(failure);

      clock = 50;
      preparation.fail();
      clock = 60;
      token!.finish('error');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].loads.preparation).toEqual({
        artifacts: [
          {
            calls: 1,
            durationMs: 40,
            errors: 1,
            id: '/repo/dep.ts',
            importMapBytes: 0,
            onlyShape: 'named',
            outputRevision: null,
            prepareCalls: 0,
            prepareMs: 0,
            preparedCodeBytes: 0,
            shakeCalls: 1,
            shakeMs: 6,
            stripCalls: 1,
            stripMs: 9,
          },
        ],
        calls: 1,
        droppedArtifacts: 0,
        durationMs: 40,
        errors: 1,
        importMapBytes: 0,
        prepareCalls: 0,
        prepareMs: 0,
        preparedCodeBytes: 0,
        shakeCalls: 1,
        shakeMs: 6,
        stripCalls: 1,
        stripMs: 9,
      });
    } finally {
      unregister();
      now.mockRestore();
    }
  });

  it('aggregates a repeated preparation before and after adding a distinct artifact', () => {
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const token = beginEvalTelemetry(emitter, {}, () => ({
      entrypoint: '/repo/root.ts',
    }));
    const finishPreparation = (id: string, outputRevision: string) => {
      token!.beginPreparation(id, ['value']).finish({
        code: `export const value = '${id}';`,
        imports: null,
        only: ['value'],
        outputRevision,
      });
    };

    try {
      token!.start({ batchIndex: 0, batchSize: 1 });
      finishPreparation('/repo/repeated.ts', 'revision-a');
      finishPreparation('/repo/repeated.ts', 'revision-a');
      finishPreparation('/repo/distinct.ts', 'revision-b');
      finishPreparation('/repo/repeated.ts', 'revision-a');
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].loads.preparation.artifacts).toEqual([
        expect.objectContaining({
          calls: 3,
          id: '/repo/repeated.ts',
          outputRevision: 'revision-a',
        }),
        expect.objectContaining({
          calls: 1,
          id: '/repo/distinct.ts',
          outputRevision: 'revision-b',
        }),
      ]);
    } finally {
      unregister();
    }
  });

  it('keeps lazy artifact merging equivalent for null and empty revisions', () => {
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const token = beginEvalTelemetry(emitter, {}, () => ({
      entrypoint: '/repo/root.ts',
    }));

    try {
      token!.start({ batchIndex: 0, batchSize: 1 });
      token!.beginPreparation('/repo/dep.ts', ['value']).fail();
      token!.beginPreparation('/repo/dep.ts', ['value']).finish({
        code: 'export const value = 1;',
        imports: null,
        only: ['value'],
        outputRevision: '',
      });
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].loads.preparation.artifacts).toEqual([
        expect.objectContaining({
          calls: 2,
          errors: 1,
          id: '/repo/dep.ts',
          outputRevision: null,
        }),
      ]);
    } finally {
      unregister();
    }
  });

  it('merges existing artifacts and drops only new keys at the artifact limit', () => {
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const token = beginEvalTelemetry(emitter, {}, () => ({
      entrypoint: '/repo/root.ts',
    }));
    const finishPreparation = (id: string, outputRevision: string) => {
      token!.beginPreparation(id, ['value']).finish({
        code: `export const value = '${id}';`,
        imports: null,
        only: ['value'],
        outputRevision,
      });
    };

    try {
      token!.start({ batchIndex: 0, batchSize: 1 });
      for (let index = 0; index < EVAL_PREPARATION_ARTIFACT_LIMIT; index += 1) {
        finishPreparation(`/repo/dep-${index}.ts`, `revision-${index}`);
      }
      finishPreparation('/repo/dep-0.ts', 'revision-0');
      finishPreparation('/repo/overflow.ts', 'overflow-revision');
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      const [
        {
          loads: { preparation },
        },
      ] = roots;
      expect(preparation.artifacts).toHaveLength(
        EVAL_PREPARATION_ARTIFACT_LIMIT
      );
      expect(preparation.artifacts[0]).toEqual(
        expect.objectContaining({ calls: 2, id: '/repo/dep-0.ts' })
      );
      expect(preparation.droppedArtifacts).toBe(1);
    } finally {
      unregister();
    }
  });

  it('does not double count a Promise handler that settles and then throws', () => {
    let clock = 0;
    const now = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const failure = new Error('hostile then');

    try {
      const token = beginEvalTelemetry(emitter, {}, () => ({
        entrypoint: '/repo/root.ts',
      }));
      clock = 5;
      token!.start({ batchIndex: 0, batchSize: 1 });
      clock = 8;
      const preparation = token!.beginPreparation('/repo/dep.ts', ['value']);
      const hostile = Promise.resolve('value');
      hostile.then = ((
        onFulfilled?: ((value: string) => unknown) | null
      ): never => {
        clock = 20;
        onFulfilled?.('value');
        clock = 30;
        throw failure;
      }) as typeof hostile.then;

      clock = 10;
      expect(() => preparation.measureStage('shake', () => hostile)).toThrow(
        failure
      );
      clock = 40;
      preparation.fail();
      clock = 50;
      token!.finish('error');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].loads.preparation).toEqual(
        expect.objectContaining({
          shakeCalls: 1,
          shakeMs: 10,
        })
      );
    } finally {
      unregister();
      now.mockRestore();
    }
  });

  it('measures Promise settlement once and ignores settlement after root close', async () => {
    let clock = 0;
    const now = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });
    const rejection = new Error('async strip failed');

    try {
      const token = beginEvalTelemetry(emitter, {}, () => ({
        entrypoint: '/repo/root.ts',
      }));
      clock = 5;
      token!.start({ batchIndex: 0, batchSize: 1 });

      clock = 10;
      const resolvedPreparation = token!.beginPreparation('/repo/resolved.ts', [
        'value',
      ]);
      let resolveStage: ((value: string) => void) | undefined;
      const resolvedStage = new Promise<string>((resolve) => {
        resolveStage = resolve;
      });
      clock = 20;
      const measuredResolved = resolvedPreparation.measureStage(
        'shake',
        () => resolvedStage
      );
      expect(measuredResolved).toBe(resolvedStage);
      clock = 32;
      resolveStage?.('resolved');
      await expect(measuredResolved).resolves.toBe('resolved');
      clock = 40;
      resolvedPreparation.finish({
        code: 'export const value = 1;',
        imports: null,
        only: ['value'],
        outputRevision: 'resolved-revision',
      });

      clock = 50;
      const rejectedPreparation = token!.beginPreparation('/repo/rejected.ts', [
        'value',
      ]);
      let rejectStage: ((reason?: unknown) => void) | undefined;
      const rejectedStage = new Promise<never>((_resolve, reject) => {
        rejectStage = reject;
      });
      clock = 60;
      const measuredRejected = rejectedPreparation.measureStage(
        'strip',
        () => rejectedStage
      );
      expect(measuredRejected).toBe(rejectedStage);
      clock = 73;
      rejectStage?.(rejection);
      await expect(measuredRejected).rejects.toBe(rejection);
      clock = 80;
      rejectedPreparation.fail();

      clock = 90;
      const latePreparation = token!.beginPreparation('/repo/late.ts', [
        'value',
      ]);
      let resolveLateStage: ((value: string) => void) | undefined;
      const lateStage = new Promise<string>((resolve) => {
        resolveLateStage = resolve;
      });
      clock = 100;
      const measuredLate = latePreparation.measureStage(
        'prepare',
        () => lateStage
      );
      clock = 110;
      latePreparation.finish({
        code: 'export const value = 2;',
        imports: null,
        only: ['value'],
        outputRevision: 'late-revision',
      });
      clock = 120;
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      const [record] = roots;
      expect(record.loads.preparation).toEqual(
        expect.objectContaining({
          calls: 3,
          errors: 1,
          prepareCalls: 1,
          prepareMs: 0,
          shakeCalls: 1,
          shakeMs: 12,
          stripCalls: 1,
          stripMs: 13,
        })
      );
      expect(record.loads.preparation.artifacts).toEqual([
        expect.objectContaining({
          errors: 0,
          id: '/repo/resolved.ts',
          shakeCalls: 1,
          shakeMs: 12,
        }),
        expect.objectContaining({
          errors: 1,
          id: '/repo/rejected.ts',
          stripCalls: 1,
          stripMs: 13,
        }),
        expect.objectContaining({
          errors: 0,
          id: '/repo/late.ts',
          prepareCalls: 1,
          prepareMs: 0,
        }),
      ]);

      const emittedSnapshot = JSON.parse(JSON.stringify(record));
      now.mockClear();
      clock = 150;
      resolveLateStage?.('late');
      const lateValue = await measuredLate;
      const clockReadsAfterClose = now.mock.calls.length;
      expect(lateValue).toBe('late');
      expect(clockReadsAfterClose).toBe(0);
      expect(record).toEqual(emittedSnapshot);
    } finally {
      unregister();
      now.mockRestore();
    }
  });

  it('separates queue wait from execution duration', () => {
    const now = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(25)
      .mockReturnValueOnce(40);
    const emitter = createEmitter();
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });

    try {
      const token = beginEvalTelemetry(emitter, {}, () => ({
        entrypoint: '/repo/root.ts',
      }));
      token!.start({ batchIndex: 0, batchSize: 1 });
      token!.finish('success');

      const roots = records.filter((record) => record.type === 'eval-root');
      expect(roots).toHaveLength(1);
      expect(roots[0].root.queueWaitMs).toBe(15);
      expect(roots[0].root.durationMs).toBe(15);
    } finally {
      unregister();
      now.mockRestore();
    }
  });

  it('scopes lifecycle inference to the reporter registration window', () => {
    const emitter = createEmitter();
    const broker = {};
    const records: EvalTelemetryRecord[] = [];
    const unregister = registerEvalTelemetryReporter(emitter, (record) => {
      records.push(record);
    });

    recordEvalBrokerLifecycle(emitter, broker, () => ({
      event: 'broker-created',
      reason: 'constructor',
    }));
    recordEvalBrokerLifecycle(emitter, broker, () => ({
      event: 'runner-activated',
      reason: 'ensure',
    }));
    recordEvalBrokerLifecycle(emitter, broker, () => ({
      event: 'runner-activated',
      reason: 'happy-dom-replacement',
    }));
    unregister();
    recordEvalBrokerLifecycle(emitter, broker, () => ({
      event: 'broker-dispose-observed',
      reason: 'after-reporter-close',
    }));

    const lifecycle = records.filter(
      (record) => record.type === 'eval-lifecycle'
    );
    expect(lifecycle).toHaveLength(3);
    expect(lifecycle.map((record) => record.brokerId)).toEqual([1, 1, 1]);
    expect(lifecycle[1]).toEqual(
      expect.objectContaining({ restartInferred: false })
    );
    expect(lifecycle[2]).toEqual(
      expect.objectContaining({ restartInferred: true })
    );
  });

  it.each([
    ['/work/project/src/root.ts', '/work/project', 'src/root.ts'],
    ['C:\\work\\project\\src\\root.ts', 'C:\\work\\project', 'src\\root.ts'],
    ['D:\\private\\root.ts', 'C:\\work\\project', 'root.ts'],
    [
      '\\\\server-a\\project\\src\\root.ts',
      '\\\\server-a\\project',
      'src\\root.ts',
    ],
    ['\\\\server-b\\private\\root.ts', '\\\\server-a\\project', 'root.ts'],
    ['//server-b/private/root.ts', '//server-a/project', 'root.ts'],
    ['file:///Users/alice/private/root.ts', '/work/project', 'root.ts'],
    ['\0virtual:/Users/alice/private/root.ts', '/work/project', 'root.ts'],
    ['virtual:foo/bar.ts', '/work/project', 'virtual:foo/bar.ts'],
    ['../private/root.ts', '/work/project', 'root.ts'],
    ['..\\private\\root.ts', 'C:\\work\\project', 'root.ts'],
  ])(
    'serializes %s relative to %s without leaking private paths',
    (entrypoint, workingDirectory, expected) => {
      const serialized = serializeEvalTelemetryJSONl(
        captureRoot(entrypoint),
        workingDirectory
      );
      expect(JSON.parse(serialized).root.entrypoint).toBe(expected);
    }
  );

  it('freezes the schema recursively', () => {
    expect(Object.isFrozen(EVAL_TELEMETRY_SCHEMA)).toBe(true);
    expect(Object.isFrozen(EVAL_TELEMETRY_SCHEMA.denominators)).toBe(true);
    expect(Object.isFrozen(EVAL_TELEMETRY_SCHEMA.limitations)).toBe(true);
  });

  it('measures canonical import maps with sorted, deduplicated UTF-8 tuples', () => {
    const imports = new Map([
      ['./β.js', ['z', 'a', 'a']],
      ['./a.js', ['*', '*']],
    ]);
    const canonical = [
      ['./a.js', ['*']],
      ['./β.js', ['a', 'z']],
    ];

    expect(measureCanonicalImportMapBytes(imports)).toBe(
      Buffer.byteLength(JSON.stringify(canonical))
    );
  });
});
