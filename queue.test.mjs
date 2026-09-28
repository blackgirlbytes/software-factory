import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openQueue, enqueue, claimNext, finishJob, getJob, recoverInterrupted,
  resumeBlocked, QueueError } from './queue.mjs';

test('a submitted job survives supervisor restart and keeps its identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-queue-'));
  try {
    let db = openQueue(join(dir, 'state.sqlite3'));
    const input = { projectId: 'sample-cli', request: 'Build a small CLI.',
      idempotencyKey: 'submission-12345' };
    const job = enqueue(db, input);
    assert.equal(enqueue(db, input).job_id, job.job_id);
    assert.throws(() => enqueue(db, { ...input, request: 'Build something else.' }), QueueError);
    assert.throws(() => enqueue(db, { ...input, idempotencyKey: 'submission-67890' }), QueueError);
    assert.equal(claimNext(db).job_id, job.job_id);
    db.close();

    db = openQueue(join(dir, 'state.sqlite3'));
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
