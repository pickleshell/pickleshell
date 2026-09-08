import { z } from 'zod';

const target = z.string().regex(/^(private\/[a-z][a-z0-9_-]{0,63}|shared\/[a-z][a-z0-9_/-]{0,120})$/)
  .describe('Explicit administrative target alias from memory_admin_inventory');
const memory_id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
export const MANAGEMENT_TOOLS = {
  memory_list_targets: { schema: {}, description: 'List your private and approved shared targets, resolved scopes and permissions' },
  memory_admin_status: { schema: {}, description: 'Inspect safe broker/backend readiness, loaded release and policy status' },
  memory_admin_principals: { schema: {}, description: 'List configured principals and permissions without credential material' },
  memory_admin_policy: { schema: {}, description: 'Read sanitized operator policy; policy mutation is unsupported' },
  memory_admin_inventory: { schema: {}, description: 'Discover your explicit administrative targets and grants; counts unavailable' },
  memory_admin_search: { schema: { target, query: z.string().min(1).max(8000), limit: z.number().int().min(1).max(100).default(5) }, description: 'Search one explicitly granted administrative target; repeat for other approved targets' },
  memory_admin_get: { schema: { target, memory_id }, description: 'Read one record within an explicitly granted administrative target' },
  memory_admin_delete: { schema: { target, memory_id, confirm_memory_id: memory_id.describe('Repeat the exact memory_id to confirm deletion of this single record') }, description: 'Permanently delete one record in an explicitly granted target with an independent delete permission' },
  memory_admin_principal_status: { schema: { subject: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).describe('Configured principal to inspect; never selects caller identity') }, description: 'Inspect a configured principal policy binding; does not probe their credential file' },
  memory_admin_health: { schema: {}, description: 'Probe broker to backend connectivity and authenticated policy path without secrets' },
};

export function managementOperation(tool) {
  return { method: 'POST', path: '/management/' + tool.slice(7), body: Object.keys(MANAGEMENT_TOOLS[tool].schema), unscoped: true };
}
