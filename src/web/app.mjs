import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';

function hasTestToken(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Private catalogue contract prototype. No listener, accounts, requests,
// download controls, or production authentication are provided here.
export function buildTestApp({ testToken, searchTitles, loadDetail }) {
  if (typeof testToken !== 'string' || testToken.length < 16 || typeof searchTitles !== 'function') {
    throw new TypeError('Invalid private test app configuration');
  }
  const app = Fastify({ logger: false });
  const requireTestToken = async (request, reply) => {
    if (!hasTestToken(request.headers.authorization, testToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/api/catalogue/search', { preHandler: requireTestToken }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { q, page: rawPage } = request.query;
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (typeof q !== 'string' || q.trim().length < 2 || q.trim().length > 120 ||
        !Number.isSafeInteger(page) || page < 1 || page > 1000) {
      return reply.code(400).send({ error: 'Invalid search' });
    }
    const result = await searchTitles({ query: q.trim(), page });
    if (result.state === 'invalid_query') return reply.code(400).send({ error: 'Invalid search' });
    if (result.state !== 'results') return reply.code(503).send({ error: 'Catalogue unavailable' });
    return result;
  });

  app.get('/api/catalogue/:id', { preHandler: requireTestToken }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = Number(request.params.id);
    const rawPage = request.query.page;
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(page) || page < 1 || page > 1000) {
      return reply.code(400).send({ error: 'Invalid AniDB ID or page' });
    }
    if (typeof loadDetail !== 'function') return reply.code(503).send({ error: 'Catalogue detail unavailable' });
    const result = await loadDetail({ anidbId: id, page });
    if (result.state === 'detail_pending') return { state: 'detail_pending', anidbId: id, requestable: false };
    if (result.state !== 'details') return reply.code(503).send({ error: 'Catalogue detail unavailable' });
    return { ...result, requestable: false };
  });

  return app;
}

