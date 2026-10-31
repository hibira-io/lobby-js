import type Pusher from 'pusher-js';

export interface Member<Info = any> {
  id: string;
  info: Info | null;
  ready: boolean;
  host: boolean;
  me: boolean;
}

export interface MembersEvent<Info = any> {
  players: Member<Info>[];
  waiting: Member<Info>[];
  host: Member<Info> | null;
  joined?: Member<Info>;
  left?: Member<Info>;
}

export interface ChatMessage<Info = any> {
  id: string;
  from: string;
  info: Info | null;
  text: string;
  extra: any;
  at: number;
  mine: boolean;
}

export interface RoomEvents<Info = any, Settings = Record<string, any>> {
  ready: MembersEvent<Info>;
  members: MembersEvent<Info>;
  host: { host: Member<Info>; previous: string };
  settings: { settings: Settings; by: string };
  start: { data: any; by: string };
  message: ChatMessage<Info>;
  typing: { typing: string[] };
  kicked: { by: string; reason: string | null };
  full: { capacity: number };
  error: Error;
}

export interface RoomOptions {
  /** Seats; members past it get "full". Default Infinity. */
  capacity?: number;
  /** Leave the room on "full". Default true. */
  leaveWhenFull?: boolean;
  /** Chat messages kept in `messages`. Default 100. */
  maxMessages?: number;
  /** How long a typing signal lasts, in ms. Default 4000. */
  typingTimeout?: number;
}

export class Room<Info = any, Settings extends Record<string, any> = Record<string, any>> {
  static join<Info = any, Settings extends Record<string, any> = Record<string, any>>(
    pusher: Pusher,
    channelName: string,
    options?: RoomOptions,
  ): Room<Info, Settings>;
  constructor(channel: any, options?: RoomOptions);

  readonly channel: any;
  readonly name: string;
  readonly capacity: number;
  myID: string | null;
  ready: boolean;
  phase: 'waiting' | 'started';
  settings: Settings;
  messages: ChatMessage<Info>[];

  readonly players: Member<Info>[];
  readonly waiting: Member<Info>[];
  readonly host: Member<Info> | null;
  readonly isHost: boolean;
  readonly me: Member<Info> | null;
  readonly allReady: boolean;
  readonly typing: string[];

  on<K extends keyof RoomEvents<Info, Settings>>(event: K, fn: (e: RoomEvents<Info, Settings>[K]) => void): () => void;
  off<K extends keyof RoomEvents<Info, Settings>>(event: K, fn: (e: RoomEvents<Info, Settings>[K]) => void): void;

  setReady(ready?: boolean): void;
  setSettings(patch: Partial<Settings>): void;
  kick(userId: string, reason?: string): void;
  start(data?: any, options?: { requireAllReady?: boolean }): void;
  send(text: string, extra?: any): ChatMessage<Info>;
  sendTyping(): void;
  leave(): void;
}

export interface Ticket<Info = any> {
  id: string;
  joinedAt: number;
  rating?: number;
  criteria?: Record<string, any>;
  info?: Info | null;
}

export interface MatchRules<Info = any> {
  /** Players per match. Default 2. */
  size?: number;
  /** Smallest match allowed once a player has waited fillAfter ms. Default size. */
  minSize?: number | null;
  /** ms before a match smaller than size is allowed. Default Infinity. */
  fillAfter?: number;
  /** Rating difference allowed at first. Default Infinity. */
  ratingRange?: number;
  /** Added to the range every widenEvery ms of waiting. Default 0. */
  widenBy?: number;
  /** Default 5000. */
  widenEvery?: number;
  /** The range never grows past this. Default Infinity. */
  maxRange?: number;
  /** Extra rule on two tickets; return false when they must not play together. */
  compatible?: ((a: Ticket<Info>, b: Ticket<Info>) => boolean) | null;
}

export interface QueueOptions<Info = any> extends MatchRules<Info> {
  /** ms before giving up with "timeout"; Infinity waits forever. Default 60000. */
  timeout?: number;
  /** ms between matching rounds on the host. Default 1000. */
  interval?: number;
  /** Match room channel prefix. Default "presence-match-". */
  roomPrefix?: string;
  /** Join the match room as a Room (Queue.join only). Default true. */
  autoRoom?: boolean;
  /** Options for the match Room; capacity defaults to the match size. */
  roomOptions?: RoomOptions;
}

export interface QueueUpdate {
  position: number | null;
  count: number;
  waited: number;
  range: number;
  host: boolean;
}

export interface Match<Info = any, Settings extends Record<string, any> = Record<string, any>> {
  id: string;
  /** The match room's presence channel, e.g. "presence-match-<id>". */
  channel: string;
  /** Matched players in queue order. */
  players: { id: string; info: Info | null; me: boolean }[];
  /** The match room, already joining (null without Queue.join or with autoRoom: false). */
  room: Room<Info, Settings> | null;
}

export interface QueueEvents<Info = any> {
  ready: QueueUpdate;
  update: QueueUpdate;
  match: Match<Info>;
  timeout: { waited: number };
  error: Error;
}

export class Queue<Info = any> {
  static join<Info = any>(pusher: Pusher, channelName: string, options?: QueueOptions<Info>): Queue<Info>;
  constructor(channel: any, options?: QueueOptions<Info>);

  readonly channel: any;
  readonly name: string;
  myID: string | null;
  ready: boolean;
  status: 'waiting' | 'matched' | 'timeout' | 'left';
  match: Match<Info> | null;

  readonly tickets: Ticket<Info>[];
  readonly count: number;
  readonly position: number | null;
  readonly myTicket: Ticket<Info> | null;
  readonly waited: number;
  readonly range: number;
  readonly isHost: boolean;

  on<K extends keyof QueueEvents<Info>>(event: K, fn: (e: QueueEvents<Info>[K]) => void): () => void;
  off<K extends keyof QueueEvents<Info>>(event: K, fn: (e: QueueEvents<Info>[K]) => void): void;
  leave(): void;
}

export const QUEUE_EVENT: { match: 'client-queue-match' };

export function findMatches<Info = any>(
  tickets: Ticket<Info>[],
  rules?: MatchRules<Info>,
  now?: number,
): { players: string[]; tickets: Ticket<Info>[] }[];
export function allowedRange(waited: number, rules?: MatchRules): number;
export function criteriaFit(a?: Record<string, any>, b?: Record<string, any>): boolean;

export default Room;
