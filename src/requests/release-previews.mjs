import { randomUUID } from 'node:crypto';
import { createReleaseSelection } from '../acquisition/release-selection.mjs';

const held = reason => ({ state: 'held', reason });

// Unsaved contexts reuse ordinary search and preflight. They never enter the
// durable request/watch queues until an authenticated, explicit commit.
export function createReleasePreviews({ requests, prepare, selectionOptions,
  now = Date.now, wake = () => {}, onCommitted = () => {} }) {
  const sessions = new Map();
  const drafts = new Map();
  // Positive IDs are required by the existing discovery/preflight contracts.
  // These IDs are private to this resolver and never written into the ledger.
  let sequence = Number.MAX_SAFE_INTEGER;
  const prune = () => {
    for (const [key, session] of sessions) {
      if (session.expiresMs <= now() && !session.pending && !session.inspections) {
        sessions.delete(key);
        drafts.delete(session.id);
      }
    }
    // Retain a bounded receipt cache for retries, independently of live drafts.
    const receipts = [...sessions].filter(([, session]) => session.committed && !session.pending && !session.inspections);
    for (const [key, session] of receipts.slice(0, Math.max(0, receipts.length - 100))) {
      sessions.delete(key);
      drafts.delete(session.id);
    }
  };
  const access = (token, userId) => {
    prune();
    const session = sessions.get(token);
    return session?.input.requesterId === userId && session.expiresMs > now() ? session.id : null;
  };
  const atCapacity = userId => {
    const active = [...sessions.values()].filter(s => !s.committed);
    return active.length >= 100 || active.filter(s => s.input.requesterId === userId).length >= 10;
  };
  const adapter = {
    ...requests,
    getRequest: id => drafts.get(id)?.request ?? requests.getRequest(id),
    getReleaseControl: (id, time) => drafts.get(id)?.control ?? requests.getReleaseControl(id, time),
    updateReleaseControl(id, revision, next, time) {
      const session = drafts.get(id);
      if (!session) return requests.updateReleaseControl(id, revision, next, time);
      if (session.control.revision !== revision) return held('stale_release_selection');
      session.control = { ...next,
        ...(next.preference===undefined&&session.control.preference!==undefined?{preference:session.control.preference}:{}),
        revision: revision + 1 };
      return { state: 'updated', control: session.control };
    },
    updateReleasePreference(id, revision, preference, time) {
      const session = drafts.get(id);
      return session ? adapter.updateReleaseControl(id, revision,
        { ...session.control, preference }, time) :
        requests.updateReleasePreference(id, revision, preference, time);
    },
  };
  const selection = createReleaseSelection({
    ...selectionOptions,
    async previewCandidate(input) {
      const result = await selectionOptions.previewCandidate(input);
      if (!result) return result;
      const { requestId: ignored, ...preview } = result;
      return preview;
    },
    requests: adapter, now,
    wake: id => { if (!drafts.has(id)) wake(id); },
  });
  const existingSubmission = (result, input) => {
    if (result?.state !== 'held' || result.created !== false ||
        !['awaiting_availability_evidence', 'already_monitored'].includes(result.reason) ||
        !Number.isSafeInteger(result.requestId) || result.requestId < 1) return null;
    const request = requests.getRequest(result.requestId);
    if (!request || request.status === 'cancelled' ||
        request.requesterId !== input.requesterId || request.anidbId !== input.anidbId) return null;
    return { state: 'updated', requestId: request.id, created: false,
      control: requests.getReleaseControl(request.id, now()) };
  };
  const open = async input => {
    prune();
    const prepared = await prepare(input);
    const existing = existingSubmission(prepared, input);
    if (existing) return { state: 'existing', requestId: existing.requestId, created: false };
    if (prepared.state !== 'prepared') return prepared;
    prune();
    if (atCapacity(input.requesterId)) return held('release_preview_limit');
    const id = sequence--;
    const previewId = randomUUID();
    const session = { id, input: { ...input }, commandKey: prepared.submission.commandKey, expiresMs: now() + 600_000,
      control: { mode: 'manual', phase: 'selecting', revision: 1 },
      request: { ...prepared.submission.intent, id, requesterId: input.requesterId,
        status: 'held', watchClosed: false, preview: true } };
    sessions.set(previewId, session);
    drafts.set(id, session);
    return { state: 'preview', previewId, expiresMs: session.expiresMs };
  };
  const command = async (token, userId, body) => {
    const id = access(token, userId);
    if (!id) return held('release_preview_expired');
    const session = drafts.get(id);
    if (session.committed) {
      const saved = requests.getRequest(session.committed.requestId);
      if (saved?.status === 'cancelled') return held('request_cancelled');
      return existingSubmission({ state: 'held', reason: 'awaiting_availability_evidence',
        requestId: session.committed.requestId, created: false }, session.input) ?? held('request_missing');
    }
    if (body.action === 'inspect') {
      // Inspection is read-only. Receipt-level preflight already coalesces the
      // same token; unrelated receipts and mutations must keep their own results.
      session.inspections = (session.inspections ?? 0) + 1;
      try {
        const result = await selection.inspect(id, body.token);
        return session.expiresMs <= now() ? held('release_preview_expired') : result;
      } finally { session.inspections--; }
    }
    const commandKey = JSON.stringify([body.action, body.revision, body.token,
      body.mode, body.group, body.audio, body.preferFutureGroup ?? false]);
    if (session.pending) return session.pendingKey === commandKey ? session.pending : held('release_search_in_progress');
    const before = session.control;
    const reject = result => { session.control = before; return result; };
    const run = async () => {
      const { action, revision } = body;
      const commits = ['choose', 'auto', 'better', 'registered'].includes(action);
      let autoPrepared;
      if (commits) {
        // A parallel tab may have already saved this command or watch. Resolve
        // that success before inspecting now-owned files or changing a draft.
        const prepared = await prepare(session.input);
        if (session.expiresMs <= now()) return reject(held('release_preview_expired'));
        const existing = existingSubmission(prepared, session.input);
        if (existing) return session.committed = existing;
        if (prepared.state !== 'prepared') return reject(prepared);
        if (action === 'auto') autoPrepared = prepared;
      }
      if (action === 'auto') {
        if (before.revision !== revision || before.mode !== 'auto' || before.phase !== 'selecting') return reject(held('stale_release_selection'));
        // Explicit Auto saves scope; the existing durable request worker owns
        // comparison and proposals before ordinary guarded acquisition.
        const saved = requests.submit({ ...autoPrepared.submission, initialReleaseControl: { ...before } });
        if (!saved.requestId) return reject(saved);
        session.committed = { state: 'updated', requestId: saved.requestId,
          created: saved.created, queued: true, control: requests.getReleaseControl(saved.requestId, now()) };
        if (saved.created) {
          onCommitted({ ...saved, requesterId: userId, anidbId: session.input.anidbId });
          wake(saved.requestId);
        }
        return session.committed;
      }
      const result = action === 'begin' ? selection.begin(id, body.mode, revision) :
        action === 'choose' ? await selection.choose(id, body.token, revision, body.preferFutureGroup ?? false) :
        action === 'auto' ? await selection.auto(id, revision) :
        action === 'preference' ? await selection.setPreference(id, body.group, revision, body.audio) :
        selection.decide(id, action, revision);
      if (!commits || result?.state !== 'updated') return result;
      if (session.expiresMs <= now()) return reject(held('release_preview_expired'));
      const prepared = await prepare(session.input);
      const existing = existingSubmission(prepared, session.input);
      if (existing) return session.committed = existing;
      if (prepared.state !== 'prepared') return reject(prepared);
      const control = session.control;
      const required = [...new Set([
        ...(control.selection?.preview?.episodeIds ?? []),
        ...(control.proposal?.registered?.preview?.episodeIds ?? []),
        ...(control.proposal?.better?.preview?.episodeIds ?? []),
      ])];
      if (required.some(id => !prepared.submission.intent.episodeIds.includes(id))) {
        return reject(held('target_already_available'));
      }
      // Cached torrent inspection is identity evidence only. Check public and
      // owned coverage again immediately before the synchronous transaction.
      const coverage = await selectionOptions.readPublicCoverage({ ...session.request,
        episodeIds: prepared.submission.intent.episodeIds });
      if (session.expiresMs <= now()) return reject(held('release_preview_expired'));
      // Coverage may yield while a different tab commits the same command.
      // Resolve durable identity before treating its new ownership as an error.
      let duplicate = typeof session.commandKey === 'string' ? requests.findSubmission({
        requesterId: userId, requestKey: session.input.requestKey, commandKey: session.commandKey }) : null;
      if (!duplicate && session.input.scope === 'installment') {
        const watch = requests.findActiveWatch?.({ requesterId: userId, anidbId: session.input.anidbId });
        if (watch) duplicate = { state: 'held', reason: 'already_monitored', requestId: watch, created: false };
      }
      if (duplicate) {
        const existing = existingSubmission(duplicate, session.input);
        return existing ? session.committed = existing : reject(duplicate);
      }
      const blocked = new Set([...(coverage.availableEpisodeIds ?? []),
        ...(coverage.uncertainEpisodeIds ?? [])]);
      if (required.some(id => blocked.has(id))) return reject(held('target_already_owned'));
      if (session.expiresMs <= now()) return reject(held('release_preview_expired'));
      const saved = requests.submit({ ...prepared.submission, initialReleaseControl: control });
      if (!saved.requestId) return reject(saved);
      // An existing request is never overwritten with an abandoned draft's choice.
      const actual = requests.getReleaseControl(saved.requestId, now());
      session.committed = { state: 'updated', requestId: saved.requestId,
        created: saved.created, control: actual };
      if (saved.created) {
        onCommitted({ ...saved, requesterId: userId, anidbId: session.input.anidbId });
        wake(saved.requestId);
      }
      return session.committed;
    };
    session.pendingKey = commandKey;
    session.pending = run();
    try { return await session.pending; }
    catch (error) { if (!session.committed) session.control = before; throw error; }
    finally { session.pending = null; session.pendingKey = null; }
  };
  return { open, access, command, selection, readRequest: adapter.getRequest };
}
