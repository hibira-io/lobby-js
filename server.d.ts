export class RoomFullError extends Error {
  readonly status: 403;
  readonly channel: string;
  readonly capacity: number;
  readonly count: number;
}

/** The parts of the `pusher` Node client these helpers use. */
export interface PusherLike {
  authorizeChannel?(socketId: string, channel: string, data?: any): any;
  authenticate?(socketId: string, channel: string, data?: any): any;
  get(opts: { path: string; params?: Record<string, any> }): Promise<any>;
}

export interface AuthorizeRoomRequest {
  socketId: string;
  channel: string;
  userId: string | number;
  userInfo?: Record<string, any>;
  capacity?: number;
  now?: number;
}

export function authorizeRoom(pusher: PusherLike, req: AuthorizeRoomRequest): Promise<{ auth: string; channel_data?: string }>;
export function roomSize(pusher: PusherLike, channel: string): Promise<number>;
export function listRooms(
  pusher: PusherLike,
  options?: { prefix?: string },
): Promise<{ id: string; channel: string; members: number }[]>;
