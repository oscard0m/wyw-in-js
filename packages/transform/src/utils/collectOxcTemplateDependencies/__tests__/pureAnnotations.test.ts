import { parseOxc } from '../scopeAnalysis';
import { collectPureAnnotatedInvocationSpans } from '../pureAnnotations';

const filename = '/source.ts';
const key = (node: { end: number; start: number }): string =>
  `${node.start}:${node.end}`;

describe('PURE invocation annotations', () => {
  it.each([
    '//#__PURE__\nfactory();',
    '/*#__PURE__*/ const factory = () => {}; factory();',
    '/*#__PURE_CALL__*/ factory();',
  ])(
    'does not treat a non-leading PURE-like comment as an annotation',
    (code) => {
      const program = parseOxc(code, filename);

      expect(
        collectPureAnnotatedInvocationSpans(code, filename, program)
      ).toHaveLength(0);
    }
  );

  it.each([
    '/*#__PURE__*/\n\nfactory();',
    'const value = /*#__PURE__*/ /* generated */ factory();',
    'const value = /*#__PURE__*/ (factory());',
    'const value = (/* @__PURE__ */ factory());',
    'const value = /*#__PURE__*/ new Factory();',
    'const value = /*#__PURE__*/ factory?.();',
    'const value = /*#__PURE__*/ (factory?.());',
    'const value = /*#__PURE__*/ (factory() as unknown);',
    'const value = /*#__PURE__*/ (factory() satisfies unknown);',
    'const value = /*#__PURE__*/ (factory()!);',
    'const value = /*#__PURE__*/ (<unknown>factory());',
  ])('allows leading trivia before the annotated call', (code) => {
    const program = parseOxc(code, filename);
    const spans = collectPureAnnotatedInvocationSpans(code, filename, program);

    expect(spans).toHaveLength(1);
  });

  it('annotates the outer call and its callee chain', () => {
    const code = 'const value = /*#__PURE__*/ factory()();';
    const program = parseOxc(code, filename);
    const statement = program.body[0];
    expect(statement?.type).toBe('VariableDeclaration');
    if (statement?.type !== 'VariableDeclaration') return;

    const outer = statement.declarations[0]?.init;
    expect(outer?.type).toBe('CallExpression');
    if (outer?.type !== 'CallExpression') return;
    const inner = outer.callee;
    expect(inner.type).toBe('CallExpression');
    if (inner.type !== 'CallExpression') return;

    const spans = collectPureAnnotatedInvocationSpans(code, filename, program);
    expect(spans).toContain(key(outer));
    expect(spans).toContain(key(inner));
  });

  it('covers the callee subtree but not the outer call arguments', () => {
    const code =
      'const value = /*#__PURE__*/ factory(inner())(outerArgument());';
    const program = parseOxc(code, filename);
    const statement = program.body[0];
    expect(statement?.type).toBe('VariableDeclaration');
    if (statement?.type !== 'VariableDeclaration') return;

    const outer = statement.declarations[0]?.init;
    expect(outer?.type).toBe('CallExpression');
    if (outer?.type !== 'CallExpression') return;
    const innerFactory = outer.callee;
    expect(innerFactory.type).toBe('CallExpression');
    if (innerFactory.type !== 'CallExpression') return;
    const innerArgument = innerFactory.arguments[0];
    const outerArgument = outer.arguments[0];
    expect(innerArgument?.type).toBe('CallExpression');
    expect(outerArgument?.type).toBe('CallExpression');
    if (
      innerArgument?.type !== 'CallExpression' ||
      outerArgument?.type !== 'CallExpression'
    ) {
      return;
    }

    const spans = collectPureAnnotatedInvocationSpans(code, filename, program);
    expect(spans).toContain(key(outer));
    expect(spans).toContain(key(innerFactory));
    expect(spans).toContain(key(innerArgument));
    expect(spans).not.toContain(key(outerArgument));
  });

  it('does not extend through deferred functions in the callee subtree', () => {
    const code = 'const value = /*#__PURE__*/ factory(() => deferred())();';
    const program = parseOxc(code, filename);
    const statement = program.body[0];
    expect(statement?.type).toBe('VariableDeclaration');
    if (statement?.type !== 'VariableDeclaration') return;

    const outer = statement.declarations[0]?.init;
    expect(outer?.type).toBe('CallExpression');
    if (outer?.type !== 'CallExpression') return;
    const innerFactory = outer.callee;
    expect(innerFactory.type).toBe('CallExpression');
    if (innerFactory.type !== 'CallExpression') return;
    const callback = innerFactory.arguments[0];
    expect(callback?.type).toBe('ArrowFunctionExpression');
    if (callback?.type !== 'ArrowFunctionExpression') return;
    const deferred = callback.body;
    expect(deferred.type).toBe('CallExpression');
    if (deferred.type !== 'CallExpression') return;

    const spans = collectPureAnnotatedInvocationSpans(code, filename, program);
    expect(spans).toContain(key(outer));
    expect(spans).toContain(key(innerFactory));
    expect(spans).not.toContain(key(deferred));
  });

  it('keeps an annotated argument call separate from its parent call', () => {
    const code = 'const value = outer(/* @__PURE__ */ inner());';
    const program = parseOxc(code, filename);
    const statement = program.body[0];
    expect(statement?.type).toBe('VariableDeclaration');
    if (statement?.type !== 'VariableDeclaration') return;

    const outer = statement.declarations[0]?.init;
    expect(outer?.type).toBe('CallExpression');
    if (outer?.type !== 'CallExpression') return;
    const inner = outer.arguments[0];
    expect(inner?.type).toBe('CallExpression');
    if (inner?.type !== 'CallExpression') return;

    const spans = collectPureAnnotatedInvocationSpans(code, filename, program);
    expect(spans).toContain(key(inner));
    expect(spans).not.toContain(key(outer));
  });

  it('does not extend an outer annotation to calls in its arguments', () => {
    const code = 'const value = /*#__PURE__*/ outer(inner());';
    const program = parseOxc(code, filename);
    const statement = program.body[0];
    expect(statement?.type).toBe('VariableDeclaration');
    if (statement?.type !== 'VariableDeclaration') return;

    const outer = statement.declarations[0]?.init;
    expect(outer?.type).toBe('CallExpression');
    if (outer?.type !== 'CallExpression') return;
    const inner = outer.arguments[0];
    expect(inner?.type).toBe('CallExpression');
    if (inner?.type !== 'CallExpression') return;

    const spans = collectPureAnnotatedInvocationSpans(code, filename, program);
    expect(spans).toContain(key(outer));
    expect(spans).not.toContain(key(inner));
  });

  it.each([
    'const value = /*#__PURE__*/ (mutate(space) === undefined);',
    'const value = /*#__PURE__*/ (mutate(space), undefined);',
    'const value = /*#__PURE__*/ (condition ? mutate(space) : undefined);',
    'const value = String /*#__PURE__*/ (mutate(space));',
    'const value = factory /*#__PURE__*/ ();',
  ])('does not annotate a nested invocation in %s', (code) => {
    const program = parseOxc(code, filename);

    expect(
      collectPureAnnotatedInvocationSpans(code, filename, program)
    ).toHaveLength(0);
  });

  it('handles many annotations without changing their association', () => {
    const invocationCount = 3000;
    const code = Array.from(
      { length: invocationCount },
      (_, index) => `const value${index} = /*#__PURE__*/ factory${index}();`
    ).join('\n');
    const program = parseOxc(code, filename);

    expect(
      collectPureAnnotatedInvocationSpans(code, filename, program)
    ).toHaveLength(invocationCount);
  });
});
