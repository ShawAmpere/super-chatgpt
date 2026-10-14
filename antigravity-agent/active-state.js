// The shared registry reserves independent slots across MCP server processes.
export function activeTasks(value) {
  if (value == null) return {};
  if (value.version === 2 && value.tasks && typeof value.tasks === 'object' && !Array.isArray(value.tasks)) {
    for (const [id, task] of Object.entries(value.tasks)) {
      if (!task || task.taskId !== id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid active-task registry; recovery is required.');
    }
    return value.tasks;
  }
  if (/^[0-9a-f-]{36}$/i.test(value.taskId || '')) return { [value.taskId]: value };
  throw new Error('Unrecognized active-task registry; refusing to overwrite ownership.');
}

export function activeRegistry(tasks) { return { version: 2, tasks }; }

export function concurrencyLimit(value) {
  const limit = value === undefined ? 4 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('ANTIGRAVITY_AGENT_MAX_CONCURRENT must be an integer from 1 to 32.');
  return limit;
}
