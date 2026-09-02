import path from 'path';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import type { Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const filename = path.join(__dirname, '__fixtures__', 'foo.js');
const code = 'export const foo = 1;';

type Captured = { emitWarning: Services['emitWarning'] };

const runWith = (
  cache: TransformCacheCollection,
  emitWarning: (message: string) => void,
  captured: { workflow: Captured[]; nested: Captured[] } | null,
  eventEmitter: EventEmitter
) =>
  transform(
    {
      // a stable key keeps one eval session across runs, as the loaders do
      asyncResolveKey: 'transform.action-services.test',
      cache,
      emitWarning,
      eventEmitter,
      options: {
        filename,
        root: __dirname,
        pluginOptions: {
          configFile: false,
          // share `cache` between runs, as the bundler loaders do
          features: { globalCache: true },
          babelOptions: { babelrc: false, configFile: false },
        },
      },
    },
    code,
    async () => {
      throw new Error('no imports expected');
    },
    {
      // eslint-disable-next-line require-yield
      *workflow() {
        if (captured) {
          captured.workflow.push({ emitWarning: this.services.emitWarning });
          yield* this.getNext(
            'processEntrypoint',
            this.entrypoint,
            undefined,
            null
          );
        }
        return { code: '', sourceMap: null };
      },
      // eslint-disable-next-line require-yield
      *transform() {
        captured?.nested.push({ emitWarning: this.services.emitWarning });
        return { code, metadata: null };
      },
    } as Parameters<typeof transform>[3]
  );

describe('actions of a transform run', () => {
  it('use the services of the run that created them, not those of the cached entrypoint', async () => {
    const cache = new TransformCacheCollection();
    const warnA = () => {};
    const warnB = () => {};
    let emitterAClosed = false;
    const assertEmitterAOpen = () => {
      if (emitterAClosed) {
        throw new Error('run A emitter was used after its transform');
      }
    };
    const emitterA = new EventEmitter(
      assertEmitterAOpen,
      () => {
        assertEmitterAOpen();
        return 0;
      },
      assertEmitterAOpen
    );
    const eventsB: string[] = [];
    const emitterB = new EventEmitter(
      () => {},
      () => 0,
      (_sequenceId, _timestamp, event) => eventsB.push(event.type)
    );

    // Run A leaves a root entrypoint for `filename` in the shared cache that
    // was created with A's services and never processed, which is the state
    // the eval broker's on-demand preparation of a dependency leaves behind.
    await runWith(cache, warnA, null, emitterA);
    emitterAClosed = true;

    // Run B transforms the same, unchanged file. `innerCreate` reuses the
    // cached entrypoint as is (not changed, not evaluated, `only` covered).
    const captured = { workflow: [] as Captured[], nested: [] as Captured[] };
    await runWith(cache, warnB, captured, emitterB);

    const tagOf = (c: Captured) => (c.emitWarning === warnB ? 'B' : 'A');
    expect(captured.workflow.map(tagOf)).toEqual(['B']);
    expect(captured.nested.map(tagOf)).toEqual(['B']);
    expect(eventsB).toEqual(
      expect.arrayContaining([
        'actionCreated',
        'actionCreated',
        'actionCreated',
        'setTransformResult',
      ])
    );
  });
});
