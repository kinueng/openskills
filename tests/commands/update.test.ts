import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateSkills } from '../../src/commands/update.js';
import { readSkillMetadata, writeSkillMetadata } from '../../src/utils/skill-metadata.js';

/**
 * Set up a local bare git repo containing SKILL.md so tests can use it as
 * a clone source without hitting the network. Returns the bare repo path
 * (used as `repoUrl`), a working clone for pushing new commits, and the
 * initial HEAD SHA.
 */
function setupBareSkillRepo(
  parent: string,
  label: string,
  skillContent: string
): { bareDir: string; workDir: string; sha: string } {
  const bareDir = join(parent, `${label}.git`);
  const workDir = join(parent, `${label}-work`);
  mkdirSync(workDir, { recursive: true });
  const opts = { cwd: workDir, stdio: 'pipe' as const };

  execSync('git init -q -b main', opts);
  // Set identity per-repo so tests don't depend on the developer's
  // global git config (HOME is already pointed at a temp dir).
  execSync('git config user.email "test@example.com"', opts);
  execSync('git config user.name "Test"', opts);
  writeFileSync(join(workDir, 'SKILL.md'), skillContent);
  execSync('git add SKILL.md', opts);
  execSync('git commit -q -m "initial"', opts);

  execSync(`git init --bare -q -b main "${bareDir}"`);
  execSync(`git remote add origin "${bareDir}"`, opts);
  execSync('git push -q origin main', opts);

  const sha = execSync('git rev-parse HEAD', { cwd: workDir, encoding: 'utf-8' }).trim();
  return { bareDir, workDir, sha };
}

/** Push a new SKILL.md commit to the bare repo via the working clone. */
function pushNewSkillCommit(workDir: string, newContent: string): string {
  const opts = { cwd: workDir, stdio: 'pipe' as const };
  writeFileSync(join(workDir, 'SKILL.md'), newContent);
  execSync('git add SKILL.md', opts);
  execSync('git commit -q -m "update"', opts);
  execSync('git push -q origin main', opts);
  return execSync('git rev-parse HEAD', { cwd: workDir, encoding: 'utf-8' }).trim();
}

