import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const root = new URL('./', import.meta.url);
createServer(async (request, response) => {
  const [name, type] = files.get(request.url) ?? [];
  if (!name) { response.writeHead(404); response.end(); return; }
  try {
    const bytes = await readFile(fileURLToPath(new URL(name, root)));
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src https://cdn.anidb.net; base-uri 'none'; form-action 'none'",
    });
    response.end(bytes);
  } catch { response.writeHead(500); response.end(); }
}).listen(17117, '127.0.0.1');
