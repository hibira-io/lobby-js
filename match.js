// Matching rules for the matchmaking queue, shared by the browser (Queue) and
// backends that want to run matching themselves. Pure functions, no I/O.
//
// A ticket is { id, joinedAt, rating, criteria }:
//   - joinedAt orders the queue: the player who waited longest is matched first;
//   - rating is a number (skill, level, MMR); players match when their ratings
//     are within the allowed range of the longest-waiting player, and that
//     range widens the longer they wait;
//   - criteria is an object such as { mode: 'duo', region: ['hkg', 'tyo'] }.
//     Two tickets fit when every key they both have agrees: equal values, or
//     arrays that share at least one value. A key only one side has is a wildcard.

export const MATCH_DEFAULTS = {
  size: 2,
  minSize: null,
  fillAfter: Infinity,
  ratingRange: Infinity,
  widenBy: 0,
  widenEvery: 5000,
  maxRange: Infinity,
};

/** The rating range a ticket accepts after waiting `waited` ms. */
export function allowedRange(waited, rules = {}) {
  const r = { ...MATCH_DEFAULTS, ...rules };
  const steps = r.widenBy > 0 && r.widenEvery > 0 ? Math.floor(Math.max(0, waited) / r.widenEvery) : 0;
  return Math.min(r.maxRange, r.ratingRange + steps * r.widenBy);
}

/** True when two tickets' criteria agree on every key both have. */
export function criteriaFit(a = {}, b = {}) {
  for (const key of Object.keys(a ?? {})) {
    if (!b || !(key in b)) continue;
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) || Array.isArray(y)) {
      const xs = Array.isArray(x) ? x : [x];
      const ys = Array.isArray(y) ? y : [y];
      if (!xs.some((v) => ys.includes(v))) return false;
    } else if (x !== y) {
      return false;
    }
  }
  return true;
}

/**
 * Group tickets into matches.
 *
 * Tickets are taken oldest first. Each one picks the closest-rated tickets
 * that fit its criteria (and `rules.compatible`, when given) and are within
 * its allowed rating range, until there are `size` players. When there are
 * not enough, a ticket that has waited `fillAfter` ms takes a smaller match of
 * at least `minSize`. Tickets left over stay in the queue.
 *
 * @param {Array<{id: string, joinedAt: number, rating?: number, criteria?: object}>} tickets
 * @param {object} [rules] size, minSize, fillAfter, ratingRange, widenBy, widenEvery, maxRange, compatible(a, b)
 * @param {number} [now=Date.now()]
 * @returns {Array<{players: string[], tickets: object[]}>} players in queue order
 */
export function findMatches(tickets, rules = {}, now = Date.now()) {
  const r = { ...MATCH_DEFAULTS, ...rules };
  const size = Math.max(1, Math.floor(r.size));
  const minSize = Math.max(1, Math.min(size, Math.floor(r.minSize ?? size)));
  const queue = [...tickets].sort(byQueueOrder);
  const taken = new Set();
  const matches = [];

  for (const anchor of queue) {
    if (taken.has(anchor.id)) continue;
    const waited = now - anchor.joinedAt;
    const range = allowedRange(waited, r);
    const candidates = queue
      .filter((t) => t !== anchor && !taken.has(t.id) && fits(anchor, t, range, r))
      .sort((a, b) => Math.abs(rating(a) - rating(anchor)) - Math.abs(rating(b) - rating(anchor)) || byQueueOrder(a, b));

    // Every pair in the group must fit, not only each player and the anchor:
    // { region: 'hkg' } and { region: 'tyo' } can both fit an anchor with no region.
    const group = [anchor];
    for (const c of candidates) {
      if (group.length >= size) break;
      if (group.every((g) => g === anchor || fits(g, c, Infinity, r))) group.push(c);
    }
    const enough = group.length >= size || (waited >= r.fillAfter && group.length >= minSize);
    if (!enough) continue;
    group.sort(byQueueOrder);
    for (const t of group) taken.add(t.id);
    matches.push({ players: group.map((t) => t.id), tickets: group });
  }
  return matches;
}

function fits(a, b, range, r) {
  if (Math.abs(rating(a) - rating(b)) > range) return false;
  if (!criteriaFit(a.criteria, b.criteria)) return false;
  return typeof r.compatible === 'function' ? r.compatible(a, b) !== false : true;
}

function rating(t) {
  return typeof t.rating === 'number' && Number.isFinite(t.rating) ? t.rating : 0;
}

function byQueueOrder(a, b) {
  if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
