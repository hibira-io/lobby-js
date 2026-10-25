import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../index.js';

// A stand-in for a pusher-js presence channel: bind/unbind, trigger (recorded)
// and a way to emit events with pusher-js's (data, metadata) arguments.
function fakeChannel(name = 'presence-room-1') {
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

const info = (t, name) => ({ joined_at: t, name });

function joined(members, myID, options) {
  const ch = fakeChannel();
  const room = new Room(ch, options);
  ch.emit('pusher:subscription_succeeded', { members, myID, count: Object.keys(members).length });
  return { ch, room };
}

test('seats and host follow joined_at, then user id', () => {
  const { room } = joined({ c: info(30), a: info(10), b: info(10), x: null }, 'b');
  assert.deepEqual(room.players.map((p) => p.id), ['a', 'b', 'c', 'x']);
  assert.equal(room.host.id, 'a');
  assert.equal(room.isHost, false);
  assert.equal(room.me.id, 'b');
});

test('host leaving hands the room to the next member', () => {
  const { ch, room } = joined({ a: info(1), b: info(2) }, 'b');
  const hosts = [];
  room.on('host', (e) => hosts.push([e.previous, e.host.id]));
  ch.emit('pusher:member_removed', { id: 'a', info: info(1) });
  assert.equal(room.isHost, true);
  assert.deepEqual(hosts, [['a', 'b']]);
});

test('ready flags: own change is local and sent, others come from events', () => {
  const { ch, room } = joined({ a: info(1), b: info(2) }, 'a');
  room.setReady(true);
  assert.deepEqual(ch.sent.at(-1), ['client-lobby-ready', { ready: true }]);
  assert.equal(room.allReady, false);
  ch.emit('client-lobby-ready', { ready: true }, { user_id: 'b' });
  assert.equal(room.allReady, true);
  ch.emit('client-lobby-ready', { ready: true }, { user_id: 'stranger' });
  assert.equal(room.players.length, 2);
});

test('host-only events from a non-host are ignored', () => {
  const { ch, room } = joined({ a: info(1), b: info(2), c: info(3) }, 'c');
  const starts = [];
  room.on('start', (e) => starts.push(e));
  ch.emit('client-lobby-start', { data: 'evil' }, { user_id: 'b' });
  ch.emit('client-lobby-settings', { settings: { map: 'evil' } }, { user_id: 'b' });
  ch.emit('client-lobby-kick', { user_id: 'c' }, { user_id: 'b' });
  assert.equal(starts.length, 0);
  assert.deepEqual(room.settings, {});
  assert.equal(room.phase, 'waiting');
  ch.emit('client-lobby-start', { data: { seed: 7 }, seq: 1 }, { user_id: 'a' });
  assert.deepEqual(starts, [{ data: { seed: 7 }, by: 'a' }]);
  assert.equal(room.phase, 'started');
});

test('host actions throw for non-hosts and work for the host', () => {
  const { ch, room } = joined({ a: info(1), b: info(2) }, 'a');
  room.setSettings({ map: 'desert' });
  room.setSettings({ rounds: 3 });
  assert.deepEqual(room.settings, { map: 'desert', rounds: 3 });
  assert.throws(() => room.start(null, { requireAllReady: true }), /not every player is ready/);
  room.kick('b', 'afk');
  assert.deepEqual(ch.sent.at(-1), ['client-lobby-kick', { user_id: 'b', reason: 'afk' }]);
  room.start({ url: 'wss://game' });
  assert.equal(room.phase, 'started');

  const other = joined({ a: info(1), b: info(2) }, 'b').room;
  assert.throws(() => other.setSettings({}), /only the host/);
  assert.throws(() => other.start(), /only the host/);
  assert.throws(() => other.kick('a'), /only the host/);
});

test('the host sends new members a snapshot of the room', async () => {
  const { ch, room } = joined({ a: info(1), b: info(2) }, 'a', { stateDelay: 5 });
  room.setSettings({ map: 'snow' });
  ch.emit('client-lobby-ready', { ready: true }, { user_id: 'b' });
  ch.emit('pusher:member_added', { id: 'c', info: info(3) });
  await new Promise((r) => setTimeout(r, 20));
  const [ev, state] = ch.sent.at(-1);
  assert.equal(ev, 'client-lobby-state');
  assert.deepEqual(state, { settings: { map: 'snow' }, ready: { b: true }, phase: 'waiting', seq: 1 });

  // ...and the new member applies it.
  const late = joined({ a: info(1), b: info(2), c: info(3) }, 'c');
  late.ch.emit('client-lobby-state', state, { user_id: 'a' });
  assert.deepEqual(late.room.settings, { map: 'snow' });
  assert.equal(late.room.players.find((p) => p.id === 'b').ready, true);
  room.leave();
});

test('a member past capacity is told the room is full and leaves', () => {
  const ch = fakeChannel();
  let unsubscribed = 0;
  const pusher = { subscribe: () => ch, unsubscribe: () => unsubscribed++ };
  const room = Room.join(pusher, 'presence-room-1', { capacity: 2 });
  const full = [];
  room.on('full', (e) => full.push(e));
  ch.emit('pusher:subscription_succeeded', { members: { a: info(1), me: info(2) }, myID: 'me' });
  assert.equal(full.length, 0);
  // Someone authorized just before us shows up after we joined: we are now third.
  ch.emit('pusher:member_added', { id: 'z', info: info(1.5) });
  assert.deepEqual(full, [{ capacity: 2 }]);
  assert.equal(unsubscribed, 1);
});

test('waiting lists members past capacity', () => {
  const { room } = joined({ a: info(1), b: info(2), c: info(3) }, 'a', { capacity: 2 });
  assert.deepEqual(room.players.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(room.waiting.map((p) => p.id), ['c']);
});

test('kicked member leaves', () => {
  const ch = fakeChannel();
  let unsubscribed = 0;
  const room = Room.join({ subscribe: () => ch, unsubscribe: () => unsubscribed++ }, 'presence-room-1');
  const kicked = [];
  room.on('kicked', (e) => kicked.push(e));
  ch.emit('pusher:subscription_succeeded', { members: { a: info(1), me: info(2) }, myID: 'me' });
  ch.emit('client-lobby-kick', { user_id: 'someone-else' }, { user_id: 'a' });
  assert.equal(kicked.length, 0);
  ch.emit('client-lobby-kick', { user_id: 'me', reason: 'afk' }, { user_id: 'a' });
  assert.deepEqual(kicked, [{ by: 'a', reason: 'afk' }]);
  assert.equal(unsubscribed, 1);
  assert.equal(ch.handlers.get('client-lobby-chat').size, 0);
});

test('chat: own messages are local, others arrive with sender info', () => {
  const { ch, room } = joined({ a: info(1, 'Ann'), b: info(2, 'Bo') }, 'a', { maxMessages: 2 });
  const got = [];
  room.on('message', (m) => got.push(m));
  const mine = room.send('hi');
  assert.equal(ch.sent.at(-1)[0], 'client-lobby-chat');
  assert.equal(ch.sent.at(-1)[1].text, 'hi');
  assert.equal(mine.mine, true);
  ch.emit('client-lobby-chat', JSON.stringify({ id: 'm2', text: 'yo' }), { user_id: 'b' });
  ch.emit('client-lobby-chat', { id: 'm3', text: 'gl' }, { user_id: 'b' });
  ch.emit('client-lobby-chat', { id: 'bad' }, { user_id: 'b' });
  assert.deepEqual(got.map((m) => [m.from, m.text]), [['a', 'hi'], ['b', 'yo'], ['b', 'gl']]);
  assert.equal(got[1].info.name, 'Bo');
  assert.deepEqual(room.messages.map((m) => m.id), ['m2', 'm3']);
});

test('typing is throttled when sending and expires when received', async () => {
  const { ch, room } = joined({ a: info(1), b: info(2) }, 'a', { typingTimeout: 30 });
  room.sendTyping();
  room.sendTyping();
  assert.equal(ch.sent.filter(([e]) => e === 'client-lobby-typing').length, 1);

  const seen = [];
  room.on('typing', (e) => seen.push(e.typing));
  ch.emit('client-lobby-typing', {}, { user_id: 'b' });
  ch.emit('client-lobby-typing', {}, { user_id: 'b' });
  assert.deepEqual(room.typing, ['b']);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, [['b'], []]);
  ch.emit('client-lobby-typing', {}, { user_id: 'b' });
  ch.emit('client-lobby-chat', { text: 'done' }, { user_id: 'b' });
  assert.deepEqual(room.typing, []);
  room.leave();
});

test('actions before joining throw; failed sends emit error', () => {
  const ch = fakeChannel();
  const room = new Room(ch);
  assert.throws(() => room.send('x'), /not joined/);
  ch.emit('pusher:subscription_succeeded', { members: { a: info(1) }, myID: 'a' });
  const errors = [];
  room.on('error', (e) => errors.push(e));
  ch.connected = false;
  room.send('x');
  assert.equal(errors.length, 1);
});

test('join refuses non-presence and presence-large channels', () => {
  const pusher = { subscribe: () => fakeChannel() };
  assert.throws(() => Room.join(pusher, 'private-room-1'));
  assert.throws(() => Room.join(pusher, 'presence-large-room-1'));
});
