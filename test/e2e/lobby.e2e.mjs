// End-to-end test against a running Hibira (or any Pusher-compatible) server
// with client events enabled. Skipped unless LOBBY_E2E_KEY is set:
//
//   LOBBY_E2E_HOST=127.0.0.1 LOBBY_E2E_PORT=8080 LOBBY_E2E_TLS=0 \
//   LOBBY_E2E_APP_ID=lobby LOBBY_E2E_KEY=... LOBBY_E2E_SECRET=... npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PusherClient from 'pusher-js';
import PusherServer from 'pusher';
import { Room } from '../../index.js';
import { authorizeRoom, listRooms, RoomFullError } from '../../server.js';

const env = process.env;
const skip = !env.LOBBY_E2E_KEY && 'set LOBBY_E2E_KEY to run';
const host = env.LOBBY_E2E_HOST ?? '127.0.0.1';
const port = Number(env.LOBBY_E2E_PORT ?? 8080);
const tls = env.LOBBY_E2E_TLS === '1';

const server = skip
  ? null
  : new PusherServer({ appId: env.LOBBY_E2E_APP_ID, key: env.LOBBY_E2E_KEY, secret: env.LOBBY_E2E_SECRET, host, port: String(port), useTLS: tls });

function client(userId, name, capacity) {
  const pusher = new PusherClient(env.LOBBY_E2E_KEY, {
    cluster: 'mt1',
    wsHost: host,
    wsPort: port,
    wssPort: port,
    forceTLS: tls,
    enabledTransports: ['ws'],
    channelAuthorization: {
      customHandler: ({ socketId, channelName }, cb) =>
        authorizeRoom(server, { socketId, channel: channelName, userId, userInfo: { name }, capacity })
          .then((auth) => cb(null, auth), (err) => cb(err, null)),
    },
  });
  return pusher;
}

const once = (room, ev, pred = () => true) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), 5000);
    const off = room.on(ev, (e) => {
      if (!pred(e)) return;
      clearTimeout(t);
      off();
      resolve(e);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('lobby round trip on a real server', { skip }, async () => {
  const name = `presence-room-e2e${Date.now()}`;
  const conns = [];
  try {
    const pa = client('alice', 'Alice', 2);
    conns.push(pa);
    const a = Room.join(pa, name, { capacity: 2, stateDelay: 50 });
    await once(a, 'ready');
    assert.equal(a.isHost, true);
    a.setSettings({ map: 'snow' });
    await sleep(50);

    const pb = client('bob', 'Bob', 2);
    conns.push(pb);
    const b = Room.join(pb, name, { capacity: 2 });
    await once(b, 'ready');
    // The host notices Bob and sends him the current settings.
    const settings = await once(b, 'settings');
    assert.deepEqual(settings.settings, { map: 'snow' });
    assert.equal(b.host.id, 'alice');
    assert.equal(b.host.info.name, 'Alice');

    // Room is full now: the auth endpoint refuses a third member.
    await assert.rejects(authorizeRoom(server, { socketId: '1.1', channel: name, userId: 'carol', capacity: 2 }), RoomFullError);
    const rooms = await listRooms(server, { prefix: 'presence-room-e2e' });
    assert.ok(rooms.some((r) => r.channel === name && r.members === 2));

    // Ready flags and chat cross the wire with the sender's user_id.
    const readySeen = once(a, 'members', (e) => e.players.some((p) => p.id === 'bob' && p.ready));
    b.setReady(true);
    await readySeen;
    a.setReady(true);
    await once(b, 'members', () => b.allReady);
    const msg = once(a, 'message', (m) => !m.mine);
    b.send('gl hf');
    assert.deepEqual([(await msg).from, (await msg).text], ['bob', 'gl hf']);

    // Only the host can start; the start reaches Bob.
    const started = once(b, 'start');
    a.start({ seed: 42 }, { requireAllReady: true });
    assert.deepEqual((await started).data, { seed: 42 });

    // Host leaves: Bob takes over.
    const newHost = once(b, 'host');
    a.leave();
    assert.equal((await newHost).host.id, 'bob');
    assert.equal(b.isHost, true);
    b.leave();
  } finally {
    for (const c of conns) c.disconnect();
  }
});
