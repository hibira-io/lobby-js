import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue, QUEUE_EVENT, findMatches, allowedRange, criteriaFit } from '../index.js';
import { authorizeQueue } from '../server.js';

function fakeChannel(name = 'presence-queue-duo') {
  const handlers = new Map();
  return {
    name,
    sent: [],
    connected: true,
    bind(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
    },
    unbind(ev, fn) {
      handlers.get(ev)?.delete(fn);
    },
    trigger(ev, data) {
      if (!this.connected) return false;
      this.sent.push([ev, data]);
      return true;
    },
    emit(ev, data, meta) {
      for (const fn of handlers.get(ev) ?? []) fn(data, meta);
    },
    handlers,
  };
}

function fakePusher() {
  const channels = new Map();
  return {
    channels,
    unsubscribed: [],
    subscribe(name) {
      const ch = fakeChannel(name);
      channels.set(name, ch);
      return ch;
    },
    unsubscribe(name) {
      this.unsubscribed.push(name);
    },
  };
}

const t = (id, joinedAt, rating, criteria) => ({ id, joinedAt, rating, criteria });
const info = (joined_at, rating, criteria, name) => ({ joined_at, rating, criteria, name });

function queued(members, myID, options) {
  const ch = fakeChannel();
  const q = new Queue(ch, { timeout: Infinity, ...options });
  ch.emit('pusher:subscription_succeeded', { members, myID, count: Object.keys(members).length });
  return { ch, q };
}

// ---- matching rules --------------------------------------------------------

test('findMatches: oldest first, closest rating, leftovers wait', () => {
  const now = 10_000;
  const m = findMatches([t('a', 1, 1000), t('b', 2, 1500), t('c', 3, 1010), t('d', 4, 1490), t('e', 5, 3000)], { size: 2 }, now);
  assert.deepEqual(m.map((x) => x.players), [['a', 'c'], ['b', 'd']]);
});

test('findMatches: rating range widens with waiting time, up to maxRange', () => {
  const rules = { size: 2, ratingRange: 100, widenBy: 100, widenEvery: 1000, maxRange: 250 };
  const tickets = [t('a', 0, 1000), t('b', 0, 1300)];
  assert.equal(findMatches(tickets, rules, 500).length, 0);
  assert.equal(allowedRange(1500, rules), 200);
  assert.equal(findMatches(tickets, rules, 1500).length, 0);
  assert.equal(allowedRange(60_000, rules), 250);
  assert.equal(findMatches(tickets, rules, 60_000).length, 0);
  assert.equal(findMatches([t('a', 0, 1000), t('b', 0, 1240)], rules, 60_000).length, 1);
});

test('findMatches: smaller match after fillAfter', () => {
  const rules = { size: 4, minSize: 2, fillAfter: 5000 };
  const tickets = [t('a', 0), t('b', 100), t('c', 200)];
  assert.equal(findMatches(tickets, rules, 4000).length, 0);
  assert.deepEqual(findMatches(tickets, rules, 5000).map((x) => x.players), [['a', 'b', 'c']]);
});

test('criteriaFit: equal values, overlapping arrays, missing keys are wildcards', () => {
  assert.equal(criteriaFit({ mode: 'duo' }, { mode: 'duo' }), true);
  assert.equal(criteriaFit({ mode: 'duo' }, { mode: 'solo' }), false);
  assert.equal(criteriaFit({ region: ['hkg', 'tyo'] }, { region: 'tyo' }), true);
  assert.equal(criteriaFit({ region: ['hkg'] }, { region: ['sin'] }), false);
  assert.equal(criteriaFit({ mode: 'duo' }, {}), true);
});

test('findMatches: every pair in a group must fit, not only each player and the anchor', () => {
  const m = findMatches([t('a', 0, 0, {}), t('b', 1, 0, { region: 'hkg' }), t('c', 2, 0, { region: 'tyo' })], { size: 3 }, 10);
  assert.equal(m.length, 0);
  const m2 = findMatches([t('a', 0, 0, {}), t('b', 1, 0, { region: 'hkg' }), t('c', 2, 0, { region: 'tyo' })], { size: 2 }, 10);
  assert.deepEqual(m2.map((x) => x.players), [['a', 'b']]);
});

