import type { Node } from 'oxc-parser';

import { collectOxcPatternRuntimeExpressions } from '../oxc/patterns';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';

type IsReadOnlyCall = (node: Node) => boolean;

const isDirectReadOnlyExpression = (
  node: Node,
  isReadOnlyCall: IsReadOnlyCall
): boolean => {
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSInstantiationExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'ParenthesizedExpression'
  ) {
    return isDirectReadOnlyExpression(node.expression, isReadOnlyCall);
  }

  if (node.type === 'Identifier' || node.type === 'Literal') {
    return true;
  }

  if (node.type === 'ObjectExpression') {
    return node.properties.every((property) => {
      if (property.type === 'SpreadElement' || property.method) {
        return false;
      }

      return (
        (!property.computed ||
          isDirectReadOnlyExpression(property.key, isReadOnlyCall)) &&
        isDirectReadOnlyExpression(property.value, isReadOnlyCall)
      );
    });
  }

  if (node.type === 'ArrayExpression') {
    return node.elements.every(
      (element) =>
        !element ||
        (element.type !== 'SpreadElement' &&
          isDirectReadOnlyExpression(element, isReadOnlyCall))
    );
  }

  if (node.type === 'CallExpression') {
    return (
      !node.arguments.some((argument) => argument.type === 'SpreadElement') &&
      isReadOnlyCall(node) &&
      node.arguments.every(
        (argument) =>
          argument.type !== 'SpreadElement' &&
          isDirectReadOnlyExpression(argument, isReadOnlyCall)
      )
    );
  }

  return false;
};

export const isReadOnlyOpaqueFunction = (
  node: Node,
  isReadOnlyCall: IsReadOnlyCall = () => false
): boolean => {
  if (!isOxcFunctionLike(node)) {
    return false;
  }

  if (
    node.params.some(
      (param) => collectOxcPatternRuntimeExpressions(param).length > 0
    )
  ) {
    return false;
  }

  const { body } = node;
  if (!body) {
    return false;
  }
  if (body.type !== 'BlockStatement') {
    return isDirectReadOnlyExpression(body, isReadOnlyCall);
  }

  return body.body.every(
    (statement) =>
      statement.type === 'EmptyStatement' ||
      (statement.type === 'ExpressionStatement' &&
        statement.expression.type === 'Literal' &&
        typeof statement.expression.value === 'string') ||
      (statement.type === 'ReturnStatement' &&
        (!statement.argument ||
          isDirectReadOnlyExpression(statement.argument, isReadOnlyCall)))
  );
};
