#!/usr/bin/env node
/** Restartable HTTP supervisor. Run as a private Sprite service. */
import { createServer } from 'node:http';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openQueue, enqueue, getJob, listJobs, recoverInterrupted,
  claimNext, finishJob, resumeBlocked, QueueError } from './queue.mjs';
import { workflowStatus } from './workflow.mjs';

const execFile = promisify(execFileCallback);
const root = dirname(fileURLToPath(import.meta.url));
const stateDir = join(root, '.factory');
const statePath = join(stateDir, 'state.sqlite3');
const port = Number(process.env.FACTORY_PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FACTORY_PORT');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const db = openQueue(statePath);
recoverInterrupted(db);
let activeJobId = null;
let activeChild = null;
let stopping = false;

function reply(response, code, value) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  let content = '';
  for await (const part of request) {
    content += part.toString();
    if (content.length > 600_000) throw new QueueError('Request body is too large');
  }
  try { return JSON.parse(content); }
  catch { throw new QueueError('Request body must be JSON'); }
}

async function keepAwake(jobId) {
  if (process.env.FACTORY_ALLOW_NO_TASK === '1') return () => {};
  const prefix = `factory-${jobId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  let lease = 0;
  let currentName = null;
  const renew = async () => {
    const nextName = `${prefix}-${lease++}`;
    await execFile('sprite-env', ['curl', '-X', 'POST', '/v1/tasks',
      '-d', JSON.stringify({ name: nextName, expire: '1h' })],
      { timeout: 15_000 });
    const previousName = currentName;
    currentName = nextName;
    if (previousName) {
      try {
        await execFile('sprite-env', ['curl', '-X', 'DELETE', `/v1/tasks/${previousName}`],
          { timeout: 15_000 });
      } catch (error) {
        console.error(`Could not close Sprite task ${previousName}: ${error.message}`);
      }
    }
  };
  await renew();
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(renew).catch(error => {
      console.error(`Could not renew Sprite task for ${jobId}: ${error.message}`);
      activeChild?.kill('SIGTERM');
    });
  }, 20 * 60_000);
  return async () => {
    clearInterval(timer);
    await renewal;
    try { await execFile('sprite-env', ['curl', '-X', 'DELETE', `/v1/tasks/${currentName}`],
      { timeout: 15_000 }); } catch (error) {
      console.error(`Could not close Sprite task ${currentName}: ${error.message}`);
    }
  };
}

function runFactory(job) {
  const args = ['factory.mjs', 'run', job.project_id, '--request', job.request];
  if (job.reference_path) args.push('--reference-path', job.reference_path);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    let output = '';
    const collect = chunk => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      activeChild = null;
      resolve({ code, signal, output });
    });
  });
}

function classifyFailure(output, attempt) {
  if (/quota exceeded|usage_limit_exceeded/i.test(output)) {
    return { status: 'queued', code: 'usage_limit_exceeded',
      error: 'Codex API credits unavailable; retrying after a delay',
      retryAfterMs: Math.min(6 * 60 * 60_000, 60 * 60_000 * 2 ** Math.min(attempt - 1, 3)) };
  }
  if (/Set (SPRITE_TOKEN|OPENAI_API_KEY|GITHUB_TOKEN)|needs exactly one nonempty/i.test(output)) {
    return { status: 'blocked', code: 'missing_credential', error: 'Controller credential is missing' };
  }
  if (attempt < 3 && /timed out|ECONNRESET|ETIMEDOUT|network unavailable|Operation failed/i.test(output)) {
    return { status: 'queued', code: 'transient', error: 'Transient failure; retrying from saved state',
      retryAfterMs: 30_000 * 2 ** (attempt - 1) };
  }
  return { status: 'failed', code: 'worker_failed', error: output.slice(-2000) || 'Factory worker exited without details' };
}

async function workLoop() {
  while (!stopping) {
    const job = claimNext(db);
    if (!job) {
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    activeJobId = job.job_id;
    console.log(`Starting ${job.job_id} for ${job.project_id}, attempt ${job.attempts}`);
    let release = () => {};
    try {
      release = await keepAwake(job.job_id);
      const result = await runFactory(job);
      if (stopping) break;
      if (result.code === 0) finishJob(db, job.job_id, { status: 'complete' });
      else finishJob(db, job.job_id, classifyFailure(result.output, job.attempts));
    } catch (error) {
      if (!stopping) finishJob(db, job.job_id,
        classifyFailure(error.message ?? String(error), job.attempts));
    } finally {
      await release();
      activeJobId = null;
    }
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && url.pathname === '/health') {
      return reply(response, 200, { status: 'ok', active_job_id: activeJobId });
    }
    if (request.method === 'GET' && url.pathname === '/jobs') {
      return reply(response, 200, { jobs: listJobs(db) });
    }
    if (request.method === 'POST' && url.pathname === '/adopt') {
      const input = await body(request);
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.projectId ?? '')) {
        throw new QueueError('Invalid project ID');
      }
      const run = db.prepare(`SELECT request, reference_path, stage FROM factory_runs
        WHERE project_id = ? AND status != 'complete' ORDER BY created_at DESC LIMIT 1`)
        .get(input.projectId);
      if (!run) throw new QueueError('No unfinished local run was transferred for this project');
      if (['bootstrap', 'research', 'plan'].includes(run.stage) && run.reference_path) {
        throw new QueueError('This run needs its local reference snapshot before remote adoption');
      }
      const job = enqueue(db, { projectId: input.projectId, request: run.request,
        referencePath: run.reference_path, idempotencyKey: input.idempotencyKey });
      return reply(response, 202, { job });
    }
    if (request.method === 'POST' && url.pathname === '/jobs') {
      const input = await body(request);
      let referencePath = null;
      if (input.referenceSnapshot !== undefined) {
        if (typeof input.idempotencyKey !== 'string'
          || !/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) {
          throw new QueueError('Invalid idempotency key');
        }
        if (typeof input.referenceSnapshot !== 'string'
          || !input.referenceSnapshot.startsWith('# Reference source snapshot\n')
          || input.referenceSnapshot.length > 500_000) {
          throw new QueueError('Invalid reference snapshot');
        }
        referencePath = join(stateDir, 'references', `${input.idempotencyKey}.md`);
        mkdirSync(dirname(referencePath), { recursive: true, mode: 0o700 });
        if (existsSync(referencePath)) {
          if (readFileSync(referencePath, 'utf8') !== input.referenceSnapshot) {
            throw new QueueError('Idempotency key belongs to a different reference snapshot');
          }
        } else writeFileSync(referencePath, input.referenceSnapshot, { mode: 0o600, flag: 'wx' });
      }
      const job = enqueue(db, { projectId: input.projectId, request: input.request,
        idempotencyKey: input.idempotencyKey, referencePath });
      return reply(response, 202, { job });
    }
    if (parts[0] === 'jobs' && parts.length === 2 && request.method === 'GET') {
      const job = getJob(db, parts[1]);
      if (!job) return reply(response, 404, { error: 'Job not found' });
      return reply(response, 200, { job, run: workflowStatus(db, job.project_id) });
    }
    if (parts[0] === 'jobs' && parts.length === 3 && parts[2] === 'resume'
      && request.method === 'POST') {
      return reply(response, 202, { job: resumeBlocked(db, parts[1]) });
    }
    return reply(response, 404, { error: 'Not found' });
  } catch (error) {
    return reply(response, error instanceof QueueError ? 400 : 500,
      { error: error.message ?? 'Server error' });
  }
});

const shutdown = () => {
  stopping = true;
  activeChild?.kill('SIGTERM');
  server.close();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(port, '127.0.0.1', () => {
  console.log(`Factory supervisor listening on 127.0.0.1:${port}`);
  workLoop().catch(error => {
    console.error(`Factory supervisor stopped: ${error.message}`);
    process.exitCode = 1;
    shutdown();
  });
});
