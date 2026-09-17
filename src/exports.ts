import { buildFindings, fileHotspots, type Finding } from './findings.js';
import { ENFORCEMENT_READINESS, SCOPE_STATEMENT, advisoryNotice } from './policy.js';
import { summarize, writeFileAtomic } from './report.js';
import type { Report } from './types.js';

export const EXPORT_FORMATS = ['csv', 'sarif', 'md'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_FILENAMES: Record<ExportFormat, string> = {
  csv: 'findings.csv', sarif: 'report.sarif', md: 'summary.md',
};

export function parseExportFormats(values: string[]): ExportFormat[] {
  const requested = values.flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase()).filter(Boolean);
  const formats: ExportFormat[] = [];
  for (const value of requested) {
    if (value === 'all') { for (const format of EXPORT_FORMATS) if (!formats.includes(format)) formats.push(format); continue; }
    if (!(EXPORT_FORMATS as readonly string[]).includes(value)) {
      throw new Error(`Unknown export format '${value}'. Supported: ${EXPORT_FORMATS.join(', ')}, all.`);
    }
    if (!formats.includes(value as ExportFormat)) formats.push(value as ExportFormat);
  }
  return formats;
}

/** Work-item identifiers end up inside CSV, SARIF, and Markdown that other systems
 * parse, so accept only a conservative identifier shape rather than sanitizing
 * arbitrary text after the fact. */
const WORK_ITEM = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/;
export function assertWorkItems(workItems: string[]): void {
  for (const item of workItems) {
    if (!WORK_ITEM.test(item)) {
      throw new Error(`Invalid work item '${item}'. Use 1-64 characters: letters, digits, '.', '_', '-', '/'.`);
    }
  }
}

/** Quote every field, and defuse the leading characters spreadsheet software treats
 * as a formula so an operator or source snippet can never execute on open. */
function csvCell(value: unknown): string {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  const safe = /^[=+\-@\t]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const CSV_COLUMNS = [
  'runId', 'workItems', 'tool', 'toolVersion', 'createdAt', 'mode', 'threshold',
  'findingId', 'category', 'priority', 'equivalenceRisk', 'file', 'line', 'column',
  'operator', 'change', 'testsRun', 'title', 'detail', 'suggestedAction',
] as const;

export function toCsv(report: Report): string {
  const workItems = report.traceability.workItems.join(' ');
  const rows = buildFindings(report).map((finding) => [
    report.traceability.runId, workItems, report.tool.name, report.tool.version,
    report.createdAt, report.policy.mode, report.policy.threshold,
    finding.id, finding.category, finding.priority, finding.equivalenceRisk,
    finding.file, finding.line, finding.column, finding.operator, finding.change,
    finding.testsRun ?? '', finding.title, finding.detail, finding.suggestedAction,
  ].map(csvCell).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

/** Advisory-first also applies to machine-readable output: no finding is ever emitted
 * at SARIF level 'error', and in advisory mode every finding is a 'note', so ingesting
 * this file cannot by itself fail a pipeline that treats warnings as failures. */
function sarifLevel(report: Report, finding: Finding): 'note' | 'warning' {
  if (report.policy.mode !== 'enforce') return 'note';
  return finding.priority === 'high' ? 'warning' : 'note';
}

const ruleIdFor = (finding: Finding) =>
  finding.category === 'test-gap' ? `test-gap/${finding.operator || 'unknown'}` : finding.category;

export function toSarif(report: Report): string {
  const findings = buildFindings(report);
  const summary = summarize(report);
  const rules = new Map<string, Record<string, unknown>>();
  for (const finding of findings) {
    const id = ruleIdFor(finding);
    if (rules.has(id)) continue;
    rules.set(id, {
      id,
      name: id.replaceAll('/', '-'),
      shortDescription: { text: finding.category === 'test-gap'
        ? `Surviving ${finding.operator || 'mutation'} mutant: no selected test detected the change`
        : finding.category === 'unproven-mutant'
          ? 'Mutant produced no test evidence and is excluded from the score'
          : 'Run-level problem affecting how the result can be read' },
      fullDescription: { text: SCOPE_STATEMENT },
      defaultConfiguration: { level: 'note' },
      help: { text: finding.suggestedAction },
    });
  }
  const document = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: {
        name: report.tool.name,
        version: report.tool.version,
        informationUri: 'https://github.com/JoshuaStorm1017/apex-mutant',
        rules: [...rules.values()],
      } },
      automationDetails: { id: `${report.tool.name}/${report.traceability.runId}` },
      results: findings.map((finding) => ({
        ruleId: ruleIdFor(finding),
        level: sarifLevel(report, finding),
        message: { text: `${finding.detail} Suggested action: ${finding.suggestedAction}` },
        ...(finding.file ? { locations: [{ physicalLocation: {
          artifactLocation: { uri: finding.file.replaceAll('\\', '/') },
          region: { startLine: Math.max(1, finding.line), startColumn: Math.max(1, finding.column) },
        } }] } : {}),
        properties: {
          category: finding.category, priority: finding.priority,
          equivalenceRisk: finding.equivalenceRisk, mutationId: finding.id,
          change: finding.change, workItems: report.traceability.workItems,
        },
      })),
      properties: {
        mode: report.policy.mode, threshold: report.policy.threshold,
        mutationScore: summary.score, killed: summary.killed, survived: summary.survived,
        inconclusive: summary.invalid + summary.timeout + summary.error,
        complete: report.complete, workItems: report.traceability.workItems,
        advisoryNotice: advisoryNotice(report.policy),
      },
    }],
  };
  return JSON.stringify(document, null, 2) + '\n';
}

