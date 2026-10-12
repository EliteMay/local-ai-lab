import { createCloudAsk } from './providers.mjs';
import { createMockAsk } from './team.mjs';

const ROLES = ['planner', 'reviewer', 'integrator'];

/** Each role is independently mapped to a model/provider; no cross-provider fallback. */
export function createRoleRouter({ provider = 'mock', model, roleOptions = {}, env = process.env, fetchImpl = fetch } = {}) {
  const asks = {};
  for (const role of ROLES) {
    const selected = roleOptions[role] ?? {};
    const roleProvider = selected.provider ?? provider;
    const roleModel = selected.model ?? model;
    asks[role] = roleProvider === 'mock' ? createMockAsk() : createCloudAsk({ provider: roleProvider, model: roleModel, env, fetchImpl });
  }
  return (request) => {
    if (!ROLES.includes(request.role)) throw new Error('不明なAI役割です');
    return asks[request.role](request);
  };
}
