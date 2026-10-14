import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureBroker, stateRoot } from './service-client.js';

export async function createDesktopLauncher(startBroker = () => ensureBroker({ parent: true })) {
  const token = randomBytes(32).toString('hex'), instanceId = randomUUID();
  const server = http.createServer(async (request, response) => {
    const given = Buffer.from(request.headers.authorization || ''), expected = Buffer.from('Bearer ' + token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      response.writeHead(403); response.end(); return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/health') {
      response.end(JSON.stringify({ instance_id: instanceId, pid: process.pid, protocol: 1 })); return;
    }
    if (request.method !== 'POST' || request.url !== '/start') {
      response.writeHead(404); response.end('{}'); return;
    }
    try {
      const info = await startBroker();
      response.end(JSON.stringify({ instance_id: info?.instance_id || null }));
    } catch { response.writeHead(503); response.end('{}'); }
  });
  const directory = path.join(stateRoot(), 'launchers');
  const file = path.join(directory, process.pid + '-' + token.slice(0, 16) + '.json'), temporary = file + '.tmp';
  const closeServer = async () => {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    server.unref();
    await mkdir(directory, { recursive: true });
    const environment = JSON.stringify({ port: server.address().port, token, pid: process.pid,
      instance_id: instanceId, created_at: new Date().toISOString() });
    await writeFile(temporary, environment, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    return { environment, async close() { await rm(file, { force: true }); await closeServer(); } };
  } catch (error) {
    await closeServer();
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
