// Room lobby for pusher-js and Laravel Echo on Hibira presence channels.
//
// A room is a presence channel (presence-room-<id> by default). Nothing runs
// on the server besides what every Pusher-compatible server already does:
//
//   - members come from the presence channel;
//   - ready flags, settings, kicks, start and chat are client events
//     (client-lobby-*), so the app needs client events turned on;
//   - every member orders the room the same way, by the joined_at your auth
//     endpoint signs into user_info (see ./server.js), then by user id. The
//     first member is the host, and members past `capacity` are told the
//     room is full;
//   - the host sends a snapshot (settings, ready flags, phase) to new
//     members, and the next host already has one when the host leaves.
//
// Client events are not echoed back to the sender, so the room applies your
// own actions locally. Events that only the host may send are ignored when
// they come from anyone else; the server stamps client events on presence
// channels with the sender's user_id, so a member cannot pretend to be host.

const EVENT = {
  state: 'client-lobby-state',
  ready: 'client-lobby-ready',
  settings: 'client-lobby-settings',
  kick: 'client-lobby-kick',
  start: 'client-lobby-start',
  chat: 'client-lobby-chat',
  typing: 'client-lobby-typing',
};

const DEFAULTS = {
  capacity: Infinity,
  leaveWhenFull: true,
  maxMessages: 100,
  typingTimeout: 4000,
  stateDelay: 150,
};

export class Room {
  /**
   * Subscribe to a room channel and track it.
   * @param {import('pusher-js').default} pusher
   * @param {string} channelName a presence- channel, e.g. "presence-room-42"
   * @param {object} [options] see constructor
   */
  static join(pusher, channelName, options = {}) {
    if (!channelName.startsWith('presence-') || channelName.startsWith('presence-large-')) {
      throw new Error(`Room: "${channelName}" is not a presence channel (presence-large- channels do not allow client events)`);
    }
    const room = new Room(pusher.subscribe(channelName), options);
    room._unsubscribe = () => pusher.unsubscribe(channelName);
    return room;
  }

  /**
   * Track a pusher-js presence channel, e.g.
   * `new Room(Echo.join('room.42').subscription)`. Create it right after
   * subscribing so no event is missed.
   * @param {object} channel pusher-js PresenceChannel
   * @param {object} [options]
   * @param {number} [options.capacity=Infinity] seats; members past it are full
   * @param {boolean} [options.leaveWhenFull=true] leave on "full"
   * @param {number} [options.maxMessages=100] chat messages kept in `messages`
   * @param {number} [options.typingTimeout=4000] ms a typing signal lasts
   */
  constructor(channel, options = {}) {
    const o = { ...DEFAULTS, ...options };
    this.channel = channel;
    this.name = channel.name;
    this.capacity = o.capacity;
    this.leaveWhenFull = o.leaveWhenFull;
    this.maxMessages = o.maxMessages;
    this.typingTimeout = o.typingTimeout;
    this.stateDelay = o.stateDelay;
    /** This connection's member id (null until subscribed). */
    this.myID = null;
    this.ready = false;
    /** "waiting" until the host calls start(), then "started". */
    this.phase = 'waiting';
    /** Room settings; only the host changes them. */
    this.settings = {};
    /** Chat messages received since joining, oldest first. */
    this.messages = [];
    this._members = new Map(); // id -> info
    this._ready = new Map(); // id -> boolean
    this._typing = new Map(); // id -> timer
    this._handlers = new Map();
    this._host = null;
    this._full = false;
    this._seq = 0;
    this._stateTimer = null;
    this._lastTyping = 0;
    this._unsubscribe = null;
    this._left = false;

    this._bindings = [
      ['pusher:subscription_succeeded', (m) => this._snapshot(m)],
      ['pusher:member_added', (m) => this._added(m)],
      ['pusher:member_removed', (m) => this._removed(m)],
      [EVENT.state, (d, meta) => this._onState(d, meta)],
      [EVENT.ready, (d, meta) => this._onReady(d, meta)],
      [EVENT.settings, (d, meta) => this._onSettings(d, meta)],
      [EVENT.kick, (d, meta) => this._onKick(d, meta)],
      [EVENT.start, (d, meta) => this._onStart(d, meta)],
      [EVENT.chat, (d, meta) => this._onChat(d, meta)],
      [EVENT.typing, (d, meta) => this._onTyping(d, meta)],
    ];
    for (const [ev, fn] of this._bindings) channel.bind(ev, fn);
    if (channel.subscribed && channel.members && channel.members.count) {
      this._snapshot(channel.members);
    }
  }

  /**
   * Register a handler; returns a function that removes it. Events: ready,
   * members, host, settings, start, message, typing, kicked, full, error.
   */
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

  // ---- reading the room --------------------------------------------------

