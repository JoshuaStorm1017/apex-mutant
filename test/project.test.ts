import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readProject, planProject, snapshotProject, assertSafeRelativePath } from '../src/project.js';

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'apex-mutant-project-'));
}

async function writeClass(root: string, relative: string, body = 'public class Placeholder { void m() { Boolean b = true; } }') {
  const full = join(root, relative);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body);
}

async function sfdxProject(root: string, packageDirectories: unknown) {
  await writeFile(join(root, 'sfdx-project.json'), JSON.stringify({ packageDirectories, sourceApiVersion: '58.0', namespace: 'acme' }));
}

test('readProject discovers Apex files, requires meta companions, and ignores tooling directories', async () => {
  const root = await fixture();
  try {
    await sfdxProject(root, [{ path: 'force-app', default: true }]);
    const cls = 'force-app/main/default/classes/Foo.cls';
    await writeClass(root, cls);
    await writeClass(root, cls + '-meta.xml', '<ApexClass/>');
    await writeClass(root, 'force-app/main/default/triggers/Bar.trigger', 'trigger Bar on Account (before insert) {}');
    await writeClass(root, 'force-app/main/default/triggers/Bar.trigger-meta.xml', '<ApexTrigger/>');
    // Ignored/hidden entries must never surface as project files.
    await writeClass(root, 'force-app/node_modules/x/Ignored.cls');
    await writeClass(root, 'force-app/.hidden/Ignored2.cls');
    await writeClass(root, 'force-app/main/default/classes/.DS_Store', 'junk');

    const project = await readProject(root);
    assert.deepEqual(project.packageDirs, ['force-app']);
    assert.deepEqual([...project.files.keys()].sort(), [
      'force-app/main/default/classes/Foo.cls',
      'force-app/main/default/classes/Foo.cls-meta.xml',
      'force-app/main/default/triggers/Bar.trigger',
      'force-app/main/default/triggers/Bar.trigger-meta.xml',
    ]);
    assert.equal(project.config.namespace, 'acme');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readProject allows package directories with no Apex at all', async () => {
  const root = await fixture();
  try {
    await sfdxProject(root, [{ path: 'force-app' }, { path: 'utils' }]);
    await writeClass(root, 'force-app/classes/Foo.cls');
    await writeClass(root, 'force-app/classes/Foo.cls-meta.xml', '<ApexClass/>');
    await mkdir(join(root, 'utils'), { recursive: true });
    const project = await readProject(root);
    assert.deepEqual(project.packageDirs.sort(), ['force-app', 'utils']);
    assert.equal(project.files.size, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readProject rejects a class file missing its metadata companion', async () => {
  const root = await fixture();
  try {
    await sfdxProject(root, [{ path: 'force-app' }]);
    await writeClass(root, 'force-app/classes/Foo.cls');
    await assert.rejects(readProject(root), /Missing metadata companion/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readProject rejects missing, empty, overlapping, or escaping package directories', async () => {
  const root = await fixture();
  try {
    await sfdxProject(root, []);
    await assert.rejects(readProject(root), /packageDirectories/);

    await sfdxProject(root, [{ path: '../outside' }]);
    await assert.rejects(readProject(root), /subdirectories inside the project/);

    await sfdxProject(root, [{ path: '/etc' }]);
    await assert.rejects(readProject(root));

    await mkdir(join(root, 'force-app', 'main'), { recursive: true });
    await sfdxProject(root, [{ path: 'force-app' }, { path: 'force-app/main' }]);
    await assert.rejects(readProject(root), /must not overlap/);

    await sfdxProject(root, [{ path: '   ' }]);
    await assert.rejects(readProject(root), /Invalid package directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readProject rejects a symlinked package directory ancestor', { skip: process.platform === 'win32' }, async () => {
  const root = await fixture();
  try {
    const real = join(root, 'real-app');
    await mkdir(join(real, 'classes'), { recursive: true });
    await symlink(real, join(root, 'force-app'));
    await sfdxProject(root, [{ path: 'force-app' }]);
    await assert.rejects(readProject(root), /Unsafe package directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readProject rejects a symlinked file inside an otherwise safe package directory', { skip: process.platform === 'win32' }, async () => {
  const root = await fixture();
  try {
    await sfdxProject(root, [{ path: 'force-app' }]);
    const outside = join(root, 'outside.cls');
    await writeFile(outside, 'public class Outside {}');
    await mkdir(join(root, 'force-app', 'classes'), { recursive: true });
    await symlink(outside, join(root, 'force-app', 'classes', 'Linked.cls'));
    await assert.rejects(readProject(root), /Symlinks are unsupported/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planProject applies deterministic include/exclude/operator filters and maxMutants', async () => {
  const root = await fixture();
  try {
    await sfdxProject(root, [{ path: 'force-app' }]);
    const a = 'force-app/classes/A.cls';
    const b = 'force-app/classes/B.cls';
    await writeClass(root, a, 'public class A { void m() { Boolean b = true; Integer x = 1 * 2; } }');
    await writeClass(root, a + '-meta.xml', '<ApexClass/>');
    await writeClass(root, b, 'public class B { void m() { Boolean b = false; } }');
    await writeClass(root, b + '-meta.xml', '<ApexClass/>');
    const project = await readProject(root);

    const all = planProject(project);
    assert.ok(all.length >= 3);
    // planProject concatenates per-file mutation lists; each file's own mutations stay
    // in ascending offset order (offsets are only comparable within a single file).
    for (const file of [a, b]) {
      const perFile = all.filter((m) => m.file === file);
      assert.deepEqual([...perFile].sort((x, y) => x.start - y.start), perFile);
    }
    // Repeated calls over the same project are byte-for-byte identical.
    assert.deepEqual(planProject(project), all);

    const onlyA = planProject(project, { include: [a] });
    assert.ok(onlyA.every((m) => m.file === a));
    assert.ok(onlyA.length > 0);

    const excludeA = planProject(project, { exclude: [a] });
    assert.ok(excludeA.every((m) => m.file === b));

    const onlyBoolean = planProject(project, { operators: ['boolean-literal'] });
    assert.ok(onlyBoolean.length > 0);
    assert.ok(onlyBoolean.every((m) => m.operator === 'boolean-literal'));

    const limited = planProject(project, { maxMutants: 1 });
    assert.equal(limited.length, 1);
    assert.deepEqual(limited[0], all[0]);

    assert.throws(() => planProject(project, { maxMutants: 0 }), /positive integer/);
    assert.throws(() => planProject(project, { maxMutants: 1.5 }), /positive integer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshotProject writes an allowlisted config and exact file contents into an isolated directory', async () => {
  const root = await fixture();
  try {
    await sfdxProject(root, [{ path: 'force-app' }]);
    const cls = 'force-app/classes/Foo.cls';
    await writeClass(root, cls, 'public class Foo {}');
    await writeClass(root, cls + '-meta.xml', '<ApexClass/>');
    const project = await readProject(root);
    // Simulate an unexpected/unsanctioned config key that must never be copied.
    project.config.authFilePath = '~/.sfdx/secret.json';

    const snapshot = await snapshotProject(project);
    try {
      const config = JSON.parse(await readFile(join(snapshot.directory, 'sfdx-project.json'), 'utf8'));
      assert.deepEqual(config, { packageDirectories: [{ path: 'force-app', default: true }], namespace: 'acme', sourceApiVersion: '58.0' });
      assert.equal(await readFile(join(snapshot.directory, cls), 'utf8'), 'public class Foo {}');
      assert.equal(await readFile(join(snapshot.directory, cls + '-meta.xml'), 'utf8'), '<ApexClass/>');
    } finally {
      await snapshot.cleanup();
    }
    await assert.rejects(stat(snapshot.directory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshotProject rejects file keys that would escape the snapshot directory', async () => {
  const root = await fixture();
  try {
    await sfdxProject(root, [{ path: 'force-app' }]);
    const cls = 'force-app/classes/Foo.cls';
    await writeClass(root, cls, 'public class Foo {}');
    await writeClass(root, cls + '-meta.xml', '<ApexClass/>');
    const project = await readProject(root);
    // A hand-crafted Project (library callers can build one directly) must not be able to
    // make snapshotProject write outside its own temporary directory.
    project.files.set('../../evil.cls', 'public class Evil {}');

    await assert.rejects(snapshotProject(project), /Unsafe file path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assertSafeRelativePath rejects backslash traversal and drive-letter prefixes regardless of the host OS', () => {
  // These must be rejected on every platform this code might run on, not only on
  // whichever OS treats '\' as a path separator natively — Apex identifiers never
  // legitimately contain '\' or ':', so any occurrence here is unsafe by construction.
  for (const unsafe of [
    '..\\..\\evil.cls', 'force-app\\..\\..\\evil.cls', 'C:\\evil.cls', 'c:evil.cls',
    'force-app\\classes\\Foo.cls\\..\\..\\evil.cls', '\\evil.cls',
  ]) {
    assert.throws(() => assertSafeRelativePath(unsafe), /Unsafe file path/, unsafe);
  }
  for (const safe of ['force-app/classes/Foo.cls', 'Foo.cls', 'a/b/c.trigger']) {
    assert.doesNotThrow(() => assertSafeRelativePath(safe), safe);
  }
});
