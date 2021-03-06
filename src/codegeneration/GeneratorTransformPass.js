// Copyright 2012 Traceur Authors.
//
// Licensed under the Apache License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {AsyncTransformer} from './generator/AsyncTransformer';
import {ForInTransformPass} from './generator/ForInTransformPass';
import {
  GetAccessor,
  SetAccessor
} from '../syntax/trees/ParseTrees';
import {GeneratorTransformer} from './generator/GeneratorTransformer';
import {ParseTreeVisitor} from '../syntax/ParseTreeVisitor';
import {parseStatement} from './PlaceholderParser';
import {TempVarTransformer} from './TempVarTransformer';
import {EQUAL} from '../syntax/TokenType';
import {
  BINARY_OPERATOR,
  COMMA_EXPRESSION,
  PAREN_EXPRESSION,
  YIELD_EXPRESSION
} from '../syntax/trees/ParseTreeType';
import {
  FunctionDeclaration,
  FunctionExpression
} from '../syntax/trees/ParseTrees';
import {YieldFinder} from './YieldFinder';
import {
  createAssignmentExpression,
  createAssignmentStatement,
  createBlock,
  createCommaExpression,
  createExpressionStatement,
  createIdentifierExpression as id,
  createReturnStatement,
  createMemberExpression,
  createVariableDeclaration,
  createVariableDeclarationList,
  createVariableStatement,
  createYieldStatement
} from './ParseTreeFactory';
import isYieldAssign from './generator/isYieldAssign';
import {
  transformOptions,
  options
} from '../options';

class YieldExpressionTransformer extends TempVarTransformer {
  /**
   * @param {UniqueIdentifierGenerator} identifierGenerator
   */
  constructor(identifierGenerator, reporter) {
    super(identifierGenerator);
  }

  /**
   * @param {ExpressionStatement} tree
   * @return {ParseTree}
   */
  transformExpressionStatement(tree) {
    var e = tree.expression, ex;

    // Inside EXPRESSION_STATEMENT, we should always be able to safely remove
    // parens from BINARY_OPERATOR and COMMA_EXPRESSION. This will need to be
    // revisited if the switch afterwards ever supports more than that.
    while (e.type === PAREN_EXPRESSION) {
      e = e.expression;
    }

    function commaWrap(lhs, rhs) {
      return createExpressionStatement(
          createCommaExpression(
              [createAssignmentExpression(lhs, rhs), ...ex.slice(1)]));
    }

    switch (e.type) {
      case COMMA_EXPRESSION:
        ex = e.expressions;
        if (ex[0].type === BINARY_OPERATOR && isYieldAssign(ex[0]))
          return this.factorAssign_(ex[0].left, ex[0].right, commaWrap);
    }

    return tree;
  }

  transformVariableStatement(tree) {
    var tdd = tree.declarations.declarations;

    function isYieldVarAssign(tree) {
      return tree.initialiser && tree.initialiser.type === YIELD_EXPRESSION;
    }

    function varWrap(lhs, rhs) {
      return createVariableStatement(
          createVariableDeclarationList(
              tree.declarations.declarationType,
              [createVariableDeclaration(lhs, rhs), ...tdd.slice(1)]));
    }

    if (isYieldVarAssign(tdd[0]))
      return this.factorAssign_(tdd[0].lvalue, tdd[0].initialiser, varWrap);

    return tree;
  }

  transformReturnStatement(tree) {
    if (tree.expression && tree.expression.type === YIELD_EXPRESSION)
      return this.factor_(tree.expression, createReturnStatement);
    return tree;
  }

  /**
   * Factor out a simple yield assignment into a simple yield expression and a
   * wrapped $yieldSent assignment.
   * @param {ParseTree} lhs The assignment target.
   * @param {ParseTree} rhs The yield expression.
   * @param {Function} wrap A function that returns a ParseTree wrapping lhs
   *     and $yieldSent properly for its intended context.
   * @return {ParseTree} { yield ...; wrap(lhs, $yieldSent) }
   */
  factorAssign_(lhs, rhs, wrap) {
    return this.factor_(rhs, (ident) => {
      return wrap(lhs, ident);
    });
  }

