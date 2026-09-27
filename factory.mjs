#!/usr/bin/env node
/** Local controller for persistent project Sprites. */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ExecError, SpritesClient } from '@fly/sprites';

const root = dirname(fileURLToPath(import.meta.url));
const statePath = join(root, '.factory', 'state.sqlite3');
const projectPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
const entireVersionExpected = 'Entire CLI 0.11.3';
const entireCodexHookSha256 = 'd0ed5dd1cf5d2d269abfdb6c00161b406d0233b7a4bf1ff72f288405b4959b10';

class FactoryError extends Error {}

function token() {
  if (process.env.SPRITE_TOKEN?.trim()) return process.env.SPRITE_TOKEN.trim();
  const path = join(root, '.env.local');
  if (!existsSync(path)) throw new FactoryError('Set SPRITE_TOKEN in .env.local or the environment');
  const values = readFileSync(path, 'utf8').split(/\r?\n/)
    .filter(line => line.startsWith('SPRITE_TOKEN='))
    .map(line => line.slice('SPRITE_TOKEN='.length).trim().replace(/^(['"])(.*)\1$/, '$2'));
  if (values.length !== 1 || !values[0]) {
    throw new FactoryError('.env.local needs exactly one nonempty SPRITE_TOKEN');
  }
  return values[0];
}

function database() {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(statePath);
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    sprite_name TEXT NOT NULL UNIQUE,
    sprite_id TEXT,
    sprite_url TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const columns = new Set(db.prepare('PRAGMA table_info(projects)').all().map(row => row.name));
  for (const name of ['repo_path', 'entire_version', 'codex_hook_sha256']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} TEXT`);
  }
  return db;
}

function project(db, projectId) {
  const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
  if (!row) throw new FactoryError(`Unknown project: ${projectId}. Run provision first.`);
  return row;
}

async function getSprite(client, name) {
  try {
    return await client.getSprite(name);
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function provision(db, client, projectId) {
  if (!projectPattern.test(projectId)) {
    throw new FactoryError('Project ID must use lowercase letters, digits, and hyphens (max 40)');
  }
  let row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
  if (!row) {
    // Persist identity before the API request so retries reconcile a Sprite
    // created just before a controller crash.
    const name = `sf-${projectId.slice(0, 35).replace(/-$/, '')}-${randomBytes(4).toString('hex')}`;
    db.prepare("INSERT INTO projects (project_id, sprite_name, state) VALUES (?, ?, 'provisioning')")
      .run(projectId, name);
    row = project(db, projectId);
  }
  const sprite = await getSprite(client, row.sprite_name) ?? await client.createSprite(row.sprite_name);
  if (!sprite.id || sprite.name !== row.sprite_name) {
    throw new FactoryError('Sprites API returned incomplete project identity');
  }
  db.prepare("UPDATE projects SET sprite_id = ?, sprite_url = ?, state = 'ready', updated_at = CURRENT_TIMESTAMP WHERE project_id = ?")
    .run(sprite.id, sprite.url ?? null, projectId);
  return sprite;
}

function summary(row, sprite) {
  const result = {
    project_id: row.project_id,
    sprite_name: row.sprite_name,
    sprite_id: row.sprite_id,
    sprite_url: row.sprite_url,
    state: row.state,
    repo_path: row.repo_path,
    entire_version: row.entire_version,
    codex_hook_vetted: row.codex_hook_sha256 === entireCodexHookSha256,
  };
  if (sprite) {
    result.sprite_status = sprite.status;
    result.url_auth = sprite.urlSettings?.auth;
  }
  return result;
}

async function remoteResult(sprite, file, args = [], cwd) {
  try {
    return await sprite.execFile(file, args, { cwd, timeout: 120_000 });
  } catch (error) {
    if (error instanceof ExecError) return error.result;
    throw error;
  }
}

async function remoteRun(sprite, file, args = [], cwd) {
  const result = await remoteResult(sprite, file, args, cwd);
  if (result.exitCode !== 0) {
    throw new FactoryError(`Sprite command ${file} failed (exit ${result.exitCode})`);
  }
  return String(result.stdout).trim();
}

async function remoteExists(sprite, path) {
  return (await remoteResult(sprite, 'test', ['-e', path])).exitCode === 0;
}

async function verifyCodexHooks(sprite, repoPath) {
  const config = await sprite.filesystem('/').readFile(`${repoPath}/.codex/hooks.json`, 'utf8');
  const digest = createHash('sha256').update(config).digest('hex');
  if (digest !== entireCodexHookSha256) {
    throw new FactoryError('Codex hooks differ from the vetted Entire 0.11.3 configuration');
  }
  const extraSources = [
    '/home/sprite/.codex/hooks.json',
    '/home/sprite/.codex/config.toml',
    '/home/sprite/.codex/plugins',
    `${repoPath}/.codex/config.toml`,
  ];
  for (const path of extraSources) {
    if (await remoteExists(sprite, path)) {
      throw new FactoryError(`Additional Codex hook source needs review: ${path}`);
    }
  }
  return digest;
}

async function bootstrap(db, sprite, projectId, repoUrl) {
  const repoPath = `/home/sprite/projects/${projectId}`;
  await remoteRun(sprite, 'git', ['--version']);
  if (!(await remoteExists(sprite, `${repoPath}/.git`))) {
    await remoteRun(sprite, 'mkdir', ['-p', '/home/sprite/projects']);
    if (repoUrl) {
      await remoteRun(sprite, 'git', ['clone', '--', repoUrl, repoPath]);
    } else {
      await remoteRun(sprite, 'git', ['init', '-b', 'main', repoPath]);
    }
  }
  const hasEntire = (await remoteResult(sprite, 'sh', ['-lc', 'command -v entire'])).exitCode === 0;
  let installed = hasEntire ? await remoteResult(sprite, 'entire', ['version'])
    : { exitCode: 1, stdout: '' };
  if (installed.exitCode !== 0 || !String(installed.stdout).startsWith(entireVersionExpected)) {
    const install = `set -euo pipefail
      version=0.11.3
      archive=entire_linux_amd64.tar.gz
      base=https://github.com/entireio/cli/releases/download/v$version
      temp_dir=$(mktemp -d)
      trap 'rm -rf "$temp_dir"' EXIT
      curl -fsSL "$base/$archive" -o "$temp_dir/$archive"
      curl -fsSL "$base/checksums.txt" -o "$temp_dir/checksums.txt"
      (cd "$temp_dir" && grep " $archive$" checksums.txt | sha256sum -c -)
      tar -xzf "$temp_dir/$archive" -C "$temp_dir"
      install -m 755 "$temp_dir/entire" /home/sprite/.local/bin/entire
      install -m 755 "$temp_dir/git-remote-entire" /home/sprite/.local/bin/git-remote-entire`;
    await remoteRun(sprite, 'bash', ['-lc', install]);
    installed = await remoteResult(sprite, 'entire', ['version']);
  }
  const entireVersion = String(installed.stdout).split('\n')[0];
  if (installed.exitCode !== 0 || entireVersion !== entireVersionExpected) {
    throw new FactoryError(`Expected ${entireVersionExpected} inside Sprite`);
  }
  if (!(await remoteExists(sprite, `${repoPath}/.entire/settings.json`))) {
    await remoteRun(sprite, 'entire', ['enable', '--agent', 'codex', '--no-init-repo', '--telemetry=false'], repoPath);
  }
  await remoteRun(sprite, 'entire', ['agent', 'add', 'codex'], repoPath);
  await remoteRun(sprite, 'entire', ['agent', 'add', 'claude-code'], repoPath);
  const status = JSON.parse(await remoteRun(sprite, 'entire', ['status', '--json'], repoPath));
  if (!status.enabled || !status.agents.includes('Codex') || !status.agents.includes('Claude Code')) {
    throw new FactoryError('Entire did not enable both harness integrations');
  }
  await remoteRun(sprite, 'entire', ['doctor'], repoPath);
  const hookSha = await verifyCodexHooks(sprite, repoPath);
  const files = ['.entire/settings.json', '.entire/.gitignore', '.codex/hooks.json', '.claude/settings.json'];
  await remoteRun(sprite, 'git', ['add', '--', ...files], repoPath);
  const staged = await remoteResult(sprite, 'git', ['diff', '--cached', '--quiet'], repoPath);
  if (staged.exitCode === 1) {
    await remoteRun(sprite, 'git', ['-c', 'user.name=Software Factory', '-c', 'user.email=factory@localhost',
      'commit', '-m', 'Enable Entire session tracking'], repoPath);
  } else if (staged.exitCode !== 0) {
    throw new FactoryError('Could not inspect staged bootstrap files');
  }
  db.prepare(`UPDATE projects SET repo_path = ?, entire_version = ?, codex_hook_sha256 = ?,
    updated_at = CURRENT_TIMESTAMP WHERE project_id = ?`)
    .run(repoPath, entireVersion, hookSha, projectId);
  return { repo_path: repoPath, entire_version: entireVersion, codex_hook_vetted: true };
}

function usage() {
  console.log(`Usage:
  node factory.mjs provision <project-id>
  node factory.mjs projects
  node factory.mjs status <project-id>
  node factory.mjs exec <project-id> -- <command> [args...]
  node factory.mjs bootstrap <project-id> [--repo-url <git-url>]`);
}

async function main(args) {
  const [command, projectId, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    usage();
    return command ? 0 : 1;
  }
  const db = database();
  try {
    if (command === 'projects') {
      console.log(JSON.stringify(db.prepare('SELECT * FROM projects ORDER BY project_id').all()
        .map(row => summary(row)), null, 2));
      return 0;
    }
    if (!['provision', 'status', 'exec', 'bootstrap'].includes(command) || !projectId) {
      usage();
      return 1;
    }
    const client = new SpritesClient(token());
    if (command === 'provision') {
      const sprite = await provision(db, client, projectId);
      console.log(JSON.stringify(summary(project(db, projectId), sprite), null, 2));
      return 0;
    }
    const row = project(db, projectId);
    const sprite = await getSprite(client, row.sprite_name);
    if (!sprite) throw new FactoryError(`Sprite for ${projectId} is missing; state is preserved`);
    if (command === 'status') {
      console.log(JSON.stringify(summary(row, sprite), null, 2));
      return 0;
    }
    if (command === 'bootstrap') {
      let repoUrl;
      if (rest.length) {
        if (rest.length !== 2 || rest[0] !== '--repo-url') {
          throw new FactoryError('Use bootstrap <project-id> [--repo-url <git-url>]');
        }
        repoUrl = rest[1];
      }
      console.log(JSON.stringify(await bootstrap(db, sprite, projectId, repoUrl), null, 2));
      return 0;
    }
    const argv = rest[0] === '--' ? rest.slice(1) : rest;
    if (!argv.length) throw new FactoryError('Pass a command after the project ID');
    let result;
    try {
      result = await sprite.execFile(argv[0], argv.slice(1), { timeout: 120_000 });
    } catch (error) {
      if (!(error instanceof ExecError)) throw error;
      result = error.result;
    }
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.exitCode;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof FactoryError ? error.message
    : `Operation failed (${error.constructor?.name ?? 'Error'}${error.statusCode ? `, HTTP ${error.statusCode}` : ''})`;
  console.error(`factory: ${message}`);
  process.exitCode = 1;
}
