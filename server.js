// Server-side helpers for rooms, for Node backends that use the `pusher`
// package (any object with the same authorizeChannel/get methods works).
//
// The browser never sees the app secret, so two things a lobby needs happen
// in your backend:
//
//   - authorizeRoom() signs the presence subscription. It adds joined_at to
//     user_info, which every client uses to agree on seat order and host,
//     and refuses the subscription when the room is already full.
//   - authorizeQueue() signs a matchmaking queue subscription the same way,
//     with the player's rating and criteria from your own records, so a
//     player cannot change them in the browser.
//   - listRooms() reads the occupied rooms and their member counts from the
//     HTTP API for a room browser.

export class RoomFullError extends Error {
  constructor(channel, capacity, count) {
    super(`room ${channel} is full (${count}/${capacity})`);
    this.name = 'RoomFullError';
    this.status = 403;
    this.channel = channel;
    this.capacity = capacity;
    this.count = count;
  }
}

/**
 * Sign a presence subscription to a room.
 *
 * @param {object} pusher a `pusher` (Node) instance
 * @param {object} req
 * @param {string} req.socketId socket_id from the auth request
 * @param {string} req.channel channel_name from the auth request
 * @param {string} req.userId your user's id
 * @param {object} [req.userInfo] public info the room shows (name, avatar...)
 * @param {number} [req.capacity] refuse when this many members are already in
 * @param {number} [req.now] joined_at to sign, ms since epoch (default Date.now())
 * @returns {Promise<object>} the body to return from the auth endpoint
 * @throws {RoomFullError} when the room has `capacity` members
 */
export async function authorizeRoom(pusher, { socketId, channel, userId, userInfo = {}, capacity, now }) {
  if (!channel.startsWith('presence-') || channel.startsWith('presence-large-')) {
    throw new Error(`authorizeRoom: "${channel}" is not a presence channel`);
  }
  if (capacity != null && Number.isFinite(capacity)) {
    const count = await roomSize(pusher, channel);
    if (count >= capacity) throw new RoomFullError(channel, capacity, count);
  }
  const presence = { user_id: String(userId), user_info: { ...userInfo, joined_at: now ?? Date.now() } };
  const sign = pusher.authorizeChannel ?? pusher.authenticate;
  return sign.call(pusher, socketId, channel, presence);
}

/**
 * Sign a presence subscription to a matchmaking queue (see Queue).
 *
 * @param {object} pusher a `pusher` (Node) instance
 * @param {object} req
 * @param {string} req.socketId socket_id from the auth request
 * @param {string} req.channel channel_name from the auth request, e.g. "presence-queue-duo"
 * @param {string} req.userId your user's id
 * @param {object} [req.userInfo] public info shown to the match (name, avatar...)
 * @param {number} [req.rating] skill rating from your database
 * @param {object} [req.criteria] e.g. { mode: 'duo', region: ['hkg', 'tyo'] }
 * @param {number} [req.now] joined_at to sign, ms since epoch (default Date.now())
 * @returns {Promise<object>} the body to return from the auth endpoint
 */
export async function authorizeQueue(pusher, { socketId, channel, userId, userInfo = {}, rating, criteria, now }) {
  if (!channel.startsWith('presence-') || channel.startsWith('presence-large-')) {
    throw new Error(`authorizeQueue: "${channel}" is not a presence channel`);
  }
  if (rating != null && !(typeof rating === 'number' && Number.isFinite(rating))) {
    throw new Error('authorizeQueue: rating must be a finite number');
  }
  if (criteria != null && (typeof criteria !== 'object' || Array.isArray(criteria))) {
    throw new Error('authorizeQueue: criteria must be an object');
  }
  const info = { ...userInfo, joined_at: now ?? Date.now() };
  if (rating != null) info.rating = rating;
  if (criteria != null) info.criteria = criteria;
  const sign = pusher.authorizeChannel ?? pusher.authenticate;
  return sign.call(pusher, socketId, channel, { user_id: String(userId), user_info: info });
}

/** Member count of one room (0 when nobody is in it). */
export async function roomSize(pusher, channel) {
  const body = await getJSON(pusher, `/channels/${encodeURIComponent(channel)}`, { info: 'user_count' });
  return body.user_count ?? 0;
}

/**
 * Occupied rooms whose channel starts with `prefix`, with member counts:
 * [{id, channel, members}], where id is the channel name without the prefix.
 * Rooms nobody is in are not listed; keep room names, modes and capacity in
 * your own database and merge them with this.
 */
export async function listRooms(pusher, { prefix = 'presence-room-' } = {}) {
  if (!prefix.startsWith('presence-')) throw new Error('listRooms: prefix must start with "presence-"');
  const body = await getJSON(pusher, '/channels', { filter_by_prefix: prefix, info: 'user_count' });
  return Object.entries(body.channels ?? {})
    .map(([channel, info]) => ({ id: channel.slice(prefix.length), channel, members: info.user_count ?? 0 }))
    .sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
}

export { findMatches, allowedRange, criteriaFit } from './match.js';

async function getJSON(pusher, path, params) {
  const res = await pusher.get({ path, params });
  if (res.status && res.status !== 200) throw new Error(`Hibira HTTP API ${path}: ${res.status}`);
  return typeof res.json === 'function' ? res.json() : res;
}
