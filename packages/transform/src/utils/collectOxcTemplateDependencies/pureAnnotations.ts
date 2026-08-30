import type { Comment, Node, Program } from 'oxc-parser';

import { walkOxc } from '../oxc/ast';
import { isOxcTransparentRuntimeExpression } from '../oxc/runtimeSemantics';
import { parseOxcCached } from '../parseOxc';
import { collectEagerNodeStarts } from './expressionReplacements';

const PURE_ANNOTATION = /^(?:#|@)__PURE__$/;
const WHITESPACE = /\s/u;
const pureInvocationSpansCache = new WeakMap<Program, Set<string>>();

type AnchoredInvocation = {
  anchorStart: number;
  invocation: Node;
};

type SourceRange = {
  end: number;
  start: number;
};

type TransparentRuntimeExpression = Node & { expression?: Node };

const spanKey = (node: Pick<Node, 'end' | 'start'>): string =>
  `${node.start}:${node.end}`;

const addPureInvocationAndCalleeSpans = (
  invocation: Node,
  spans: Set<string>
): void => {
  spans.add(spanKey(invocation));
  if (
    invocation.type !== 'CallExpression' &&
    invocation.type !== 'NewExpression'
  ) {
    return;
  }

  // Conventional PURE annotations cover evaluation of the callee as part of
  // the annotated invocation. This includes inner calls in a callee chain,
  // but not calls in the annotated invocation's own arguments.
  const eagerNodeStarts = collectEagerNodeStarts(invocation.callee);
  walkOxc(invocation.callee, (node) => {
    if (
      eagerNodeStarts.has(node.start) &&
      (node.type === 'CallExpression' || node.type === 'NewExpression')
    ) {
      spans.add(spanKey(node));
    }
  });
};

const collectInvocationAnchors = (program: Program): AnchoredInvocation[] => {
  const parents = new WeakMap<Node, Node | null>();
  const invocations: Node[] = [];

  walkOxc(program, (node, parent) => {
    parents.set(node, parent);
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      invocations.push(node);
    }
  });

  const anchoredInvocations: AnchoredInvocation[] = [];
  invocations.forEach((invocation) => {
    // A marker may be placed either directly before the invocation or before
    // any transparent wrapper around it, such as `(factory())` or a TS cast.
    const anchorStarts = new Set([invocation.start]);
    let current = invocation;
    let parent = parents.get(current);

    while (
      parent &&
      isOxcTransparentRuntimeExpression(parent, true) &&
      (parent as TransparentRuntimeExpression).expression === current
    ) {
      anchorStarts.add(parent.start);
      current = parent;
      parent = parents.get(current);
    }

    anchorStarts.forEach((anchorStart) => {
      anchoredInvocations.push({ anchorStart, invocation });
    });
  });

  return anchoredInvocations.sort(
    // Chained calls share a source start. Associate the marker with the
    // widest invocation so `/*#__PURE__*/ factory()()` marks the outer call.
    (left, right) =>
      left.anchorStart - right.anchorStart ||
      right.invocation.end - left.invocation.end ||
      left.invocation.start - right.invocation.start
  );
};

const groupInvocationAnchors = (
  anchoredInvocations: readonly AnchoredInvocation[]
): AnchoredInvocation[] => {
  const grouped: AnchoredInvocation[] = [];
  anchoredInvocations.forEach((anchoredInvocation) => {
    if (grouped.at(-1)?.anchorStart !== anchoredInvocation.anchorStart) {
      grouped.push(anchoredInvocation);
    }
  });

  return grouped;
};

const isPureComment = (comment: Comment): boolean =>
  comment.type === 'Block' && PURE_ANNOTATION.test(comment.value.trim());

const collectSignificantSourceRanges = (
  code: string,
  comments: readonly Comment[]
): SourceRange[] => {
  const ranges: SourceRange[] = [];
  let commentIndex = 0;
  let cursor = 0;

  while (cursor < code.length) {
    while (
      commentIndex < comments.length &&
      comments[commentIndex].end <= cursor
    ) {
      commentIndex += 1;
    }

    const comment = comments[commentIndex];
    if (comment && comment.start <= cursor && cursor < comment.end) {
      cursor = comment.end;
      commentIndex += 1;
    } else if (WHITESPACE.test(code[cursor])) {
      cursor += 1;
    } else {
      const start = cursor;
      while (cursor < code.length) {
        const nextComment = comments[commentIndex];
        if (nextComment?.start === cursor || WHITESPACE.test(code[cursor])) {
          break;
        }
        cursor += 1;
      }
      ranges.push({ start, end: cursor });
    }
  }

  return ranges;
};

const findFirstSignificantOffset = (
  ranges: readonly SourceRange[],
  offset: number
): number | null => {
  let left = 0;
  let right = ranges.length;

  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (ranges[middle].end <= offset) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  const range = ranges[left];
  if (!range) return null;

  return Math.max(offset, range.start);
};

export const collectPureAnnotatedInvocationSpans = (
  code: string,
  filename: string,
  program: Program
): Set<string> => {
  const cached = pureInvocationSpansCache.get(program);
  if (cached) return cached;

  const { comments: parsedComments } = parseOxcCached(
    filename,
    code,
    'unambiguous'
  );
  const pureComments = parsedComments
    .filter(isPureComment)
    .sort((left, right) => left.end - right.end || left.start - right.start);
  if (pureComments.length === 0) {
    const empty = new Set<string>();
    pureInvocationSpansCache.set(program, empty);
    return empty;
  }

  const comments = parsedComments
    .slice()
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const invocationAnchors = groupInvocationAnchors(
    collectInvocationAnchors(program)
  );
  const significantRanges = collectSignificantSourceRanges(code, comments);
  const spans = new Set<string>();
  let anchorIndex = 0;

  pureComments.forEach((comment) => {
    const nextSignificantOffset = findFirstSignificantOffset(
      significantRanges,
      comment.end
    );
    if (nextSignificantOffset === null) return;

    while (
      anchorIndex < invocationAnchors.length &&
      invocationAnchors[anchorIndex].anchorStart < nextSignificantOffset
    ) {
      anchorIndex += 1;
    }

    const invocation = invocationAnchors[anchorIndex];
    if (invocation?.anchorStart === nextSignificantOffset) {
      addPureInvocationAndCalleeSpans(invocation.invocation, spans);
    }
  });

  pureInvocationSpansCache.set(program, spans);
  return spans;
};