  /**
   * Factor out a nested yield expression into a simple yield expression and a
   * wrapped $yieldSent statement.
   *
   *   return yield expr
   *
   * becomes
   *
   *   yield expr;
   *   return $yieldSent
   *
   * @param {ParseTree} expression The yield expression.
   * @param {Function} wrap A function that returns a ParseTree wrapping lhs
   *     and $yieldSent properly for its intended context.
   * @return {ParseTree} { yield ...; wrap($yieldSent) }
   */
  factor_(expression, wrap) {
    return createBlock([
        createExpressionStatement(expression),
        wrap(createMemberExpression('$ctx', 'sent'))]);
  }
}

/**
 * This pass just finds function bodies with yields in them and passes them
 * off to the GeneratorTransformer for the heavy lifting.
 */
export class GeneratorTransformPass extends TempVarTransformer {
  /**
   * @param {UniqueIdentifierGenerator} identifierGenerator
   * @param {ErrorReporter} reporter
   */
  constructor(identifierGenerator, reporter) {
    super(identifierGenerator);
    this.reporter_ = reporter;
  }

  /**
   * @param {FunctionDeclaration} tree
   * @return {ParseTree}
   */
  transformFunctionDeclaration(tree) {
    return this.transformFunction_(tree, FunctionDeclaration);
  }

  /**
   * @param {FunctionExpression} tree
   * @return {ParseTree}
   */
  transformFunctionExpression(tree) {
    return this.transformFunction_(tree, FunctionExpression);
  }

  transformFunction_(tree, constructor) {
    var body = this.transformBody_(tree.functionBody, tree.isGenerator);
    if (body === tree.functionBody)
      return tree;

    // The generator has been transformed away.
    var isGenerator = false;

    return new constructor(null, tree.name, isGenerator,
                           tree.formalParameterList, tree.typeAnnotation,
                           tree.annotations, body);
  }

  /**
   * @param {FunctionBody} tree
   * @return {FunctionBody}
   */
  transformBody_(tree, isGenerator) {
    var finder;

    // transform nested functions
    var body = super.transformFunctionBody(tree);

    if (isGenerator || transformOptions.deferredFunctions) {
      finder = new YieldFinder(tree);
      if (!(finder.hasYield || isGenerator || finder.hasAwait))
        return body;
    } else if (!isGenerator) {
      return body;
    }

    // We need to transform for-in loops because the object key iteration
    // cannot be interrupted.
    if (finder.hasForIn &&
        (transformOptions.generators || transformOptions.deferredFunctions)) {
      body = new ForInTransformPass(this.identifierGenerator).transformAny(body);
    }

    if (finder.hasYield || isGenerator) {
      if (transformOptions.generators) {
        body = new YieldExpressionTransformer(this.identifierGenerator,
                                              this.reporter_).
            transformAny(body);

        body = GeneratorTransformer.transformGeneratorBody(
            this.identifierGenerator,
            this.reporter_,
            body);
      }
    } else if (transformOptions.deferredFunctions) {
      body = AsyncTransformer.transformAsyncBody(
          this.identifierGenerator, this.reporter_, body);
    }
    return body;
  }

  /**
   * @param {GetAccessor} tree
   * @return {ParseTree}
   */
  transformGetAccessor(tree) {
    var body = this.transformBody_(tree.body);
    if (body === tree.body)
      return tree;

    return new GetAccessor(
        tree.location,
        tree.isStatic,
        tree.name,
        tree.typeAnnotation,
        tree.annotations,
        body);
  }

  /**
   * @param {SetAccessor} tree
   * @return {ParseTree}
   */
  transformSetAccessor(tree) {
    var body = this.transformBody_(tree.body);
    if (body === tree.body)
      return tree;

    return new SetAccessor(
        tree.location,
        tree.isStatic,
        tree.name,
        tree.parameter,
        tree.annotations,
        body);
  }
}
