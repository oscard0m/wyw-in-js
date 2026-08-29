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
  ])('allows leading trivia before the annotated call', (code) => {
    const program = parseOxc(code, filename);
    const spans = collectPureAnnotatedInvocationSpans(code, filename, program);

    expect(spans).toHaveLength(1);
  });

  it('annotates the outer call in a chained invocation', () => {
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
    expect(spans).not.toContain(key(inner));
  });
});
