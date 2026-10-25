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

export default Room;
