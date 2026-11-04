import { MatchRoomDoc, RoomPlayerDoc } from '../types/game';

const TOPIC_PREFIX = 'haxarena2d/d9371ec7_v2';
const ROOMS_WILDCARD = `${TOPIC_PREFIX}/rooms/+`;
const PLAYERS_WILDCARD = `${TOPIC_PREFIX}/players/+/+`;

const BROKER_URLS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeVarLen(len: number): number[] {
  const bytes: number[] = [];
  let x = len;
  do {
    let encodedByte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) {
      encodedByte |= 128;
    }
    bytes.push(encodedByte);
  } while (x > 0);
  return bytes;
}

function encodeMqttString(str: string): Uint8Array {
  const utf8 = encoder.encode(str);
  const out = new Uint8Array(2 + utf8.length);
  out[0] = (utf8.length >> 8) & 0xff;
  out[1] = utf8.length & 0xff;
  out.set(utf8, 2);
  return out;
}

function buildConnectPacket(clientId: string): Uint8Array {
  const protoName = encodeMqttString('MQTT');
  const clientIdBytes = encodeMqttString(clientId);
  // Protocol level 4 (MQTT 3.1.1), Connect Flags 0x02 (Clean Session), KeepAlive 30s
  const varHeader = new Uint8Array([
    ...protoName,
    0x04,
    0x02,
    0x00,
    0x1e,
  ]);
  const remLen = varHeader.length + clientIdBytes.length;
  const remLenBytes = encodeVarLen(remLen);
  const pkt = new Uint8Array(1 + remLenBytes.length + remLen);
  pkt[0] = 0x10;
  pkt.set(remLenBytes, 1);
  pkt.set(varHeader, 1 + remLenBytes.length);
  pkt.set(clientIdBytes, 1 + remLenBytes.length + varHeader.length);
  return pkt;
}

function buildSubscribePacket(packetId: number, topics: string[]): Uint8Array {
  const topicChunks: Uint8Array[] = [];
  let payloadLen = 0;
  for (const t of topics) {
    const tb = encodeMqttString(t);
    const chunk = new Uint8Array(tb.length + 1);
    chunk.set(tb, 0);
    chunk[tb.length] = 0x00; // QoS 0
    topicChunks.push(chunk);
    payloadLen += chunk.length;
  }
  const remLen = 2 + payloadLen;
  const remLenBytes = encodeVarLen(remLen);
  const pkt = new Uint8Array(1 + remLenBytes.length + remLen);
  pkt[0] = 0x82;
  pkt.set(remLenBytes, 1);
  let offset = 1 + remLenBytes.length;
  pkt[offset++] = (packetId >> 8) & 0xff;
  pkt[offset++] = packetId & 0xff;
  for (const c of topicChunks) {
    pkt.set(c, offset);
    offset += c.length;
  }
  return pkt;
}

function buildPublishPacket(
  topic: string,
  payloadBytes: Uint8Array,
  retain: boolean
): Uint8Array {
  const topicBytes = encodeMqttString(topic);
  const remLen = topicBytes.length + payloadBytes.length;
  const remLenBytes = encodeVarLen(remLen);
  const pkt = new Uint8Array(1 + remLenBytes.length + remLen);
  pkt[0] = 0x30 | (retain ? 0x01 : 0x00); // QoS 0
  pkt.set(remLenBytes, 1);
  pkt.set(topicBytes, 1 + remLenBytes.length);
  pkt.set(payloadBytes, 1 + remLenBytes.length + topicBytes.length);
  return pkt;
}

export type SyncedRoomRecord = MatchRoomDoc & {
  updatedAtMs: number;
  actorUid?: string;
};

export type SyncedPlayerRecord = RoomPlayerDoc & {
  updatedAtMs: number;
};

class RealtimeMultiplayerBroker {
  private rooms = new Map<string, SyncedRoomRecord>();
  private players = new Map<string, Record<string, SyncedPlayerRecord>>();
  private deletedRoomIds = new Map<string, number>();
  private listeners = new Set<(roomId?: string) => void>();
  private sockets: Array<{
    url: string;
    ws: WebSocket | null;
    connected: boolean;
    rxBuf: Uint8Array;
    pingTimer: number | null;
    reconnectTimer: number | null;
  }> = [];
  private started = false;

