#!/usr/bin/env node
/** Thin local client for the autonomous factory supervisor Sprite. */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ExecError, SpritesClient } from '@fly/sprites';
import { factoryInternals as f } from './factory.mjs';
import { referenceSnapshot } from './workflow.mjs';
import { normalizeBrief } from './brief.mjs';

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

function envFile(previous = '') {
  const values = { SPRITE_TOKEN: f.secret('SPRITE_TOKEN'),
    OPENAI_API_KEY: f.secret('OPENAI_API_KEY'), GITHUB_TOKEN: githubToken() };
  try { values.TYPESAFE_API_KEY = f.secret('TYPESAFE_API_KEY'); }
  catch {
    const saved = previous.match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1]?.trim();
    if (saved) values.TYPESAFE_API_KEY = saved;
  }
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
  const remoteEnv = `${remoteRoot}/.env.local`;
  let previousEnvExists;
  try { previousEnvExists = await target.execFile('test', ['-e', remoteEnv]); }
  catch (error) {
    if (!(error instanceof ExecError)) throw error;
    previousEnvExists = error.result;
  }
  const previousEnv = previousEnvExists.exitCode === 0
    ? await target.filesystem('/').readFile(remoteEnv, 'utf8') : '';
  await target.filesystem('/').writeFile(remoteEnv, envFile(previousEnv), { mode: 0o600 });
  await runRemote(target, 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund']);
  const stream = await target.createService(serviceName,
    { cmd: 'node', args: ['orchestrator.mjs'], dir: remoteRoot }, '5s');
  for await (const event of stream) {
    if (event.type === 'error') throw new Error('Orchestrator Sprite service failed to start');
  }
  const restarted = await target.restartService(serviceName, '5s');
  for await (const event of restarted) {
    if (event.type === 'error') throw new Error('Orchestrator Sprite service failed to restart');
  }
  const health = await call(target, 'GET', '/health');
  console.log(JSON.stringify({ sprite: target.name, service: serviceName, health }, null, 2));
}

async function call(target, method, path, body) {
  const args = ['-sS', '-w', '\n%{http_code}', '-X', method];
  let payloadPath = null;
  if (body !== undefined) {
    const payload = JSON.stringify(body);
    args.push('-H', 'Content-Type: application/json', '--data-binary');
    if (payload.length > 16_000) {
      payloadPath = `/home/sprite/factory-submit-${randomUUID()}.json`;
      await target.filesystem('/').writeFile(payloadPath, payload, { mode: 0o600 });
      args.push(`@${payloadPath}`);
    } else args.push(payload);
  }
  args.push(`http://127.0.0.1:8080${path}`);
  let result;
  try { result = await target.execFile('curl', args, { timeout: 45_000 }); }
  finally {
    if (payloadPath) await target.execFile('rm', ['-f', '--', payloadPath]);
  }
  if (result.exitCode !== 0) throw new Error('Could not reach the orchestrator service');
  const output = String(result.stdout);
  const split = output.lastIndexOf('\n');
  if (split < 0) throw new Error('Orchestrator returned no HTTP status');
  const code = Number(output.slice(split + 1));
  const value = JSON.parse(output.slice(0, split));
  if (code < 200 || code >= 300) throw new Error(value.error ?? `Orchestrator HTTP ${code}`);
  return value;
}

async function intake(request, hasReference) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Demo intake needs a terminal; use --brief-file <json> for non-interactive submission');
  }
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\nDemo request: ${request}\nPress Enter to keep a shown default.\n`);
    const coreFlow = await reader.question('What must someone be able to do in the demo? [use request] ');
    const exclusions = await reader.question('What should the demo leave out? [none specified] ');
    const liveIntegrations = await reader.question('Which live integrations are required? [none; use fixtures] ');
    const referenceUse = hasReference
      ? await reader.question('Reference repo: context or requirements? [context] ')
      : 'none';
    return normalizeBrief({ coreFlow, exclusions, liveIntegrations,
      referenceUse: referenceUse || (hasReference ? 'context' : 'none') }, request, hasReference);
  } finally {
    reader.close();
  }
}

async function parseSubmit(args) {
  const [projectId, ...rest] = args;
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(projectId ?? '')) {
    throw new Error('Pass a lowercase project ID');
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--request', '--reference-path', '--idempotency-key', '--brief-file'].includes(rest[i])
      || !rest[i + 1] || options[rest[i]]) throw new Error('Invalid submit options');
    options[rest[i]] = rest[i + 1];
  }
  if (!options['--request']?.trim()) throw new Error('Submit requires --request');
  const request = options['--request'].trim();
  const hasReference = Boolean(options['--reference-path']);
  let brief;
  if (options['--brief-file']) {
    let supplied;
    try { supplied = JSON.parse(readFileSync(options['--brief-file'], 'utf8')); }
    catch { throw new Error('Brief file must contain a JSON object'); }
    brief = normalizeBrief(supplied, request, hasReference);
  } else brief = await intake(request, hasReference);
  return { projectId, request, brief,
    idempotencyKey: options['--idempotency-key'] ?? randomUUID().replaceAll('-', ''),
    ...(options['--reference-path']
      ? { referenceSnapshot: referenceSnapshot(options['--reference-path']) } : {}) };
}

async function main([command, ...args]) {
  if (command === 'deploy') return deploy();
  const submission = command === 'submit' ? await parseSubmit(args) : null;
  const target = await sprite();
  let result;
  if (command === 'health') result = await call(target, 'GET', '/health');
  else if (command === 'jobs') result = await call(target, 'GET', '/jobs');
  else if (command === 'submit') result = await call(target, 'POST', '/jobs', submission);
  else if (command === 'adopt' && args.length === 1) result = await call(target, 'POST', '/adopt',
    { projectId: args[0], idempotencyKey: randomUUID().replaceAll('-', '') });
  else if (command === 'status' && args.length === 1) result = await call(target, 'GET', `/jobs/${args[0]}`);
  else if (command === 'resume' && args.length === 1) result = await call(target, 'POST', `/jobs/${args[0]}/resume`);
  else throw new Error('Use deploy, submit <project> --request <text> [--reference-path <repo>] [--brief-file <json>], adopt <project>, jobs, status <job>, resume <job>, or health');
  console.log(JSON.stringify(result, null, 2));
}

try { await main(process.argv.slice(2)); }
catch (error) { console.error(`control: ${error.message}`); process.exitCode = 1; }
