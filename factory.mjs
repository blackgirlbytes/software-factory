#!/usr/bin/env node
/** Local controller for persistent project Sprites. */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn as spawnLocal } from 'node:child_process';
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
const codexVersionExpected = 'codex-cli 0.158.0';
const codexInstallDir = '/home/sprite/.local/share/software-factory-codex';
const codexScript = `${codexInstallDir}/node_modules/@openai/codex/bin/codex.js`;
const previousAgentRulesSha256 = '1383fb6dcff9b4bd33e062a43806ee3aef8fc1ecb57a24e470eb979ece50b3d7';

class FactoryError extends Error {}

function secret(name) {
  if (process.env[name]?.trim()) return process.env[name].trim();
  const path = join(root, '.env.local');
  if (!existsSync(path)) throw new FactoryError(`Set ${name} in .env.local or the environment`);
  const values = readFileSync(path, 'utf8').split(/\r?\n/)
    .filter(line => line.startsWith(`${name}=`))
    .map(line => line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2'));
  if (values.length !== 1 || !values[0]) {
    throw new FactoryError(`.env.local needs exactly one nonempty ${name}`);
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
  db.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const sessionColumns = new Set(db.prepare('PRAGMA table_info(agent_sessions)').all().map(row => row.name));
  for (const name of ['commit_sha', 'checkpoint_id']) {
    if (!sessionColumns.has(name)) db.exec(`ALTER TABLE agent_sessions ADD COLUMN ${name} TEXT`);
  }
  const columns = new Set(db.prepare('PRAGMA table_info(projects)').all().map(row => row.name));
  for (const [name, type] of [
    ['repo_path', 'TEXT'], ['entire_version', 'TEXT'], ['codex_hook_sha256', 'TEXT'],
    ['github_repo', 'TEXT'], ['github_repo_id', 'INTEGER'],
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${type}`);
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
    github_repo: row.github_repo,
    entire_version: row.entire_version,
    codex_hook_vetted_at_bootstrap: row.codex_hook_sha256 === entireCodexHookSha256,
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

async function localCommand(file, args, input = '') {
  return await new Promise((resolve, reject) => {
    const command = spawnLocal(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      command.kill('SIGTERM');
      reject(new FactoryError(`${file} timed out`));
    }, 60_000);
    command.stdout.on('data', chunk => { stdout += chunk.toString(); });
    command.stderr.on('data', chunk => { stderr += chunk.toString(); });
    command.once('error', () => {
      clearTimeout(timer);
      reject(new FactoryError(`${file} is required to manage project repositories`));
    });
    command.once('close', exitCode => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    command.stdin.end(input);
  });
}

async function githubApi(endpoint, { method, body, allowMissing = false } = {}) {
  const args = ['api', endpoint];
  if (method) args.push('--method', method);
  if (body !== undefined) args.push('--input', '-');
  const result = await localCommand('gh', args, body === undefined ? '' : JSON.stringify(body));
  if (result.exitCode !== 0) {
    if (allowMissing && result.stderr.includes('(HTTP 404)')) return null;
    throw new FactoryError(`GitHub API request failed: ${endpoint}`);
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new FactoryError(`GitHub API returned invalid JSON: ${endpoint}`); }
}

async function ensureManagedRemote(db, sprite, row, repoPath) {
  const account = await githubApi('user');
  if (!/^[A-Za-z0-9-]+$/.test(account.login)) throw new FactoryError('Invalid GitHub account name');
  const fullName = `${account.login}/${row.sprite_name}`;
  if (row.github_repo && row.github_repo !== fullName) {
    throw new FactoryError('This project is bound to a different GitHub repository');
  }
  const description = `Software Factory project ${row.project_id} (${row.sprite_name})`;
  let repo = await githubApi(`repos/${fullName}`, { allowMissing: true });
  if (!repo) {
    repo = await githubApi('user/repos', { method: 'POST', body: {
      name: row.sprite_name, description, private: true, auto_init: false,
    } });
  }
  if (repo.full_name !== fullName || (row.github_repo_id && repo.id !== row.github_repo_id)
    || (!row.github_repo_id && (repo.description !== description || !repo.private))) {
    throw new FactoryError(`GitHub repository ${fullName} does not match this project`);
  }
  db.prepare(`UPDATE projects SET github_repo = ?, github_repo_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE project_id = ?`).run(fullName, repo.id, row.project_id);

  const sshDir = '/home/sprite/.ssh';
  const keyPath = `${sshDir}/${row.sprite_name}`;
  const knownHostsPath = `${sshDir}/known_hosts-${row.sprite_name}`;
  await remoteRun(sprite, 'mkdir', ['-p', sshDir]);
  await remoteRun(sprite, 'chmod', ['700', sshDir]);
  if (!(await remoteExists(sprite, keyPath))) {
    await remoteRun(sprite, 'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath,
      '-C', `${row.sprite_name}@software-factory`]);
  }
  const publicKey = (await sprite.filesystem('/').readFile(`${keyPath}.pub`, 'utf8')).trim();
  const keyIdentity = publicKey.split(/\s+/).slice(0, 2).join(' ');
  const keys = await githubApi(`repos/${fullName}/keys`);
  const existingKey = keys.find(key => key.key.split(/\s+/).slice(0, 2).join(' ') === keyIdentity);
  if (existingKey?.read_only) throw new FactoryError('Project deploy key cannot push');
  if (!existingKey) {
    await githubApi(`repos/${fullName}/keys`, { method: 'POST', body: {
      title: `Software Factory ${row.sprite_name}`, key: publicKey, read_only: false,
    } });
  }

  const githubMeta = await githubApi('meta');
  if (!Array.isArray(githubMeta.ssh_keys) || !githubMeta.ssh_keys.length) {
    throw new FactoryError('GitHub did not provide SSH host keys');
  }
  await sprite.filesystem('/').writeFile(knownHostsPath,
    `${githubMeta.ssh_keys.map(key => `github.com ${key}`).join('\n')}\n`, { mode: 0o600 });
  const sshCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsPath}`;
  await remoteRun(sprite, 'git', ['config', '--local', 'core.sshCommand', sshCommand], repoPath);
  const url = `git@github.com:${fullName}.git`;
  const remotes = (await remoteRun(sprite, 'git', ['remote'], repoPath)).split(/\r?\n/);
  if (remotes.includes('origin')) {
    const current = await remoteRun(sprite, 'git', ['remote', 'get-url', 'origin'], repoPath);
    if (current !== url) throw new FactoryError('Project origin differs from managed GitHub repository');
  } else {
    await remoteRun(sprite, 'git', ['remote', 'add', 'origin', url], repoPath);
  }
  await remoteRun(sprite, 'git', ['ls-remote', 'origin'], repoPath);
  return fullName;
}

async function installAgentRules(sprite, repoPath) {
  const destination = `${repoPath}/AGENTS.md`;
  const expected = readFileSync(join(root, 'templates', 'AGENTS.md'), 'utf8');
  let updating = false;
  if (await remoteExists(sprite, destination)) {
    const actual = await sprite.filesystem('/').readFile(destination, 'utf8');
    if (actual === expected) return;
    if (createHash('sha256').update(actual).digest('hex') !== previousAgentRulesSha256) {
      throw new FactoryError('Project AGENTS.md differs from factory rules');
    }
    updating = true;
  }
  await sprite.filesystem('/').writeFile(destination, expected);
  await remoteRun(sprite, 'git', ['add', '--', 'AGENTS.md'], repoPath);
  await remoteRun(sprite, 'git', ['-c', 'user.name=Software Factory', '-c', 'user.email=factory@localhost',
    'commit', '-m', updating ? 'Update factory agent rules' : 'Add factory agent rules'], repoPath);
  await remoteRun(sprite, 'git', ['push', 'origin', 'main'], repoPath);
}

async function streamedCommand(sprite, file, args, { cwd, input = '', timeout = 120_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const command = sprite.spawn(file, args, { cwd });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      command.kill('SIGTERM');
      finish(new FactoryError(`Sprite command ${file} timed out`));
    }, timeout);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }
    command.stdout.on('data', chunk => { stdout += chunk.toString(); });
    command.stderr.on('data', chunk => { stderr += chunk.toString(); });
    command.once('error', error => finish(error));
    command.once('spawn', () => command.stdin.end(input));
    command.once('exit', exitCode => finish(null, { exitCode, stdout, stderr }));
  });
}

