/** Deterministic provenance checks for a factory plan's delivery contract. */

export class ScopeError extends Error {}

const normalize = value => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function validateScope(plan, request, referenceSnapshot = '') {
  const criteria = plan?.acceptance_criteria;
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 30) {
    throw new ScopeError('Plan needs 1–30 sourced acceptance criteria');
  }
  const ids = new Set();
  for (const criterion of criteria) {
    const { id, text, source, verification } = criterion ?? {};
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id ?? '') || ids.has(id)
      || !nonempty(text) || !nonempty(verification)) {
      throw new ScopeError('Acceptance criteria need unique IDs, text, and verification');
    }
    ids.add(id);
    if (!source || !nonempty(source.quote) || source.quote.trim().length < 8) {
      throw new ScopeError(`Acceptance criterion ${id} needs a substantive source quote`);
    }
    if (source.kind === 'request') {
      if (!normalize(request).includes(normalize(source.quote))) {
        throw new ScopeError(`Acceptance criterion ${id} quotes text absent from the request`);
      }
    } else if (source.kind === 'reference') {
      if (!nonempty(source.path) || !/^[A-Za-z0-9._/-]+$/.test(source.path)
        || source.path.split('/').some(part => !part || part === '.' || part === '..')
        || !referenceSnapshot.includes(`\n## ${source.path}\n`)
        || !normalize(referenceSnapshot).includes(normalize(source.quote))) {
        throw new ScopeError(`Acceptance criterion ${id} has an unverified reference quote`);
      }
    } else {
      throw new ScopeError(`Acceptance criterion ${id} must cite the request or reference`);
    }
  }
  if (plan.optional_ideas !== undefined && (!Array.isArray(plan.optional_ideas)
    || plan.optional_ideas.some(item => !nonempty(item)))) {
    throw new ScopeError('Optional ideas must be nonempty strings');
  }
  return plan;
}
