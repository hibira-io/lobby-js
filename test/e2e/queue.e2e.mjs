// Matchmaking queue end to end against a running Hibira (or any
// Pusher-compatible) server with client events enabled. Same env as
// lobby.e2e.mjs; skipped unless LOBBY_E2E_KEY is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PusherClient from 'pusher-js';
import PusherServer from 'pusher';
import { Queue } from '../../index.js';
import { authorizeQueue, authorizeRoom } from '../../server.js';

const env = process.env;
const skip = !env.LOBBY_E2E_KEY && 'set LOBBY_E2E_KEY to run';
const host = env.LOBBY_E2E_HOST ?? '127.0.0.1';
const port = Number(env.LOBBY_E2E_PORT ?? 8080);
const tls = env.LOBBY_E2E_TLS === '1';

const server = skip
  ? null
  : new PusherServer({ appId: env.LOBBY_E2E_APP_ID, key: env.LOBBY_E2E_KEY, secret: env.LOBBY_E2E_SECRET, host, port: String(port), useTLS: tls });

// One auth endpoint for both channel kinds, like a real backend would have.
function client(userId, rating, criteria) {
  return new PusherClient(env.LOBBY_E2E_KEY, {
    cluster: 'mt1',
    wsHost: host,
    wsPort: port,
    wssPort: port,
    forceTLS: tls,
    enabledTransports: ['ws'],
    channelAuthorization: {
      customHandler: ({ socketId, channelName }, cb) => {
        const req = { socketId, channel: channelName, userId, userInfo: { name: userId } };
        const signed = channelName.startsWith('presence-queue-')
          ? authorizeQueue(server, { ...req, rating, criteria })
          : authorizeRoom(server, req);
        signed.then((auth) => cb(null, auth), (err) => cb(err, null));
      },
    },
  });
}

const once = (emitter, ev) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), 8000);
    const off = emitter.on(ev, (e) => {
      clearTimeout(t);
      off();
      resolve(e);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('queue matches by rating and moves both pairs into their rooms', { skip }, async () => {
  const name = `presence-queue-e2e${Date.now()}`;
  const players = [
    ['ann', 1000],
    ['ben', 2000],
    ['cat', 1050],
    ['dan', 2040],
  ];
  const conns = [];
  const queues = {};
  try {
    for (const [id, rating] of players) {
      const p = client(id, rating, { mode: 'duo' });
      conns.push(p);
      queues[id] = Queue.join(p, name, { size: 2, ratingRange: 100, timeout: 10_000, interval: 200 });
      await once(queues[id], 'ready');
      await sleep(100);
    }
    const matches = Object.fromEntries(
      await Promise.all(Object.entries(queues).map(async ([id, q]) => [id, q.match ?? (await once(q, 'match'))])),
    );
    assert.deepEqual(matches.ann.players.map((p) => p.id), ['ann', 'cat']);
    assert.deepEqual(matches.ben.players.map((p) => p.id), ['ben', 'dan']);
    assert.equal(matches.ann.channel, matches.cat.channel);
    assert.equal(matches.ben.channel, matches.dan.channel);
    assert.notEqual(matches.ann.channel, matches.ben.channel);

    // Both players end up in the same match room.
    const room = matches.cat.room;
    if (room.players.length < 2) await once(room, 'members');
    assert.deepEqual(room.players.map((p) => p.id).sort(), ['ann', 'cat']);
    for (const m of Object.values(matches)) m.room.leave();
  } finally {
    for (const c of conns) c.disconnect();
  }
});

test('queue times out when nobody fits', { skip }, async () => {
  const name = `presence-queue-e2e-to${Date.now()}`;
  const conns = [client('eve', 1000, { mode: 'solo' }), client('fay', 1000, { mode: 'duo' })];
  try {
    const qs = conns.map((p) => Queue.join(p, name, { size: 2, timeout: 1500, interval: 200 }));
    await Promise.all(qs.map((q) => once(q, 'timeout')));
    for (const q of qs) assert.equal(q.status, 'timeout');
  } finally {
    for (const c of conns) c.disconnect();
  }
});
