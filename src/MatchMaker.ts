import { merge } from './Utils';

import { Client, generateId, isValidId } from './index';
import { IpcProtocol, send } from './Protocol';

import { RegisteredHandler } from './matchmaker/RegisteredHandler';
import { Room, RoomAvailable, RoomConstructor } from './Room';

import { LocalPresence } from './presence/LocalPresence';
import { Presence } from './presence/Presence';

import { debugAndPrintError, debugMatchMaking } from './Debug';
import { MatchMakeError } from './Errors';

export type ClientOptions = any;

export interface RoomWithScore {
  roomId: string;
  score: number;
}

// remote room call timeouts
export const REMOTE_ROOM_SHORT_TIMEOUT = Number(process.env.COLYSEUS_PRESENCE_SHORT_TIMEOUT || 4000);
export const REMOTE_ROOM_LARGE_TIMEOUT = Number(process.env.COLYSEUS_PRESENCE_LARGE_TIMEOUT || 8000);

export class MatchMaker {
  public handlers: {[id: string]: RegisteredHandler} = {};

  private localRooms: {[roomId: string]: Room} = {};
  private presence: Presence;

  private isGracefullyShuttingDown: boolean = false;

  constructor(presence?: Presence) {
    this.presence = presence || new LocalPresence();
  }

  public async connectToRoom(client: Client, roomId: string) {
    const room = this.localRooms[roomId];
    const clientOptions = client.options;

    // assign sessionId to socket connection.
    client.sessionId = await this.presence.get(`${roomId}:${client.id}`);

    // clean temporary data
    delete clientOptions.auth;
    delete clientOptions.requestId;
    delete client.options;

    if (room) {
      (room as any)._onJoin(client, clientOptions, client.auth);

    } else {
      const remoteSessionSub = `${roomId}:${client.sessionId}`;

      this.presence.subscribe(remoteSessionSub, (message) => {
        const [method, data] = message;

        if (method === 'send') {
          send(client, new Buffer(data), false);

        } else if (method === 'close') {
          client.close(data || undefined);
        }
      });

      await this.remoteRoomCall(roomId, '_onJoin', [{
        id: client.id,
        remote: true,
        sessionId: client.sessionId,
      }, clientOptions, client.auth]);

      // forward 'message' events to room's process
      client.on('message', (data: Buffer | ArrayBuffer) => {
        // compatibility with uws
        if (data instanceof ArrayBuffer) { data = new Buffer(data); }

        this.remoteRoomCall(roomId, '_emitOnClient', [client.sessionId, Array.from(data as Buffer)]);
      });

      // forward 'close' events to room's process
      client.once('close', (code) => {
        this.presence.unsubscribe(remoteSessionSub);
        this.remoteRoomCall(roomId, '_emitOnClient', [client.sessionId, 'close', code]);
      });
    }
  }

  /**
   * Create or joins the client into a particular room
   *
   * The client doesn't join instantly because this method is called from the
   * match-making process. The client will request a new WebSocket connection
   * to effectively join into the room created/joined by this method.
   */
  public async onJoinRoomRequest(client: Client, roomToJoin: string, clientOptions: ClientOptions): Promise<string> {
    const hasHandler = this.hasHandler(roomToJoin);
    let roomId: string;

    // `rejoin` requests come with a pre-set `sessionId`
    const isReconnect = (clientOptions.sessionId !== undefined);
    const sessionId: string = clientOptions.sessionId || generateId();

    const isJoinById: boolean = (!hasHandler && isValidId(roomToJoin));
    let shouldCreateRoom = hasHandler && !isReconnect;

    if (isReconnect) {
      roomToJoin = await this.presence.get(sessionId);

      if (!roomToJoin) {
        throw new MatchMakeError(`rejoin has been expired for ${sessionId}`);
      }
    }

    if (isJoinById || isReconnect) {
      // join room by id
      roomId = await this.joinById(roomToJoin, clientOptions, isReconnect && sessionId);

    } else if (!hasHandler) {
      throw new MatchMakeError(`Failed to join invalid room "${roomToJoin}"`);
    }

    if (!roomId && !isReconnect) {
      // when multiple clients request to create a room simultaneously, we need
      // to wait for the first room to be created to prevent creating multiple of them
      await this.awaitRoomAvailable(roomToJoin);

      // check if there's an existing room with provided name available to join
      const availableRoomsByScore = await this.getAvailableRoomByScore(roomToJoin, clientOptions);

      for (let i = 0, l = availableRoomsByScore.length; i < l; i++) {
        roomId = await this.joinById(availableRoomsByScore[i].roomId, clientOptions);

        // couldn't join this room, skip
        if (!roomId) {
          continue;
        }

        if (await this.remoteRoomCall(roomId, '_reserveSeat', [{
          id: client.id,
          sessionId,
        }])) {
          // seat reservation was successful, no need to try other rooms.
          shouldCreateRoom = false;
          break;

        } else {
          shouldCreateRoom = true;
        }
      }
    }

    // if couldn't join a room by its id, let's try to create a new one
    if (shouldCreateRoom) {
      roomId = await this.create(roomToJoin, clientOptions);
    }

    if (!roomId) {
      throw new MatchMakeError(`Failed to join invalid room "${roomToJoin}"`);

    } else if (shouldCreateRoom || isJoinById) {
      const reserveSeatSuccessful = await this.remoteRoomCall(roomId, '_reserveSeat', [{
        id: client.id,
        sessionId,
      }]);

      if (!reserveSeatSuccessful) {
        throw new MatchMakeError('join_request_fail');
      }
    }

    return roomId;
  }

