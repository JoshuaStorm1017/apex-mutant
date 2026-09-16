import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMutation, generateMutations } from '../src/mutations.js';

const wrap = (body: string) => `public class Example { public static Boolean check(Integer a, Integer b) { ${body} } }`;

test('generates deterministic AST-aware operators and independently applicable edits', () => {
  const source = wrap('Integer c = a * b / 2 - 1; return a < b && a >= 1 || a == b || !true;');
  const mutants = generateMutations(source, 'classes/Example.cls');
  assert.deepEqual(mutants.map(m => [m.original, m.replacement, m.operator]), [
    ['*', '/', 'arithmetic'], ['/', '*', 'arithmetic'], ['-', '+', 'arithmetic'],
    ['<', '<=', 'conditional-boundary'], ['&&', '||', 'logical-connector'],
    ['=', '', 'conditional-boundary'], ['||', '&&', 'logical-connector'],
    ['==', '!=', 'equality-negation'], ['||', '&&', 'logical-connector'],
    ['!', '', 'negation-removal'], ['true', 'false', 'boolean-literal'],
  ]);
  assert.deepEqual(generateMutations(source, 'classes/Example.cls'), mutants);
  assert.equal(new Set(mutants.map(m => m.id)).size, mutants.length);
  for (const mutant of mutants) {
    const edited = applyMutation(source, mutant);
    assert.equal(edited, source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end));
    assert.doesNotThrow(() => generateMutations(edited, mutant.file));
  }
});

test('never mutates comments, strings, annotation values, generics or queries including binds', () => {
  const source = `public class Example {
    @AuraEnabled(cacheable=true) public static Boolean check() {
      // false == true && < > + - * /
      String text = 'true != false < > &&'; /* true < false */
      List<List<Account>> values = new List<List<Account>>();
      List<Account> accounts = [SELECT Id FROM Account WHERE IsDeleted = false AND Name = :(true ? 'a' : 'b')];
      List<List<SObject>> found = [FIND 'true' IN ALL FIELDS RETURNING Account(Id WHERE IsDeleted = false)];
      return false;
    }
  }`;
  const mutants = generateMutations(source, 'Example.cls');
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].start, source.lastIndexOf('false'));
});

test('skips entire test classes and test/setup methods regardless of annotation case', () => {
  assert.deepEqual(generateMutations('@ISTEST public class Example { static Boolean flag = true; @IsTest static void run() { System.assert(true); } }', 'Example.cls'), []);
  const source = `public class Example {
    @IsTest static void testOne() { System.assert(1 < 2); }
    static testMethod void testTwo() { System.assert(true); }
    @TestSetup static void setup() { Boolean flag = false; }
    @IsTest private class Nested { Boolean flag = true; }
    public Boolean live() { return true; }
  }`;
  const mutants = generateMutations(source, 'Example.cls');
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].start, source.lastIndexOf('true'));
});

test('maps Unicode code points to JavaScript offsets and one-based line/column', () => {
  const source = "public class Example {\r\n  String emoji = '😀'; Boolean flag = true;\r\n}";
  const [mutant] = generateMutations(source, 'Example.cls');
  assert.equal(mutant.start, source.indexOf('true'));
  assert.equal(mutant.end, source.indexOf('true') + 4);
  assert.equal(mutant.line, 2);
  assert.equal(mutant.column, source.split('\n')[1].indexOf('true') + 1);
  assert.equal(applyMutation(source, mutant), source.replace('true', 'false'));
});

test('rejects parser and lexer errors, trailing garbage and invalid test files', () => {
  for (const source of [
    wrap('return a < ;'), wrap("String bad = '\\q'; return true;"),
    wrap('return true;') + ' garbage', '@IsTest class Broken { ? }',
  ]) assert.throws(() => generateMutations(source, 'Broken.cls'), /Cannot parse Apex/);
});

test('rejects stale source even if the edited token and offset are unchanged', () => {
  const source = wrap('return true;');
  const [mutant] = generateMutations(source, 'Example.cls');
  assert.throws(() => applyMutation(source + '\n', mutant), /Stale or invalid mutation/);
  assert.throws(() => applyMutation(source.replace('true', 'null'), mutant), /Stale or invalid mutation/);
  assert.throws(() => applyMutation(source, { ...mutant, replacement: 'null' }), /Stale or invalid mutation/);
  assert.throws(() => applyMutation(source, { ...mutant, start: -1 }), /Stale or invalid mutation/);
  assert.notEqual(generateMutations(source + '\n', 'Example.cls')[0].id, mutant.id);
});

test('parses triggers and excludes concatenation, compound assignments and unary arithmetic', () => {
  const source = `trigger Example on Account (before insert) {
    Integer a = -1; a += 1; a++; String text = 'x' + 'y';
    if (Trigger.isInsert && true) { a = a - 1; }
  }`;
  assert.deepEqual(generateMutations(source, 'Example.trigger').map(m => m.original), ['&&', 'true', '-']);
});

test('supports Apex equality variants and preserves comments inside boundary operators', () => {
  const source = wrap('return a != b || a === b || a !== b || a <> b || a < /* keep */ = b;');
  const mutants = generateMutations(source, 'Example.cls');
  assert.deepEqual(mutants.filter(m => m.operator === 'equality-negation').map(m => m.replacement), ['==', '!==', '===', '==']);
  const boundary = mutants.find(m => m.operator === 'conditional-boundary')!;
  assert.match(applyMutation(source, boundary), /< \/\* keep \*\/  b/);
});