/** Prose keeps its punctuation; only table cells need '|' escaped, and a stray
 * newline in either would break the row or the list item. */
const mdText = (value: unknown) => String(value ?? '').replace(/[\r\n]+/g, ' ');
const mdCell = (value: unknown) => mdText(value).replaceAll('|', '\\|');

export function toMarkdown(report: Report): string {
  const summary = summarize(report);
  const findings = buildFindings(report);
  const hotspots = fileHotspots(report);
  const score = summary.score === null ? 'N/A' : `${summary.score.toFixed(1)}%`;
  const lines: string[] = [
    `# Apex Mutant run ${report.traceability.runId}`,
    '',
    `- Tool: ${report.tool.name} ${report.tool.version}`,
    `- Created: ${report.createdAt}`,
    `- Work items: ${report.traceability.workItems.length ? report.traceability.workItems.map(mdText).join(', ') : 'none recorded'}`,
    `- Mode: ${report.policy.mode}${report.policy.mode === 'enforce' ? ` (threshold ${report.policy.threshold}%)` : ''}`,
    `- Mutants: ${summary.total}/${report.totalPlanned} evaluated, killed ${summary.killed}, survived ${summary.survived}, inconclusive ${summary.invalid + summary.timeout + summary.error}`,
    `- Suppressed: ${summary.suppressed} mutant(s) excluded by in-source markers (never validated, never scored)`,
    `- Mutation score: ${score}`,
    '',
    `> ${advisoryNotice(report.policy)}`,
    `> ${SCOPE_STATEMENT}`,
    '',
    '## Execution safeguards',
    '',
    `- Execution: ${report.safeguards.validationOnly ? 'validation-only (`sf project deploy start --dry-run`); no metadata deployed' : `not attested by apex-mutant (${mdText(report.safeguards.validator)})`}`,
    `- Validator: ${mdText(report.safeguards.validator)}`,
    `- Source isolation: ${report.safeguards.snapshotIsolated ? 'mutants applied only inside a temporary snapshot copy' : 'not attested'}`,
    `- Target org: ${report.safeguards.orgCheck ? `${mdText(report.safeguards.orgCheck.targetOrg)} classified as ${report.safeguards.orgCheck.classification}` : 'no classification recorded'}`,
    `- Local source integrity: ${report.safeguards.sourceIntegrity
      ? (report.safeguards.sourceIntegrity.verified
        ? `${report.safeguards.sourceIntegrity.unchanged ? 'unchanged' : 'CHANGED'} (${report.safeguards.sourceIntegrity.filesChecked} file(s) re-read)`
        : `not verified — ${mdText(report.safeguards.sourceIntegrity.message)}`)
      : 'not checked'}`,
    '',
    `## Findings (${findings.length})`,
    '',
  ];
  if (!findings.length) lines.push('Every planned mutant was killed and the run completed cleanly.', '');
  for (const finding of findings) {
    lines.push(`### [${finding.priority.toUpperCase()}] ${mdText(finding.title)}`, '');
    if (finding.file) lines.push(`- Location: \`${mdText(finding.file)}:${finding.line}:${finding.column}\` (${mdText(finding.operator)}: \`${mdText(finding.change)}\`)`);
    lines.push(`- Equivalence risk: ${finding.equivalenceRisk}`, '', mdText(finding.detail), '', `**Do this:** ${mdText(finding.suggestedAction)}`, '');
  }
  if (hotspots.length) {
    lines.push('## Where the gaps concentrate', '', '| File | Survived | Killed | Score | Inconclusive |', '| --- | --- | --- | --- | --- |');
    for (const hotspot of hotspots) {
      lines.push(`| ${mdCell(hotspot.file)} | ${hotspot.survived} | ${hotspot.killed} | ${hotspot.score === null ? 'N/A' : `${hotspot.score.toFixed(1)}%`} | ${hotspot.inconclusive} |`);
    }
    lines.push('');
  }
  lines.push('## Before enforcing a score in CI', '');
  for (const item of ENFORCEMENT_READINESS) lines.push(`- [ ] ${item}`);
  lines.push('');
  return lines.join('\n');
}

const RENDERERS: Record<ExportFormat, (report: Report) => string> = { csv: toCsv, sarif: toSarif, md: toMarkdown };

/** Written next to report.json/report.html in the same output directory, with the
 * same symlink-safe atomic write. Returns the filenames written, in request order. */
export async function writeExports(directory: string, report: Report, formats: ExportFormat[]): Promise<string[]> {
  const written: string[] = [];
  for (const format of formats) {
    await writeFileAtomic(directory, EXPORT_FILENAMES[format], RENDERERS[format](report));
    written.push(EXPORT_FILENAMES[format]);
  }
  return written;
}
