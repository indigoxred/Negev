// Admin-only routes: import diagnostics, operational review and its
// actions, account settings and suspended-request review. Moved out of
// user-app.mjs unchanged; every route still checks the admin role itself.
export function registerAdminRoutes(app, { requireUser, currentUser, writeGuards, allowedBody,
  safeImportReasons, accounts, readImportActivity, listOperationalReview,
  reviewOperationalItem, reviewHeldRequest, deleteAccount, now = Date.now }) {
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
          !['release_rejected', 'import_hold', 'start_hold', 'removal_hold',
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
        !['start_hold', 'import_hold', 'removal_hold'].includes(stage) ||
        !['retry', 'release'].includes(action) ||
        (action === 'release' && stage !== 'start_hold')) {
      return reply.code(400).send({ error: 'Invalid review action' });
    }
    if (typeof reviewOperationalItem !== 'function') {
      return reply.code(503).send({ error: 'Review actions unavailable' });
    }
    let result;
    try {
      const actorId=request.negevUser.id;
      result = await reviewOperationalItem({ stage, attemptId, action, actorId,
        ...(stage==='removal_hold'?{authorizeAction:()=>{
          const user=currentUser(request);
          return user?.id===actorId && user.role==='admin';
        }}:{}) });
    } catch (error) { request.negevError = error; return reply.code(503).send({ error: 'Review actions unavailable' }); }
    if (result?.state === 'retry_scheduled') return { state: 'retry_scheduled' };
    if (stage === 'removal_hold' && ['retired_prestart_mismatch','retired_stalled'].includes(result?.state)) return {state:'removal_confirmed'};
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
  app.patch('/api/admin/users/:id/disabled', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.negevUser.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    const userId = Number(request.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0 ||
        Object.keys(request.query).length ||
        !allowedBody(request.body, ['disabled']) ||
        typeof request.body.disabled !== 'boolean') {
      return reply.code(400).send({ error: 'Invalid account setting' });
    }
    if (typeof accounts.setDisabled !== 'function') {
      return reply.code(503).send({ error: 'Account changes unavailable' });
    }
    const result = accounts.setDisabled({ adminUserId: request.negevUser.id,
      userId, disabled: request.body.disabled });
    if (result.state === 'updated') return result;
    if (result.reason === 'cannot_disable_self') {
      return reply.code(409).send({ error: 'You cannot disable your own account', reason: result.reason });
    }
    return reply.code(404).send({ error: 'Account unavailable' });
  });
  const adminOnly = (request, reply) => {
    if (request.negevUser.role === 'admin') return true;
    reply.code(403).send({ error: 'Admin required' });
    return false;
  };
  const positiveParam = (value) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  // Permanent. The account must be disabled first; see src/auth/delete-account.mjs.
  app.post('/api/admin/users/:id/delete', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!adminOnly(request, reply)) return reply;
    const userId = positiveParam(request.params.id);
    if (userId === null || Object.keys(request.query).length ||
        !allowedBody(request.body ?? {}, []) || Object.keys(request.body ?? {}).length) {
      return reply.code(400).send({ error: 'Invalid account deletion' });
    }
    if (typeof deleteAccount !== 'function') {
      return reply.code(503).send({ error: 'Account deletion unavailable' });
    }
    let result;
    try { result = await deleteAccount({ adminUserId: request.negevUser.id, userId }); }
    catch (error) {
      request.negevError = error;
      return reply.code(503).send({ error: 'Account deletion unavailable' });
    }
    if (result.state === 'deleted') return result;
    const messages = {
      cannot_delete_self: 'You cannot delete your own account.',
      disable_first: 'Disable the account before deleting it.',
      acquisition_unsettled: 'A download is still being prepared or reconciled. Wait for it to settle before deleting the account.',
    };
    return reply.code(messages[result.reason] ? 409 : 404).send({
      error: messages[result.reason] ?? 'Account unavailable', reason: result.reason });
  });
  app.get('/api/admin/invitations', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!adminOnly(request, reply)) return reply;
    if (typeof accounts.listInvites !== 'function') {
      return reply.code(503).send({ error: 'Invitations unavailable' });
    }
    return accounts.listInvites({ adminUserId: request.negevUser.id });
  });
  app.post('/api/admin/invitations/:id/revoke', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!adminOnly(request, reply)) return reply;
    const inviteId = positiveParam(request.params.id);
    if (inviteId === null || Object.keys(request.query).length ||
        !allowedBody(request.body ?? {}, []) || Object.keys(request.body ?? {}).length) {
      return reply.code(400).send({ error: 'Invalid invitation' });
    }
    if (typeof accounts.revokeInvite !== 'function') {
      return reply.code(503).send({ error: 'Invitations unavailable' });
    }
    const result = accounts.revokeInvite({ adminUserId: request.negevUser.id, inviteId });
    return result.state === 'revoked' ? result : reply.code(409).send({
      error: 'That invitation was already used, revoked or does not exist.' });
  });
  app.post('/api/admin/users/:id/password-reset', { preHandler: writeGuards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!adminOnly(request, reply)) return reply;
    const userId = positiveParam(request.params.id);
    if (userId === null || Object.keys(request.query).length ||
        !allowedBody(request.body ?? {}, []) || Object.keys(request.body ?? {}).length) {
      return reply.code(400).send({ error: 'Invalid password reset' });
    }
    if (typeof accounts.createPasswordReset !== 'function') {
      return reply.code(503).send({ error: 'Password resets unavailable' });
    }
    const result = accounts.createPasswordReset({ adminUserId: request.negevUser.id,
      userId, expiresMs: now() + 24 * 60 * 60 * 1000 });
    return result.state === 'created' ? reply.code(201).send(result)
      : reply.code(404).send({ error: 'Account unavailable' });
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
