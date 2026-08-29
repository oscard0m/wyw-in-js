import type { Comment, Node, Program } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { parseOxcCached } from '../parseOxc';

const PURE_ANNOTATION = /^(?:#|@)__PURE__$/;
const pureInvocationSpansCache = new WeakMap<Program, Set<string>>();

const spanKey = (node: Pick<Node, 'end' | 'start'>): string =>
  `${node.start}:${node.end}`;

const collectInvocations = (node: Node, calls: Node[]): void => {
  if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    calls.push(node);
  }
  getOxcNodeChildren(node).forEach((child) => collectInvocations(child, calls));
};

const isPureComment = (comment: Comment): boolean =>
  comment.type === 'Block' && PURE_ANNOTATION.test(comment.value.trim());

const isAllowedLeadingGap = (value: string): boolean => /^[\s(]*$/.test(value);

const isOnlyLeadingTrivia = (
  code: string,
  comments: readonly Comment[],
  start: number,
  end: number
): boolean => {
  let cursor = start;
  for (const comment of comments) {
    if (comment.start >= cursor) {
      if (comment.end > end) break;
      if (!isAllowedLeadingGap(code.slice(cursor, comment.start))) return false;
      cursor = comment.end;
    }
  }

  return isAllowedLeadingGap(code.slice(cursor, end));
};

export const collectPureAnnotatedInvocationSpans = (
  code: string,
  filename: string,
  program: Program
): Set<string> => {
  const cached = pureInvocationSpansCache.get(program);
  if (cached) return cached;

  const { comments } = parseOxcCached(filename, code, 'unambiguous');
  const pureComments = comments.filter(isPureComment);
  if (pureComments.length === 0) {
    const empty = new Set<string>();
    pureInvocationSpansCache.set(program, empty);
    return empty;
  }

  const invocations: Node[] = [];
  collectInvocations(program, invocations);

  const spans = new Set<string>();
  pureComments.forEach((comment) => {
    const candidate = invocations
      .filter(
        (node) =>
          node.start >= comment.end &&
          isOnlyLeadingTrivia(code, comments, comment.end, node.start)
      )
      .sort(
        (left, right) => left.start - right.start || right.end - left.end
      )[0];
    if (candidate) {
      spans.add(spanKey(candidate));
    }
  });

  pureInvocationSpansCache.set(program, spans);
  return spans;
};
