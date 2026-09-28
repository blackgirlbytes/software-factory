/** Human-approved demo intent shared by the submit client and factory worker. */

export class BriefError extends Error {}

function field(value, name, limit, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > limit || /[\u0000]/.test(value)) {
    throw new BriefError(`Invalid ${name} in demo brief`);
  }
  return value.trim() || fallback;
}

export function normalizeBrief(value, request, hasReference) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BriefError('A short demo brief is required before submission');
  }
  if (typeof request !== 'string' || !request.trim()) {
    throw new BriefError('The demo request is required');
  }
  const referenceUse = value.referenceUse ?? (hasReference ? 'context' : 'none');
  if (hasReference ? !['context', 'requirements'].includes(referenceUse) : referenceUse !== 'none') {
    throw new BriefError('Reference use must be context or requirements when a reference is supplied');
  }
  return {
    coreFlow: field(value.coreFlow, 'core flow', 4000, request.trim()),
    exclusions: field(value.exclusions, 'exclusions', 2000, 'None specified.'),
    liveIntegrations: field(value.liveIntegrations, 'live integrations', 1000,
      'None required; use fixture or local data.'),
    referenceUse,
  };
}

export function briefDocument(request, brief) {
  return `# Approved demo brief\n\n` +
    `## Original request\n\n${request.trim()}\n\n` +
    `## Core flow to demonstrate\n\n${brief.coreFlow}\n\n` +
    `## Explicitly out of scope\n\n${brief.exclusions}\n\n` +
    `## Required live integrations\n\n${brief.liveIntegrations}\n\n` +
    `## Reference repository use\n\n${brief.referenceUse}\n`;
}