  /** Seated members in room order: [{id, info, ready, host, me}]. */
  get players() {
    return this._ordered().slice(0, this.capacity).map((id) => this._member(id));
  }

  /** Members past capacity, in room order (normally empty, briefly not after a join race). */
  get waiting() {
    return this._ordered().slice(this.capacity).map((id) => this._member(id));
  }

  /** The host member, or null before subscription. */
  get host() {
    return this._host == null ? null : this._member(this._host);
  }

  get isHost() {
    return this.myID != null && this._host === this.myID;
  }

  /** The current user's member, or null before subscription. */
  get me() {
    return this.myID == null || !this._members.has(this.myID) ? null : this._member(this.myID);
  }

  /** True when there is at least one player and every player is ready. */
  get allReady() {
    const p = this.players;
    return p.length > 0 && p.every((m) => m.ready);
  }

  /** User ids currently typing (yourself excluded). */
  get typing() {
    return [...this._typing.keys()];
  }

  _member(id) {
    return { id, info: this._members.get(id) ?? null, ready: this._ready.get(id) === true, host: id === this._host, me: id === this.myID };
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

  /** Mark yourself ready or not ready. */
  setReady(ready = true) {
    this._requireJoined();
    ready = !!ready;
    this._ready.set(this.myID, ready);
    this._trigger(EVENT.ready, { ready });
    this._emit('members', this._membersEvent());
  }

  /** Host only: merge `patch` into the room settings. */
  setSettings(patch) {
    this._requireHost('setSettings');
    this.settings = { ...this.settings, ...patch };
    this._trigger(EVENT.settings, { settings: this.settings, seq: ++this._seq });
    this._emit('settings', { settings: this.settings, by: this.myID });
  }

  /**
   * Host only: ask a member to leave. The kicked client leaves by itself; to
   * keep a member out for real, refuse them in your auth endpoint and call
   * the HTTP API's terminate_connections for that user.
   */
  kick(userId, reason) {
    this._requireHost('kick');
    if (userId === this.myID) throw new Error('Room: the host cannot kick themselves');
    this._trigger(EVENT.kick, { user_id: userId, reason: reason ?? null });
  }

  /**
   * Host only: start the game. `data` reaches every member's "start"
   * handler (yours too), e.g. a server URL or a seed. With
   * `{requireAllReady: true}` it throws unless every player is ready.
   */
  start(data = null, { requireAllReady = false } = {}) {
    this._requireHost('start');
    if (requireAllReady && !this.allReady) throw new Error('Room: not every player is ready');
    this.phase = 'started';
    this._trigger(EVENT.start, { data, seq: ++this._seq });
    this._emit('start', { data, by: this.myID });
  }

  /** Send a chat message to the room; returns the message as stored locally. */
  send(text, extra) {
    this._requireJoined();
    const msg = { id: randomID(), text: String(text), ...(extra === undefined ? {} : { extra }) };
    this._trigger(EVENT.chat, msg);
    clearTypingTimer(this._typing, this.myID);
    return this._pushMessage(msg, this.myID);
  }

  /** Tell the room you are typing; call it on every keystroke, it sends at most every typingTimeout/2 ms. */
  sendTyping() {
    this._requireJoined();
    const now = Date.now();
    if (now - this._lastTyping < this.typingTimeout / 2) return;
    this._lastTyping = now;
    this._trigger(EVENT.typing, {});
  }

  /** Stop tracking and unsubscribe (when Room.join created the subscription). */
  leave() {
    if (this._left) return;
    this._left = true;
    for (const [ev, fn] of this._bindings) this.channel.unbind(ev, fn);
    clearTimeout(this._stateTimer);
    for (const t of this._typing.values()) clearTimeout(t);
    this._typing.clear();
    if (this._unsubscribe) this._unsubscribe();
    this._handlers.clear();
  }

  _requireJoined() {
    if (!this.ready || this._left) throw new Error('Room: not joined yet');
  }

  _requireHost(what) {
    this._requireJoined();
    if (!this.isHost) throw new Error(`Room: only the host can ${what}()`);
  }

  _trigger(event, data) {
    if (!this.channel.trigger(event, data)) {
      this._emit('error', new Error(`Room: could not send ${event} (not connected?)`));
    }
  }

  // ---- presence ----------------------------------------------------------

  _snapshot(members) {
    // pusher-js passes its Members object: .members is the user_id -> info
    // hash and .myID our own id.
    this._members = new Map(Object.entries(members.members ?? {}));
    this.myID = members.myID ?? null;
    this.ready = true;
    this._recompute();
    this._emit('ready', this._membersEvent());
    this._checkFull();
  }

  _added(m) {
    this._members.set(m.id, m.info ?? null);
    this._recompute();
    this._emit('members', { ...this._membersEvent(), joined: this._member(m.id) });
    if (this.isHost) this._scheduleState();
    // Two members authorized at nearly the same time can both pass a
    // capacity check; the one that joined later is the one past capacity.
    this._checkFull();
  }

  _removed(m) {
    const gone = this._member(m.id);
    this._members.delete(m.id);
    this._ready.delete(m.id);
    clearTypingTimer(this._typing, m.id);
    this._recompute();
    this._emit('members', { ...this._membersEvent(), left: gone });
    // A member leaving can free a seat, but it never makes anyone full.
  }

  _recompute() {
    const prev = this._host;
    const order = this._ordered();
    this._host = order[0] ?? null;
    if (prev !== null && prev !== this._host) this._emit('host', { host: this.host, previous: prev });
  }

  _checkFull() {
    if (this._full || this.myID == null) return;
    if (this._ordered().indexOf(this.myID) >= this.capacity) {
      this._full = true;
      this._emit('full', { capacity: this.capacity });
      if (this.leaveWhenFull) this.leave();
    }
  }

  _membersEvent() {
    return { players: this.players, waiting: this.waiting, host: this.host };
  }

  _scheduleState() {
    clearTimeout(this._stateTimer);
    this._stateTimer = setTimeout(() => {
      if (!this._left && this.isHost) {
        this._trigger(EVENT.state, {
          settings: this.settings,
          ready: Object.fromEntries(this._ready),
          phase: this.phase,
          seq: this._seq,
        });
      }
    }, this.stateDelay);
    this._stateTimer.unref?.();
  }

  // ---- client events -----------------------------------------------------

  _fromHost(meta) {
    return meta?.user_id != null && meta.user_id === this._host;
  }

  _onState(d, meta) {
    if (!this._fromHost(meta)) return;
    d = parse(d);
    if (typeof d.seq === 'number' && d.seq < this._seq) return;
    this._seq = d.seq ?? this._seq;
    this.settings = d.settings ?? {};
    this.phase = d.phase ?? this.phase;
    for (const [id, r] of Object.entries(d.ready ?? {})) {
      if (id !== this.myID && this._members.has(id)) this._ready.set(id, r === true);
    }
    this._emit('settings', { settings: this.settings, by: meta.user_id });
    this._emit('members', this._membersEvent());
  }

  _onReady(d, meta) {
    if (meta?.user_id == null || !this._members.has(meta.user_id)) return;
    this._ready.set(meta.user_id, parse(d).ready === true);
    this._emit('members', this._membersEvent());
  }

  _onSettings(d, meta) {
    if (!this._fromHost(meta)) return;
    d = parse(d);
    this._seq = Math.max(this._seq, d.seq ?? 0);
    this.settings = d.settings ?? {};
    this._emit('settings', { settings: this.settings, by: meta.user_id });
  }

  _onKick(d, meta) {
    if (!this._fromHost(meta)) return;
    d = parse(d);
    if (d.user_id !== this.myID) return;
    this._emit('kicked', { by: meta.user_id, reason: d.reason ?? null });
    this.leave();
  }

  _onStart(d, meta) {
    if (!this._fromHost(meta)) return;
    d = parse(d);
    this._seq = Math.max(this._seq, d.seq ?? 0);
    this.phase = 'started';
    this._emit('start', { data: d.data ?? null, by: meta.user_id });
  }

  _onChat(d, meta) {
    if (meta?.user_id == null) return;
    d = parse(d);
    if (typeof d.text !== 'string') return;
    clearTypingTimer(this._typing, meta.user_id);
    this._pushMessage(d, meta.user_id);
  }

  _onTyping(_d, meta) {
    const id = meta?.user_id;
    if (id == null || id === this.myID || !this._members.has(id)) return;
    const had = this._typing.has(id);
    clearTimeout(this._typing.get(id));
    const t = setTimeout(() => {
      this._typing.delete(id);
      this._emit('typing', { typing: this.typing });
    }, this.typingTimeout);
    t.unref?.();
    this._typing.set(id, t);
    if (!had) this._emit('typing', { typing: this.typing });
  }

  _pushMessage(d, from) {
    const msg = {
      id: typeof d.id === 'string' ? d.id : randomID(),
      from,
      info: this._members.get(from) ?? null,
      text: d.text,
      extra: d.extra ?? null,
      at: Date.now(),
      mine: from === this.myID,
    };
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) this.messages.splice(0, this.messages.length - this.maxMessages);
    this._emit('message', msg);
    return msg;
  }
}

function clearTypingTimer(map, id) {
  if (!map.has(id)) return;
  clearTimeout(map.get(id));
  map.delete(id);
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
  if (c?.randomUUID) return c.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export default Room;