  public start() {
    if (this.started || typeof window === 'undefined' || !('WebSocket' in window)) {
      return;
    }
    this.started = true;

    for (const url of BROKER_URLS) {
      const entry = {
        url,
        ws: null as WebSocket | null,
        connected: false,
        rxBuf: new Uint8Array(0),
        pingTimer: null as number | null,
        reconnectTimer: null as number | null,
      };
      this.sockets.push(entry);
      this.connectBroker(entry);
    }
  }

  private connectBroker(entry: (typeof this.sockets)[number]) {
    if (entry.reconnectTimer) {
      window.clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    try {
      const ws = new WebSocket(entry.url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      entry.ws = ws;
      entry.connected = false;
      entry.rxBuf = new Uint8Array(0);

      ws.onopen = () => {
        const clientId = `hax_${Math.random().toString(36).slice(2, 11)}`;
        try {
          const pkt = buildConnectPacket(clientId);
          ws.send(pkt.buffer.slice(pkt.byteOffset, pkt.byteOffset + pkt.byteLength) as ArrayBuffer);
        } catch {
          // ignore
        }
      };

      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const incoming = new Uint8Array(ev.data);
        const merged = new Uint8Array(entry.rxBuf.length + incoming.length);
        merged.set(entry.rxBuf, 0);
        merged.set(incoming, entry.rxBuf.length);
        entry.rxBuf = merged;
        this.processBuffer(entry);
      };

      ws.onclose = () => {
        entry.connected = false;
        if (entry.pingTimer) {
          window.clearInterval(entry.pingTimer);
          entry.pingTimer = null;
        }
        entry.reconnectTimer = window.setTimeout(() => {
          this.connectBroker(entry);
        }, 2500);
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      };
    } catch {
      entry.reconnectTimer = window.setTimeout(() => {
        this.connectBroker(entry);
      }, 3000);
    }
  }

  private processBuffer(entry: (typeof this.sockets)[number]) {
    while (entry.rxBuf.length >= 2) {
      const byte0 = entry.rxBuf[0];
      let multiplier = 1;
      let remLen = 0;
      let idx = 1;
      let encodedByte = 0;

      do {
        if (idx >= entry.rxBuf.length) {
          return; // wait for more bytes
        }
        encodedByte = entry.rxBuf[idx++];
        remLen += (encodedByte & 127) * multiplier;
        multiplier *= 128;
      } while ((encodedByte & 128) !== 0 && idx < 5);

      const totalPacketLen = idx + remLen;
      if (entry.rxBuf.length < totalPacketLen) {
        return; // wait for full packet
      }

      const packet = entry.rxBuf.slice(0, totalPacketLen);
      entry.rxBuf = entry.rxBuf.slice(totalPacketLen);

      const packetType = byte0 & 0xf0;
      if (packetType === 0x20) {
        // CONNACK -> subscribe to rooms and players wildcards
        entry.connected = true;
        try {
          const subPkt = buildSubscribePacket(1, [ROOMS_WILDCARD, PLAYERS_WILDCARD]);
          entry.ws?.send(
            subPkt.buffer.slice(subPkt.byteOffset, subPkt.byteOffset + subPkt.byteLength) as ArrayBuffer
          );
          // Re-publish any locally known active rooms so peers stay synced
          for (const room of this.rooms.values()) {
            this.sendToEntry(
              entry,
              `${TOPIC_PREFIX}/rooms/${room.roomId}`,
              encoder.encode(JSON.stringify(room)),
              true
            );
          }
        } catch {
          // ignore
        }

        if (entry.pingTimer) window.clearInterval(entry.pingTimer);
        entry.pingTimer = window.setInterval(() => {
          if (entry.connected && entry.ws?.readyState === WebSocket.OPEN) {
            try {
              const ping = new Uint8Array([0xc0, 0x00]);
              entry.ws.send(
                ping.buffer.slice(ping.byteOffset, ping.byteOffset + ping.byteLength) as ArrayBuffer
              );
            } catch {
              // ignore
            }
          }
        }, 20000);
      } else if (packetType === 0x30) {
        // PUBLISH packet received
        const qos = (byte0 >> 1) & 0x03;
        let pIdx = idx;
        if (pIdx + 2 > packet.length) continue;
        const topicLen = (packet[pIdx] << 8) | packet[pIdx + 1];
        pIdx += 2;
        if (pIdx + topicLen > packet.length) continue;
        const topic = decoder.decode(packet.slice(pIdx, pIdx + topicLen));
        pIdx += topicLen;
        if (qos > 0) {
          pIdx += 2; // skip packet identifier
        }
        const payloadBytes = packet.slice(pIdx);
        this.handleIncomingPublish(topic, payloadBytes);
      }
    }
  }

  private handleIncomingPublish(topic: string, payloadBytes: Uint8Array) {
    const roomsPrefix = `${TOPIC_PREFIX}/rooms/`;
    const playersPrefix = `${TOPIC_PREFIX}/players/`;

    if (topic.startsWith(roomsPrefix)) {
      const roomId = topic.slice(roomsPrefix.length);
      if (!roomId) return;

      if (payloadBytes.length === 0) {
        this.deletedRoomIds.set(roomId, Date.now());
        this.rooms.delete(roomId);
        this.players.delete(roomId);
        this.emitChange(roomId);
        return;
      }

      try {
        const parsed = JSON.parse(decoder.decode(payloadBytes)) as SyncedRoomRecord & {
          deleted?: boolean;
        };
        if (parsed.deleted || !parsed.roomId) {
          this.deletedRoomIds.set(roomId, Date.now());
          this.rooms.delete(roomId);
          this.players.delete(roomId);
          this.emitChange(roomId);
          return;
        }

        const deletedAt = this.deletedRoomIds.get(roomId) || 0;
        if (parsed.updatedAtMs && parsed.updatedAtMs < deletedAt) {
          return;
        }

        const existing = this.rooms.get(roomId);
        if (!existing || (parsed.updatedAtMs || 0) >= (existing.updatedAtMs || 0) - 250) {
          this.rooms.set(roomId, {
            ...parsed,
            updatedAtMs: parsed.updatedAtMs || Date.now(),
          });
          this.emitChange(roomId);
        }
      } catch {
        // ignore malformed JSON
      }
    } else if (topic.startsWith(playersPrefix)) {
      const rest = topic.slice(playersPrefix.length);
      const parts = rest.split('/');
      if (parts.length < 2) return;
      const [roomId, uid] = parts;
      if (!roomId || !uid) return;

      if (payloadBytes.length === 0) {
        const rPlayers = this.players.get(roomId);
        if (rPlayers && rPlayers[uid]) {
          delete rPlayers[uid];
          this.emitChange(roomId);
        }
        return;
      }

      try {
        const parsed = JSON.parse(decoder.decode(payloadBytes)) as SyncedPlayerRecord & {
          deleted?: boolean;
        };
        const rPlayers = this.players.get(roomId) || {};
        if (parsed.deleted || !parsed.playerId) {
          delete rPlayers[uid];
          this.players.set(roomId, rPlayers);
          this.emitChange(roomId);
          return;
        }

        const existing = rPlayers[uid];
        if (!existing || (parsed.updatedAtMs || 0) >= (existing.updatedAtMs || 0) - 250) {
          rPlayers[uid] = {
            ...parsed,
            updatedAtMs: parsed.updatedAtMs || Date.now(),
          };
          this.players.set(roomId, rPlayers);
          this.emitChange(roomId);
        }
      } catch {
        // ignore
      }
    }
  }

  private sendToEntry(
    entry: (typeof this.sockets)[number],
    topic: string,
    payload: Uint8Array,
    retain: boolean
  ) {
    if (entry.connected && entry.ws?.readyState === WebSocket.OPEN) {
      try {
        const pkt = buildPublishPacket(topic, payload, retain);
        entry.ws.send(
          pkt.buffer.slice(pkt.byteOffset, pkt.byteOffset + pkt.byteLength) as ArrayBuffer
        );
      } catch {
        // ignore
      }
    }
  }

  private broadcastMqtt(topic: string, payload: Uint8Array, retain: boolean) {
    this.start();
    for (const entry of this.sockets) {
      this.sendToEntry(entry, topic, payload, retain);
    }
  }

  public publishRoom(room: SyncedRoomRecord, retain = true) {
    this.start();
    this.deletedRoomIds.delete(room.roomId);
    this.rooms.set(room.roomId, room);
    const bytes = encoder.encode(JSON.stringify(room));
    this.broadcastMqtt(`${TOPIC_PREFIX}/rooms/${room.roomId}`, bytes, retain);
    this.emitChange(room.roomId);
  }

  public deleteRoom(roomId: string, playerUids: string[] = []) {
    this.start();
    this.deletedRoomIds.set(roomId, Date.now());
    const existingPlayers = this.players.get(roomId) || {};
    const allUids = Array.from(
      new Set([...playerUids, ...Object.keys(existingPlayers)])
    );
    this.rooms.delete(roomId);
    this.players.delete(roomId);

    // Clear retained room message on broker by publishing 0-byte retained payload
    this.broadcastMqtt(`${TOPIC_PREFIX}/rooms/${roomId}`, new Uint8Array(0), true);
    for (const uid of allUids) {
      this.broadcastMqtt(
        `${TOPIC_PREFIX}/players/${roomId}/${uid}`,
        new Uint8Array(0),
        true
      );
    }
    this.emitChange(roomId);
  }

  public publishPlayer(player: SyncedPlayerRecord, retain = true) {
    this.start();
    const rPlayers = this.players.get(player.roomId) || {};
    rPlayers[player.playerId] = player;
    this.players.set(player.roomId, rPlayers);
    const bytes = encoder.encode(JSON.stringify(player));
    this.broadcastMqtt(
      `${TOPIC_PREFIX}/players/${player.roomId}/${player.playerId}`,
      bytes,
      retain
    );
    this.emitChange(player.roomId);
  }

  public deletePlayer(roomId: string, uid: string) {
    this.start();
    const rPlayers = this.players.get(roomId);
    if (rPlayers) {
      delete rPlayers[uid];
    }
    this.broadcastMqtt(
      `${TOPIC_PREFIX}/players/${roomId}/${uid}`,
      new Uint8Array(0),
      true
    );
    this.emitChange(roomId);
  }

  public getActiveLobbyRooms(): SyncedRoomRecord[] {
    this.start();
    const now = Date.now();
    const result: SyncedRoomRecord[] = [];
    for (const [roomId, room] of this.rooms.entries()) {
      const age = now - (room.updatedAtMs || now);
      const isStaleWaiting = room.status === 'waiting' && age > 25 * 60 * 1000;
      const isStalePlaying = room.status === 'playing' && age > 10 * 60 * 1000;
      const isFinishedOld = room.status === 'finished' && age > 12 * 1000;
      if (
        room.memberUids.length === 0 ||
        room.status === 'finished' ||
        isStaleWaiting ||
        isStalePlaying ||
        isFinishedOld
      ) {
        if (isStaleWaiting || isStalePlaying || isFinishedOld) {
          this.deleteRoom(roomId, room.memberUids);
        }
        continue;
      }
      result.push(room);
    }
    return result.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
  }

  public getRoom(roomId: string): SyncedRoomRecord | null {
    this.start();
    return this.rooms.get(roomId) || null;
  }

  public getRoomPlayers(roomId: string): Record<string, SyncedPlayerRecord> {
    this.start();
    return { ...(this.players.get(roomId) || {}) };
  }

  public subscribe(cb: (roomId?: string) => void): () => void {
    this.start();
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emitChange(roomId?: string) {
    for (const cb of this.listeners) {
      try {
        cb(roomId);
      } catch {
        // ignore
      }
    }
  }
}

export const realtimeWsBroker = new RealtimeMultiplayerBroker();
