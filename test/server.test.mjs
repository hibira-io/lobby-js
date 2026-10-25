import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRoom, listRooms, roomSize, RoomFullError } from '../server.js';

// A stand-in for the `pusher` Node client: get() answers from a table and
// authorizeChannel() echoes what it was asked to sign.
function fakePusher(responses) {
  const calls = [];
  return {
    calls,
    async get({ path, params }) {
      calls.push([path, params]);
      const body = responses[path];
      if (body === undefined) return { status: 404, json: async () => ({}) };
      return { status: 200, json: async () => body };
    },
    authorizeChannel(socketId, channel, data) {
      return { auth: `key:sig(${socketId},${channel})`, channel_data: JSON.stringify(data) };
    },
  };
}

test('authorizeRoom signs joined_at into user_info', async () => {
  const p = fakePusher({});
  const res = await authorizeRoom(p, { socketId: '1.2', channel: 'presence-room-9', userId: 42, userInfo: { name: 'Ann' }, now: 1000 });
  assert.deepEqual(JSON.parse(res.channel_data), { user_id: '42', user_info: { name: 'Ann', joined_at: 1000 } });
  assert.equal(p.calls.length, 0);
});

test('authorizeRoom refuses a full room', async () => {
  const p = fakePusher({ '/channels/presence-room-9': { occupied: true, user_count: 4 } });
  await assert.rejects(
    authorizeRoom(p, { socketId: '1.2', channel: 'presence-room-9', userId: 'u', capacity: 4 }),
    (err) => err instanceof RoomFullError && err.status === 403 && err.count === 4,
  );
  const ok = await authorizeRoom(p, { socketId: '1.2', channel: 'presence-room-9', userId: 'u', capacity: 5 });
  assert.ok(ok.auth);
  assert.deepEqual(p.calls[0], ['/channels/presence-room-9', { info: 'user_count' }]);
});

test('authorizeRoom refuses channels that are not rooms', async () => {
  const p = fakePusher({});
  await assert.rejects(authorizeRoom(p, { socketId: '1', channel: 'private-x', userId: 'u' }));
  await assert.rejects(authorizeRoom(p, { socketId: '1', channel: 'presence-large-x', userId: 'u' }));
});

test('roomSize is 0 for an empty room', async () => {
  assert.equal(await roomSize(fakePusher({ '/channels/presence-room-1': { occupied: false } }), 'presence-room-1'), 0);
});

test('listRooms strips the prefix and sorts', async () => {
  const p = fakePusher({
    '/channels': { channels: { 'presence-room-b': { user_count: 1 }, 'presence-room-a': { user_count: 3 } } },
  });
  assert.deepEqual(await listRooms(p), [
    { id: 'a', channel: 'presence-room-a', members: 3 },
    { id: 'b', channel: 'presence-room-b', members: 1 },
  ]);
  assert.deepEqual(p.calls[0], ['/channels', { filter_by_prefix: 'presence-room-', info: 'user_count' }]);
  await assert.rejects(listRooms(p, { prefix: 'private-' }));
});

test('HTTP errors surface', async () => {
  await assert.rejects(roomSize(fakePusher({}), 'presence-room-x'), /404/);
});
