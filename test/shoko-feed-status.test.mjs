import assert from 'node:assert/strict';
import test from 'node:test';
import { createShokoFeedStatusReporter } from
  '../src/availability/shoko-feed-status.mjs';

test('reports Shoko feed state transitions once without event details', () => {
  const messages = [];
  const report = createShokoFeedStatusReporter({
    write: (message) => messages.push(message),
  });
  report('feed_disconnected');
  report('feed_disconnected');
  report('feed_started');
  report('feed_reconnected');
  report('file_detected');
  report('feed_disconnected');
  assert.deepEqual(messages, [
    'Shoko file feed disconnected\n',
    'Shoko file feed connected\n',
    'Shoko file feed disconnected\n',
  ]);
});
