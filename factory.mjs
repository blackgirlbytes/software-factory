#!/usr/bin/env node
/** Local controller for persistent project Sprites. */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ExecError, SpritesClient } from '@fly/sprites';

const root = dirname(fileURLToPath(import.meta.url));
const statePath = join(root, '.factory', 'state.sqlite3');
const projectPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

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
  };
  if (sprite) {
    result.sprite_status = sprite.status;
    result.url_auth = sprite.urlSettings?.auth;
  }
  return result;
}

function usage() {
  console.log(`Usage:
  node factory.mjs provision <project-id>
  node factory.mjs projects
  node factory.mjs status <project-id>
  node factory.mjs exec <project-id> -- <command> [args...]`);
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
    if (!['provision', 'status', 'exec'].includes(command) || !projectId) {
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