async function prepareCodex(sprite) {
  const installed = await remoteResult(sprite, 'node', [codexScript, '--version']);
  if (installed.exitCode === 0 && String(installed.stdout).trim() === codexVersionExpected) return;
  await remoteRun(sprite, 'npm', ['install', '--prefix', codexInstallDir,
    '--no-audit', '--no-fund', '@openai/codex@0.158.0']);
  const result = await remoteResult(sprite, 'node', [codexScript, '--version']);
  if (result.exitCode !== 0 || String(result.stdout).trim() !== codexVersionExpected) {
    throw new FactoryError(`Expected ${codexVersionExpected} inside Sprite`);
  }
}

async function authenticateCodex(sprite) {
  const result = await streamedCommand(sprite, 'node', [codexScript, 'login', '--with-api-key'],
    { input: `${secret('OPENAI_API_KEY')}\n` });
  if (result.exitCode !== 0) throw new FactoryError('Codex API-key login failed inside Sprite');
  const status = await remoteResult(sprite, 'node', [codexScript, 'login', 'status']);
  if (status.exitCode !== 0 || !`${status.stdout}${status.stderr}`.includes('Logged in')) {
    throw new FactoryError('Codex is not authenticated inside Sprite');
  }
}

async function codexSmoke(db, sprite, projectId, repoPath) {
  await prepareCodex(sprite);
  await authenticateCodex(sprite);
  await verifyCodexHooks(sprite, repoPath);
  // Sprites inherit ambient capabilities that Bubblewrap rejects. Drop them
  // before launching Codex so its own sandbox can protect the workspace.
  const result = await streamedCommand(sprite, 'setpriv', [
    '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
    'node', codexScript, 'exec', '--sandbox', 'read-only', '--dangerously-bypass-hook-trust',
    '--json', '-C', repoPath,
    'Run pwd using a shell command and report its exact output. Do not edit files.'], { cwd: repoPath });
  const events = String(result.stdout).split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const sessionId = events.find(event => event.type === 'thread.started')?.thread_id;
  const commandWorked = events.some(event => event.type === 'item.completed'
    && event.item?.type === 'command_execution'
    && event.item?.exit_code === 0
    && String(event.item?.aggregated_output).includes(repoPath));
  if (result.exitCode !== 0 || !sessionId || !commandWorked) {
    throw new FactoryError('Codex could not run a shell command inside Sprite');
  }
  let captured = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const list = JSON.parse(await remoteRun(sprite, 'entire', ['session', 'list', '--json'], repoPath));
    if (list.some(session => session.session_id === sessionId && session.turns > 0)) {
      captured = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!captured) throw new FactoryError('Entire did not capture the Codex session');
  db.prepare(`INSERT OR REPLACE INTO agent_sessions (session_id, project_id, agent, status)
    VALUES (?, ?, 'Codex', 'completed')`).run(sessionId, projectId);
  return { project_id: projectId, codex_version: codexVersionExpected,
    session_id: sessionId, shell_command_verified: true, entire_session_captured: true };
}

