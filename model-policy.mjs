/** Model choices for Codex sessions run inside project Sprites. */

const profiles = Object.freeze({
  smoke: ['gpt-6-luna', 'low', 'Short tool-use readiness check'],
  research: ['gpt-6-luna', 'low', 'Scoped documentation and source research'],
  plan: ['gpt-6-astra', 'medium', 'Interpret the request and design the task graph'],
  plan_repair: ['gpt-6-astra', 'medium', 'Repair a plan without changing its intent'],
  replan: ['gpt-6-astra', 'high', 'Resolve repeated planning or scope failures'],
  scope_audit: ['gpt-6-astra', 'medium', 'Check the plan against the original request'],
  build_simple: ['gpt-6-luna', 'low', 'Small, well-specified file task'],
  build_standard: ['gpt-6-sol', 'low', 'Bounded implementation task'],
  build_complex: ['gpt-6-sol', 'medium', 'Implementation task with substantial integration or debugging'],
  review_fix: ['gpt-6-sol', 'medium', 'Repair a verified review finding'],
  review: ['gpt-6-astra', 'medium', 'Judge the whole result against the original intent'],
  tutorial: ['gpt-6-luna', 'low', 'Explain the verified implementation'],
});

export function routeCodexTask(role, { complexity = 'standard' } = {}) {
  if (role === 'build' && !['simple', 'standard', 'complex'].includes(complexity)) {
    throw new TypeError(`Invalid build complexity: ${complexity}`);
  }
  const profile = profiles[role === 'build' ? `build_${complexity}` : role];
  if (!profile) throw new TypeError(`Unknown Codex role: ${role}`);
  const [model, reasoningEffort, reason] = profile;
  return { role, model, reasoningEffort, reason };
}
