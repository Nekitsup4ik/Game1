import { EventState, EventTeam, MatchRoomDoc, RoomPlayerDoc } from '../types/game';

const TOPIC_PREFIX = 'haxarena2d/v3_live';
const ROOMS_WILDCARD = `${TOPIC_PREFIX}/rooms/+`;
const PLAYERS_WILDCARD = `${TOPIC_PREFIX}/players/+/+`;
const FAST_WILDCARD = `${TOPIC_PREFIX}/fast/+`;
const RTC_SIGNAL_WILDCARD = `${TOPIC_PREFIX}/rtc/+`;

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
  const varHeader = new Uint8Array([...protoName, 0x04, 0x02, 0x00, 0x1e]);
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

function toArrayBuffer(pkt: Uint8Array): ArrayBuffer {
  return pkt.buffer.slice(
    pkt.byteOffset,
    pkt.byteOffset + pkt.byteLength
  ) as ArrayBuffer;
}

export type SyncedRoomRecord = MatchRoomDoc & {
  updatedAtMs: number;
  heartbeatAtMs?: number;
  actorUid?: string;
  seq?: number;
};

export type SyncedPlayerRecord = RoomPlayerDoc & {
  updatedAtMs: number;
  pingMs?: number;
  seq?: number;
  keyMask?: number;
  kickUntilMs?: number;
};

interface FastPlayerTickPacket {
  t: 'p';
  u: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  k: number;
  km?: number;
  p: number;
  s: number;
}

interface FastBallTickPacket {
  t: 'b';
  u: string;
  bx: number;
  by: number;
  bvx: number;
  bvy: number;
  rs: number;
  bs: number;
  es: EventState;
  et: EventTeam;
  eu: number;
  lt: EventTeam;
  s: number;
}

type FastTickPacket = FastPlayerTickPacket | FastBallTickPacket;

class RealtimeMultiplayerBroker {
  private clientId = `hax_${Math.random().toString(36).slice(2, 10)}`;
  private rooms = new Map<string, SyncedRoomRecord>();
  private players = new Map<string, Record<string, SyncedPlayerRecord>>();
  private deletedRoomIds = new Map<string, number>();
  private structuralListeners = new Set<(roomId?: string) => void>();
  private rtcSignalListeners = new Set<(roomId: string, signal: unknown) => void>();
  private localPingMs = 18;
  private rxSeqCounter = 1000;
  private txSeqCounter = 1;
  private lastSenderSeq = new Map<string, number>();
  private localPlayerUid = '';
  private directWs: WebSocket | null = null;
  private directWsConnected = false;
  private directWsPingTimer: number | null = null;
  private directWsReconnectTimer: number | null = null;
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

    // 1. Connect to ultra-fast direct same-origin WebSocket (/ws on port 3000) when available
    const host = window.location.hostname;
    if (
      host.endsWith('.run.app') ||
      host === 'localhost' ||
      host === '127.0.0.1'
    ) {
      this.connectDirectWs();
    }

    // 2. Also connect to global WebSocket brokers for cross-network / GitHub Pages support
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

  public nextMonotonicSeq(): number {
    this.rxSeqCounter += 1;
    return this.rxSeqCounter;
  }

  public nextOutgoingSeq(): number {
    this.txSeqCounter += 1;
    return this.txSeqCounter;
  }

