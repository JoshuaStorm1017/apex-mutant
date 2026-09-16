import { lstat, readdir, readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { generateMutations } from './mutations.js';
import type { Mutation } from './types.js';

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
export function assertSafeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
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
export function planProject(project: Project, options: PlanOptions = {}): Mutation[] {
  const matches = (file: string, filters: string[]) => filters.some((prefix) => file === prefix || file.startsWith(prefix.replace(/\/$/, '') + '/'));
  const mutations: Mutation[] = [];
  for (const [file, source] of project.files) {
    if (!/\.(cls|trigger)$/i.test(file)) continue;
    if (options.include?.length && !matches(file, options.include)) continue;
    if (options.exclude?.length && matches(file, options.exclude)) continue;
    mutations.push(...generateMutations(source, file));
  }
  const selected = options.operators?.length ? mutations.filter((m) => options.operators!.includes(m.operator)) : mutations;
  if (options.maxMutants !== undefined && (!Number.isInteger(options.maxMutants) || options.maxMutants < 1)) {
    throw new Error('maxMutants must be a positive integer.');
  }
  return selected.slice(0, options.maxMutants);
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
