import { lstat, readdir, readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { generateMutations } from './mutations.js';
import { applySuppressions, findSuppressions, staleMarkerProblem } from './suppressions.js';
import type { Mutation, SourceIntegrity, SuppressedMutation, SuppressionProblem } from './types.js';

export interface Project {
  root: string;
  packageDirs: string[];
  files: Map<string, string>;
  config: Record<string, unknown>;
}
const ignored = new Set(['node_modules', '.git', '.sf', '.sfdx', '.apex-mutant', 'dist', 'coverage']);
const apexFile = /\.(cls|trigger)(-meta\.xml)?$/i;
const unix = (path: string) => path.split(sep).join('/');
// Defense in depth: Project is a public type, so a hand-built one could carry an unsafe key.
// Checked independent of the host OS: a key built on one platform (or by a caller
// that never ran it through unix()) may contain '\' traversal or a drive prefix even
// when this process's own path separator is '/', and vice versa — Apex identifiers
// never legitimately contain either, so any occurrence here is treated as unsafe.
export function assertSafeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) ||
    path.split(/[/\\]/).some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Unsafe file path in project snapshot: ${path}`);
  }
}

export async function readProject(directory: string): Promise<Project> {
  const root = resolve(directory);
  const config = JSON.parse(await readFile(join(root, 'sfdx-project.json'), 'utf8'));
  if (!Array.isArray(config.packageDirectories) || config.packageDirectories.length === 0) {
    throw new Error('sfdx-project.json must define packageDirectories.');
  }
  const packageDirs: string[] = [];
  const files = new Map<string, string>();
  for (const entry of config.packageDirectories) {
    if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) throw new Error('Invalid package directory.');
    const full = resolve(root, entry.path);
    const path = relative(root, full);
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error('Package directories must be subdirectories inside the project.');
    }
    if (packageDirs.some((other) => path === other || path.startsWith(other + sep) || other.startsWith(path + sep))) {
      throw new Error('Package directories must not overlap.');
    }
    // Inspect every ancestor: an apparently internal path can traverse a symlink.
    let current = root;
    for (const part of path.split(sep)) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe package directory: ${unix(path)}`);
    }
    packageDirs.push(path);
    async function visit(dir: string): Promise<void> {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (ignored.has(entry.name) || entry.name.startsWith('.')) continue;
        const filename = join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Symlinks are unsupported: ${unix(relative(root, filename))}`);
        if (entry.isDirectory()) await visit(filename);
        else if (entry.isFile() && apexFile.test(entry.name)) {
          files.set(unix(relative(root, filename)), await readFile(filename, 'utf8'));
        }
      }
    }
    await visit(full);
  }
  for (const file of files.keys()) {
    if (/\.(cls|trigger)$/i.test(file) && !files.has(file + '-meta.xml')) {
      throw new Error(`Missing metadata companion: ${file}-meta.xml`);
    }
  }
  return { root, packageDirs: packageDirs.map(unix), files, config };
}

export interface PlanOptions { include?: string[]; exclude?: string[]; operators?: string[]; maxMutants?: number }
export interface PlanResult {
  mutations: Mutation[];
  suppressed: SuppressedMutation[];
  problems: SuppressionProblem[];
}

/** Generate the plan, honoring in-source suppression markers.
 *
 * Suppression is applied per file immediately after generation — before the operator
 * filter and before `maxMutants` — so a suppressed mutant is excluded no matter how the
 * run is narrowed, and so a marker is only called stale when it matches nothing in that
 * file's *complete* mutation set rather than in whatever subset this invocation asked
 * for. Files excluded by --include/--exclude are never scanned: their markers are not
 * this run's business. */
export function planProjectDetailed(project: Project, options: PlanOptions = {}): PlanResult {
  const matches = (file: string, filters: string[]) => filters.some((prefix) => file === prefix || file.startsWith(prefix.replace(/\/$/, '') + '/'));
  const mutations: Mutation[] = [];
  const suppressedMutations: SuppressedMutation[] = [];
  const problems: SuppressionProblem[] = [];
  for (const [file, source] of project.files) {
    if (!/\.(cls|trigger)$/i.test(file)) continue;
    if (options.include?.length && !matches(file, options.include)) continue;
    if (options.exclude?.length && matches(file, options.exclude)) continue;
    const { markers, problems: markerProblems } = findSuppressions(source, file);
    problems.push(...markerProblems);
    const { kept, suppressed, unusedMarkers } = applySuppressions(generateMutations(source, file), markers);
    problems.push(...unusedMarkers.map(staleMarkerProblem));
    mutations.push(...kept);
    suppressedMutations.push(...suppressed);
  }
  const operators = options.operators?.length ? options.operators : undefined;
  const selected = operators ? mutations.filter((m) => operators.includes(m.operator)) : mutations;
  if (options.maxMutants !== undefined && (!Number.isInteger(options.maxMutants) || options.maxMutants < 1)) {
    throw new Error('maxMutants must be a positive integer.');
  }
  return {
    mutations: selected.slice(0, options.maxMutants),
    suppressed: operators ? suppressedMutations.filter((m) => operators.includes(m.operator)) : suppressedMutations,
    problems,
  };
}

export function planProject(project: Project, options: PlanOptions = {}): Mutation[] {
  return planProjectDetailed(project, options).mutations;
}

export async function snapshotProject(project: Project): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'apex-mutant-'));
  try {
    // Deliberate allowlist: never copy auth files, arbitrary config, or non-Apex metadata.
    const config: Record<string, unknown> = {
      packageDirectories: project.packageDirs.map((path, index) => ({ path, default: index === 0 })),
    };
    for (const key of ['namespace', 'sourceApiVersion']) {
      if (typeof project.config[key] === 'string') config[key] = project.config[key];
    }
    await writeFile(join(directory, 'sfdx-project.json'), JSON.stringify(config, null, 2));
    for (const path of project.packageDirs) {
      assertSafeRelativePath(path);
      await mkdir(join(directory, path), { recursive: true });
    }
    for (const [file, content] of project.files) {
      assertSafeRelativePath(file);
      await mkdir(resolve(directory, file, '..'), { recursive: true });
      await writeFile(join(directory, file), content);
    }
    return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Re-read every file apex-mutant loaded and compare it byte-for-byte with what it
 * read before the run. Mutants are only ever written into the temporary snapshot, so
 * this is the evidence for that claim rather than a restatement of it: if anything in
 * the local package directories differs afterwards, the report says so.
 *
 * `verified: false` means the check could not be completed (an in-memory Project with
 * no files on disk, an unreadable file, an unsafe path) — never that the source is
 * unchanged. It deliberately reads only the paths already in the snapshot, so a file
 * added by something else during the run is out of scope and not reported. */
export async function verifySourceIntegrity(project: Project): Promise<SourceIntegrity> {
  const changedFiles: string[] = [];
  const unreadable: string[] = [];
  let checked = 0;
  for (const [file, content] of project.files) {
    try {
      assertSafeRelativePath(file);
      const current = await readFile(join(project.root, file), 'utf8');
      checked++;
      if (current !== content) changedFiles.push(file);
    } catch {
      unreadable.push(file);
    }
  }
  if (unreadable.length) {
    return {
      verified: false, unchanged: false, filesChecked: checked, changedFiles,
      message: `${unreadable.length} of ${project.files.size} file(s) could not be re-read from ${project.root}; integrity is unproven either way.`,
    };
  }
  return {
    verified: true, unchanged: changedFiles.length === 0, filesChecked: checked, changedFiles,
    message: changedFiles.length
      ? `${changedFiles.length} file(s) differ from what apex-mutant read before the run: ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? ', …' : ''}.`
      : `All ${checked} file(s) are byte-for-byte identical to what apex-mutant read before the run.`,
  };
}
