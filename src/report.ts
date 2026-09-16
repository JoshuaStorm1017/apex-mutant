import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Report, Outcome } from './types.js';

export function summarize(report: Report) {
  const counts: Record<Outcome, number> = { killed: 0, survived: 0, invalid: 0, timeout: 0, error: 0 };
  for (const result of report.results) counts[result.outcome]++;
  const scored = counts.killed + counts.survived;
  return { ...counts, score: scored ? counts.killed / scored * 100 : null, scored, total: report.results.length };
}
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderHtml(report: Report): string {
  const summary = summarize(report);
  const score = summary.score === null ? 'N/A' : `${summary.score.toFixed(1)}%`;
  const rows = report.results.map((m) => `<tr data-outcome="${escape(m.outcome)}"><td><span class="badge ${escape(m.outcome)}">${escape(m.outcome)}</span></td><td>${escape(m.file)}<small>Line ${m.line}:${m.column} · ${escape(m.operator)}</small></td><td><code>${escape(m.original)}</code> → <code>${escape(m.replacement)}</code></td><td>${escape(m.message ?? '')}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'"><title>Apex Mutant report</title><style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b1120;color:#e7edf7}body{max-width:1200px;margin:48px auto;padding:0 24px}h1{font-size:40px;letter-spacing:-1px;margin-bottom:8px}.eyebrow{color:#5eead4;font-weight:700;letter-spacing:2px;font-size:12px}p,small{color:#a9b7cc}small{display:block;margin-top:6px}.summary{display:flex;gap:16px;flex-wrap:wrap;margin:32px 0}.card{padding:20px;background:#152035;border:1px solid #263650;border-radius:12px;min-width:110px}.card strong{display:block;font-size:28px;margin-top:8px}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:#a9b7cc}th,td{padding:16px 12px;border-bottom:1px solid #263650;vertical-align:top}code{color:#fcd34d;white-space:pre-wrap;overflow-wrap:anywhere}.badge{padding:4px 8px;border-radius:6px;background:#273449}.killed{color:#5eead4}.survived{color:#fda4af}.invalid,.timeout,.error{color:#fcd34d}.table{overflow:auto}.notice{border-left:3px solid #5eead4;padding:12px 18px;background:#152035}footer{margin-top:32px;color:#a9b7cc;font-size:13px}
  </style></head><body><div class="eyebrow">APEX MUTANT / TEST QUALITY</div><h1>Would your tests catch the bug?</h1><p>${escape(report.createdAt)} · ${report.complete ? 'Run complete' : 'Incomplete run'} · ${summary.total}/${report.totalPlanned} mutants evaluated</p><div class="summary"><div class="card">Mutation score<strong>${score}</strong></div>${(['killed','survived','invalid','timeout','error'] as const).map((key) => `<div class="card">${key}<strong>${summary[key]}</strong></div>`).join('')}</div><p class="notice">Baseline: ${escape(report.baseline.outcome)}${report.baseline.message ? ` — ${escape(report.baseline.message)}` : ''}. Score = killed ÷ (killed + survived). Invalid mutations, timeouts, and errors are excluded. Surviving mutants deserve review; some may be behaviorally equivalent.</p><div class="table"><table><thead><tr><th>Result</th><th>Location</th><th>Change</th><th>Details</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No mutation results. Inspect baseline status and selected source paths.</td></tr>'}</tbody></table></div><footer>Generated locally by Apex Mutant. No external scripts, assets, or telemetry. This report contains source snippets; keep it private.</footer></body></html>`;
}

export async function writeReport(directory: string, report: Report): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of [
    ['report.json', JSON.stringify({ ...report, summary: summarize(report) }, null, 2) + '\n'],
    ['report.html', renderHtml(report)],
  ]) {
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, join(directory, name));
  }
}

export function reportExitCode(report: Report, threshold = 0): number {
  const summary = summarize(report);
  if (!report.complete || report.baseline.outcome !== 'survived' || summary.error || summary.timeout || summary.score === null) return 2;
  return summary.score < threshold ? 1 : 0;
}
