import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type RunnerMessage = {
  error?: { message?: string };
  id?: string;
  modulesReset?: boolean;
  payload?: Record<string, unknown>;
  sessionId?: number;
  type: string;
};

const delay = (timeoutMs: number) =>
  new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, timeoutMs);
  });

const waitForFile = (filename: string, timeoutMs = 2_000) =>
  new Promise<void>((resolveFile, rejectFile) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (existsSync(filename)) {
        resolveFile();
      } else if (Date.now() >= deadline) {
        rejectFile(new Error(`Timed out waiting for ${filename}`));
      } else {
        setTimeout(poll, 10);
      }
    };
    poll();
  });

const createHarness = (cwd: string) => {
  const runnerPath = join(__dirname, '..', 'eval', 'runner.js');
  const nodeBinary = process.execPath.includes('bun')
    ? 'node'
    : process.execPath;
  const child = spawn(
    process.env.WYW_NODE_BINARY || nodeBinary,
    ['--experimental-vm-modules', runnerPath],
    {
      cwd,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        WYW_EVAL_RUNNER: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const messages: RunnerMessage[] = [];
  const listeners = new Set<() => void>();
  let stdoutBuffer = '';
  let stderr = '';

  child.stdout.on('data', (chunk: string) => {
    const lines = `${stdoutBuffer}${chunk}`.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        messages.push(JSON.parse(line) as RunnerMessage);
      }
    }
    for (const listener of listeners) listener();
    listeners.clear();
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const send = (...payloads: unknown[]) =>
    new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(
        `${payloads.map((payload) => JSON.stringify(payload)).join('\n')}\n`,
        (error) => {
          if (error) rejectWrite(error);
          else resolveWrite();
        }
      );
    });

  const take = async (
    predicate: (message: RunnerMessage) => boolean,
    timeoutMs = 2_000
  ): Promise<RunnerMessage> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index !== -1) {
        return messages.splice(index, 1)[0];
      }

      // eslint-disable-next-line no-await-in-loop
      await Promise.race([
        new Promise<void>((resolveMessage) => {
          listeners.add(resolveMessage);
        }),
        delay(Math.min(50, Math.max(1, deadline - Date.now()))),
      ]);
    }

    throw new Error(
      `Timed out waiting for eval runner message. stderr: ${stderr}`
    );
  };

  return { child, messages, send, take };
};

const initMessage = (
  id: string,
  sessionId: number,
  entrypoint: string,
  happyDOM = false,
  reuseModules = false
) => ({
  type: 'INIT',
  id,
  payload: {
    debugEvalFiles: false,
    entrypoint,
    evalOptions: {
      errors: 'strict',
      extensions: ['.js', '.mjs'],
      globals: {},
      require: 'off',
      root: join(entrypoint, '..'),
    },
    features: { happyDOM },
    reuseModules,
    sessionId,
  },
});

const loadResult = (
  request: RunnerMessage,
  id: string,
  code: string,
  hash: string,
  only: string[]
) => ({
  type: 'LOAD_RESULT',
  id: request.id,
  payload: { code, hash, id, map: null, only },
});

const stopHarness = async (child: ChildProcessWithoutNullStreams) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
  });
  child.stdin.end();
  const timeout = Symbol('timeout');
  const result = await Promise.race([
    exited.then(() => undefined),
    delay(500).then(() => timeout),
  ]);
  if (result === timeout) {
    child.kill();
    await exited;
  }
};

