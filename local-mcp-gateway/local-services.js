import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Local extensions are optional and separate from the distributed defaults.
export function localServices(file = fileURLToPath(new URL('./services.local.json', import.meta.url))) {
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { services: [], environment: [], defaults: {}, instructions: '' }; throw error; }
  const services = config.services || [];
  if (!Array.isArray(services) || services.length > 8) throw Error('Invalid local service configuration.');
  for (const service of services) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(service.id) || !/^[a-z][a-z0-9-]{0,63}$/.test(service.directory) ||
        !Array.isArray(service.tools) || service.tools.length > 64 ||
        service.tools.some(name => !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name)) ||
        (service.mutating_tools || []).some(name => !service.tools.includes(name))) throw Error('Invalid local service definition.');
  }
  const environment = config.environment || [], defaults = config.defaults || {};
  if (!Array.isArray(environment) || environment.length > 32 || !defaults || Array.isArray(defaults) || typeof defaults !== 'object' ||
      [...environment, ...Object.keys(defaults)].some(name => !/^[A-Z][A-Z0-9_]*$/.test(name) || /CONTROL_PLANE|TUNNEL.*(?:KEY|TOKEN)/.test(name)) ||
      Object.values(defaults).some(value => typeof value !== 'string') ||
      (config.instructions != null && typeof config.instructions !== 'string')) throw Error('Invalid local environment configuration.');
  return { services, environment, defaults, instructions: config.instructions || '' };
}
