# Changelog

## 0.2.0

Matchmaking queue. `Queue` waits on a presence channel, matches players by
rating (with a range that widens while they wait) and criteria, gives up after
a timeout, and moves matched players into a new `Room` on
`presence-match-<id>`. The longest-waiting player runs the matching and
announces it with the `client-queue-match` client event, so no server changes
are needed. New server helper `authorizeQueue()` signs the rating and
criteria into `user_info`, and the matching rules are exported as the pure
functions `findMatches()`, `allowedRange()` and `criteriaFit()`.

## 0.1.1

The package homepage on npm now links to https://hibira.io. No code changes.

## 0.1.0

First release: `Room` for pusher-js and Laravel Echo (seats, host, ready flags,
settings, kick, start, room chat and typing) and the `@hibira-io/lobby/server`
helpers `authorizeRoom()`, `roomSize()` and `listRooms()`.