  private connectDirectWs() {
    if (this.directWsReconnectTimer) {
      window.clearTimeout(this.directWsReconnectTimer);
      this.directWsReconnectTimer = null;
    }
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      this.directWs = ws;
      this.directWsConnected = false;

      ws.onopen = () => {
        this.directWsConnected = true;
        if (this.directWsPingTimer) window.clearInterval(this.directWsPingTimer);
        // Probe RTT immediately on open, then strictly every 3000ms (3s)
        try {
          ws.send(JSON.stringify({ pingT0: performance.now() }));
        } catch {
          // ignore
        }
        this.directWsPingTimer = window.setInterval(() => {
          if (this.directWsConnected && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ pingT0: performance.now() }));
            } catch {
              // ignore
            }
          }
        }, 3000);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const msg = JSON.parse(ev.data) as {
            topic?: string;
            payload?: string;
            pongT0?: number;
          };
          if (typeof msg.pongT0 === 'number') {
            this.updateMeasuredPing(performance.now() - msg.pongT0);
            return;
          }
          if (msg.topic && typeof msg.payload === 'string') {
            this.handleIncomingPublish(
              msg.topic,
              encoder.encode(msg.payload),
              true
            );
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        this.directWsConnected = false;
        if (this.directWsPingTimer) {
          window.clearInterval(this.directWsPingTimer);
          this.directWsPingTimer = null;
        }
        this.directWsReconnectTimer = window.setTimeout(() => {
          this.connectDirectWs();
        }, 1500);
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      };
    } catch {
      this.directWsReconnectTimer = window.setTimeout(() => {
        this.connectDirectWs();
      }, 2000);
    }
  }

  public getLocalPingMs(): number {
    return this.localPingMs;
  }

  public updateMeasuredPing(rttMs: number) {
    if (!Number.isFinite(rttMs) || rttMs <= 0) return;
    const clamped = Math.max(2, Math.min(999, Math.round(rttMs)));
    this.localPingMs = Math.round(this.localPingMs * 0.6 + clamped * 0.4);
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
        const subId = `${this.clientId}_${Math.random().toString(36).slice(2, 6)}`;
        try {
          ws.send(toArrayBuffer(buildConnectPacket(subId)));
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
          return;
        }
        encodedByte = entry.rxBuf[idx++];
        remLen += (encodedByte & 127) * multiplier;
        multiplier *= 128;
      } while ((encodedByte & 128) !== 0 && idx < 5);

      const totalPacketLen = idx + remLen;
      if (entry.rxBuf.length < totalPacketLen) {
        return;
      }

      const packet = entry.rxBuf.slice(0, totalPacketLen);
      entry.rxBuf = entry.rxBuf.slice(totalPacketLen);

      const packetType = byte0 & 0xf0;
      if (packetType === 0x20) {
        entry.connected = true;
        const pingTopic = `${TOPIC_PREFIX}/ping/${this.clientId}`;
        try {
          entry.ws?.send(
            toArrayBuffer(
              buildSubscribePacket(1, [
                ROOMS_WILDCARD,
                PLAYERS_WILDCARD,
                FAST_WILDCARD,
                RTC_SIGNAL_WILDCARD,
                pingTopic,
              ])
            )
          );
        } catch {
          // ignore
        }

        if (entry.pingTimer) window.clearInterval(entry.pingTimer);
        entry.pingTimer = window.setInterval(() => {
          if (entry.connected && entry.ws?.readyState === WebSocket.OPEN) {
            try {
              // Send MQTT PINGREQ + RTT measurement probe strictly every 3000ms (3s)
              entry.ws.send(toArrayBuffer(new Uint8Array([0xc0, 0x00])));
              if (!this.directWsConnected) {
                const probe = encoder.encode(String(performance.now()));
                entry.ws.send(
                  toArrayBuffer(buildPublishPacket(pingTopic, probe, false))
                );
              }
            } catch {
              // ignore
            }
          }
        }, 3000);
      } else if (packetType === 0x30) {
        const qos = (byte0 >> 1) & 0x03;
        let pIdx = idx;
        if (pIdx + 2 > packet.length) continue;
        const topicLen = (packet[pIdx] << 8) | packet[pIdx + 1];
        pIdx += 2;
        if (pIdx + topicLen > packet.length) continue;
        const topic = decoder.decode(packet.slice(pIdx, pIdx + topicLen));
        pIdx += topicLen;
        if (qos > 0) {
          pIdx += 2;
        }
        const payloadBytes = packet.slice(pIdx);
        this.handleIncomingPublish(topic, payloadBytes, false);
      }
    }
  }

  private handleIncomingPublish(
    topic: string,
    payloadBytes: Uint8Array,
    fromDirectWs = false
  ) {
    const pingTopic = `${TOPIC_PREFIX}/ping/${this.clientId}`;
    if (topic === pingTopic) {
      const sentPerf = Number(decoder.decode(payloadBytes));
      if (Number.isFinite(sentPerf) && sentPerf > 0) {
        const rtt = performance.now() - sentPerf;
        this.updateMeasuredPing(rtt);
      }
      return;
    }

    const rtcPrefix = `${TOPIC_PREFIX}/rtc/`;
    if (topic.startsWith(rtcPrefix)) {
      const roomId = topic.slice(rtcPrefix.length);
      if (!roomId || payloadBytes.length === 0) return;
      try {
        const sig = JSON.parse(decoder.decode(payloadBytes));
        for (const cb of this.rtcSignalListeners) {
          try {
            cb(roomId, sig);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      return;
    }

    const fastPrefix = `${TOPIC_PREFIX}/fast/`;
    if (topic.startsWith(fastPrefix)) {
      // Never accept delayed 250ms+ MQTT echoes when directWs (<5ms) is active!
      if (!fromDirectWs && this.directWsConnected) {
        return;
      }
      const roomId = topic.slice(fastPrefix.length);
      if (!roomId || payloadBytes.length === 0) return;
      if (this.deletedRoomIds.has(roomId)) return;

      try {
        const pkt = JSON.parse(decoder.decode(payloadBytes)) as FastTickPacket;

        // Ignore self-echoed packets from MQTT brokers!
        if (this.localPlayerUid && pkt.u === this.localPlayerUid) {
          return;
        }

        // Per-sender monotonic sequence deduplication (zero clock skew across machines, blocks all duplicate/late packets!)
        if (pkt.u && typeof pkt.s === 'number') {
          const dedupKey = `${roomId}:${pkt.t}:${pkt.u}`;
          const prevS = this.lastSenderSeq.get(dedupKey);
          if (
            prevS !== undefined &&
            pkt.s <= prevS &&
            prevS - pkt.s < 50000
          ) {
            return;
          }
          this.lastSenderSeq.set(dedupKey, pkt.s);
        }

        const localRxSeq = this.nextMonotonicSeq();

        if (pkt.t === 'p') {
          const nowMs = Date.now();
          const rPlayers = this.players.get(roomId) || {};
          const existing = rPlayers[pkt.u];
          const km = typeof pkt.km === 'number' ? pkt.km : pkt.k === 1 ? 16 : 0;
          const isKickingNow = pkt.k === 1 || (km & 16) !== 0;
          const kickUntilMs = isKickingNow
            ? nowMs + 140
            : existing?.kickUntilMs || 0;

          rPlayers[pkt.u] = {
            ...(existing || {
              playerId: pkt.u,
              roomId,
              nickname: 'Player',
              jerseyNumber: 10,
              team: 'red',
            }),
            x: pkt.x,
            y: pkt.y,
            vx: pkt.vx,
            vy: pkt.vy,
            kicking: isKickingNow || nowMs < kickUntilMs,
            kickUntilMs,
            keyMask: km,
            pingMs: pkt.p,
            seq: localRxSeq,
            updatedAtMs: nowMs,
          };
          this.players.set(roomId, rPlayers);
          const room = this.rooms.get(roomId);
          if (room) {
            room.heartbeatAtMs = nowMs;
          }
        } else if (pkt.t === 'b') {
          const room = this.rooms.get(roomId);
          if (!room) return;
          const scoreOrEventChanged =
            room.redScore !== pkt.rs ||
            room.blueScore !== pkt.bs ||
            room.eventState !== pkt.es ||
            room.eventUntilMs !== pkt.eu;

          room.ballX = pkt.bx;
          room.ballY = pkt.by;
          room.ballVx = pkt.bvx;
          room.ballVy = pkt.bvy;
          room.redScore = Math.max(room.redScore, pkt.rs);
          room.blueScore = Math.max(room.blueScore, pkt.bs);
          room.eventState = pkt.es;
          room.eventTeam = pkt.et;
          room.eventUntilMs = pkt.eu;
          room.lastTouchTeam = pkt.lt;
          room.actorUid = pkt.u;
          room.seq = localRxSeq;
          room.updatedAtMs = Date.now();
          room.heartbeatAtMs = Date.now();

          if (scoreOrEventChanged) {
            this.emitStructuralChange(roomId);
          }
        }
      } catch {
        // ignore
      }
      return;
    }

    const roomsPrefix = `${TOPIC_PREFIX}/rooms/`;
    const playersPrefix = `${TOPIC_PREFIX}/players/`;

    if (topic.startsWith(roomsPrefix)) {
      const roomId = topic.slice(roomsPrefix.length);
      if (!roomId) return;

      const existing = this.rooms.get(roomId);
      // Block delayed external MQTT echoes or stale retained deletions when directWs (<5ms) is active for an ongoing match
      if (!fromDirectWs && this.directWsConnected && existing) {
        return;
      }

      if (payloadBytes.length === 0) {
        this.deletedRoomIds.set(roomId, Date.now());
        this.rooms.delete(roomId);
        this.players.delete(roomId);
        this.emitStructuralChange(roomId);
        return;
      }

      try {
        const parsed = JSON.parse(decoder.decode(payloadBytes)) as SyncedRoomRecord & {
          deleted?: boolean;
        };
        const now = Date.now();
        const hb = parsed.heartbeatAtMs || parsed.updatedAtMs || 0;
        const isActiveLocalMatch = existing && existing.status === 'playing';

        // Never delete an active playing room due to sender clock skew or old MQTT retained messages!
        if (
          parsed.deleted ||
          !parsed.roomId ||
          parsed.status === 'finished' ||
          (!isActiveLocalMatch && !fromDirectWs && now - hb > 18000)
        ) {
          if (now - hb > 18000 && !parsed.deleted && !fromDirectWs) {
            this.broadcastMqtt(
              `${TOPIC_PREFIX}/rooms/${roomId}`,
              new Uint8Array(0),
              true
            );
          }
          this.rooms.delete(roomId);
          this.players.delete(roomId);
          this.emitStructuralChange(roomId);
          return;
        }

        const deletedAt = this.deletedRoomIds.get(roomId) || 0;
        if (deletedAt > 0 && now - deletedAt < 5000) {
          return;
        }

        const localRxSeq = this.nextMonotonicSeq();
        this.rooms.set(roomId, {
          ...parsed,
          ballX:
            existing && existing.status === 'playing' && parsed.eventState === 'normal'
              ? existing.ballX
              : parsed.ballX,
          ballY:
            existing && existing.status === 'playing' && parsed.eventState === 'normal'
              ? existing.ballY
              : parsed.ballY,
          ballVx:
            existing && existing.status === 'playing' && parsed.eventState === 'normal'
              ? existing.ballVx
              : parsed.ballVx,
          ballVy:
            existing && existing.status === 'playing' && parsed.eventState === 'normal'
              ? existing.ballVy
              : parsed.ballVy,
          seq:
            existing &&
            existing.status === 'playing' &&
            parsed.eventState === 'normal' &&
            existing.seq &&
            existing.seq < 1000000000
              ? existing.seq
              : localRxSeq,
          updatedAtMs: now,
          heartbeatAtMs: now,
        });
        this.emitStructuralChange(roomId);
      } catch {
        // ignore
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
          this.emitStructuralChange(roomId);
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
          this.emitStructuralChange(roomId);
          return;
        }

        const existing = rPlayers[uid];
        // Block delayed external MQTT echoes when ultra-fast directWs (<5ms) is active
        if (!fromDirectWs && this.directWsConnected && existing) {
          return;
        }

        const structuralChanged =
          !existing ||
          existing.team !== parsed.team ||
          existing.nickname !== parsed.nickname ||
          existing.jerseyNumber !== parsed.jerseyNumber;

        const isFormationOrSpawnReset =
          !existing ||
          structuralChanged ||
          (parsed.vx === 0 && parsed.vy === 0);

        const localRxSeq = this.nextMonotonicSeq();
        rPlayers[uid] = {
          ...parsed,
          x: isFormationOrSpawnReset ? parsed.x : existing.x,
          y: isFormationOrSpawnReset ? parsed.y : existing.y,
          vx: isFormationOrSpawnReset ? parsed.vx : existing.vx,
          vy: isFormationOrSpawnReset ? parsed.vy : existing.vy,
          seq: isFormationOrSpawnReset ? localRxSeq : existing.seq || localRxSeq,
          updatedAtMs: Date.now(),
        };
        this.players.set(roomId, rPlayers);
        if (structuralChanged) {
          this.emitStructuralChange(roomId);
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
        entry.ws.send(toArrayBuffer(buildPublishPacket(topic, payload, retain)));
      } catch {
        // ignore
      }
    }
  }

  private broadcastMqtt(topic: string, payload: Uint8Array, retain: boolean) {
    this.start();

    // 1. Always send over direct same-origin WebSocket (/ws) first (<5ms latency, zero throttling!)
    if (
      this.directWsConnected &&
      this.directWs &&
      this.directWs.readyState === WebSocket.OPEN
    ) {
      try {
        this.directWs.send(
          JSON.stringify({
            topic,
            payload: decoder.decode(payload),
          })
        );
        // For non-retained fast ticks, never send to slow external MQTT brokers when directWs is open!
        if (!retain) {
          return;
        }
      } catch {
        // ignore
      }
    }

    // 2. Send to primary connected external broker for lobby discovery or GitHub Pages fallback
    let sent = false;
    for (const entry of this.sockets) {
      if (entry.connected && entry.ws?.readyState === WebSocket.OPEN) {
        this.sendToEntry(entry, topic, payload, retain);
        sent = true;
        if (!retain) {
          break;
        }
      }
    }
    if (!sent) {
      for (const entry of this.sockets) {
        this.sendToEntry(entry, topic, payload, retain);
      }
    }
  }

  public publishRoom(room: SyncedRoomRecord, retain = true) {
    this.start();
    const now = Date.now();
    const stamped: SyncedRoomRecord = {
      ...room,
      seq: this.nextMonotonicSeq(),
      updatedAtMs: now,
      heartbeatAtMs: now,
    };
    this.deletedRoomIds.delete(room.roomId);
    this.rooms.set(room.roomId, stamped);
    const bytes = encoder.encode(JSON.stringify(stamped));
    this.broadcastMqtt(`${TOPIC_PREFIX}/rooms/${room.roomId}`, bytes, retain);
    this.emitStructuralChange(room.roomId);
  }

  public publishFastPlayerTick(
    roomId: string,
    uid: string,
    x: number,
    y: number,
    vx: number,
    vy: number,
    kicking: boolean,
    pingMs: number,
    _seq: number,
    fallbackMeta?: {
      nickname: string;
      jerseyNumber: number;
      team: 'red' | 'blue';
      keyMask?: number;
    }
  ) {
    this.start();
    this.localPlayerUid = uid;
    const localSeq = this.nextMonotonicSeq();
    const outSeq = this.nextOutgoingSeq();
    const rPlayers = this.players.get(roomId) || {};
    const existing = rPlayers[uid];
    const km =
      typeof fallbackMeta?.keyMask === 'number'
        ? fallbackMeta.keyMask
        : kicking
          ? 16
          : 0;
    rPlayers[uid] = {
      playerId: uid,
      roomId,
      nickname: existing?.nickname || fallbackMeta?.nickname || 'Player',
      jerseyNumber: existing?.jerseyNumber || fallbackMeta?.jerseyNumber || 10,
      team: existing?.team || fallbackMeta?.team || 'red',
      x,
      y,
      vx,
      vy,
      kicking,
      keyMask: km,
      pingMs,
      seq: localSeq,
      updatedAtMs: Date.now(),
    };
    this.players.set(roomId, rPlayers);

    const pkt: FastPlayerTickPacket = {
      t: 'p',
      u: uid,
      x,
      y,
      vx,
      vy,
      k: kicking ? 1 : 0,
      km,
      p: pingMs,
      s: outSeq,
    };
    this.broadcastMqtt(
      `${TOPIC_PREFIX}/fast/${roomId}`,
      encoder.encode(JSON.stringify(pkt)),
      false
    );
  }

  public publishFastBallTick(
    roomId: string,
    actorUid: string,
    patch: {
      redScore: number;
      blueScore: number;
      ballX: number;
      ballY: number;
      ballVx: number;
      ballVy: number;
      eventState: EventState;
      eventTeam: EventTeam;
      eventUntilMs: number;
      lastTouchTeam: EventTeam;
    },
    _seq: number
  ) {
    this.start();
    if (actorUid) {
      this.localPlayerUid = actorUid;
    }
    const localSeq = this.nextMonotonicSeq();
    const outSeq = this.nextOutgoingSeq();
    const room = this.rooms.get(roomId);
    if (room) {
      room.redScore = Math.max(room.redScore, patch.redScore);
      room.blueScore = Math.max(room.blueScore, patch.blueScore);
      room.ballX = patch.ballX;
      room.ballY = patch.ballY;
      room.ballVx = patch.ballVx;
      room.ballVy = patch.ballVy;
      room.eventState = patch.eventState;
      room.eventTeam = patch.eventTeam;
      room.eventUntilMs = patch.eventUntilMs;
      room.lastTouchTeam = patch.lastTouchTeam;
      room.actorUid = actorUid;
      room.seq = localSeq;
      room.updatedAtMs = Date.now();
      room.heartbeatAtMs = Date.now();
    }

    const pkt: FastBallTickPacket = {
      t: 'b',
      u: actorUid,
      bx: patch.ballX,
      by: patch.ballY,
      bvx: patch.ballVx,
      bvy: patch.ballVy,
      rs: patch.redScore,
      bs: patch.blueScore,
      es: patch.eventState,
      et: patch.eventTeam,
      eu: patch.eventUntilMs,
      lt: patch.lastTouchTeam,
      s: outSeq,
    };
    this.broadcastMqtt(
      `${TOPIC_PREFIX}/fast/${roomId}`,
      encoder.encode(JSON.stringify(pkt)),
      false
    );
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

    this.broadcastMqtt(`${TOPIC_PREFIX}/rooms/${roomId}`, new Uint8Array(0), true);
    for (const uid of allUids) {
      this.broadcastMqtt(
        `${TOPIC_PREFIX}/players/${roomId}/${uid}`,
        new Uint8Array(0),
        true
      );
    }
    this.emitStructuralChange(roomId);
  }

  public publishPlayer(player: SyncedPlayerRecord, retain = true) {
    this.start();
    const rPlayers = this.players.get(player.roomId) || {};
    rPlayers[player.playerId] = {
      ...player,
      seq: this.nextMonotonicSeq(),
      pingMs: player.pingMs ?? this.localPingMs,
      updatedAtMs: Date.now(),
    };
    this.players.set(player.roomId, rPlayers);
    const bytes = encoder.encode(JSON.stringify(rPlayers[player.playerId]));
    this.broadcastMqtt(
      `${TOPIC_PREFIX}/players/${player.roomId}/${player.playerId}`,
      bytes,
      retain
    );
    this.emitStructuralChange(player.roomId);
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
    this.emitStructuralChange(roomId);
  }

  public getActiveLobbyRooms(): SyncedRoomRecord[] {
    this.start();
    const now = Date.now();
    const result: SyncedRoomRecord[] = [];
    for (const [roomId, room] of this.rooms.entries()) {
      const hb = room.heartbeatAtMs || room.updatedAtMs || 0;
      const age = now - hb;
      // Strict 16-second liveness check so abandoned rooms disappear automatically
      if (
        room.memberUids.length === 0 ||
        room.status === 'finished' ||
        age > 16000
      ) {
        if (age > 16000) {
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
    return this.players.get(roomId) || {};
  }

  public publishWebRTCSignal(roomId: string, signal: unknown) {
    this.start();
    const bytes = encoder.encode(JSON.stringify(signal));
    this.broadcastMqtt(`${TOPIC_PREFIX}/rtc/${roomId}`, bytes, false);
  }

  public subscribeWebRTCSignals(
    roomId: string,
    cb: (signal: unknown) => void
  ): () => void {
    this.start();
    const listener = (incomingRoomId: string, signal: unknown) => {
      if (incomingRoomId === roomId) {
        cb(signal);
      }
    };
    this.rtcSignalListeners.add(listener);
    return () => {
      this.rtcSignalListeners.delete(listener);
    };
  }

  public subscribe(cb: (roomId?: string) => void): () => void {
    this.start();
    this.structuralListeners.add(cb);
    return () => {
      this.structuralListeners.delete(cb);
    };
  }

  private emitStructuralChange(roomId?: string) {
    for (const cb of this.structuralListeners) {
      try {
        cb(roomId);
      } catch {
        // ignore
      }
    }
  }
}

export const realtimeWsBroker = new RealtimeMultiplayerBroker();
