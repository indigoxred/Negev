// Admin-only routes: import diagnostics, operational review and its
// actions, account settings and suspended-request review. Moved out of
// user-app.mjs unchanged; every route still checks the admin role itself.
export function registerAdminRoutes(app, { requireUser, writeGuards, allowedBody,
  safeImportReasons, accounts, readImportActivity, listOperationalReview,
  reviewOperationalItem, reviewHeldRequest }) {
  // Read-only operator diagnostic. A quiet observation is never a download
  // permission and no file, path, torrent, or provider details leave the API.
  app.post('/api/admin/import-activity', { preHandler: writeGuards,
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
  async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin required' });
    }
    if (Object.keys(request.query).length ||
        !allowedBody(request.body, []) ||
        typeof readImportActivity !== 'function') {
      return reply.code(503).send({ error: 'Import activity unavailable' });
    }
    let observation;
    try { observation = await readImportActivity(); }
    catch (error) {
      request.log.warn({ err: error }, 'Negev import activity read failed');
      observation = { state: 'unavailable' };
    }
    const activity = ['quiet_observed', 'busy',
      'scheduled_unverified'].includes(observation?.state)
      ? observation.state : 'unavailable';
    return { state: 'import_activity', activity,
      ...(activity === 'busy' && safeImportReasons.has(observation?.reason)
        ? { reason: observation.reason } : {}),
      acquisitionAuthorized: false };
  });
  app.get('/api/admin/review', { preHandler: requireUser,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin required' });
    }
    const keys = Object.keys(request.query);
    const rawAfter = request.query.afterAttemptId;
    const rawLimit = request.query.limit;
    const afterAttemptId = rawAfter === undefined ? 0 : Number(rawAfter);
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (keys.some((key) => !['afterAttemptId', 'limit'].includes(key)) ||
        rawAfter !== undefined &&
          (typeof rawAfter !== 'string' || !/^(0|[1-9]\d*)$/.test(rawAfter)) ||
        rawLimit !== undefined &&
          (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit)) ||
        !Number.isSafeInteger(afterAttemptId) || afterAttemptId < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      return reply.code(400).send({ error: 'Invalid review page' });
    }
    if (typeof listOperationalReview !== 'function') {
      return reply.code(503).send({ error: 'Review unavailable' });
    }
    let result;
    try { result = await listOperationalReview({ afterAttemptId, limit }); }
    catch (error) { request.negevError = error; return reply.code(503).send({ error: 'Review unavailable' }); }
    if (result?.state !== 'review' || !Array.isArray(result.items) ||
        result.items.length > limit ||
        (result.nextAfterAttemptId !== null &&
          (!Number.isSafeInteger(result.nextAfterAttemptId) ||
            result.nextAfterAttemptId <= afterAttemptId)) ||
        result.items.some((item, index) =>
          !Number.isSafeInteger(item?.attemptId) ||
          item.attemptId <= (index === 0 ? afterAttemptId : result.items[index - 1].attemptId) ||
          !Number.isSafeInteger(item.requestId) || item.requestId < 1 ||
          !Number.isSafeInteger(item.anidbId) || item.anidbId < 1 ||
          !['release_rejected', 'import_hold', 'start_hold',
            'completion_interrupted', 'shoko_rescan_hold'].includes(item.stage) ||
          typeof item.reason !== 'string' ||
          !/^[a-z][a-z0-9_]{0,79}$/.test(item.reason) ||
          !Number.isSafeInteger(item.observedMs) || item.observedMs < 0)) {
      return reply.code(503).send({ error: 'Review unavailable' });
    }
    return { state: 'review', nextAfterAttemptId: result.nextAfterAttemptId,
      items: result.items.map(({ attemptId, requestId, anidbId,
        stage, reason, observedMs, title, englishTitle }) =>
        ({ attemptId, requestId, anidbId, stage, reason, observedMs,
          title: typeof title === 'string' && title.trim() && title.length <= 500 &&
            !/[\x00-\x1f\x7f]/.test(title) ? title : `Anime ${anidbId}`,
          englishTitle: typeof englishTitle === 'string' && englishTitle.trim() &&
            englishTitle.length <= 500 && !/[\x00-\x1f\x7f]/.test(englishTitle) ? englishTitle : null })) };
  });
  // Admin action on one parked review item: retry it now, or release a
  // never-started download so its episodes can be acquired again.
  app.post('/api/admin/review/:attemptId', { preHandler: writeGuards,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin required' });
    }
    const raw = request.params.attemptId;
    const attemptId = Number(raw);
    const { stage, action } = request.body ?? {};
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(attemptId) ||
        !allowedBody(request.body, ['stage', 'action']) ||
        Object.keys(request.body).length !== 2 ||
        !['start_hold', 'import_hold'].includes(stage) ||
        !['retry', 'release'].includes(action) ||
        (action === 'release' && stage !== 'start_hold')) {
      return reply.code(400).send({ error: 'Invalid review action' });
    }
    if (typeof reviewOperationalItem !== 'function') {
      return reply.code(503).send({ error: 'Review actions unavailable' });
    }
    let result;
    try {
      result = await reviewOperationalItem({ stage, attemptId, action,
        actorId: request.negevUser.id });
    } catch (error) { request.negevError = error; return reply.code(503).send({ error: 'Review actions unavailable' }); }
    if (result?.state === 'retry_scheduled') return { state: 'retry_scheduled' };
    if (result?.state === 'retired_prestart_mismatch') return { state: 'released' };
    const reason = typeof result?.reason === 'string' &&
      /^[a-z][a-z0-9_]{0,79}$/.test(result.reason) ? result.reason : 'action_unavailable';
    if (['release_unavailable', 'service_stopping'].includes(reason)) {
      return reply.code(503).send({ error: 'Release is unavailable right now', reason });
    }
    return reply.code(409).send({ error: reason === 'not_in_review'
      ? 'This item is no longer waiting for review'
      : 'The action did not finish. Refresh the review list to see where it stands.',
    reason });
  });
  app.get('/api/admin/users', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    return accounts.listUsers({ adminUserId: request.negevUser.id });
  });
  app.patch('/api/admin/users/:id/adult', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    const userId = Number(request.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0 ||
        Object.keys(request.query).length ||
        !allowedBody(request.body, ['allowed']) ||
        typeof request.body.allowed !== 'boolean') {
      return reply.code(400).send({ error: 'Invalid account setting' });
    }
    const result = accounts.setAdultAllowed({ adminUserId: request.negevUser.id,
      userId, allowed: request.body.allowed });
    return result.state === 'updated' ? result :
      reply.code(404).send({ error: 'Account unavailable' });
  });
  app.post('/api/admin/requests/:id/review', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    const requestId = Number(request.params.id);
    const action = request.body?.action;
    if (!Number.isSafeInteger(requestId) || requestId < 1 ||
        !allowedBody(request.body, ['action']) ||
        Object.keys(request.body).length !== 1 ||
        !['approve', 'cancel'].includes(action)) {
      return reply.code(400).send({ error: 'Invalid review action' });
    }
    if (typeof reviewHeldRequest !== 'function') {
      return reply.code(503).send({ error: 'Owner review unavailable' });
    }
    const result = reviewHeldRequest({ requestId, action });
    if (['resumed', 'cancelled'].includes(result.state)) return result;
    return reply.code(409).send({ error: 'This request can no longer be reviewed here',
      reason: result.reason });
  });
}