describe('updateSkills', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tempRoot: string;
  let projectDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'openskills-update-test-'));
    projectDir = join(tempRoot, 'project');
    mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);

    process.env.HOME = join(tempRoot, 'home');
    mkdirSync(process.env.HOME, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('updates a local skill from recorded source', async () => {
    const sourceDir = join(tempRoot, 'source-skill');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, 'SKILL.md'),
      "---\nname: demo\ndescription: v2\n---\n\n# Demo\nv2\n"
    );

    const targetDir = join(projectDir, '.claude/skills/demo');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, 'SKILL.md'),
      "---\nname: demo\ndescription: v1\n---\n\n# Demo\nv1\n"
    );

    writeSkillMetadata(targetDir, {
      source: './source-skill',
      sourceType: 'local',
      localPath: sourceDir,
      installedAt: '2026-01-01T00:00:00.000Z',
    });

    await updateSkills([]);

    const updated = readFileSync(join(targetDir, 'SKILL.md'), 'utf-8');
    expect(updated).toContain('v2');
  });

  it('skips skills without metadata without deleting them', async () => {
    const targetDir = join(projectDir, '.claude/skills/no-metadata');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, 'SKILL.md'),
      "---\nname: no-metadata\ndescription: v1\n---\n\n# Demo\nv1\n"
    );

    await updateSkills([]);

    const content = readFileSync(join(targetDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('v1');
  });

  it('skips clone when recorded commitSha matches upstream HEAD', async () => {
    const { bareDir, sha } = setupBareSkillRepo(
      tempRoot,
      'skip-match',
      "---\nname: skip-match\ndescription: remote\n---\n\nremote-content\n"
    );

    // Install location holds a deliberately-different local content. If the
    // clone runs, this string gets overwritten with the remote's. Surviving
    // unchanged is the proof that the up-to-date short-circuit fired.
    const targetDir = join(projectDir, '.claude/skills/skip-match');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, 'SKILL.md'),
      "---\nname: skip-match\ndescription: local\n---\n\nlocal-untouched\n"
    );
    writeSkillMetadata(targetDir, {
      source: 'test/skip-match',
      sourceType: 'git',
      repoUrl: bareDir,
      subpath: '',
      installedAt: '2026-01-01T00:00:00.000Z',
      commitSha: sha,
    });

    await updateSkills([]);

    const after = readFileSync(join(targetDir, 'SKILL.md'), 'utf-8');
    expect(after).toContain('local-untouched');
  });

  it('re-clones and refreshes commitSha when upstream HEAD differs', async () => {
    const { bareDir, workDir, sha: oldSha } = setupBareSkillRepo(
      tempRoot,
      'changed-remote',
      "---\nname: changed-remote\ndescription: v1\n---\n\nv1\n"
    );

    const targetDir = join(projectDir, '.claude/skills/changed-remote');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, 'SKILL.md'),
      "---\nname: changed-remote\ndescription: v1\n---\n\nv1\n"
    );
    writeSkillMetadata(targetDir, {
      source: 'test/changed-remote',
      sourceType: 'git',
      repoUrl: bareDir,
      subpath: '',
      installedAt: '2026-01-01T00:00:00.000Z',
      commitSha: oldSha,
    });

    const newSha = pushNewSkillCommit(
      workDir,
      "---\nname: changed-remote\ndescription: v2\n---\n\nv2\n"
    );
    expect(newSha).not.toBe(oldSha);

    await updateSkills([]);

    const after = readFileSync(join(targetDir, 'SKILL.md'), 'utf-8');
    expect(after).toContain('v2');
    const updatedMetadata = readSkillMetadata(targetDir);
    expect(updatedMetadata?.commitSha).toBe(newSha);
  });

  it('clones and stamps commitSha when metadata has none (legacy install)', async () => {
    const { bareDir, sha } = setupBareSkillRepo(
      tempRoot,
      'legacy',
      "---\nname: legacy\ndescription: remote\n---\n\nremote-content\n"
    );

    const targetDir = join(projectDir, '.claude/skills/legacy');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, 'SKILL.md'),
      "---\nname: legacy\ndescription: stale\n---\n\nstale\n"
    );
    // Legacy metadata: no commitSha field. Older openskills versions wrote
    // these; they should auto-heal on first update.
    writeSkillMetadata(targetDir, {
      source: 'test/legacy',
      sourceType: 'git',
      repoUrl: bareDir,
      subpath: '',
      installedAt: '2026-01-01T00:00:00.000Z',
    });

    await updateSkills([]);

    const after = readFileSync(join(targetDir, 'SKILL.md'), 'utf-8');
    expect(after).toContain('remote-content');
    const updatedMetadata = readSkillMetadata(targetDir);
    expect(updatedMetadata?.commitSha).toBe(sha);
  });

  it('--force re-clones even when recorded commitSha matches upstream', async () => {
    const { bareDir, sha } = setupBareSkillRepo(
      tempRoot,
      'force-bypass',
      "---\nname: force-bypass\ndescription: remote\n---\n\nremote-content\n"
    );

    const targetDir = join(projectDir, '.claude/skills/force-bypass');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, 'SKILL.md'),
      "---\nname: force-bypass\ndescription: local\n---\n\nlocal-untouched\n"
    );
    writeSkillMetadata(targetDir, {
      source: 'test/force-bypass',
      sourceType: 'git',
      repoUrl: bareDir,
      subpath: '',
      installedAt: '2026-01-01T00:00:00.000Z',
      commitSha: sha,
    });

    await updateSkills([], { force: true });

    const after = readFileSync(join(targetDir, 'SKILL.md'), 'utf-8');
    expect(after).toContain('remote-content');
  });
});
