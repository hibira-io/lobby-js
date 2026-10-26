# @hibira-io/lobby

[![npm](https://img.shields.io/npm/v/@hibira-io/lobby)](https://www.npmjs.com/package/@hibira-io/lobby)
[![ci](https://github.com/hibira-io/lobby-js/actions/workflows/ci.yml/badge.svg)](https://github.com/hibira-io/lobby-js/actions/workflows/ci.yml)

Game rooms and lobbies for [pusher-js](https://github.com/pusher/pusher-js)
and Laravel Echo on [Hibira](https://hibira.io), with no game server: seats,
a host, ready flags, room settings, kick, start, and room chat with typing
indicators.

A room is a presence channel. The member list comes from the channel, and
everything else is a client event (`client-lobby-*`), so it works on any
Pusher-compatible server with client events turned on. Every member orders the
room the same way, by the `joined_at` your auth endpoint signs into
`user_info`, so all clients agree on who the host is and who is seated without
a server deciding it.

Good fits: party and board games, quizzes, card games, watch parties, turn-based
and casual web games. It is not an authoritative game server: clients are
trusted to play fair once the game starts, and chat has no history.

## Install

```sh
npm install @hibira-io/lobby pusher-js
```

Turn on client events for the app in the Hibira portal (App → Settings).

## Client

```js
import Pusher from 'pusher-js';
import { Room } from '@hibira-io/lobby';

const pusher = new Pusher(key, {
  cluster: 'hkg', // required by pusher-js, unused once wsHost is set
  wsHost: 'ws.hibira.io',
  forceTLS: true,
  enabledTransports: ['ws', 'wss'],
  channelAuthorization: { endpoint: '/rooms/auth' },
});

const room = Room.join(pusher, 'presence-room-42', { capacity: 4 });

room.on('ready', ({ players, host }) => render(players, host));
room.on('members', ({ players, joined, left }) => render(players));
room.on('host', ({ host }) => console.log(`${host.info.name} is the host now`));
room.on('settings', ({ settings }) => showSettings(settings));
room.on('message', (m) => addChatLine(m.info.name, m.text, m.mine));
room.on('typing', ({ typing }) => showTyping(typing));
room.on('start', ({ data }) => startGame(data));
room.on('full', () => alert('This room is full'));
room.on('kicked', ({ reason }) => leaveScreen(reason));

room.setReady(true);
room.send('gl hf');
input.oninput = () => room.sendTyping();

if (room.isHost) {
  room.setSettings({ map: 'desert', rounds: 3 });
  room.kick('user-7', 'afk');
  room.start({ seed: 1234 }, { requireAllReady: true });
}

room.players;  // [{ id, info, ready, host, me }] in seat order
room.host;     // the first player
room.allReady; // every player is ready
room.messages; // chat since you joined (last 100)
room.leave();
```

Your own actions are applied locally right away; client events are not echoed
back to the sender. Events only the host may send (settings, kick, start) are
ignored when another member sends them. The server stamps client events with
the sender's `user_id`, so nobody can pretend to be the host.

When the host leaves, the next member in order becomes host and keeps the room
state. New members get the settings, ready flags and phase from the host a
moment after they join.

### Laravel Echo

```js
const room = new Room(Echo.join('room.42').subscription, { capacity: 4 });
```

## Server

The auth endpoint signs `joined_at` into `user_info` and refuses the
subscription when the room is full. For Node with the
[`pusher`](https://www.npmjs.com/package/pusher) package:

```js
import Pusher from 'pusher';
import { authorizeRoom, listRooms, RoomFullError } from '@hibira-io/lobby/server';

const hibira = new Pusher({ appId, key, secret, host: 'ws.hibira.io', useTLS: true });

app.post('/rooms/auth', async (req, res) => {
  try {
    const auth = await authorizeRoom(hibira, {
      socketId: req.body.socket_id,
      channel: req.body.channel_name,
      userId: req.user.id,
      userInfo: { name: req.user.name },
      capacity: 4,
    });
    res.json(auth);
  } catch (err) {
    res.status(err instanceof RoomFullError ? 403 : 500).json({ error: err.message });
  }
});

// Room browser: occupied rooms and their member counts.
app.get('/rooms', async (req, res) => res.json(await listRooms(hibira)));
// → [{ id: '42', channel: 'presence-room-42', members: 3 }]
```

Two players authorized at the same moment can both pass the capacity check. The
room then has one member too many for a moment; every client agrees that the
one who joined last is past capacity, and that client gets `full` and leaves.

Laravel: return `joined_at` from the presence channel callback.

```php
// routes/channels.php
Broadcast::channel('room.{id}', function ($user, $id) {
    return ['id' => $user->id, 'name' => $user->name, 'joined_at' => (int) floor(microtime(true) * 1000)];
});
```

To check capacity, ask the HTTP API for
`GET /apps/{id}/channels/presence-room.{id}?info=user_count` before returning.

### Keeping someone out

`kick()` asks the client to leave, and an honest client does. To keep a member
out for real, refuse them in the auth endpoint and call the HTTP API's
`POST /apps/{id}/users/{user_id}/terminate_connections`.

## Limits

These are the server's limits for client events, which the lobby uses:

| | |
|---|---|
| Members per room | presence channel limit (100 on Hibira) |
| Client events | 10 per second per connection; `sendTyping()` sends at most one every 2 s |
| Event size | 10 KB |
| Billing | each client event counts as one message, however many members receive it |

## Events on the wire

All events are client events on the room's presence channel, so you can read
or send them from other SDKs (Android, iOS, Unity) too.

| Event | Sent by | Data |
|---|---|---|
| `client-lobby-ready` | any member | `{ready}` |
| `client-lobby-settings` | host | `{settings, seq}` |
| `client-lobby-state` | host, to new members | `{settings, ready: {user_id: bool}, phase, seq}` |
| `client-lobby-kick` | host | `{user_id, reason}` |
| `client-lobby-start` | host | `{data, seq}` |
| `client-lobby-chat` | any member | `{id, text, extra?}` |
| `client-lobby-typing` | any member | `{}` |

## Development

```sh
npm test         # unit tests
npm run test:e2e # against a running server, see test/e2e/lobby.e2e.mjs
```

## License

MIT
