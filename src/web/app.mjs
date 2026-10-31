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
export function buildTestApp({ testToken, searchTitles }) {
  if (typeof testToken !== 'string' || testToken.length < 16 || typeof searchTitles !== 'function') {
    throw new TypeError('Invalid private test app configuration');
  }
  const app = Fastify({ logger: false });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/api/catalogue/search', {
    preHandler: async (request, reply) => {
      if (!hasTestToken(request.headers.authorization, testToken)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    },
  }, async (request, reply) => {
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

  return app;
}