test('findMatches: compatible() can veto a pair', () => {
  const m = findMatches([t('a', 0), t('b', 1), t('c', 2)], { size: 2, compatible: (x, y) => !(x.id === 'a' && y.id === 'b') }, 10);
  assert.deepEqual(m.map((x) => x.players), [['a', 'c']]);
});

// ---- the queue -------------------------------------------------------------

test('the longest-waiting member hosts and announces matches', () => {
  const { ch, q } = queued({ a: info(1, 1000), b: info(2, 1020) }, 'a', { size: 2 });
  assert.equal(q.isHost, true);
  assert.equal(ch.sent.length, 1);
  const [ev, data] = ch.sent[0];
  assert.equal(ev, QUEUE_EVENT.match);
  assert.deepEqual(data.matches[0].players, ['a', 'b']);
  assert.match(data.matches[0].id, /^[0-9a-z]{16,}$/);
  assert.equal(q.status, 'matched');
  assert.equal(q.match.channel, `presence-match-${data.matches[0].id}`);
  assert.equal(q.match.room, null);
});

test('a match from the host moves you into the match room', () => {
  const pusher = fakePusher();
  const q = Queue.join(pusher, 'presence-queue-duo', { size: 2, timeout: Infinity, roomOptions: { stateDelay: 0 } });
  const ch = pusher.channels.get('presence-queue-duo');
  ch.emit('pusher:subscription_succeeded', { members: { a: info(1), b: info(2) }, myID: 'b' });
  assert.equal(q.isHost, false);
  assert.equal(q.position, 2);
  const got = [];
  q.on('match', (m) => got.push(m));
  ch.emit(QUEUE_EVENT.match, { matches: [{ id: 'm1', players: ['a', 'b'] }] }, { user_id: 'a' });
  assert.equal(got.length, 1);
  assert.equal(got[0].channel, 'presence-match-m1');
  assert.deepEqual(got[0].players.map((p) => [p.id, p.me]), [['a', false], ['b', true]]);
  assert.equal(got[0].room.capacity, 2);
  assert.ok(pusher.channels.has('presence-match-m1'));
  assert.deepEqual(pusher.unsubscribed, ['presence-queue-duo']);
  assert.equal(q.status, 'matched');
});

test('matches from anyone but the host are ignored', () => {
  const { ch, q } = queued({ a: info(1), b: info(2), c: info(3) }, 'c', { size: 3, timeout: Infinity, interval: 1e9 });
  ch.emit(QUEUE_EVENT.match, JSON.stringify({ matches: [{ id: 'x', players: ['b', 'c'] }] }), { user_id: 'b' });
  assert.equal(q.status, 'waiting');
  ch.emit(QUEUE_EVENT.match, JSON.stringify({ matches: [{ id: 'y', players: ['a', 'c'] }] }), { user_id: 'a' });
  assert.equal(q.status, 'matched');
  assert.equal(q.match.id, 'y');
});

test('the next host skips players already matched by the old one', () => {
  const { ch, q } = queued({ a: info(1), b: info(2), c: info(3), d: info(4) }, 'c', { size: 2 });
  ch.emit(QUEUE_EVENT.match, { matches: [{ id: 'm1', players: ['a', 'b'] }] }, { user_id: 'a' });
  assert.equal(q.count, 2);
  assert.equal(q.position, 1);
  // a leaves first; b is still on its way out when c becomes host.
  ch.emit('pusher:member_removed', { id: 'a' });
  assert.equal(q.isHost, false); // b is still the oldest member
  ch.emit('pusher:member_removed', { id: 'b' });
  assert.equal(q.isHost, true);
  q._tick();
  assert.equal(ch.sent.length, 1);
  assert.deepEqual(ch.sent[0][1].matches[0].players, ['c', 'd']);
});

test('a player cannot be in two matches', () => {
  const { ch, q } = queued({ a: info(1), b: info(2), c: info(3) }, 'c', { size: 2 });
  ch.emit(QUEUE_EVENT.match, { matches: [{ id: 'm1', players: ['a', 'b'] }, { id: 'm2', players: ['b', 'c'] }] }, { user_id: 'a' });
  assert.equal(q.status, 'waiting');
});

test('the host waits for enough players, then matches on the next join', () => {
  const { ch, q } = queued({ a: info(1) }, 'a', { size: 2 });
  assert.equal(ch.sent.length, 0);
  ch.emit('pusher:member_added', { id: 'b', info: info(2) });
  assert.equal(ch.sent.length, 1);
  assert.equal(q.status, 'matched');
});

