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
      if (session.expiresMs <= now() && !session.pending) {
        sessions.delete(key);
        drafts.delete(session.id);
      }
    }
  };
  const access = (token, userId) => {
    prune();
    const session = sessions.get(token);
    return session?.input.requesterId === userId ? session.id : null;
  };
  const atCapacity = userId => sessions.size >= 100 ||
    [...sessions.values()].filter(s => s.input.requesterId === userId).length >= 10;
  const adapter = {
    ...requests,
    getRequest: id => drafts.get(id)?.request ?? requests.getRequest(id),
    getReleaseControl: (id, time) => drafts.get(id)?.control ?? requests.getReleaseControl(id, time),
    updateReleaseControl(id, revision, next, time) {
      const session = drafts.get(id);
      if (!session) return requests.updateReleaseControl(id, revision, next, time);
      if (session.control.revision !== revision) return held('stale_release_selection');
      session.control = { ...next, revision: revision + 1 };
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
  const open = async input => {
    prune();
    if (atCapacity(input.requesterId)) return held('release_preview_limit');
    const prepared = await prepare(input);
    if (prepared.state !== 'prepared') return prepared;
    prune();
    if (atCapacity(input.requesterId)) return held('release_preview_limit');
    const id = sequence--;
    const previewId = randomUUID();
    const session = { id, input: { ...input }, expiresMs: now() + 600_000,
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
    if (session.committed) return session.committed;
    if (session.pending) return session.pending;
    const before = session.control;
    const reject = result => { session.control = before; return result; };
    const run = async () => {
      const { action, revision } = body;
      const result = action === 'begin' ? selection.begin(id, body.mode, revision) :
        action === 'inspect' ? await selection.inspect(id, body.token) :
        action === 'choose' ? await selection.choose(id, body.token, revision, body.preferFutureGroup ?? false) :
        action === 'auto' ? await selection.auto(id, revision) :
        action === 'preference' ? await selection.setPreference(id, body.group, revision, body.audio) :
        selection.decide(id, action, revision);
      if (!['choose', 'auto', 'better', 'registered'].includes(action) ||
          result?.state !== 'updated') return result;
      if (session.expiresMs <= now()) return reject(held('release_preview_expired'));
      const prepared = await prepare(session.input);
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
    session.pending = run();
    try { return await session.pending; }
    catch (error) { if (!session.committed) session.control = before; throw error; }
    finally { session.pending = null; }
  };
  return { open, access, command, selection, readRequest: adapter.getRequest };
}
