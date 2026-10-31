// Matchmaking queue on a Hibira presence channel, with no game server.
//
// A queue is a presence channel (presence-queue-<name>). Players subscribe to
// wait in it; your auth endpoint signs joined_at, rating and criteria into
// user_info (see authorizeQueue in ./server.js), so nobody can change their
// own rating or jump the queue.
//
// The member who has waited longest is the queue's host. Only the host runs
// the matching rules (./match.js) and announces matches with one client event,
// client-queue-match, which the server stamps with the host's user_id. Other
// members ignore matches from anyone else. Every member remembers who has been
// matched, so the next host does not match them again while they leave.
//
// A matched player leaves the queue and, when the queue was opened with
// Queue.join, joins the match room presence-match-<id> as a Room. The id is
// random, so only the matched players know the room's name.

import { Room } from './index.js';
import { findMatches, allowedRange, MATCH_DEFAULTS } from './match.js';

export const QUEUE_EVENT = {
  match: 'client-queue-match',
};

const DEFAULTS = {
  ...MATCH_DEFAULTS,
  timeout: 60000,
  interval: 1000,
  roomPrefix: 'presence-match-',
  autoRoom: true,
  roomOptions: {},
  maxEventBytes: 3000,
  maxEventsPerTick: 3,
  compatible: null,
};

export class Queue {
  /**
   * Subscribe to a queue channel and wait for a match.
   * @param {import('pusher-js').default} pusher
   * @param {string} channelName a presence- channel, e.g. "presence-queue-duo"
   * @param {object} [options] see constructor
   */
  static join(pusher, channelName, options = {}) {
    checkChannel(channelName);
    const queue = new Queue(pusher.subscribe(channelName), options);
    queue._pusher = pusher;
    queue._unsubscribe = () => pusher.unsubscribe(channelName);
    return queue;
  }

  /**
   * Track a pusher-js presence channel used as a queue. Create it right after
   * subscribing so no event is missed. Without Queue.join there is no pusher
   * instance to open the match room with, so "match" only carries its channel.
   *
   * Every client should use the same matching options; the host's are the
   * ones that count.
   *
   * @param {object} channel pusher-js PresenceChannel
   * @param {object} [options]
   * @param {number} [options.size=2] players per match
   * @param {number} [options.minSize=size] smallest match once fillAfter has passed
   * @param {number} [options.fillAfter=Infinity] ms before a smaller match is allowed
   * @param {number} [options.ratingRange=Infinity] rating difference allowed at first
   * @param {number} [options.widenBy=0] added to the range every widenEvery ms of waiting
   * @param {number} [options.widenEvery=5000]
   * @param {number} [options.maxRange=Infinity] the range never grows past this
   * @param {function} [options.compatible] (a, b) => boolean, extra rule on two tickets
   * @param {number} [options.timeout=60000] ms before giving up ("timeout"); Infinity waits forever
   * @param {number} [options.interval=1000] ms between matching rounds on the host
   * @param {string} [options.roomPrefix="presence-match-"] match room channel prefix
   * @param {boolean} [options.autoRoom=true] join the match room (Queue.join only)
   * @param {object} [options.roomOptions] options for the match Room
   */
  constructor(channel, options = {}) {
    const o = { ...DEFAULTS, ...options };
    this.channel = channel;
    this.name = channel.name;
    this.options = o;
    /** This connection's member id (null until subscribed). */
    this.myID = null;
    this.ready = false;
    /** "waiting", then "matched", "timeout" or "left". */
    this.status = 'waiting';
    /** The match, once found: {id, channel, players, room}. */
    this.match = null;
    this._members = new Map();
    this._claimed = new Set();
    this._handlers = new Map();
    this._host = null;
    this._timer = null;
    this._timeout = null;
    this._pusher = null;
    this._unsubscribe = null;
    this._left = false;

    this._bindings = [
      ['pusher:subscription_succeeded', (m) => this._snapshot(m)],
      ['pusher:member_added', (m) => this._added(m)],
      ['pusher:member_removed', (m) => this._removed(m)],
      [QUEUE_EVENT.match, (d, meta) => this._onMatch(d, meta)],
    ];
    for (const [ev, fn] of this._bindings) channel.bind(ev, fn);
    if (channel.subscribed && channel.members && channel.members.count) {
      this._snapshot(channel.members);
    }
  }