test('the host matches others without matching itself', () => {
  const { ch, q } = queued({ a: info(1, 0), b: info(2, 5000), c: info(3, 5010) }, 'a', { size: 2, ratingRange: 100 });
  assert.equal(ch.sent.length, 1);
  assert.deepEqual(ch.sent[0][1].matches[0].players, ['b', 'c']);
  assert.equal(q.status, 'waiting');
  assert.equal(q.count, 1);
});

test('big rounds are split into batches under maxEventBytes', () => {
  const members = { host: info(0, 99_999) };
  for (let i = 1; i <= 40; i++) members[`user-${String(i).padStart(3, '0')}`] = info(i, 0);
  const { ch, q } = queued(members, 'host', { size: 2, ratingRange: 10, maxEventBytes: 600, maxEventsPerTick: 10 });
  assert.equal(q.isHost, true);
  assert.ok(ch.sent.length > 1);
  for (const [, data] of ch.sent) assert.ok(JSON.stringify(data).length <= 600);
  assert.equal(ch.sent.flatMap(([, d]) => d.matches).length, 20);
  assert.equal(q.count, 1);
});

test('maxEventsPerTick caps a round; the rest match next round', () => {
  const members = { host: info(0, 99_999) };
  for (let i = 1; i <= 40; i++) members[`user-${String(i).padStart(3, '0')}`] = info(i, 0);
  const { ch, q } = queued(members, 'host', { size: 2, ratingRange: 10, maxEventBytes: 600, maxEventsPerTick: 1, interval: 1e9 });
  assert.equal(ch.sent.length, 1);
  const first = ch.sent[0][1].matches.length;
  q._tick();
  assert.equal(ch.sent.length, 2);
  assert.ok(first + ch.sent[1][1].matches.length <= 20);
  const all = ch.sent.flatMap(([, d]) => d.matches.flatMap((m) => m.players));
  assert.equal(new Set(all).size, all.length);
});

test('timeout gives up and leaves the queue', async () => {
  const pusher = fakePusher();
  const q = Queue.join(pusher, 'presence-queue-duo', { size: 2, timeout: 20 });
  pusher.channels.get('presence-queue-duo').emit('pusher:subscription_succeeded', { members: { a: info(1) }, myID: 'a' });
  const keepAlive = setTimeout(() => {}, 1000); // the queue's own timer is unref'd
  const timedOut = await new Promise((resolve) => q.on('timeout', resolve));
  clearTimeout(keepAlive);
  assert.equal(typeof timedOut.waited, 'number');
  assert.equal(q.status, 'timeout');
  assert.deepEqual(pusher.unsubscribed, ['presence-queue-duo']);
});

test('leave() stops waiting', () => {
  const { ch, q } = queued({ a: info(1), b: info(2) }, 'b', { size: 3 });
  q.leave();
  assert.equal(q.status, 'left');
  ch.emit(QUEUE_EVENT.match, { matches: [{ id: 'm', players: ['a', 'b'] }] }, { user_id: 'a' });
  assert.equal(q.status, 'left');
});

test('Queue.join refuses non-presence channels', () => {
  assert.throws(() => Queue.join(fakePusher(), 'private-queue'), /not a presence channel/);
  assert.throws(() => Queue.join(fakePusher(), 'presence-large-queue'), /not a presence channel/);
});

test('authorizeQueue signs joined_at, rating and criteria', async () => {
  const calls = [];
  const pusher = { authorizeChannel: (...a) => (calls.push(a), { auth: 'k:sig', channel_data: JSON.stringify(a[2]) }) };
  await authorizeQueue(pusher, { socketId: '1.2', channel: 'presence-queue-duo', userId: 7, userInfo: { name: 'Ann' }, rating: 1200, criteria: { mode: 'duo' }, now: 42 });
  assert.deepEqual(calls[0], ['1.2', 'presence-queue-duo', { user_id: '7', user_info: { name: 'Ann', joined_at: 42, rating: 1200, criteria: { mode: 'duo' } } }]);
  await assert.rejects(authorizeQueue(pusher, { socketId: '1', channel: 'private-q', userId: 1 }), /not a presence channel/);
  await assert.rejects(authorizeQueue(pusher, { socketId: '1', channel: 'presence-q', userId: 1, rating: NaN }), /finite number/);
});