  public async remoteRoomCall(
    roomId: string,
    method: string,
    args?: any[],
    rejectionTimeout = REMOTE_ROOM_SHORT_TIMEOUT,
  ) {
    const room = this.localRooms[roomId];

    if (!room) {
      return new Promise((resolve, reject) => {
        let unsubscribeTimeout: NodeJS.Timer;

        const requestId = generateId();
        const channel = `${roomId}:${requestId}`;

        const unsubscribe = () => {
          this.presence.unsubscribe(channel);
          clearTimeout(unsubscribeTimeout);
        };

        this.presence.subscribe(channel, (message) => {
          const [code, data] = message;
          if (code === IpcProtocol.SUCCESS) {
            resolve(data);

          } else if (code === IpcProtocol.ERROR) {
            reject(data);
          }
          unsubscribe();
        });

        this.presence.publish(this.getRoomChannel(roomId), [method, requestId, args]);

        unsubscribeTimeout = setTimeout(() => {
          unsubscribe();

          const request = `${method}${ args && ' with args ' + JSON.stringify(args) || '' }`;
          reject(new Error(`remote room (${roomId}) timed out, requesting "${request}". ` +
            `Timeout setting: ${rejectionTimeout}ms`));
        }, rejectionTimeout);
      });

    } else {
      if (!args && typeof(room[method]) !== 'function') {
        return room[method];
      }

      return room[method].apply(room, args);
    }
  }

  public async registerHandler(name: string, klass: RoomConstructor, options: any = {}) {
    const registeredHandler = new RegisteredHandler(klass, options);

    this.handlers[ name ] = registeredHandler;

    await this.cleanupStaleRooms(name);

    return registeredHandler;
  }

  public hasHandler(name: string) {
    return this.handlers[ name ] !== undefined;
  }

  public async joinById(roomId: string, clientOptions: ClientOptions, rejoinSessionId?: string): Promise<string> {
    const exists = await this.presence.exists(this.getRoomChannel(roomId));

    if (!exists) {
      debugMatchMaking(`trying to join non-existant room "${ roomId }"`);
      return;

    } else if (rejoinSessionId && await this.remoteRoomCall(roomId, 'hasReservedSeat', [rejoinSessionId])) {
      return roomId;

    } else if (await this.remoteRoomCall(roomId, 'hasReachedMaxClients')) {
      debugMatchMaking(`room "${ roomId }" reached maxClients.`);
      return;

    } else if (!(await this.remoteRoomCall(roomId, 'requestJoin', [clientOptions, false]))) {
      debugMatchMaking(`can't join room "${ roomId }" with options: ${ JSON.stringify(clientOptions) }`);
      return;
    }

    return roomId;
  }

  public async getAvailableRoomByScore(roomName: string, clientOptions: ClientOptions): Promise<RoomWithScore[]> {
    return (await this.getRoomsWithScore(roomName, clientOptions)).
      sort((a, b) => b.score - a.score);
  }

