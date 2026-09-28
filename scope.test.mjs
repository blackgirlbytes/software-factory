import test from 'node:test';
import assert from 'node:assert/strict';
import { ScopeError, validateScope } from './scope.mjs';

const request = 'Build a mobile-friendly web app where a group can vote on dinner.';
const criterion = {
  id: 'group_vote',
  text: 'A connected group can vote on dinner.',
  source: { kind: 'request', quote: 'a group can vote on dinner' },
  verification: 'Two separate browsers submit votes and see the same result.',
};

test('a directly sourced requirement is blocking', () => {
  const plan = { acceptance_criteria: [criterion], optional_ideas: ['Replay offline votes later.'] };
  assert.equal(validateScope(plan, request), plan);
  assert.equal(validateScope({ acceptance_criteria: [{ ...criterion, id: 'A1' }] }, request)
    .acceptance_criteria[0].id, 'A1');
});

test('an inferred feature cannot cite words absent from the request', () => {
  const plan = { acceptance_criteria: [{ ...criterion, id: 'offline',
    text: 'Replay offline votes after reload.',
    source: { kind: 'request', quote: 'replay offline votes' } }] };
  assert.throws(() => validateScope(plan, request), ScopeError);
});

test('reference criteria require a real file and quote', () => {
  const snapshot = '# Reference source snapshot\n## PRODUCT.md\n\n```\nRoom votes persist across refresh.\n```\n';
  const plan = { acceptance_criteria: [{ ...criterion, id: 'refresh',
    text: 'Room votes persist across refresh.',
    source: { kind: 'reference', path: 'PRODUCT.md', quote: 'Room votes persist across refresh.' } }] };
  assert.equal(validateScope(plan, request, snapshot), plan);
  assert.throws(() => validateScope(plan, request, ''), ScopeError);
  assert.throws(() => validateScope({ acceptance_criteria: [{ ...plan.acceptance_criteria[0],
    source: { kind: 'reference', path: 'OTHER.md', quote: 'Room votes persist across refresh.' } }] },
  request, snapshot), ScopeError);
  const markdownSnapshot = '# Reference source snapshot\n## PLAN.md\n\n```\n## Safety\n\n' +
    'Room votes persist across refresh.\n```\n';
  assert.equal(validateScope({ acceptance_criteria: [{ ...criterion,
    source: { kind: 'reference', path: 'PLAN.md', quote: 'Room votes persist across refresh.' } }] },
  request, markdownSnapshot).acceptance_criteria.length, 1);
});

test('duplicate IDs and empty verification are rejected', () => {
  assert.throws(() => validateScope({ acceptance_criteria: [criterion, criterion] }, request), ScopeError);
  assert.throws(() => validateScope({ acceptance_criteria: [{ ...criterion, verification: '' }] }, request), ScopeError);
});
