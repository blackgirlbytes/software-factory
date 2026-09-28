/** Durable, single-run-at-a-time queue for the factory supervisor. */
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const projectPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class QueueError extends Error {}

export function openQueue(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_jobs (
    job_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL, request TEXT NOT NULL, reference_path TEXT,
    input_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    not_before_ms INTEGER NOT NULL DEFAULT 0, error_code TEXT, error TEXT,
    started_at TEXT, finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  return db;
}

export function enqueue(db, { projectId, request, referencePath = null, idempotencyKey }) {
  if (!projectPattern.test(projectId ?? '') || typeof request !== 'string'
    || !request.trim() || request.length > 10_000
    || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)
    || (referencePath !== null && (typeof referencePath !== 'string' || !referencePath.startsWith('/')))) {
    throw new QueueError('Invalid project, request, reference path, or idempotency key');
  }
  const normalizedRequest = request.trim();
  const hash = createHash('sha256').update(JSON.stringify([projectId, normalizedRequest, referencePath])).digest('hex');
  const previous = db.prepare('SELECT * FROM autonomy_jobs WHERE idempotency_key = ?').get(idempotencyKey);
  if (previous) {
    if (previous.input_hash !== hash) throw new QueueError('Idempotency key belongs to a different request');
    return previous;
  }
  const active = db.prepare(`SELECT job_id FROM autonomy_jobs WHERE project_id = ?
    AND status IN ('queued', 'running', 'blocked') LIMIT 1`).get(projectId);
  if (active) throw new QueueError(`Project already has an unfinished job: ${active.job_id}`);
  const jobId = randomUUID();
  db.prepare(`INSERT INTO autonomy_jobs
    (job_id, idempotency_key, project_id, request, reference_path, input_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, 'queued')`).run(jobId, idempotencyKey, projectId,
    normalizedRequest, referencePath, hash);
  return getJob(db, jobId);
}

export function getJob(db, jobId) {
  return db.prepare('SELECT * FROM autonomy_jobs WHERE job_id = ?').get(jobId) ?? null;
}

export function listJobs(db, limit = 30) {
  return db.prepare('SELECT * FROM autonomy_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(Math.max(1, Math.min(100, limit)));
}

export function recoverInterrupted(db) {
  return db.prepare(`UPDATE autonomy_jobs SET status = 'queued', error_code = 'interrupted',
    error = 'Supervisor restarted; resuming from saved factory state',
    updated_at = CURRENT_TIMESTAMP WHERE status = 'running'`).run().changes;
}

export function claimNext(db, now = Date.now()) {
  const job = db.prepare(`SELECT * FROM autonomy_jobs WHERE status = 'queued'
    AND not_before_ms <= ? ORDER BY created_at, rowid LIMIT 1`).get(now);
  if (!job) return null;
  const changed = db.prepare(`UPDATE autonomy_jobs SET status = 'running', attempts = attempts + 1,
    started_at = CURRENT_TIMESTAMP, error_code = NULL, error = NULL,
    updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status = 'queued'`).run(job.job_id).changes;
  return changed ? getJob(db, job.job_id) : null;
}

export function finishJob(db, jobId, { status, code = null, error = null, retryAfterMs = 0 }) {
  if (!['complete', 'blocked', 'failed', 'queued'].includes(status)) throw new QueueError('Invalid job status');
  const job = getJob(db, jobId);
  if (!job || job.status !== 'running') throw new QueueError('Only a running job can be finished');
  db.prepare(`UPDATE autonomy_jobs SET status = ?, error_code = ?, error = ?,
    not_before_ms = ?, finished_at = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?`)
    .run(status, code, error, status === 'queued' ? Date.now() + retryAfterMs : 0,
      status === 'queued' ? null : new Date().toISOString(), jobId);
  return getJob(db, jobId);
}

export function resumeBlocked(db, jobId) {
  const changed = db.prepare(`UPDATE autonomy_jobs SET status = 'queued', not_before_ms = 0,
    error_code = NULL, error = NULL, finished_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND status IN ('blocked', 'failed')`).run(jobId).changes;
  if (!changed) throw new QueueError('Job is not blocked or failed');
  return getJob(db, jobId);
}