  public async create(roomName: string, clientOptions: ClientOptions): Promise<string> {
    const registeredHandler = this.handlers[ roomName ];
    const room = new registeredHandler.klass();

    // set room public attributes
    room.roomId = generateId();
    room.roomName = roomName;
    room.presence = this.presence;

    if (room.onInit) {
      await room.onInit(merge({}, clientOptions, registeredHandler.options));
    }

    // imediatelly ask client to join the room
    if ( room.requestJoin(clientOptions, true) ) {
      debugMatchMaking('spawning \'%s\' (%s) on process %d', roomName, room.roomId, process.pid);

      room.on('lock', this.lockRoom.bind(this, roomName, room));
      room.on('unlock', this.unlockRoom.bind(this, roomName, room));
      room.on('join', this.onClientJoinRoom.bind(this, room));
      room.on('leave', this.onClientLeaveRoom.bind(this, room));
      room.once('dispose', this.disposeRoom.bind(this, roomName, room));

      // room always start unlocked
      await this.createRoomReferences(room, true);

      registeredHandler.emit('create', room);

      return room.roomId;

    } else {
      (room as any)._dispose();

      throw new MatchMakeError(`Failed to auto-create room "${roomName}" during ` +
        `join request using options "${JSON.stringify(clientOptions)}"`);
    }
  }

  public async getAvailableRooms(
    roomName: string,
    roomMethodName: string = 'getAvailableData',
  ): Promise<RoomAvailable[]> {
    const roomIds = await this.presence.smembers(roomName);
    const availableRooms: RoomAvailable[] = [];

    await Promise.all(roomIds.map(async (roomId) => {
      let availability: RoomAvailable;

      try {
        availability = await this.remoteRoomCall(roomId, roomMethodName);

      } catch (e) {
        // room did not respond
      }

      if (availability) {
        availableRooms.push(availability);
      }

      return true;
    }));

    return availableRooms;
  }

  public async getAllRooms(
    roomName: string,
    roomMethodName: string = 'getAvailableData',
  ): Promise<RoomAvailable[]> {
    const roomIds = await this.presence.smembers(`a_${roomName}`);
    const rooms: RoomAvailable[] = [];

    await Promise.all(roomIds.map(async (roomId) => {
      let availability: RoomAvailable;

      try {
        availability = await this.remoteRoomCall(roomId, roomMethodName);

      } catch (e) {
        // room did not respond
      }

      if (availability) {
        rooms.push(availability);
      }

      return true;
    }));

    return rooms;
  }

  // used only for testing purposes
  public getRoomById(roomId: string) {
    return this.localRooms[roomId];
  }

  public gracefullyShutdown(): Promise<any> {
    if (this.isGracefullyShuttingDown) {
      return Promise.reject(false);
    }

    this.isGracefullyShuttingDown = true;

    const promises = [];

    for (const roomId in this.localRooms) {
      if (!this.localRooms.hasOwnProperty(roomId)) {
        continue;
      }

      const room = this.localRooms[roomId];
      promises.push( room.disconnect() );
    }

    return Promise.all(promises);
  }

  protected async cleanupStaleRooms(roomName: string) {
    //
    // clean-up possibly stale room ids
    // (ungraceful shutdowns using Redis can result on stale room ids still on memory.)
    //
    const roomIds = await this.presence.smembers(`a_${roomName}`);

    // remove connecting counts
    await this.presence.del(this.getHandlerConcurrencyKey(roomName));

    await Promise.all(roomIds.map(async (roomId) => {
      try {
        // use hardcoded short timeout for cleaning up stale rooms.
        await this.remoteRoomCall(roomId, 'roomId');

      } catch (e) {
        debugMatchMaking(`cleaning up stale room '${roomName}' (${roomId})`);
        this.clearRoomReferences({roomId, roomName} as Room);
        this.presence.srem(`a_${roomName}`, roomId);
      }
    }));
  }

  protected async getRoomsWithScore(roomName: string, clientOptions: ClientOptions): Promise<RoomWithScore[]> {
    const roomsWithScore: RoomWithScore[] = [];
    const roomIds = await this.presence.smembers(roomName);
    const remoteRequestJoins = [];

    await Promise.all(roomIds.map(async (roomId) => {
      let maxClientsReached: boolean;

      try {
        maxClientsReached = await this.remoteRoomCall(roomId, 'hasReachedMaxClients');

      } catch (e) {
        // room did not responded.
        maxClientsReached = true;
      }

      // check maxClients before requesting to join.
      if (maxClientsReached) { return; }

      const localRoom = this.localRooms[roomId];
      if (!localRoom) {
        remoteRequestJoins.push(new Promise(async (resolve, reject) => {
          const score = await this.remoteRoomCall(roomId, 'requestJoin', [clientOptions, false]);
          resolve({ roomId, score });
        }));

      } else {
        roomsWithScore.push({
          roomId,
          score: localRoom.requestJoin(clientOptions, false) as number,
        });
      }

      return true;
    }));

    return (await Promise.all(remoteRequestJoins)).concat(roomsWithScore);
  }