async function codexFile(db, sprite, row, relativePath, instruction,
  { network = false, timeout = 600_000, branch = 'main' } = {}) {
  const segments = relativePath?.split('/') ?? [];
  if (!relativePath || !/^[A-Za-z0-9._/-]+$/.test(relativePath)
    || segments.some(segment => !segment || segment === '.' || segment === '..')
    || ['.git', '.codex', '.entire'].includes(segments[0]) || relativePath === 'AGENTS.md') {
    throw new FactoryError('Pass one safe repository-relative file path');
  }
  if (!instruction?.trim()) throw new FactoryError('Pass a file instruction after --');
  if (!row.github_repo || !row.repo_path) {
    throw new FactoryError('Bootstrap a factory-managed repository before running Codex');
  }
  const repoPath = row.repo_path;
  const rules = await sprite.filesystem('/').readFile(`${repoPath}/AGENTS.md`, 'utf8');
  if (rules !== readFileSync(join(root, 'templates', 'AGENTS.md'), 'utf8')) {
    throw new FactoryError('Project AGENTS.md is not the current factory policy');
  }
  if (await remoteRun(sprite, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], repoPath)) {
    throw new FactoryError('Project working tree must be clean before a file task');
  }
  await prepareCodex(sprite);
  await authenticateCodex(sprite);
  await verifyCodexHooks(sprite, repoPath);
  const prompt = `Read AGENTS.md. Change only ${relativePath}. ${instruction.trim()}\n` +
    'After changing that one file, stop. The factory controller will immediately commit and push it because your sandbox protects .git. Do not edit another file or attempt Git metadata changes.';
  const result = await streamedCommand(sprite, 'setpriv', [
    '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
    'node', codexScript, 'exec', '--sandbox', 'workspace-write',
    ...(network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    '--dangerously-bypass-hook-trust', '--json', '-C', repoPath, prompt,
  ], { cwd: repoPath, timeout });
  const events = String(result.stdout).split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const sessionId = events.find(event => event.type === 'thread.started')?.thread_id;
  const tracked = await remoteRun(sprite, 'git', ['diff', '--name-only', 'HEAD'], repoPath);
  const untracked = await remoteRun(sprite, 'git', ['ls-files', '--others', '--exclude-standard'], repoPath);
  const changes = `${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean);
  if (result.exitCode !== 0 || !sessionId || changes.length !== 1
    || changes[0] !== relativePath) {
    const lastEvent = events.at(-1)?.type ?? 'none';
    throw new FactoryError(`Codex file task did not change exactly ${relativePath} ` +
      `(exit ${result.exitCode}, session ${sessionId ? 'started' : 'missing'}, ` +
      `changed ${JSON.stringify(changes)}, last event ${lastEvent}); inspect the Sprite before continuing`);
  }
  await remoteRun(sprite, 'git', ['add', '--', relativePath], repoPath);
  await remoteRun(sprite, 'git', ['-c', 'user.name=Software Factory', '-c', 'user.email=factory@localhost',
    'commit', '-m', `Update ${relativePath}`], repoPath);
  await remoteRun(sprite, 'git', ['push', 'origin', branch], repoPath);
  const commit = await remoteRun(sprite, 'git', ['log', '-1', '--format=%H%n%B'], repoPath);
  const commitSha = commit.split('\n')[0];
  const checkpointId = commit.match(/^Entire-Checkpoint:\s*(\S+)/m)?.[1];
  if (!checkpointId) throw new FactoryError('Change was pushed but Entire did not link a checkpoint');
  if (await remoteRun(sprite, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], repoPath)) {
    throw new FactoryError('Change was pushed but the project working tree is not clean');
  }
  db.prepare(`INSERT OR REPLACE INTO agent_sessions
    (session_id, project_id, agent, status, commit_sha, checkpoint_id)
    VALUES (?, ?, 'Codex', 'completed', ?, ?)`).run(sessionId, row.project_id, commitSha, checkpointId);
  return { project_id: row.project_id, file: relativePath, session_id: sessionId,
    commit_sha: commitSha, checkpoint_id: checkpointId, pushed: true };
}

async function codexRead(db, sprite, row, prompt, { timeout = 600_000 } = {}) {
  if (!row.repo_path) throw new FactoryError('Bootstrap this project before running Codex');
  const repoPath = row.repo_path;
  if (await remoteRun(sprite, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], repoPath)) {
    throw new FactoryError('Project working tree must be clean before a read-only agent task');
  }
  await prepareCodex(sprite);
  await authenticateCodex(sprite);
  await verifyCodexHooks(sprite, repoPath);
  const result = await streamedCommand(sprite, 'setpriv', [
    '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
    'node', codexScript, 'exec', '--sandbox', 'read-only',
    '--dangerously-bypass-hook-trust', '--json', '-C', repoPath, prompt,
  ], { cwd: repoPath, timeout });
  const events = String(result.stdout).split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const sessionId = events.find(event => event.type === 'thread.started')?.thread_id;
  const answer = events.filter(event => event.type === 'item.completed'
    && event.item?.type === 'agent_message').at(-1)?.item?.text;
  if (result.exitCode !== 0 || !sessionId || !answer) {
    throw new FactoryError('Read-only Codex task did not complete');
  }
  let captured = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const list = JSON.parse(await remoteRun(sprite, 'entire', ['session', 'list', '--json'], repoPath));
    if (list.some(session => session.session_id === sessionId && session.turns > 0)) {
      captured = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!captured) throw new FactoryError('Entire did not capture the read-only Codex task');
  if (await remoteRun(sprite, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], repoPath)) {
    throw new FactoryError('Read-only Codex task changed the project working tree');
  }
  db.prepare(`INSERT OR REPLACE INTO agent_sessions (session_id, project_id, agent, status)
    VALUES (?, ?, 'Codex', 'completed')`).run(sessionId, row.project_id);
  return { session_id: sessionId, answer };
}

async function trustCodexProject(sprite, repoPath) {
  const path = '/home/sprite/.codex/config.toml';
  const existing = await remoteExists(sprite, path)
    ? await sprite.filesystem('/').readFile(path, 'utf8') : '';
  const lines = existing.trim().split(/\r?\n/).filter(Boolean);
  const trustedProjectsOnly = lines.length % 2 === 0 && lines.every((line, index) =>
    index % 2 === 0
      ? /^\[projects\."\/home\/sprite\/projects\/[a-z0-9-]+"\]$/.test(line)
      : line === 'trust_level = "trusted"');
  if (!trustedProjectsOnly) {
    throw new FactoryError('Codex user configuration needs review before trusting this project');
  }
  const entry = `[projects."${repoPath}"]`;
  if (!lines.includes(entry)) {
    await sprite.filesystem('/').writeFile(path,
      `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${entry}\ntrust_level = "trusted"\n`,
      { mode: 0o600 });
  }
}

async function verifyCodexHooks(sprite, repoPath) {
  const config = await sprite.filesystem('/').readFile(`${repoPath}/.codex/hooks.json`, 'utf8');
  const digest = createHash('sha256').update(config).digest('hex');
  if (digest !== entireCodexHookSha256) {
    throw new FactoryError('Codex hooks differ from the vetted Entire 0.11.3 configuration');
  }
  const extraSources = [
    '/home/sprite/.codex/hooks.json',
    '/home/sprite/.codex/plugins',
    `${repoPath}/.codex/config.toml`,
  ];
  for (const path of extraSources) {
    if (await remoteExists(sprite, path)) {
      throw new FactoryError(`Additional Codex hook source needs review: ${path}`);
    }
  }
  const userConfigPath = '/home/sprite/.codex/config.toml';
  if (await remoteExists(sprite, userConfigPath)) {
    const userConfig = await sprite.filesystem('/').readFile(userConfigPath, 'utf8');
    const lines = userConfig.trim().split(/\r?\n/).filter(Boolean);
    const trustedProjectsOnly = lines.length % 2 === 0 && lines.every((line, index) =>
      index % 2 === 0
        ? /^\[projects\."\/home\/sprite\/projects\/[a-z0-9-]+"\]$/.test(line)
        : line === 'trust_level = "trusted"');
    if (!trustedProjectsOnly) {
      throw new FactoryError('Codex user configuration differs from the vetted project trust setting');
    }
  }
  return digest;
}

async function bootstrap(db, sprite, projectId, repoUrl) {
  const repoPath = `/home/sprite/projects/${projectId}`;
  const row = project(db, projectId);
  await remoteRun(sprite, 'git', ['--version']);
  const repoExists = await remoteExists(sprite, `${repoPath}/.git`);
  if (repoUrl && row.github_repo) throw new FactoryError('Managed project cannot switch to a source repository');
  if (!repoExists) {
    await remoteRun(sprite, 'mkdir', ['-p', '/home/sprite/projects']);
    if (repoUrl) {
      await remoteRun(sprite, 'git', ['clone', '--', repoUrl, repoPath]);
    } else {
      await remoteRun(sprite, 'git', ['init', '-b', 'main', repoPath]);
    }
  }
  const remotes = (await remoteRun(sprite, 'git', ['remote'], repoPath)).split(/\r?\n/);
  if (repoUrl && repoExists && !remotes.includes('origin')) {
    throw new FactoryError('Existing project cannot be replaced by --repo-url');
  }
  const managedRepo = !repoUrl && (Boolean(row.github_repo) || !remotes.includes('origin'));
  const githubRepo = managedRepo ? await ensureManagedRemote(db, sprite, row, repoPath) : null;
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
  if (!(await remoteExists(sprite, `${repoPath}/.codex/hooks.json`))) {
    await remoteRun(sprite, 'entire', ['agent', 'add', 'codex'], repoPath);
  }
  await trustCodexProject(sprite, repoPath);
  const status = JSON.parse(await remoteRun(sprite, 'entire', ['status', '--json'], repoPath));
  if (!status.enabled || !status.agents.includes('Codex')) {
    throw new FactoryError('Entire did not enable Codex session tracking');
  }
  await remoteRun(sprite, 'entire', ['doctor'], repoPath);
  const hookSha = await verifyCodexHooks(sprite, repoPath);
  const files = ['.entire/settings.json', '.entire/.gitignore', '.codex/hooks.json'];
  await remoteRun(sprite, 'git', ['add', '--', ...files], repoPath);
  const staged = await remoteResult(sprite, 'git', ['diff', '--cached', '--quiet'], repoPath);
  if (staged.exitCode === 1) {
    await remoteRun(sprite, 'git', ['-c', 'user.name=Software Factory', '-c', 'user.email=factory@localhost',
      'commit', '-m', 'Enable Entire session tracking'], repoPath);
  } else if (staged.exitCode !== 0) {
    throw new FactoryError('Could not inspect staged bootstrap files');
  }
  if (managedRepo) {
    await remoteRun(sprite, 'git', ['push', '-u', 'origin', 'main'], repoPath);
    await installAgentRules(sprite, repoPath);
    const syncStatus = JSON.parse(await remoteRun(sprite, 'entire', ['status', '--json'], repoPath));
    if (syncStatus.checkpoint_sync_remote !== 'origin') {
      throw new FactoryError('Entire checkpoint syncing is not configured for origin');
    }
  }
  db.prepare(`UPDATE projects SET repo_path = ?, entire_version = ?, codex_hook_sha256 = ?,
    updated_at = CURRENT_TIMESTAMP WHERE project_id = ?`)
    .run(repoPath, entireVersion, hookSha, projectId);
  return { repo_path: repoPath, github_repo: githubRepo,
    agent_rules_installed: managedRepo, entire_version: entireVersion, codex_hook_vetted: true,
    codex: await codexSmoke(db, sprite, projectId, repoPath) };
}

function usage() {
  console.log(`Usage:
  node factory.mjs provision <project-id>
  node factory.mjs projects
  node factory.mjs status <project-id>
  node factory.mjs exec <project-id> -- <command> [args...]
  node factory.mjs bootstrap <project-id> [--repo-url <git-url>]
  node factory.mjs codex-smoke <project-id>
  node factory.mjs codex-file <project-id> <file> -- <instruction>
  node factory.mjs run <project-id> --request <text> [--reference-path <local-repo>]
  node factory.mjs run-status <project-id>`);
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
    if (!['provision', 'status', 'exec', 'bootstrap', 'codex-smoke', 'codex-file', 'run', 'run-status'].includes(command) || !projectId) {
      usage();
      return 1;
    }
    const client = new SpritesClient(secret('SPRITE_TOKEN'));
    if (command === 'provision') {
      const sprite = await provision(db, client, projectId);
      console.log(JSON.stringify(summary(project(db, projectId), sprite), null, 2));
      return 0;
    }
    if (command === 'run' || command === 'run-status') {
      const { configureWorkflow, runWorkflow, workflowStatus } = await import('./workflow.mjs');
      configureWorkflow(factoryInternals);
      if (command === 'run-status') {
        console.log(JSON.stringify(workflowStatus(db, projectId), null, 2));
        return 0;
      }
      const sprite = await provision(db, client, projectId);
      console.log(JSON.stringify(await runWorkflow({ db, client, sprite,
        row: project(db, projectId), args: rest }), null, 2));
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
    if (command === 'codex-smoke') {
      if (!row.repo_path) throw new FactoryError('Bootstrap this project before running Codex');
      console.log(JSON.stringify(await codexSmoke(db, sprite, projectId, row.repo_path), null, 2));
      return 0;
    }
    if (command === 'codex-file') {
      if (rest.length < 3 || rest[1] !== '--') {
        throw new FactoryError('Use codex-file <project-id> <file> -- <instruction>');
      }
      console.log(JSON.stringify(await codexFile(db, sprite, row, rest[0], rest.slice(2).join(' ')), null, 2));
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

export const factoryInternals = { root, secret, FactoryError, provision, getSprite, project,
  remoteRun, remoteResult, remoteExists, codexFile, codexRead, githubApi,
  bootstrap, trustCodexProject };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof FactoryError ? error.message
      : `Operation failed (${error.constructor?.name ?? 'Error'}${error.statusCode ? `, HTTP ${error.statusCode}` : ''})`;
    console.error(`factory: ${message}`);
    process.exitCode = 1;
  }
}
