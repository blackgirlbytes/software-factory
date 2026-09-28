import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openQueue, enqueue, claimNext, finishJob, getJob, recoverInterrupted,
  resumeBlocked, QueueError } from './queue.mjs';
import { normalizeBrief, briefDocument, BriefError } from './brief.mjs';
import { codexFileArgs } from './factory.mjs';
import { routeCodexTask } from './model-policy.mjs';
import { configureWorkflow, runWorkflow, workflowStatus, validatePlan,
  selectDemoChecks, verifyBuild } from './workflow.mjs';

test('a submitted job survives supervisor restart and keeps its identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-queue-'));
  try {
    let db = openQueue(join(dir, 'state.sqlite3'));
    const input = { projectId: 'sample-cli', request: 'Build a small CLI.',
      idempotencyKey: 'submission-12345', brief: {
        coreFlow: 'Enter a task and see it listed.', exclusions: 'No user accounts.',
        liveIntegrations: 'None required; use fixture or local data.', referenceUse: 'none',
      } };
    const job = enqueue(db, input);
    assert.equal(enqueue(db, input).job_id, job.job_id);
    assert.throws(() => enqueue(db, { ...input, request: 'Build something else.' }), QueueError);
    assert.throws(() => enqueue(db, { ...input,
      brief: { ...input.brief, exclusions: 'No analytics.' } }), QueueError);
    assert.throws(() => enqueue(db, { ...input, idempotencyKey: 'submission-67890' }), QueueError);
    assert.equal(claimNext(db).job_id, job.job_id);
    db.close();

    db = openQueue(join(dir, 'state.sqlite3'));
    assert.deepEqual(JSON.parse(getJob(db, job.job_id).brief_json), input.brief);
    assert.equal(recoverInterrupted(db), 1);
    assert.equal(claimNext(db).attempts, 2);
    finishJob(db, job.job_id, { status: 'blocked', code: 'usage_limit_exceeded',
      error: 'Codex API quota exceeded' });
    assert.equal(claimNext(db), null);
    assert.equal(getJob(db, job.job_id).error_code, 'usage_limit_exceeded');
    resumeBlocked(db, job.job_id);
    assert.equal(claimNext(db).attempts, 3);
    finishJob(db, job.job_id, { status: 'queued', code: 'usage_limit_exceeded',
      error: 'Waiting for credits', retryAfterMs: 60 * 60_000 });
    assert.equal(claimNext(db), null);
    resumeBlocked(db, job.job_id);
    assert.equal(claimNext(db).attempts, 4);
    finishJob(db, job.job_id, { status: 'complete' });
    assert.equal(getJob(db, job.job_id).status, 'complete');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('demo brief supplies safe defaults and controls reference requirements', () => {
  const brief = normalizeBrief({}, 'Show a calendar.', false);
  assert.equal(brief.coreFlow, 'Show a calendar.');
  assert.equal(brief.referenceUse, 'none');
  assert.match(briefDocument('Show a calendar.', brief), /## Core flow to demonstrate\n\nShow a calendar/);
  assert.throws(() => normalizeBrief({ referenceUse: 'requirements' }, 'Show a calendar.', false), BriefError);
  assert.equal(normalizeBrief({ referenceUse: 'requirements' }, 'Show a calendar.', true).referenceUse,
    'requirements');
});

test('Codex resume preserves the session and writable sandbox', () => {
  const session = '12345678-1234-1234-1234-123456789abc';
  const args = codexFileArgs('/home/sprite/projects/demo', 'Edit one file.',
    { network: true, resumeSessionId: session });
  assert.deepEqual(args.slice(2, 5), ['exec', 'resume', '-c']);
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(args.includes('--dangerously-bypass-hook-trust'));
  assert.equal(args.at(-2), session);
  assert.equal(args.at(-1), 'Edit one file.');
});

test('model routing assigns Astra to orchestration and low effort to routine builders', () => {
  assert.deepEqual([routeCodexTask('plan').model, routeCodexTask('plan').reasoningEffort],
    ['gpt-6-astra', 'medium']);
  assert.deepEqual([routeCodexTask('replan').model, routeCodexTask('replan').reasoningEffort],
    ['gpt-6-astra', 'high']);
  assert.deepEqual([routeCodexTask('build').model, routeCodexTask('build').reasoningEffort],
    ['gpt-6-sol', 'low']);
  assert.deepEqual([routeCodexTask('build', { complexity: 'simple' }).model,
    routeCodexTask('build', { complexity: 'simple' }).reasoningEffort],
    ['gpt-6-luna', 'low']);
  const session = '12345678-1234-1234-1234-123456789abc';
  const resumed = codexFileArgs('/home/sprite/projects/demo', 'Fix the finding.',
    { role: 'review_fix', resumeSessionId: session });
  assert.deepEqual(resumed.slice(resumed.indexOf('--model'), resumed.indexOf('--model') + 4),
    ['--model', 'gpt-6-sol', '-c', 'model_reasoning_effort="medium"']);
  assert.throws(() => routeCodexTask('build', { complexity: 'max' }), /Invalid build complexity/);
});

test('a workflow saves approved intent before contacting a project Sprite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-intake-'));
  const db = openQueue(join(dir, 'state.sqlite3'));
  try {
    configureWorkflow({ FactoryError: class FactoryError extends Error {},
      getSprite: async () => { throw new Error('offline test stop'); } });
    const row = { project_id: 'brief-demo', sprite_name: 'brief-demo' };
    const request = 'Show a task list';
    await assert.rejects(runWorkflow({ db, client: {}, row,
      args: ['--request', request] }), /approved brief/);
    const brief = normalizeBrief({ coreFlow: 'Add a task to the list.' }, request, false);
    await assert.rejects(runWorkflow({ db, client: {}, row,
      args: ['--request', request, '--brief-json', JSON.stringify(brief)] }), /offline test stop/);
    const saved = workflowStatus(db, row.project_id);
    assert.deepEqual(saved.brief, brief);
    assert.equal(saved.stage, 'bootstrap');
    assert.equal(saved.review_repairs, 0);
    assert.equal(saved.timings[0].stage, 'bootstrap');
    assert.equal(saved.timings[0].outcome, 'failed');
    assert.equal(saved.stage_elapsed_ms, null);
    await assert.rejects(runWorkflow({ db, client: {}, row,
      args: ['--request', request, '--brief-json', JSON.stringify({ ...brief, exclusions: 'No editing' })] }),
    /different approved brief/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const demoPlan = () => ({
  acceptance_criteria: [
    { id: 'core', text: 'Add a task', source: { kind: 'request', quote: 'Add a task' },
      verification: 'Run the smoke check' },
    { id: 'list', text: 'Show the task list', source: { kind: 'request', quote: 'show the task list' },
      verification: 'Build the demo' },
  ],
  tasks: [{ id: 'app', file: 'app.mjs', instruction: 'Build the demo', depends_on: [] }],
  checks: [
    { id: 'flow', kind: 'smoke', argv: ['node', 'smoke.mjs'], criterion_ids: ['core'] },
    { id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], criterion_ids: ['list'] },
  ],
  delivery: { type: 'repository' },
});

test('demo verification permits only focused, sourced checks', () => {
  configureWorkflow({ FactoryError: class FactoryError extends Error {} });
  const plan = demoPlan();
  assert.equal(validatePlan(plan, 'Add a task and show the task list', '', 'none', true), plan);
  assert.deepEqual(selectDemoChecks(plan, ['core']).map(check => check.id), ['flow']);
  assert.deepEqual(selectDemoChecks(plan, []).map(check => check.id), ['flow']);
  assert.deepEqual(selectDemoChecks(plan, ['unknown']).map(check => check.id), ['flow']);
  const overlapping = demoPlan();
  overlapping.checks[1].criterion_ids.push('core');
  assert.deepEqual(selectDemoChecks(overlapping, ['core']).map(check => check.id), ['flow']);
  const broad = demoPlan();
  broad.checks[0].argv = ['npm', 'test'];
  assert.throws(() => validatePlan(broad, 'Add a task and show the task list', '', 'none', true),
    /targeted/);
  const tooMany = demoPlan();
  tooMany.checks.push({ id: 'extra', kind: 'smoke', argv: ['node', 'extra.mjs'],
    criterion_ids: ['core'] });
  assert.throws(() => validatePlan(tooMany, 'Add a task and show the task list', '', 'none', true),
    /one core-flow smoke check/);
  const invalidComplexity = demoPlan();
  invalidComplexity.tasks[0].complexity = 'high';
  assert.throws(() => validatePlan(invalidComplexity, 'Add a task and show the task list', '', 'none', true),
    /invalid task/);
});

test('dependency install is reused until the package manifest or lock changes', async () => {
  const repo = '/home/sprite/projects/demo';
  let digest = 'first manifest and lock digest';
  let marker = '';
  let installed = false;
  const commands = [];
  const sprite = {
    filesystem: () => ({
      readFile: async () => marker,
      writeFile: async (_path, content) => { marker = content; },
    }),
    execFile: async (file, args) => {
      commands.push([file, ...args]);
      if (file === 'npm' && args[0] === 'ci') installed = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  configureWorkflow({ FactoryError: class FactoryError extends Error {},
    remoteExists: async (_sprite, path) => [
      `${repo}/package.json`, `${repo}/.gitignore`, `${repo}/package-lock.json`,
    ].includes(path) || (path === `${repo}/node_modules` && installed)
      || (path === '/home/sprite/factory-cache/demo-npm-install.txt' && Boolean(marker)),
    remoteRun: async (_sprite, command) => command === 'sha256sum' ? digest : '',
  });
  const row = { project_id: 'demo', repo_path: repo };
  const plan = demoPlan();
  const first = await verifyBuild(sprite, row, plan, { demo: true });
  assert.deepEqual(first.map(check => check.id), ['dependencies', 'flow', 'build']);
  const focused = await verifyBuild(sprite, row, plan, { demo: true, criterionIds: ['core'] });
  assert.deepEqual(focused.map(check => check.id), ['dependencies', 'flow']);
  assert.equal(focused[0].cached, true);
  assert.equal(commands.filter(args => args[0] === 'npm' && args[1] === 'ci').length, 1);
  digest = 'changed manifest or lock digest';
  await verifyBuild(sprite, row, plan, { demo: true });
  assert.equal(commands.filter(args => args[0] === 'npm' && args[1] === 'ci').length, 2);
});

test('a resumed demo cannot spend a second review repair pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-repairs-'));
  const db = openQueue(join(dir, 'state.sqlite3'));
  try {
    workflowStatus(db, 'repair-demo');
    db.exec(`CREATE TABLE agent_sessions (
      session_id TEXT, commit_sha TEXT, checkpoint_id TEXT, run_id TEXT, created_at TEXT
    )`);
    const request = 'Add a task and show the task list';
    const brief = normalizeBrief({}, request, false);
    db.prepare(`INSERT INTO factory_runs
      (run_id, project_id, request, stage, status, mode, brief_json, plan_json,
       verification_json, review_repairs)
      VALUES (?, ?, ?, 'review', 'failed', 'demo', ?, ?, ?, 1)`)
      .run('repair-run', 'repair-demo', request, JSON.stringify(brief),
        JSON.stringify(demoPlan()), JSON.stringify([{ exit_code: 0 }]));
    let edits = 0;
    configureWorkflow({ FactoryError: class FactoryError extends Error {},
      getSprite: async () => ({}),
      codexRead: async () => ({ session_id: 'review-session', answer: `\`\`\`json\n${JSON.stringify({
        approved: false, summary: 'Core flow needs repair',
        findings: [{ file: 'app.mjs', instruction: 'Fix the flow', criterion_ids: ['core'] }],
      })}\n\`\`\`` }),
      codexFile: async () => { edits += 1; },
    });
    await assert.rejects(runWorkflow({ db, client: {},
      row: { project_id: 'repair-demo', repo_path: '/repo', sprite_name: 'repair-demo' },
      args: ['--request', request, '--brief-json', JSON.stringify(brief)] }), /repair limit/);
    assert.equal(edits, 0);
    assert.equal(workflowStatus(db, 'repair-demo').review_repairs, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