describe('eval runner sessions', () => {
  it('drops stale continuations, concurrent INIT state, and late chunks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-runner-'));
    const firstEntry = join(root, 'first.js');
    const secondEntry = join(root, 'second.js');
    const oldSlow = join(root, 'old-slow.js');
    const newSlow = join(root, 'new-slow.js');
    writeFileSync(firstEntry, '');
    writeFileSync(secondEntry, '');
    writeFileSync(oldSlow, '');
    writeFileSync(newSlow, '');
    const harness = createHarness(root);

    try {
      // INIT A yields while importing happy-dom. INIT B must win and A must
      // neither overwrite B's context nor acknowledge after it becomes stale.
      await harness.send(
        initMessage('init-a', 1, firstEntry, true),
        initMessage('init-b', 2, firstEntry)
      );
      await harness.take(
        (message) => message.type === 'INIT_ACK' && message.id === 'init-b'
      );
      await delay(100);
      expect(
        harness.messages.some(
          (message) => message.type === 'INIT_ACK' && message.id === 'init-a'
        )
      ).toBe(false);

      await harness.send({
        type: 'EVAL',
        id: 'eval-old',
        payload: { id: firstEntry },
      });
      const firstLoad = await harness.take(
        (message) =>
          message.type === 'LOAD' && message.payload?.id === firstEntry
      );
      expect(firstLoad.sessionId).toBe(2);
      await harness.send(
        loadResult(
          firstLoad,
          firstEntry,
          [
            "import { value } from 'slow';",
            'export const __wywPreval = { value: () => value };',
          ].join('\n'),
          'first-entry',
          ['__wywPreval']
        )
      );
      const staleResolve = await harness.take(
        (message) =>
          message.type === 'RESOLVE' && message.payload?.specifier === 'slow'
      );
      expect(staleResolve.sessionId).toBe(2);

      // Resolving the old request and starting the next INIT in one stdin
      // chunk deterministically schedules the old continuation beside the
      // reset. It must not issue a LOAD in session 3.
      await harness.send(
        {
          type: 'RESOLVE_RESULT',
          id: staleResolve.id,
          payload: { resolvedId: oldSlow },
        },
        initMessage('init-c', 3, secondEntry)
      );
      await harness.take(
        (message) => message.type === 'INIT_ACK' && message.id === 'init-c'
      );

      // A partial response for an id dropped by INIT must be ignored instead
      // of recreating runner-side chunk assembly state.
      await harness.send({
        type: 'LOAD_RESULT',
        id: firstLoad.id,
        payload: {
          chunkCount: 2,
          chunkIndex: 0,
          codeChunk: 'stale-partial',
          id: firstEntry,
        },
      });
      await delay(50);
      expect(
        harness.messages.some(
          (message) =>
            message.type === 'LOAD' && message.payload?.id === oldSlow
        )
      ).toBe(false);

      await harness.send({
        type: 'EVAL',
        id: 'eval-new',
        payload: { id: secondEntry },
      });
      const secondLoad = await harness.take(
        (message) =>
          message.type === 'LOAD' && message.payload?.id === secondEntry
      );
      expect(secondLoad.sessionId).toBe(3);
      await harness.send(
        loadResult(
          secondLoad,
          secondEntry,
          [
            "import { value } from 'slow';",
            "export const __wywPreval = { value: () => value + '-new' };",
          ].join('\n'),
          'second-entry',
          ['__wywPreval']
        )
      );
      const freshResolve = await harness.take(
        (message) =>
          message.type === 'RESOLVE' && message.payload?.specifier === 'slow'
      );
      expect(freshResolve.sessionId).toBe(3);
      await harness.send({
        type: 'RESOLVE_RESULT',
        id: freshResolve.id,
        payload: { resolvedId: newSlow },
      });
      const dependencyLoad = await harness.take(
        (message) => message.type === 'LOAD' && message.payload?.id === newSlow
      );
      expect(dependencyLoad.sessionId).toBe(3);
      await harness.send(
        loadResult(
          dependencyLoad,
          newSlow,
          "export const value = 'fresh';",
          'new-slow',
          ['value']
        )
      );
      const result = await harness.take(
        (message) => message.type === 'EVAL_RESULT' && message.id === 'eval-new'
      );
      expect(result.error).toBeUndefined();
      expect(result.payload?.values).toEqual({
        value: { kind: 'string', value: 'fresh-new' },
      });
      expect(
        harness.messages.some(
          (message) => message.type === 'INIT_ACK' && message.id === 'init-a'
        )
      ).toBe(false);
    } finally {
      await stopHarness(harness.child);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fully resets reuse when an external dynamic import is unfinished', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-runner-'));
    const firstEntry = join(root, 'first.js');
    const secondEntry = join(root, 'second.js');
    const externalDir = join(root, 'node_modules', 'slow-external');
    const externalModule = join(externalDir, 'index.mjs');
    const externalStarted = join(root, 'external-started');
    const releaseExternal = join(root, 'release-external');
    const firstSource = [
      'export const __wywPreval = {',
      '  value: () => {',
      "    void import('slow-external');",
      "    return 'first';",
      '  },',
      '};',
    ].join('\n');
    const secondSource = [
      "import { value } from 'slow-external';",
      'export const __wywPreval = { value: () => value };',
    ].join('\n');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(firstEntry, firstSource);
    writeFileSync(secondEntry, secondSource);
    writeFileSync(
      externalModule,
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(externalStarted)}, 'started');`,
        'await new Promise((resolve) => {',
        '  const timer = setInterval(() => {',
        `    if (existsSync(${JSON.stringify(releaseExternal)})) {`,
        '      clearInterval(timer);',
        '      resolve();',
        '    }',
        '  }, 5);',
        '});',
        "export const value = 'fresh-external';",
      ].join('\n')
    );
    const harness = createHarness(root);

    try {
      await harness.send(initMessage('init-first', 1, firstEntry));
      await harness.take(
        (message) => message.type === 'INIT_ACK' && message.id === 'init-first'
      );
      await harness.send({
        type: 'EVAL',
        id: 'eval-first',
        payload: { id: firstEntry },
      });
      const firstLoad = await harness.take(
        (message) =>
          message.type === 'LOAD' && message.payload?.id === firstEntry
      );
      await harness.send(
        loadResult(firstLoad, firstEntry, firstSource, 'first-entry', [
          '__wywPreval',
        ])
      );
      const firstResolve = await harness.take(
        (message) =>
          message.type === 'RESOLVE' &&
          message.payload?.specifier === 'slow-external'
      );
      await harness.send({
        type: 'RESOLVE_RESULT',
        id: firstResolve.id,
        payload: { resolvedId: externalModule },
      });
      await harness.take(
        (message) =>
          message.type === 'EVAL_RESULT' && message.id === 'eval-first'
      );
      await waitForFile(externalStarted);

      // Reusing the VM while its externalInFlight entry belongs to session 1
      // would make session 2 await an abandoned promise forever. The runner
      // must drop the VM/module graph for this otherwise-reusable INIT.
      await harness.send(
        initMessage('init-second', 2, secondEntry, false, true)
      );
      const secondInit = await harness.take(
        (message) => message.type === 'INIT_ACK' && message.id === 'init-second'
      );
      expect(secondInit.modulesReset).toBe(true);

      await harness.send({
        type: 'EVAL',
        id: 'eval-second',
        payload: { id: secondEntry },
      });
      const secondLoad = await harness.take(
        (message) =>
          message.type === 'LOAD' && message.payload?.id === secondEntry
      );
      await harness.send(
        loadResult(secondLoad, secondEntry, secondSource, 'second-entry', [
          '__wywPreval',
        ])
      );
      const secondResolve = await harness.take(
        (message) =>
          message.type === 'RESOLVE' &&
          message.payload?.specifier === 'slow-external'
      );
      expect(secondResolve.sessionId).toBe(2);
      await harness.send({
        type: 'RESOLVE_RESULT',
        id: secondResolve.id,
        payload: { resolvedId: externalModule },
      });
      writeFileSync(releaseExternal, 'release');

      const result = await harness.take(
        (message) =>
          message.type === 'EVAL_RESULT' && message.id === 'eval-second'
      );
      expect(result.error).toBeUndefined();
      expect(result.payload?.values).toEqual({
        value: { kind: 'string', value: 'fresh-external' },
      });
    } finally {
      writeFileSync(releaseExternal, 'release');
      await stopHarness(harness.child);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
