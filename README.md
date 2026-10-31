# @hibira-io/lobby

[![npm](https://img.shields.io/npm/v/@hibira-io/lobby)](https://www.npmjs.com/package/@hibira-io/lobby)
[![ci](https://github.com/hibira-io/lobby-js/actions/workflows/ci.yml/badge.svg)](https://github.com/hibira-io/lobby-js/actions/workflows/ci.yml)

Game rooms and lobbies for [pusher-js](https://github.com/pusher/pusher-js)
and Laravel Echo on [Hibira](https://hibira.io), with no game server: seats,
a host, ready flags, room settings, kick, start, room chat with typing
indicators, and a matchmaking queue that groups players by rating and
criteria and moves them into a room together.

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

## Matchmaking queue

`Queue` puts players in a waiting line instead of a room browser. When enough
players fit together, they leave the queue and land in a new match room (a
`Room`) at the same time.

```js
import { Queue } from '@hibira-io/lobby';

const queue = Queue.join(pusher, 'presence-queue-duo', {
  size: 2,          // players per match
  ratingRange: 100, // rating difference allowed at first...
  widenBy: 50,      // ...plus 50 for every 5 s of waiting
  widenEvery: 5000,
  maxRange: 400,
  timeout: 60000,   // give up after a minute
});

queue.on('update', ({ position, count, waited, range }) => showWaiting(position, count));
queue.on('match', ({ room, players }) => {
  // room is a Room on presence-match-<random id>, already joining
  room.on('ready', () => goToRoomScreen(room));
});
queue.on('timeout', () => showNoMatch());

cancelButton.onclick = () => queue.leave();
```

How it works, with no matchmaking server:

- The queue is a presence channel. Your auth endpoint signs each player's
  `joined_at`, `rating` and `criteria` into `user_info`, so players cannot
  change their own rating or jump the line.
- The player who has waited longest hosts the queue. Only the host runs the
  matching rules and announces matches with `client-queue-match`; everyone
  else ignores matches from other members. When the host is matched or
  leaves, the next player in line takes over.
- Players are taken longest wait first. Each picks the closest ratings within
  its range, and the range widens the longer it waits. With
  `minSize` and `fillAfter`, a player who has waited long enough gets a
  smaller match instead of waiting for a full one.
- The match room's name is random, so only the matched players know it.

Every client should use the same matching options; the host's are the ones
that count. The rules also run anywhere else: `findMatches(tickets, rules)`
is a pure function, exported from both `@hibira-io/lobby` and
`@hibira-io/lobby/server`.

| Option | Default | |
|---|---|---|
| `size` | 2 | players per match |
| `minSize` | `size` | smallest match once `fillAfter` has passed |
| `fillAfter` | Infinity | ms of waiting before a smaller match is allowed |
| `ratingRange` | Infinity | rating difference allowed at first |
| `widenBy`, `widenEvery` | 0, 5000 | range grows by `widenBy` every `widenEvery` ms |
| `maxRange` | Infinity | the range never grows past this |
| `compatible(a, b)` | none | extra rule; return false to keep two tickets apart |
| `timeout` | 60000 | ms before `timeout`; Infinity waits forever |
| `interval` | 1000 | ms between matching rounds on the host |
| `roomPrefix` | `presence-match-` | match room channel prefix |
| `autoRoom` | true | join the match room (with `Queue.join`) |
| `roomOptions` | `{}` | options for the match `Room`; `capacity` defaults to the match size |

**Criteria.** Two players fit when every criteria key they both have agrees:
equal values, or arrays that share a value. A key only one of them has does
not matter. `{ mode: 'duo', region: ['hkg', 'tyo'] }` fits
`{ mode: 'duo', region: 'tyo' }` but not `{ mode: 'solo' }`. For modes that
must never mix, a separate queue channel per mode is simpler and keeps each
queue small.

**Server side.** Sign queue subscriptions with `authorizeQueue()`, taking the
rating from your own records, and match rooms with `authorizeRoom()`:

```js
import { authorizeQueue, authorizeRoom } from '@hibira-io/lobby/server';

app.post('/rooms/auth', async (req, res) => {
  const base = { socketId: req.body.socket_id, channel: req.body.channel_name, userId: req.user.id, userInfo: { name: req.user.name } };
  const auth = base.channel.startsWith('presence-queue-')
    ? await authorizeQueue(hibira, { ...base, rating: req.user.rating, criteria: { region: req.user.region } })
    : await authorizeRoom(hibira, base);
  res.json(auth);
});
```

**What it does not do.** The host is a player's browser, so a modified client
could bias the matches it announces (it cannot change anyone's signed
rating). That is fine for casual and party games; for ranked play with
rewards, run `findMatches()` on your own server and send each player their
room with `trigger()` on a private channel. A matched player who closes the tab
at the wrong moment leaves the others in a room that is one short: compare
`room.players` with `match.players` and send everyone back to the queue if
someone does not show up. One queue channel holds up to 100 waiting players
(the presence channel limit); split busy queues by mode or region.

## Limits

These are the server's limits for client events, which the lobby uses:

| | |
|---|---|
| Members per room | presence channel limit (100 on Hibira) |
| Client events | 10 per second per connection; `sendTyping()` sends at most one every 2 s |
| Event size | 4 KB on the Free plan, 10 KB on Hobby and Starter, more on higher plans ([pricing](https://hibira.io/pricing)) |
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

On a queue channel:

| Event | Sent by | Data |
|---|---|---|
| `client-queue-match` | queue host | `{matches: [{id, players: [user_id]}]}`, the room is `presence-match-<id>` |

Queue members' `user_info` carries `joined_at`, `rating` and `criteria`.

## Development

```sh
npm test         # unit tests
npm run test:e2e # against a running server, see test/e2e/
```

## License

MIT