  /** Register a handler; returns a function that removes it. Events: ready, update, match, timeout, error. */
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this._handlers.get(event) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        if (event === 'error') throw err;
        this._emit('error', err);
      }
    }
  }

  // ---- reading the queue -------------------------------------------------

  /** Players still waiting (matched players on their way out excluded), longest wait first. */
  get tickets() {
    return this._ordered()
      .filter((id) => !this._claimed.has(id))
      .map((id) => ticket(id, this._members.get(id)));
  }

  /** Players waiting, yourself included. */
  get count() {
    return this.tickets.length;
  }

  /** Your place in the queue, 1 for the longest wait; null before subscription or after a match. */
  get position() {
    const i = this.tickets.findIndex((t) => t.id === this.myID);
    return i < 0 ? null : i + 1;
  }

  /** Your own ticket, as the host sees it. */
  get myTicket() {
    return this.myID != null && this._members.has(this.myID) ? ticket(this.myID, this._members.get(this.myID)) : null;
  }

  /** ms you have waited, by your signed joined_at. */
  get waited() {
    const t = this.myTicket;
    return t && t.joinedAt !== Number.MAX_SAFE_INTEGER ? Math.max(0, Date.now() - t.joinedAt) : 0;
  }

  /** The rating range you currently accept. */
  get range() {
    return allowedRange(this.waited, this.options);
  }

  get isHost() {
    return this.myID != null && this._host === this.myID;
  }

  _ordered() {
    return [...this._members.keys()].sort((a, b) => {
      const ta = joinedAt(this._members.get(a));
      const tb = joinedAt(this._members.get(b));
      if (ta !== tb) return ta - tb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  // ---- actions -----------------------------------------------------------

  /** Leave the queue without a match. */
  leave() {
    this._close('left');
  }

  _close(status) {
    if (this._left) return;
    this._left = true;
    if (this.status === 'waiting') this.status = status;
    for (const [ev, fn] of this._bindings) this.channel.unbind(ev, fn);
    clearInterval(this._timer);
    clearTimeout(this._timeout);
    if (this._unsubscribe) this._unsubscribe();
    this._handlers.clear();
  }

  // ---- presence ----------------------------------------------------------

  _snapshot(members) {
    this._members = new Map(Object.entries(members.members ?? {}));
    this.myID = members.myID ?? null;
    this.ready = true;
    this._recompute();
    const timeout = this.options.timeout;
    if (Number.isFinite(timeout) && timeout >= 0) {
      this._timeout = setTimeout(() => this._onTimeout(), timeout);
      this._timeout.unref?.();
    }
    this._emit('ready', this._updateEvent());
    this._tick();
  }

  _added(m) {
    this._members.set(m.id, m.info ?? null);
    this._claimed.delete(m.id);
    this._recompute();
    this._emit('update', this._updateEvent());
    this._tick();
  }

  _removed(m) {
    this._members.delete(m.id);
    this._claimed.delete(m.id);
    this._recompute();
    this._emit('update', this._updateEvent());
  }

  _recompute() {
    const wasHost = this.isHost;
    this._host = this._ordered()[0] ?? null;
    if (this.isHost && !wasHost) {
      this._timer = setInterval(() => this._tick(), this.options.interval);
      this._timer.unref?.();
    } else if (!this.isHost && wasHost) {
      clearInterval(this._timer);
    }
  }

  _updateEvent() {
    return { position: this.position, count: this.count, waited: this.waited, range: this.range, host: this.isHost };
  }

  // ---- matching (host only) ----------------------------------------------

  _tick() {
    if (this._left || !this.ready || !this.isHost) return;
    const o = this.options;
    const found = findMatches(this.tickets, o, Date.now()).map((m) => ({ id: randomID(), players: m.players }));
    if (!found.length) return;

    // One client event per batch keeps each event well under the 4 KB Free
    // plan limit; a few batches per round stay under the client event rate limit.
    const batches = [];
    let batch = [];
    for (const m of found) {
      if (batch.length && JSON.stringify({ matches: [...batch, m] }).length > o.maxEventBytes) {
        batches.push(batch);
        batch = [];
      }
      batch.push(m);
    }
    if (batch.length) batches.push(batch);

    for (const b of batches.slice(0, o.maxEventsPerTick)) {
      if (!this.channel.trigger(QUEUE_EVENT.match, { matches: b })) {
        this._emit('error', new Error(`Queue: could not send ${QUEUE_EVENT.match} (not connected?)`));
        return;
      }
      // Our own event is not echoed back, so apply it here too.
      this._applyMatches(b);
      if (this._left) return;
    }
  }

  // ---- client events -----------------------------------------------------

  _onMatch(d, meta) {
    if (meta?.user_id == null || meta.user_id !== this._host) return;
    this._applyMatches(parse(d).matches);
  }

  _applyMatches(matches) {
    if (!Array.isArray(matches)) return;
    let mine = null;
    for (const m of matches) {
      if (!m || typeof m.id !== 'string' || !Array.isArray(m.players)) continue;
      // A player already claimed by an earlier match cannot be in a second one.
      if (m.players.some((id) => this._claimed.has(id))) continue;
      for (const id of m.players) this._claimed.add(id);
      if (mine == null && m.players.includes(this.myID)) mine = m;
    }
    if (mine) {
      this._matched(mine);
    } else {
      this._emit('update', this._updateEvent());
    }
  }

  _matched(m) {
    if (this.status !== 'waiting' || this._left) return;
    this.status = 'matched';
    clearTimeout(this._timeout);
    const channel = this.options.roomPrefix + m.id;
    const players = m.players.map((id) => ({ id, info: this._members.get(id) ?? null, me: id === this.myID }));
    let room = null;
    if (this._pusher && this.options.autoRoom) {
      room = Room.join(this._pusher, channel, { capacity: players.length, ...this.options.roomOptions });
    }
    this.match = { id: m.id, channel, players, room };
    this._emit('match', this.match);
    this._close('matched');
  }

  _onTimeout() {
    if (this.status !== 'waiting' || this._left) return;
    this.status = 'timeout';
    this._emit('timeout', { waited: this.waited });
    this._close('timeout');
  }
}

function checkChannel(channelName) {
  if (!channelName.startsWith('presence-') || channelName.startsWith('presence-large-')) {
    throw new Error(`Queue: "${channelName}" is not a presence channel (presence-large- channels do not allow client events)`);
  }
}

function ticket(id, info) {
  const i = info && typeof info === 'object' ? info : {};
  return {
    id,
    joinedAt: joinedAt(i),
    rating: typeof i.rating === 'number' && Number.isFinite(i.rating) ? i.rating : 0,
    criteria: i.criteria && typeof i.criteria === 'object' ? i.criteria : {},
    info: info ?? null,
  };
}

function joinedAt(info) {
  const t = info && typeof info === 'object' ? info.joined_at : undefined;
  return typeof t === 'number' && Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

function parse(d) {
  if (typeof d === 'string') {
    try {
      return JSON.parse(d) ?? {};
    } catch {
      return {};
    }
  }
  return d ?? {};
}

function randomID() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export default Queue;