  protected async createRoomReferences(room: Room, init: boolean = false): Promise<boolean> {
    this.localRooms[room.roomId] = room;

    // add unlocked room reference
    await this.presence.sadd(room.roomName, room.roomId);

    if (init) {
      // add alive room reference (a=all)
      await this.presence.sadd(`a_${room.roomName}`, room.roomId);

      await this.presence.subscribe(this.getRoomChannel(room.roomId), (message) => {
        const [method, requestId, args] = message;

        const reply = (data) => {
          this.presence.publish(`${room.roomId}:${requestId}`, data);
        };

        // reply with property value
        if (!args && typeof (room[method]) !== 'function') {
          return reply([IpcProtocol.SUCCESS, room[method]]);
        }

        // reply with method result
        let response: any;
        try {
          response = room[method].apply(room, args);

        } catch (e) {
          debugAndPrintError(e.stack || e);
          return reply([IpcProtocol.ERROR, e.message || e]);
        }

        if (!(response instanceof Promise)) {
          return reply([IpcProtocol.SUCCESS, response]);
        }

        response.
          then((result) => reply([IpcProtocol.SUCCESS, result])).
          catch((e) => {
            // user might have called `reject()` without arguments.
            const err = e && e.message || e;
            reply([IpcProtocol.ERROR, err]);
          });
      });
    }

    return true;
  }

  protected clearRoomReferences(room: Room) {
    this.presence.srem(room.roomName, room.roomId);

    // clear list of connecting clients.
    this.presence.del(room.roomId);
  }

  protected async awaitRoomAvailable(roomToJoin: string) {
      const key = this.getHandlerConcurrencyKey(roomToJoin);
      const concurrency = await this.presence.incr(key) - 1;

      this.presence.decr(key);

      if (concurrency > 0) {
        // avoid having too long timeout if 10+ clients ask to join at the same time
        const concurrencyTimeout = Math.min(concurrency * 100, REMOTE_ROOM_SHORT_TIMEOUT);

        debugMatchMaking(
          'receiving %d concurrent requests for joining \'%s\' (waiting %d ms)',
          concurrency, roomToJoin, concurrencyTimeout,
        );

        return await new Promise((resolve, reject) => setTimeout(resolve, concurrencyTimeout));
      } else {
        return true;
      }
  }

  protected getRoomChannel(roomId: string) {
    return `$${roomId}`;
  }

  protected getHandlerConcurrencyKey(name: string) {
    return `${name}:c`;
  }

  private onClientJoinRoom(room: Room, client: Client) {
    this.handlers[room.roomName].emit('join', room, client);
  }

  private onClientLeaveRoom(room: Room, client: Client) {
    this.handlers[room.roomName].emit('leave', room, client);
  }

  private lockRoom(roomName: string, room: Room): void {
    this.clearRoomReferences(room);

    // emit public event on registered handler
    this.handlers[room.roomName].emit('lock', room);
  }

  private async unlockRoom(roomName: string, room: Room) {
    if (await this.createRoomReferences(room)) {

      // emit public event on registered handler
      this.handlers[room.roomName].emit('unlock', room);
    }
  }

  private disposeRoom(roomName: string, room: Room): void {
    debugMatchMaking('disposing \'%s\' (%s) on process %d', roomName, room.roomId, process.pid);

    // emit disposal on registered session handler
    this.handlers[roomName].emit('dispose', room);

    // remove from alive rooms
    this.presence.srem(`a_${roomName}`, room.roomId);

    // remove concurrency key
    this.presence.del(this.getHandlerConcurrencyKey(roomName));

    // remove from available rooms
    this.clearRoomReferences(room);

    // unsubscribe from remote connections
    this.presence.unsubscribe(this.getRoomChannel(room.roomId));

    // remove actual room reference
    delete this.localRooms[room.roomId];
  }

}
