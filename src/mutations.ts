import { createHash } from 'node:crypto';
import {
  AnnotationContext, ApexErrorListener, ApexParserFactory,
  Arth1ExpressionContext, Arth2ExpressionContext, ClassBodyDeclarationContext,
  CmpExpressionContext, EqualityExpressionContext, LiteralPrimaryContext,
  LogAndExpressionContext, LogOrExpressionContext, NegExpressionContext,
  PostOpExpressionContext, PreOpExpressionContext,
  SoqlLiteralContext, SoslLiteralContext, TypeDeclarationContext,
  type ApexParserRuleContext, type ApexTerminalNode,
} from '@apexdevtools/apex-parser';
import type { Mutation } from './types.js';

class SyntaxErrors extends ApexErrorListener {
  first?: { line: number; column: number };
  apexSyntaxError(line: number, column: number): void {
    this.first ??= { line, column: column + 1 };
  }
}

function mutationId(source: string, mutation: Omit<Mutation, 'id'>): string {
  return createHash('sha256').update(JSON.stringify([
    source, mutation.file.replaceAll('\\', '/'), mutation.operator,
    mutation.start, mutation.end, mutation.original, mutation.replacement,
  ])).digest('hex');
}

/** Parse a class or trigger and produce deterministic, single-edit mutants.
 * No type resolution is attempted: Salesforce validation determines compilability.
 */
export function generateMutations(source: string, file: string): Mutation[] {
  const errors = new SyntaxErrors();
  const { parser } = ApexParserFactory.createLexerAndParser(source, errors);
  const tree = file.toLowerCase().endsWith('.trigger')
    ? parser.triggerUnit() : parser.compilationUnit();
  if (errors.first) {
    throw new Error(`Cannot parse Apex ${file} at ${errors.first.line}:${errors.first.column}`);
  }

  // ANTLR counts Unicode code points; JavaScript slicing counts UTF-16 code units.
  const offsets = [0];
  for (const character of source) offsets.push(offsets[offsets.length - 1] + character.length);
  const mutations: Mutation[] = [];

  function add(node: ApexTerminalNode | null, replacement: string, operator: string,
    last: ApexTerminalNode | null = node): void {
    if (!node || !last) return;
    const start = offsets[node.symbol.start];
    const end = offsets[last.symbol.stop + 1];
    if (start === undefined || end === undefined || end <= start) {
      throw new Error(`Invalid parser token range in ${file}`);
    }
    const prefix = source.slice(0, start);
    const mutation: Omit<Mutation, 'id'> = {
      file, operator, start, end,
      line: prefix.split('\n').length,
      column: start - prefix.lastIndexOf('\n'),
      original: source.slice(start, end), replacement,
    };
    mutations.push({ id: mutationId(source, mutation), ...mutation });
  }

  function visit(node: ApexParserRuleContext): void {
    // Skip complete test declarations, including nested test classes and setup methods.
    if (node instanceof TypeDeclarationContext || node instanceof ClassBodyDeclarationContext) {
      if (node.modifier_list().some(modifier => {
        const annotation = modifier.annotation();
        return Boolean(modifier.TESTMETHOD()) ||
          (annotation && ['istest', 'testsetup'].includes(annotation.id().getText().toLowerCase()));
      })) return;
    }
    // Query bind expressions are also excluded deliberately in this first version.
    if (node instanceof AnnotationContext || node instanceof SoqlLiteralContext ||
      node instanceof SoslLiteralContext) return;

    if (node instanceof CmpExpressionContext) {
      const comparison = node.LT() ?? node.GT();
      const equal = node.ASSIGN();
      if (equal) {
        // Remove only '=' so comments/whitespace between the two tokens survive.
        add(equal, '', 'conditional-boundary');
      } else {
        add(comparison, `${comparison.getText()}=`, 'conditional-boundary');
      }
    } else if (node instanceof EqualityExpressionContext) {
      const token = node.EQUAL() ?? node.NOTEQUAL() ?? node.TRIPLEEQUAL() ??
        node.TRIPLENOTEQUAL() ?? node.LESSANDGREATER();
      const replacements: Record<string, string> = {
        '==': '!=', '!=': '==', '===': '!==', '!==': '===', '<>': '==',
      };
      add(token, replacements[token.getText()], 'equality-negation');
    } else if (node instanceof LogAndExpressionContext) {
      add(node.AND(), '||', 'logical-connector');
    } else if (node instanceof LogOrExpressionContext) {
      add(node.OR(), '&&', 'logical-connector');
    } else if (node instanceof LiteralPrimaryContext) {
      const literal = node.literal().BooleanLiteral();
      if (literal) add(literal, literal.getText().toLowerCase() === 'true' ? 'false' : 'true', 'boolean-literal');
    } else if (node instanceof NegExpressionContext) {
      add(node.BANG(), '', 'negation-removal');
    } else if (node instanceof PostOpExpressionContext) {
      const inc = node.INC();
      add(inc ?? node.DEC(), inc ? '--' : '++', 'increment-decrement');
    } else if (node instanceof PreOpExpressionContext) {
      const inc = node.INC();
      const dec = node.DEC();
      if (inc || dec) add(inc ?? dec, inc ? '--' : '++', 'increment-decrement');
      else if (node.SUB()) add(node.SUB(), '', 'unary-negation-removal');
    } else if (node instanceof Arth1ExpressionContext) {
      if (node.MUL()) add(node.MUL(), '/', 'arithmetic');
      else add(node.DIV(), '*', 'arithmetic');
    } else if (node instanceof Arth2ExpressionContext) {
      // '+' can be string concatenation; only mutate numeric subtraction.
      add(node.SUB(), '+', 'arithmetic');
    }

    for (const child of node.children ?? []) {
      // ANTLR's declaration hierarchy does not model ParserRuleContext as ParseTree.
      if ('ruleIndex' in child) visit(child as unknown as ApexParserRuleContext);
    }
  }
  visit(tree);
  return mutations.sort((a, b) => a.start - b.start || a.operator.localeCompare(b.operator));
}

/** Reject edits from stale source, malformed offsets, or modified mutation records. */
export function applyMutation(source: string, mutation: Mutation): string {
  if (!Number.isInteger(mutation.start) || !Number.isInteger(mutation.end) ||
    mutation.start < 0 || mutation.end <= mutation.start || mutation.end > source.length ||
    source.slice(mutation.start, mutation.end) !== mutation.original ||
    mutation.id !== mutationId(source, mutation)) {
    throw new Error(`Stale or invalid mutation ${mutation.id}: regenerate the mutation plan`);
  }
  return source.slice(0, mutation.start) + mutation.replacement + source.slice(mutation.end);
}
