import { ApexErrorListener, ApexLexer, ApexParserFactory } from '@apexdevtools/apex-parser';
import { OPERATOR_IDS } from './mutations.js';
import type { Mutation, SuppressedMutation, SuppressionMarker, SuppressionProblem } from './types.js';
export type { SuppressedMutation, SuppressionMarker, SuppressionProblem };

const DIRECTIVE = /^\/\/\s*apex-mutant-disable-(next-line|line)\b\s*(.*)$/i;
/** Anything that mentions the directive at all is treated as an attempt to use it, so a
 * typo is reported instead of silently suppressing nothing. */
const ATTEMPTED = /apex-mutant-disable/i;
const ARGUMENTS = /^([A-Za-z0-9-]+)\s*:\s*(\S.*)$/;
const MINIMUM_REASON_LENGTH = 5;
const FORM = "// apex-mutant-disable-next-line <operator|all>: <reason>";

class SilentErrors extends ApexErrorListener {
  apexSyntaxError(): void { /* Suppression scanning never decides whether Apex parses. */ }
}

/** Find `// apex-mutant-disable-(next-)line` markers in Apex source.
 *
 * Markers are read from the lexer's comment tokens, not by scanning text: a `//` that
 * happens to sit inside a string literal is a string, not a directive. Only true line
 * comments count — a directive inside a block comment is reported as a problem rather
 * than honored, because "I commented it out" should not silently mean "I suppressed it".
 *
 * A marker without a stated reason is never honored. An equivalent mutant the team
 * cannot explain is not an equivalent mutant, and an unexplained suppression is exactly
 * how a mutation score quietly stops meaning anything. */
export function findSuppressions(source: string, file: string): { markers: SuppressionMarker[]; problems: SuppressionProblem[] } {
  const markers: SuppressionMarker[] = [];
  const problems: SuppressionProblem[] = [];
  let tokens: { type: number; line: number; text: string | null }[];
  try {
    // A fresh lexer: getAllTokens() consumes it, so it must never be the one a parser holds.
    const { lexer } = ApexParserFactory.createLexerAndParser(source, new SilentErrors());
    tokens = lexer.getAllTokens() as unknown as { type: number; line: number; text: string | null }[];
  } catch {
    return { markers, problems: [{ file, line: 0, message: 'Could not scan this file for suppression markers.' }] };
  }
  // Only comment tokens are considered: a `//` inside a string literal is a string, and
  // the lexer is what knows the difference.
  const commentTypes = new Set([ApexLexer.LINE_COMMENT, ApexLexer.COMMENT, ApexLexer.DOC_COMMENT]);
  for (const token of tokens) {
    if (!commentTypes.has(token.type)) continue;
    const text = (token.text ?? '').trim();
    if (!ATTEMPTED.test(text)) continue;
    if (token.type !== ApexLexer.LINE_COMMENT) {
      problems.push({ file, line: token.line, message: `A suppression directive only works in a // line comment. Rewrite it as \`${FORM}\`.` });
      continue;
    }
    const directive = DIRECTIVE.exec(text);
    if (!directive) {
      problems.push({ file, line: token.line, message: `Unrecognized suppression directive. Expected \`${FORM}\`.` });
      continue;
    }
    const parsed = ARGUMENTS.exec(directive[2].trim());
    if (!parsed) {
      problems.push({ file, line: token.line, message: `Suppression is missing a scope and a reason. Expected \`${FORM}\`.` });
      continue;
    }
    const scope = parsed[1].toLowerCase();
    const reason = parsed[2].trim();
    if (scope !== 'all' && !(OPERATOR_IDS as readonly string[]).includes(scope)) {
      problems.push({ file, line: token.line, message: `Unknown suppression scope '${scope}'. Use 'all' or one of: ${OPERATOR_IDS.join(', ')}.` });
      continue;
    }
    if (reason.replace(/\s+/g, '').length < MINIMUM_REASON_LENGTH) {
      problems.push({ file, line: token.line, message: 'Suppression needs a real reason (at least 5 characters) explaining why no test could kill this mutant.' });
      continue;
    }
    markers.push({
      file, line: token.line, scope, reason,
      appliesToLine: directive[1].toLowerCase() === 'next-line' ? token.line + 1 : token.line,
    });
  }
  return { markers, problems };
}

/** Partition one file's mutations against its markers. `unusedMarkers` are markers that
 * matched nothing — a stale suppression left behind after the code moved or changed. They
 * hide nothing (nothing was suppressed), but the author believes they did, so they are
 * always reported rather than quietly dropped. */
export function applySuppressions(mutations: Mutation[], markers: SuppressionMarker[]): {
  kept: Mutation[]; suppressed: SuppressedMutation[]; unusedMarkers: SuppressionMarker[];
} {
  const kept: Mutation[] = [];
  const suppressed: SuppressedMutation[] = [];
  const used = new Set<SuppressionMarker>();
  for (const mutation of mutations) {
    const marker = markers.find((candidate) =>
      candidate.appliesToLine === mutation.line && (candidate.scope === 'all' || candidate.scope === mutation.operator));
    if (!marker) { kept.push(mutation); continue; }
    used.add(marker);
    suppressed.push({ ...mutation, reason: marker.reason, markerLine: marker.line });
  }
  return { kept, suppressed, unusedMarkers: markers.filter((marker) => !used.has(marker)) };
}

export function staleMarkerProblem(marker: SuppressionMarker): SuppressionProblem {
  return {
    file: marker.file, line: marker.line,
    message: `Suppression matches no mutation on line ${marker.appliesToLine}${marker.scope === 'all' ? '' : ` for operator '${marker.scope}'`}. The code it referred to probably moved or changed — remove it or move it.`,
  };
}
