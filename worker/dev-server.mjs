// Runs worker.js on this computer for testing, without Cloudflare: node worker/dev-server.mjs
// Then point the page at it:  http://localhost:5178/?web&proxy=http://localhost:8787
// BLOCK=yahoo,nasdaq node worker/dev-server.mjs   pretends those sources are blocked, to test the switching.
import http from 'node:http';
import worker from './worker.js';

const PORT = Number(process.env.PORT) || 8787;
const BLOCK = (process.env.BLOCK || '').toLowerCase().split(',').filter(Boolean);
if (BLOCK.length) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const host = new URL(typeof input === 'string' ? input : input.url).hostname;
    if (BLOCK.some((b) => host.includes(b))) return Promise.reject(new TypeError('blocked for testing: ' + host));
    return realFetch(input, init);
  };
  console.log('Pretending these are blocked:', BLOCK.join(', '));
}

http.createServer(async (req, res) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const r = await worker.fetch(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers }), {}, null);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => console.log(`Investerview data proxy (test) at http://localhost:${PORT}`));
