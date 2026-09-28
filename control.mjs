#!/usr/bin/env node
/** Thin local client for the autonomous factory supervisor Sprite. */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ExecError, SpritesClient } from '@fly/sprites';
import { factoryInternals as f } from './factory.mjs';
import { referenceSnapshot } from './workflow.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const spriteName = 'sf-software-factory-control';
const remoteRoot = '/home/sprite/factory';
const serviceName = 'factory-supervisor';
const sourceFiles = ['factory.mjs', 'workflow.mjs', 'scope.mjs', 'queue.mjs',
  'orchestrator.mjs', 'package.json', 'package-lock.json', 'templates/AGENTS.md'];

function githubToken() {
  try { return f.secret('GITHUB_TOKEN'); } catch { /* use the local authenticated CLI */ }
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('Configure GITHUB_TOKEN or authenticate the local GitHub CLI');
  }
  return result.stdout.trim();
}

function envFile() {
  const values = { SPRITE_TOKEN: f.secret('SPRITE_TOKEN'),
    OPENAI_API_KEY: f.secret('OPENAI_API_KEY'), GITHUB_TOKEN: githubToken() };
  try { values.TYPESAFE_API_KEY = f.secret('TYPESAFE_API_KEY'); } catch { /* Jev is optional */ }
  for (const value of Object.values(values)) {
    if (/[\r\n]/.test(value)) throw new Error('Credential contains a newline');
  }
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

async function sprite(create = false) {
  const client = new SpritesClient(f.secret('SPRITE_TOKEN'));
  try { return await client.getSprite(spriteName); }
  catch (error) {
    if (error.statusCode !== 404 || !create) throw error;
    return await client.createSprite(spriteName);
  }
}

async function runRemote(sprite, command, args, cwd = remoteRoot) {
  const result = await sprite.execFile(command, args, { cwd, timeout: 600_000 });
  if (result.exitCode !== 0) throw new Error(`${command} failed in orchestrator Sprite`);
  return result;
}

async function deploy() {
  const clean = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: root, encoding: 'utf8' });
  if (clean.status !== 0 || clean.stdout.trim()) {
    throw new Error('Commit and push local factory source before deploying');
  }
  const target = await sprite(true);
  await runRemote(target, 'mkdir', ['-p', `${remoteRoot}/templates`, `${remoteRoot}/.factory`], '/home/sprite');
  for (const file of sourceFiles) {
    await target.filesystem('/').writeFile(`${remoteRoot}/${file}`, readFileSync(join(root, file)));
  }
  const remoteState = `${remoteRoot}/.factory/state.sqlite3`;
  let exists;
  try { exists = await target.execFile('test', ['-e', remoteState]); }
  catch (error) { if (!(error instanceof ExecError)) throw error; exists = error.result; }
  const localState = join(root, '.factory', 'state.sqlite3');
  if (exists.exitCode !== 0 && existsSync(localState)) {
    const db = new DatabaseSync(localState);
    db.exec('PRAGMA wal_checkpoint(FULL)');
    db.close();
    await target.filesystem('/').writeFile(remoteState, readFileSync(localState), { mode: 0o600 });
  }
  await target.filesystem('/').writeFile(`${remoteRoot}/.env.local`, envFile(), { mode: 0o600 });
  await runRemote(target, 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund']);
  const stream = await target.createService(serviceName,
    { cmd: 'node', args: ['orchestrator.mjs'], dir: remoteRoot }, '5s');
  for await (const event of stream) {
    if (event.type === 'error') throw new Error('Orchestrator Sprite service failed to start');
  }
  const health = await call(target, 'GET', '/health');
  console.log(JSON.stringify({ sprite: target.name, service: serviceName, health }, null, 2));
}

async function call(target, method, path, body) {
  const proxy = await target.proxyPort(0, 8080);
  try {
    const address = proxy.localAddr();
    if (!address) throw new Error('Orchestrator port proxy did not start');
    const response = await fetch(`http://${address}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `Orchestrator HTTP ${response.status}`);
    return value;
  } finally { proxy.close(); }
}

function parseSubmit(args) {
  const [projectId, ...rest] = args;
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(projectId ?? '')) {
    throw new Error('Pass a lowercase project ID');
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--request', '--reference-path', '--idempotency-key'].includes(rest[i])
      || !rest[i + 1] || options[rest[i]]) throw new Error('Invalid submit options');
    options[rest[i]] = rest[i + 1];
  }
  if (!options['--request']?.trim()) throw new Error('Submit requires --request');
  return { projectId, request: options['--request'].trim(),
    idempotencyKey: options['--idempotency-key'] ?? randomUUID().replaceAll('-', ''),
    ...(options['--reference-path']
      ? { referenceSnapshot: referenceSnapshot(options['--reference-path']) } : {}) };
}

async function main([command, ...args]) {
  if (command === 'deploy') return deploy();
  const target = await sprite();
  let result;
  if (command === 'health') result = await call(target, 'GET', '/health');
  else if (command === 'jobs') result = await call(target, 'GET', '/jobs');
  else if (command === 'submit') result = await call(target, 'POST', '/jobs', parseSubmit(args));
  else if (command === 'status' && args.length === 1) result = await call(target, 'GET', `/jobs/${args[0]}`);
  else if (command === 'resume' && args.length === 1) result = await call(target, 'POST', `/jobs/${args[0]}/resume`);
  else throw new Error('Use deploy, submit <project> --request <text> [--reference-path <repo>], jobs, status <job>, resume <job>, or health');
  console.log(JSON.stringify(result, null, 2));
}

try { await main(process.argv.slice(2)); }
catch (error) { console.error(`control: ${error.message}`); process.exitCode = 1; }
