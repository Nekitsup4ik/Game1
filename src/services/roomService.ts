import {
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  db,
  handleFirestoreError,
  isFirestoreQuotaExceeded,
  OperationType,
} from '../firebase';
import {
  BALL_MAX_SPEED,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  EventState,
  EventTeam,
  FIELD_CENTER_X,
  FIELD_CENTER_Y,
  getTeamSpawnPosition,
  LobbyDirectoryDoc,
  MatchRoomDoc,
  MAX_TEAM_SIZE,
  PLAYER_MAX_SPEED,
  PlayerProfile,
  RoomPlayerDoc,
  TeamColor,
  WinnerTeam,
} from '../types/game';
import {
  realtimeWsBroker,
  SyncedPlayerRecord,
  SyncedRoomRecord,
} from './realtimeWsBroker';
import {
  FastAuthoritativeSnapshot,
  WebRTCSignalMessage,
} from './webrtcLockstep';

// Clear legacy localStorage keys that previously caused ghost rooms & JSON freeze
if (typeof window !== 'undefined') {
  try {
    localStorage.removeItem('haxarena_fallback_rooms_v1');
    localStorage.removeItem('haxarena_fallback_players_v1');
  } catch {
    // ignore
  }
}

// Fast in-memory store (zero JSON.parse/stringify overhead on main thread!)
const memoryRooms = new Map<string, SyncedRoomRecord>();
const memoryPlayers = new Map<string, Record<string, SyncedPlayerRecord>>();

// Start global WebSocket multiplayer broker immediately
realtimeWsBroker.start();

// Only use local relative /api/mp/* when running on local dev / AI Studio server.
// Never spam cross-origin fetch requests from GitHub Pages on 25Hz ticks!
const isLocalApiHost =
  typeof window !== 'undefined' &&
  (window.location.hostname.endsWith('.run.app') ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1');

let apiReachable = isLocalApiHost;

const bc =
  typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel('haxarena_mp_fast_v3')
    : null;

if (bc) {
  bc.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data;
    if (!data) return;
    if (data.type === 'room' && data.room) {
      const r = data.room as SyncedRoomRecord;
      memoryRooms.set(r.roomId, {
        ...r,
        seq: realtimeWsBroker.nextMonotonicSeq(),
        updatedAtMs: Date.now(),
      });
    } else if (data.type === 'player' && data.player) {
      const p = data.player as SyncedPlayerRecord;
      const map = memoryPlayers.get(p.roomId) || {};
      map[p.playerId] = {
        ...p,
        seq: realtimeWsBroker.nextMonotonicSeq(),
        updatedAtMs: Date.now(),
      };
      memoryPlayers.set(p.roomId, map);
    } else if (data.type === 'delete_room' && data.roomId) {
      memoryRooms.delete(data.roomId);
      memoryPlayers.delete(data.roomId);
    }
  });
}

const localRtcSignalListeners = new Set<(sig: WebRTCSignalMessage) => void>();
if (bc) {
  bc.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data;
    if (data && data.type === 'rtc_signal' && data.signal) {
      for (const cb of localRtcSignalListeners) {
        try {
          cb(data.signal as WebRTCSignalMessage);
        } catch {
          // ignore
        }
      }
    }
  });
}

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

function sanitizeId(raw: string): string {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'p_guest';
}

function sanitizeNickname(raw: string): string {
  const cleaned = String(raw || '').trim().slice(0, 24);
  return cleaned.length > 0 ? cleaned : 'Player';
}

function sanitizeTitle(raw: string): string {
  const cleaned = String(raw || '').trim().slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'Матч HaxArena';
}

function extractTimestampMs(val: unknown): number {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val instanceof Timestamp) return val.toMillis();
  if (typeof (val as { toMillis?: () => number }).toMillis === 'function') {
    return (val as { toMillis: () => number }).toMillis();
  }
  if (typeof (val as { seconds?: number }).seconds === 'number') {
    return (val as { seconds: number }).seconds * 1000;
  }
  return 0;
}

async function fetchApiJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!apiReachable) return null;
  const t0 = performance.now();
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 1400);
    const res = await fetch(path, {
      ...init,
      signal: controller.signal,
    });
    window.clearTimeout(timeout);
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('application/json')) {
      const rtt = performance.now() - t0;
      realtimeWsBroker.updateMeasuredPing(rtt);
      return (await res.json()) as T;
    }
    if (res.status === 404) {
      apiReachable = false;
    }
  } catch {
    // ignore
  }
  return null;
}

async function postApiJson<T>(path: string, body: unknown): Promise<T | null> {
  if (!apiReachable) return null;
  return fetchApiJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function getLocalPingMs(): number {
  return realtimeWsBroker.getLocalPingMs();
}

/**
 * Direct 60 FPS Zero-Allocation Snapshot Reader for MatchArena.tsx
 * Bypasses React state re-renders completely during active gameplay!
 */
export function getLiveMatchSnapshot(roomId: string): {
  room: SyncedRoomRecord | null;
  players: Record<string, SyncedPlayerRecord>;
} {
  const normSeq = (s?: number) => (s && s < 1000000000 ? s : 0);
  const memRoom = memoryRooms.get(roomId);
  const wsRoom = realtimeWsBroker.getRoom(roomId);

  let bestRoom: SyncedRoomRecord | null = memRoom || wsRoom || null;
  if (memRoom && wsRoom) {
    bestRoom =
      normSeq(wsRoom.seq) >= normSeq(memRoom.seq)
        ? wsRoom
        : memRoom;
    if (memRoom.redScore > bestRoom.redScore) bestRoom.redScore = memRoom.redScore;
    if (memRoom.blueScore > bestRoom.blueScore) bestRoom.blueScore = memRoom.blueScore;
    if (wsRoom.redScore > bestRoom.redScore) bestRoom.redScore = wsRoom.redScore;
    if (wsRoom.blueScore > bestRoom.blueScore) bestRoom.blueScore = wsRoom.blueScore;
  }

  const memP = memoryPlayers.get(roomId) || {};
  const wsP = realtimeWsBroker.getRoomPlayers(roomId);
  const mergedPlayers: Record<string, SyncedPlayerRecord> = { ...memP };

  for (const [uid, pDoc] of Object.entries(wsP)) {
    const prev = mergedPlayers[uid];
    if (
      !prev ||
      normSeq(pDoc.seq) >= normSeq(prev.seq)
    ) {
      mergedPlayers[uid] = pDoc;
    }
  }

  return { room: bestRoom, players: mergedPlayers };
}

function toFirestoreRoomPayload(room: MatchRoomDoc) {
  return {
    roomId: sanitizeId(room.roomId).slice(0, 64),
    title: sanitizeTitle(room.title),
    hostUid: sanitizeId(room.hostUid),
    hostName: sanitizeNickname(room.hostName),
    status: room.status,
    memberUids: room.memberUids.map(sanitizeId).slice(0, 10),
    redUids: room.redUids.map(sanitizeId).slice(0, 5),
    blueUids: room.blueUids.map(sanitizeId).slice(0, 5),
    redScore: clamp(Math.round(room.redScore), 0, 99),
    blueScore: clamp(Math.round(room.blueScore), 0, 99),
    matchStartedAtMs: clamp(Math.round(room.matchStartedAtMs || 0), 0, 9999999999999),
    winnerTeam: room.winnerTeam,
    ballX: Math.round(clamp(room.ballX, -2000, 2000) * 10) / 10,
    ballY: Math.round(clamp(room.ballY, -2000, 2000) * 10) / 10,
    ballVx: Math.round(clamp(room.ballVx, -100, 100) * 100) / 100,
    ballVy: Math.round(clamp(room.ballVy, -100, 100) * 100) / 100,
    eventState: room.eventState,
    eventTeam: room.eventTeam,
    eventUntilMs: clamp(Math.round(room.eventUntilMs || 0), 0, 9999999999999),
    lastTouchTeam: room.lastTouchTeam,
  };
}

function toFirestorePlayerPayload(player: RoomPlayerDoc) {
  return {
    playerId: sanitizeId(player.playerId),
    roomId: sanitizeId(player.roomId).slice(0, 64),
    nickname: sanitizeNickname(player.nickname),
    jerseyNumber: clamp(Math.round(player.jerseyNumber || 10), 1, 99),
    team: player.team,
    x: Math.round(clamp(player.x, -2000, 2000) * 10) / 10,
    y: Math.round(clamp(player.y, -2000, 2000) * 10) / 10,
    vx: Math.round(clamp(player.vx, -50, 50) * 100) / 100,
    vy: Math.round(clamp(player.vy, -50, 50) * 100) / 100,
    kicking: Boolean(player.kicking),
  };
}

async function addRoomIdToFirestoreLobby(roomId: string, uid: string): Promise<void> {
  if (isFirestoreQuotaExceeded) return;
  const lobbyRef = doc(db, 'lobbies', 'main');
  try {
    const snap = await getDoc(lobbyRef);
    const safeUid = sanitizeId(uid);
    if (!snap.exists()) {
      await setDoc(lobbyRef, {
        lobbyId: 'main',
        roomIds: [roomId],
        updatedBy: safeUid,
        updatedAt: serverTimestamp(),
      });
    } else {
      const data = snap.data() as LobbyDirectoryDoc;
      const existingIds = Array.isArray(data.roomIds) ? data.roomIds : [];
      const nextIds = [
        roomId,
        ...existingIds.filter((id) => id !== roomId),
      ].slice(0, 12);
      await updateDoc(lobbyRef, {
        roomIds: nextIds,
        updatedBy: safeUid,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'lobbies/main');
  }
}

async function removeRoomIdFromFirestoreLobby(roomId: string, uid: string): Promise<void> {
  if (isFirestoreQuotaExceeded) return;
  const lobbyRef = doc(db, 'lobbies', 'main');
  try {
    const snap = await getDoc(lobbyRef);
    if (!snap.exists()) return;
    const data = snap.data() as LobbyDirectoryDoc;
    const existingIds = Array.isArray(data.roomIds) ? data.roomIds : [];
    if (!existingIds.includes(roomId)) return;
    const nextIds = existingIds.filter((id) => id !== roomId).slice(0, 12);
    await updateDoc(lobbyRef, {
      roomIds: nextIds,
      updatedBy: sanitizeId(uid),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'lobbies/main');
  }
}

export function subscribeToLobbyRooms(
  onUpdate: (rooms: MatchRoomDoc[]) => void
): () => void {
  let cancelled = false;
  let firestoreRooms: SyncedRoomRecord[] = [];
  let apiRooms: SyncedRoomRecord[] = [];

  const mergeAndEmit = () => {
    if (cancelled) return;
    const now = Date.now();
    const mergedMap = new Map<string, SyncedRoomRecord>();

    // Clean stale rooms from memory (> 16 seconds without heartbeat)
    for (const [id, r] of memoryRooms.entries()) {
      const hb = r.heartbeatAtMs || r.updatedAtMs || 0;
      if (r.status === 'finished' || r.memberUids.length === 0 || now - hb > 16000) {
        memoryRooms.delete(id);
        memoryPlayers.delete(id);
      } else {
        mergedMap.set(id, r);
      }
    }

    for (const r of firestoreRooms) {
      const hb = r.heartbeatAtMs || r.updatedAtMs || 0;
      if (r.status !== 'finished' && r.memberUids.length > 0 && now - hb <= 20000) {
        mergedMap.set(r.roomId, r);
      }
    }

    for (const r of apiRooms) {
      const hb = r.heartbeatAtMs || r.updatedAtMs || now;
      if (r.status !== 'finished' && r.memberUids.length > 0 && now - hb <= 16000) {
        mergedMap.set(r.roomId, { ...r, updatedAtMs: hb, heartbeatAtMs: hb });
      }
    }

    for (const r of realtimeWsBroker.getActiveLobbyRooms()) {
      const hb = r.heartbeatAtMs || r.updatedAtMs || 0;
      if (r.status !== 'finished' && r.memberUids.length > 0 && now - hb <= 16000) {
        mergedMap.set(r.roomId, r);
      }
    }

    const sorted = Array.from(mergedMap.values()).sort(
      (a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0)
    );
    onUpdate(sorted);
  };

  const unsubWs = realtimeWsBroker.subscribe(() => {
    mergeAndEmit();
  });

  // Firestore listener for /lobbies/main (strictly checks actual Firestore updatedAt timestamp!)
  let unsubFirestore: (() => void) | null = null;
  if (!isFirestoreQuotaExceeded) {
    const lobbyRef = doc(db, 'lobbies', 'main');
    unsubFirestore = onSnapshot(
      lobbyRef,
      async (snap) => {
        if (cancelled || isFirestoreQuotaExceeded) return;
        if (!snap.exists()) {
          firestoreRooms = [];
          mergeAndEmit();
          return;
        }
        const data = snap.data() as LobbyDirectoryDoc;
        const ids = Array.isArray(data.roomIds) ? data.roomIds.slice(0, 10) : [];
        const loaded: SyncedRoomRecord[] = [];
        const staleIds: string[] = [];
        const now = Date.now();

        for (const id of ids) {
          if (isFirestoreQuotaExceeded) break;
          try {
            const rSnap = await getDoc(doc(db, 'rooms', id));
            if (rSnap.exists()) {
              const rData = rSnap.data() as MatchRoomDoc;
              const docUpdatedMs = extractTimestampMs(rData.updatedAt) || extractTimestampMs(rData.createdAt);
              // CRITICAL FIX: Never resurrect old Firestore rooms! If older than 20s, mark stale and delete!
              if (
                rData.status !== 'finished' &&
                rData.memberUids?.length > 0 &&
                docUpdatedMs > 0 &&
                now - docUpdatedMs <= 20000
              ) {
                loaded.push({
                  ...rData,
                  updatedAtMs: docUpdatedMs,
                  heartbeatAtMs: docUpdatedMs,
                });
              } else {
                staleIds.push(id);
              }
            } else {
              staleIds.push(id);
            }
          } catch (err) {
            handleFirestoreError(err, OperationType.GET, `rooms/${id}`);
          }
        }

        // Clean up ghost room IDs from /lobbies/main automatically
        if (staleIds.length > 0 && !isFirestoreQuotaExceeded) {
          const validIds = ids.filter((id) => !staleIds.includes(id));
          updateDoc(lobbyRef, {
            roomIds: validIds,
            updatedBy: 'system_cleaner',
            updatedAt: serverTimestamp(),
          }).catch(() => {});
          for (const sId of staleIds) {
            deleteDoc(doc(db, 'rooms', sId)).catch(() => {});
          }
        }

        firestoreRooms = loaded;
        mergeAndEmit();
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, 'lobbies/main');
      }
    );
  }

  const fetchLobbyApi = async () => {
    if (cancelled) return;
    const data = await fetchApiJson<{ rooms?: SyncedRoomRecord[] }>('/api/mp/lobby');
    if (!cancelled && data && Array.isArray(data.rooms)) {
      apiRooms = data.rooms;
    }
    mergeAndEmit();
  };

  fetchLobbyApi();
  const intervalId = window.setInterval(fetchLobbyApi, 2500);

  return () => {
    cancelled = true;
    unsubWs();
    if (unsubFirestore) unsubFirestore();
    window.clearInterval(intervalId);
  };
}

/**
 * Manual on-demand refresh of Lobby Rooms («Обновить список» button)
 */
export async function refreshLobbyRoomsNow(): Promise<MatchRoomDoc[]> {
  const now = Date.now();
  const mergedMap = new Map<string, SyncedRoomRecord>();

  // 1. Check local memory rooms
  for (const [id, r] of memoryRooms.entries()) {
    const hb = r.heartbeatAtMs || r.updatedAtMs || 0;
    if (r.status === 'finished' || r.memberUids.length === 0 || now - hb > 16000) {
      memoryRooms.delete(id);
      memoryPlayers.delete(id);
    } else {
      mergedMap.set(id, r);
    }
  }

  // 2. Check WebSocket broker active rooms
  for (const r of realtimeWsBroker.getActiveLobbyRooms()) {
    const hb = r.heartbeatAtMs || r.updatedAtMs || 0;
    if (r.status !== 'finished' && r.memberUids.length > 0 && now - hb <= 16000) {
      mergedMap.set(r.roomId, r);
    }
  }

  // 3. Check Express API if available
  const apiData = await fetchApiJson<{ rooms?: SyncedRoomRecord[] }>('/api/mp/lobby');
  if (apiData && Array.isArray(apiData.rooms)) {
    for (const r of apiData.rooms) {
      const hb = r.heartbeatAtMs || r.updatedAtMs || now;
      if (r.status !== 'finished' && r.memberUids.length > 0 && now - hb <= 16000) {
        mergedMap.set(r.roomId, { ...r, updatedAtMs: hb, heartbeatAtMs: hb });
      }
    }
  }

  // 4. Check Firestore /lobbies/main if quota available
  if (!isFirestoreQuotaExceeded) {
    try {
      const lobbyRef = doc(db, 'lobbies', 'main');
      const snap = await getDoc(lobbyRef);
      if (snap.exists()) {
        const data = snap.data() as LobbyDirectoryDoc;
        const ids = Array.isArray(data.roomIds) ? data.roomIds.slice(0, 10) : [];
        for (const id of ids) {
          if (isFirestoreQuotaExceeded) break;
          try {
            const rSnap = await getDoc(doc(db, 'rooms', id));
            if (rSnap.exists()) {
              const rData = rSnap.data() as MatchRoomDoc;
              const docUpdatedMs =
                extractTimestampMs(rData.updatedAt) ||
                extractTimestampMs(rData.createdAt);
              if (
                rData.status !== 'finished' &&
                rData.memberUids?.length > 0 &&
                docUpdatedMs > 0 &&
                now - docUpdatedMs <= 20000
              ) {
                mergedMap.set(rData.roomId, {
                  ...rData,
                  updatedAtMs: docUpdatedMs,
                  heartbeatAtMs: docUpdatedMs,
                });
              }
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return Array.from(mergedMap.values()).sort(
    (a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0)
  );
}

export function subscribeToActiveRoom(
  roomId: string,
  onUpdate: (
    room: MatchRoomDoc | null,
    players: Record<string, RoomPlayerDoc>
  ) => void
): () => void {
  let cancelled = false;
  let inFlight = false;
  let lastStructuralSig = '';
  let lastUiEmitMs = 0;

  const emitIfStructuralOrPeriodic = (force = false) => {
    if (cancelled) return;
    const { room, players } = getLiveMatchSnapshot(roomId);
    if (!room) {
      if (lastStructuralSig !== 'null') {
        lastStructuralSig = 'null';
        onUpdate(null, {});
      }
      return;
    }

    // Build structural signature (status, score, events, teams, nicknames, numbers)
    // Notice: x, y, vx, vy, ballX, ballY are NOT in this signature so 25Hz physics never triggers React re-renders!
    const playerMetaSig = Object.values(players)
      .map((p) => `${p.playerId}:${p.team}:${p.nickname}:${p.jerseyNumber}`)
      .sort()
      .join('|');
    const sig = `${room.status}:${room.redScore}:${room.blueScore}:${room.eventState}:${room.eventTeam}:${room.eventUntilMs}:${room.winnerTeam}:${room.memberUids.join(',')}:${room.redUids.join(',')}:${room.blueUids.join(',')}:${playerMetaSig}`;

    const now = Date.now();
    // Emit immediately if structural state changed, or every 3000ms (3s) to refresh pingMs in the Tab scoreboard
    if (force || sig !== lastStructuralSig || now - lastUiEmitMs >= 3000) {
      lastStructuralSig = sig;
      lastUiEmitMs = now;
      onUpdate({ ...room }, { ...players });
    }
  };

  const unsubWs = realtimeWsBroker.subscribe((changedRoomId) => {
    if (!changedRoomId || changedRoomId === roomId) {
      emitIfStructuralOrPeriodic(false);
    }
  });

  // Poll Express API only at a slow 2.5s interval for room status/roster changes (NEVER overwrite live 60Hz positions!)
  const fetchRoomApi = async () => {
    if (cancelled || inFlight || !apiReachable) return;
    const existingLocal = memoryRooms.get(roomId) || realtimeWsBroker.getRoom(roomId);
    if (existingLocal && existingLocal.status === 'playing') {
      // During active gameplay, WebRTC DataChannel & WebSocket handle 60Hz ticks; avoid HTTP polling lag!
      return;
    }
    inFlight = true;
    const data = await fetchApiJson<{
      room: SyncedRoomRecord | null;
      players: Record<string, SyncedPlayerRecord>;
    }>(`/api/mp/room/${encodeURIComponent(roomId)}`);

    if (!cancelled && data && data.room) {
      const prevRoom = memoryRooms.get(roomId);
      if (
        !prevRoom ||
        data.room.status !== prevRoom.status ||
        data.room.memberUids.length !== prevRoom.memberUids.length ||
        data.room.redUids.length !== prevRoom.redUids.length ||
        data.room.blueUids.length !== prevRoom.blueUids.length
      ) {
        memoryRooms.set(roomId, {
          ...data.room,
          updatedAtMs: data.room.updatedAtMs || Date.now(),
          heartbeatAtMs: Date.now(),
        });
      }

      const memP = memoryPlayers.get(roomId) || {};
      for (const [uid, pDoc] of Object.entries(data.players || {})) {
        if (!memP[uid]) {
          memP[uid] = pDoc;
        }
      }
      memoryPlayers.set(roomId, memP);
      emitIfStructuralOrPeriodic(false);
    }
    inFlight = false;
  };

  // Emit immediately from in-memory / WebSocket store so entering a room takes 0ms!
  emitIfStructuralOrPeriodic(true);

  fetchRoomApi();
  const apiPollId = window.setInterval(fetchRoomApi, 2500);
  const uiPingRefreshId = window.setInterval(() => {
    emitIfStructuralOrPeriodic(false);
  }, 3000);

  return () => {
    cancelled = true;
    unsubWs();
    window.clearInterval(apiPollId);
    window.clearInterval(uiPingRefreshId);
  };
}

export async function sendRoomHeartbeat(roomId: string, uid: string): Promise<void> {
  const safeUid = sanitizeId(uid);
  const pingMs = realtimeWsBroker.getLocalPingMs();
  const now = Date.now();

  const room = realtimeWsBroker.getRoom(roomId) || memoryRooms.get(roomId);
  if (room && room.status !== 'finished') {
    room.updatedAtMs = now;
    room.heartbeatAtMs = now;
    memoryRooms.set(roomId, room);
    // Keep retained room fresh on WebSocket broker while players are inside
    if (room.hostUid === safeUid || room.memberUids[0] === safeUid) {
      realtimeWsBroker.publishRoom(room, true);
    }
  }

  const pMap = memoryPlayers.get(roomId) || {};
  if (pMap[safeUid]) {
    pMap[safeUid].pingMs = pingMs;
    pMap[safeUid].updatedAtMs = now;
    memoryPlayers.set(roomId, pMap);
  }

  postApiJson('/api/mp/room/heartbeat', {
    roomId,
    uid: safeUid,
    pingMs,
  }).catch(() => {});

  if (!isFirestoreQuotaExceeded && room && room.hostUid === safeUid) {
    updateDoc(doc(db, 'rooms', roomId), {
      redScore: clamp(Math.round(room.redScore), 0, 99),
      blueScore: clamp(Math.round(room.blueScore), 0, 99),
      ballX: Math.round(clamp(room.ballX, -2000, 2000) * 10) / 10,
      ballY: Math.round(clamp(room.ballY, -2000, 2000) * 10) / 10,
      ballVx: Math.round(clamp(room.ballVx, -100, 100) * 100) / 100,
      ballVy: Math.round(clamp(room.ballVy, -100, 100) * 100) / 100,
      eventState: room.eventState,
      eventTeam: room.eventTeam,
      eventUntilMs: clamp(Math.round(room.eventUntilMs || 0), 0, 9999999999999),
      lastTouchTeam: room.lastTouchTeam,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
  }
}

export async function createMatchRoom(
  profile: PlayerProfile,
  customTitle?: string
): Promise<string> {
  const safeUid = sanitizeId(profile.uid);
  const nickname = sanitizeNickname(profile.nickname);
  const jerseyNumber = clamp(Math.round(profile.jerseyNumber || 10), 1, 99);
  const title = sanitizeTitle(customTitle || `Матч игрока ${nickname}`);
  const spawn = getTeamSpawnPosition('red', 0);
  const now = Date.now();
  const pingMs = realtimeWsBroker.getLocalPingMs();

  const roomId = `room_${now}_${Math.random()
    .toString(36)
    .slice(2, 7)
    .replace(/[^a-zA-Z0-9]/g, '')}`;

  const newRoom: SyncedRoomRecord = {
    roomId,
    title,
    hostUid: safeUid,
    hostName: nickname,
    status: 'waiting',
    memberUids: [safeUid],
    redUids: [safeUid],
    blueUids: [],
    redScore: 0,
    blueScore: 0,
    matchStartedAtMs: 0,
    winnerTeam: 'none',
    ballX: FIELD_CENTER_X,
    ballY: FIELD_CENTER_Y,
    ballVx: 0,
    ballVy: 0,
    eventState: 'normal',
    eventTeam: 'none',
    eventUntilMs: 0,
    lastTouchTeam: 'none',
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
    heartbeatAtMs: now,
  };

  const hostPlayer: SyncedPlayerRecord = {
    playerId: safeUid,
    roomId,
    nickname,
    jerseyNumber,
    team: 'red',
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    kicking: false,
    pingMs,
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
  };

  // 1. Immediately store in memory & publish over /ws so the host enters the lobby in 0ms!
  memoryRooms.set(roomId, newRoom);
  memoryPlayers.set(roomId, { [safeUid]: hostPlayer });
  bc?.postMessage({ type: 'room', room: newRoom });
  bc?.postMessage({ type: 'player', player: hostPlayer });

  realtimeWsBroker.publishPlayer(hostPlayer, true);
  realtimeWsBroker.publishRoom(newRoom, true);

  // 2. Sync to Express API & Firestore in background without blocking lobby transition
  postApiJson<{ roomId: string; room: SyncedRoomRecord }>(
    '/api/mp/room/create',
    {
      roomId,
      profile: { uid: safeUid, nickname, jerseyNumber },
      customTitle: title,
    }
  ).catch(() => {});

  if (!isFirestoreQuotaExceeded) {
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'rooms', roomId), {
        ...toFirestoreRoomPayload(newRoom),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'rooms', roomId, 'players', safeUid), {
        ...toFirestorePlayerPayload(hostPlayer),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch
        .commit()
        .then(() => addRoomIdToFirestoreLobby(roomId, safeUid))
        .catch((err) => {
          handleFirestoreError(err, OperationType.CREATE, `rooms/${roomId}`);
        });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `rooms/${roomId}`);
    }
  }

  return roomId;
}

export async function joinMatchRoom(
  roomId: string,
  profile: PlayerProfile
): Promise<{ joined: boolean; reason?: string }> {
  const safeUid = sanitizeId(profile.uid);
  const nickname = sanitizeNickname(profile.nickname);
  const jerseyNumber = clamp(Math.round(profile.jerseyNumber || 10), 1, 99);
  const pingMs = realtimeWsBroker.getLocalPingMs();

  let room: SyncedRoomRecord | null =
    realtimeWsBroker.getRoom(roomId) || memoryRooms.get(roomId) || null;

  if (room) {
    // Room is already known via /ws broker: fire HTTP join in background for zero wait!
    postApiJson('/api/mp/room/join', {
      roomId,
      profile: { uid: safeUid, nickname, jerseyNumber },
    }).catch(() => {});
  } else {
    const apiRes = await postApiJson<{
      joined: boolean;
      reason?: string;
      room?: SyncedRoomRecord;
    }>('/api/mp/room/join', {
      roomId,
      profile: { uid: safeUid, nickname, jerseyNumber },
    });
    room =
      apiRes?.room ||
      realtimeWsBroker.getRoom(roomId) ||
      memoryRooms.get(roomId) ||
      null;
  }

  if (!room && !isFirestoreQuotaExceeded) {
    try {
      const snap = await getDoc(doc(db, 'rooms', roomId));
      if (snap.exists()) {
        room = { ...(snap.data() as MatchRoomDoc), updatedAtMs: Date.now() };
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `rooms/${roomId}`);
    }
  }

  if (!room) {
    return { joined: false, reason: 'Комната не найдена или была закрыта.' };
  }
  if (room.status === 'finished') {
    realtimeWsBroker.deleteRoom(roomId, room.memberUids);
    return { joined: false, reason: 'Этот матч уже завершён и комната закрыта.' };
  }
  if (room.status !== 'waiting' && !room.memberUids.includes(safeUid)) {
    return { joined: false, reason: 'Матч в этой комнате уже начался.' };
  }
  if (!room.memberUids.includes(safeUid) && room.memberUids.length >= MAX_TEAM_SIZE * 2) {
    return { joined: false, reason: 'Комната заполнена (максимум 8 игроков 4×4).' };
  }

  const redUids = [...room.redUids];
  const blueUids = [...room.blueUids];
  const memberUids = [...room.memberUids];
  let assignedTeam: TeamColor = 'red';

  if (redUids.includes(safeUid)) {
    assignedTeam = 'red';
  } else if (blueUids.includes(safeUid)) {
    assignedTeam = 'blue';
  } else {
    if (redUids.length <= blueUids.length && redUids.length < MAX_TEAM_SIZE) {
      assignedTeam = 'red';
      redUids.push(safeUid);
    } else if (blueUids.length < MAX_TEAM_SIZE) {
      assignedTeam = 'blue';
      blueUids.push(safeUid);
    } else {
      assignedTeam = 'red';
      redUids.push(safeUid);
    }
    memberUids.push(safeUid);
  }

  const indexInTeam =
    assignedTeam === 'red'
      ? Math.max(0, redUids.indexOf(safeUid))
      : Math.max(0, blueUids.indexOf(safeUid));
  const spawn = getTeamSpawnPosition(assignedTeam, indexInTeam);
  const now = Date.now();

  const updatedRoom: SyncedRoomRecord = {
    ...room,
    memberUids,
    redUids,
    blueUids,
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
    heartbeatAtMs: now,
  };

  const joinedPlayer: SyncedPlayerRecord = {
    playerId: safeUid,
    roomId,
    nickname,
    jerseyNumber,
    team: assignedTeam,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    kicking: false,
    pingMs,
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
  };

  memoryRooms.set(roomId, updatedRoom);
  const pMap = memoryPlayers.get(roomId) || {};
  pMap[safeUid] = joinedPlayer;
  memoryPlayers.set(roomId, pMap);
  bc?.postMessage({ type: 'room', room: updatedRoom });
  bc?.postMessage({ type: 'player', player: joinedPlayer });

  realtimeWsBroker.publishPlayer(joinedPlayer, true);
  realtimeWsBroker.publishRoom(updatedRoom, true);

  if (!isFirestoreQuotaExceeded) {
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'rooms', roomId), {
        hostUid: sanitizeId(updatedRoom.hostUid),
        hostName: sanitizeNickname(updatedRoom.hostName),
        memberUids: updatedRoom.memberUids.map(sanitizeId).slice(0, 10),
        redUids: updatedRoom.redUids.map(sanitizeId).slice(0, 5),
        blueUids: updatedRoom.blueUids.map(sanitizeId).slice(0, 5),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'rooms', roomId, 'players', safeUid), {
        ...toFirestorePlayerPayload(joinedPlayer),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.commit().catch((err) => {
        handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
    }
  }

  return { joined: true };
}

export async function switchPlayerTeam(
  room: MatchRoomDoc,
  profile: PlayerProfile
): Promise<{ switched: boolean; reason?: string }> {
  const safeUid = sanitizeId(profile.uid);
  const nickname = sanitizeNickname(profile.nickname);
  const jerseyNumber = clamp(Math.round(profile.jerseyNumber || 10), 1, 99);
  const pingMs = realtimeWsBroker.getLocalPingMs();

  postApiJson('/api/mp/room/switch-team', {
    roomId: room.roomId,
    profile: { uid: safeUid, nickname, jerseyNumber },
  }).catch(() => {});

  const currentRoom =
    realtimeWsBroker.getRoom(room.roomId) ||
    memoryRooms.get(room.roomId) ||
    ({ ...room, updatedAtMs: Date.now() } as SyncedRoomRecord);

  if (currentRoom.status !== 'waiting') {
    return { switched: false, reason: 'Смена команды доступна только до начала матча.' };
  }

  const isCurrentlyRed = currentRoom.redUids.includes(safeUid);
  const targetTeam: TeamColor = isCurrentlyRed ? 'blue' : 'red';
  if (targetTeam === 'red' && currentRoom.redUids.length >= MAX_TEAM_SIZE) {
    return { switched: false, reason: 'В команде Красных уже 4 игрока.' };
  }
  if (targetTeam === 'blue' && currentRoom.blueUids.length >= MAX_TEAM_SIZE) {
    return { switched: false, reason: 'В команде Синих уже 4 игрока.' };
  }

  const nextRedUids = isCurrentlyRed
    ? currentRoom.redUids.filter((id) => id !== safeUid)
    : [...currentRoom.redUids, safeUid];
  const nextBlueUids = !isCurrentlyRed
    ? currentRoom.blueUids.filter((id) => id !== safeUid)
    : [...currentRoom.blueUids, safeUid];

  const newIndex =
    targetTeam === 'red'
      ? nextRedUids.indexOf(safeUid)
      : nextBlueUids.indexOf(safeUid);
  const spawn = getTeamSpawnPosition(targetTeam, Math.max(0, newIndex));
  const now = Date.now();

  const updatedRoom: SyncedRoomRecord = {
    ...currentRoom,
    redUids: nextRedUids,
    blueUids: nextBlueUids,
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
    heartbeatAtMs: now,
  };

  const updatedPlayer: SyncedPlayerRecord = {
    playerId: safeUid,
    roomId: room.roomId,
    nickname,
    jerseyNumber,
    team: targetTeam,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    kicking: false,
    pingMs,
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
  };

  memoryRooms.set(room.roomId, updatedRoom);
  const pMap = memoryPlayers.get(room.roomId) || {};
  pMap[safeUid] = updatedPlayer;
  memoryPlayers.set(room.roomId, pMap);
  bc?.postMessage({ type: 'room', room: updatedRoom });
  bc?.postMessage({ type: 'player', player: updatedPlayer });

  realtimeWsBroker.publishPlayer(updatedPlayer, true);
  realtimeWsBroker.publishRoom(updatedRoom, true);

  if (!isFirestoreQuotaExceeded) {
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'rooms', room.roomId), {
        hostUid: sanitizeId(updatedRoom.hostUid),
        hostName: sanitizeNickname(updatedRoom.hostName),
        memberUids: updatedRoom.memberUids.map(sanitizeId).slice(0, 10),
        redUids: updatedRoom.redUids.map(sanitizeId).slice(0, 5),
        blueUids: updatedRoom.blueUids.map(sanitizeId).slice(0, 5),
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'rooms', room.roomId, 'players', safeUid), {
        team: targetTeam,
        nickname,
        jerseyNumber,
        x: spawn.x,
        y: spawn.y,
        vx: 0,
        vy: 0,
        kicking: false,
        updatedAt: serverTimestamp(),
      });
      batch.commit().catch((err) => {
        handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
    }
  }

  return { switched: true };
}

export async function startMatchByHost(
  room: MatchRoomDoc,
  playersMap: Record<string, RoomPlayerDoc>
): Promise<void> {
  postApiJson('/api/mp/room/start', { roomId: room.roomId }).catch(() => {});

  const now = Date.now();
  const updatedRoom: SyncedRoomRecord = {
    ...room,
    status: 'playing',
    redScore: 0,
    blueScore: 0,
    matchStartedAtMs: now,
    winnerTeam: 'none',
    ballX: FIELD_CENTER_X,
    ballY: FIELD_CENTER_Y,
    ballVx: 0,
    ballVy: 0,
    eventState: 'normal',
    eventTeam: 'none',
    eventUntilMs: 0,
    lastTouchTeam: 'none',
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
    heartbeatAtMs: now,
  };

  memoryRooms.set(room.roomId, updatedRoom);
  const pMap = memoryPlayers.get(room.roomId) || {};
  const resetPlayersList: SyncedPlayerRecord[] = [];

  room.redUids.forEach((uid, idx) => {
    const existing =
      playersMap[uid] ||
      realtimeWsBroker.getRoomPlayers(room.roomId)[uid] ||
      pMap[uid];
    const sp = getTeamSpawnPosition('red', idx);
    const pDoc: SyncedPlayerRecord = {
      playerId: uid,
      roomId: room.roomId,
      nickname: existing?.nickname || 'Player',
      jerseyNumber: existing?.jerseyNumber || idx + 1,
      team: 'red',
      x: sp.x,
      y: sp.y,
      vx: 0,
      vy: 0,
      kicking: false,
      pingMs: existing?.pingMs || 20,
      seq: realtimeWsBroker.nextMonotonicSeq(),
      updatedAtMs: now,
    };
    pMap[uid] = pDoc;
    resetPlayersList.push(pDoc);
  });

  room.blueUids.forEach((uid, idx) => {
    const existing =
      playersMap[uid] ||
      realtimeWsBroker.getRoomPlayers(room.roomId)[uid] ||
      pMap[uid];
    const sp = getTeamSpawnPosition('blue', idx);
    const pDoc: SyncedPlayerRecord = {
      playerId: uid,
      roomId: room.roomId,
      nickname: existing?.nickname || 'Player',
      jerseyNumber: existing?.jerseyNumber || idx + 1,
      team: 'blue',
      x: sp.x,
      y: sp.y,
      vx: 0,
      vy: 0,
      kicking: false,
      pingMs: existing?.pingMs || 20,
      seq: realtimeWsBroker.nextMonotonicSeq(),
      updatedAtMs: now,
    };
    pMap[uid] = pDoc;
    resetPlayersList.push(pDoc);
  });

  memoryPlayers.set(room.roomId, pMap);
  bc?.postMessage({ type: 'room', room: updatedRoom });
  for (const pDoc of resetPlayersList) {
    bc?.postMessage({ type: 'player', player: pDoc });
    realtimeWsBroker.publishPlayer(pDoc, true);
  }
  realtimeWsBroker.publishRoom(updatedRoom, true);

  if (!isFirestoreQuotaExceeded) {
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'rooms', room.roomId), {
        status: 'playing',
        matchStartedAtMs: now,
        ballX: FIELD_CENTER_X,
        ballY: FIELD_CENTER_Y,
        ballVx: 0,
        ballVy: 0,
        eventState: 'normal',
        eventTeam: 'none',
        eventUntilMs: 0,
        lastTouchTeam: 'none',
        updatedAt: serverTimestamp(),
      });
      for (const pDoc of resetPlayersList) {
        batch.update(doc(db, 'rooms', room.roomId, 'players', pDoc.playerId), {
          x: pDoc.x,
          y: pDoc.y,
          vx: 0,
          vy: 0,
          kicking: false,
          updatedAt: serverTimestamp(),
        });
      }
      batch.commit().catch((err) => {
        handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
    }
  }
}

export async function syncLocalPlayerDisc(
  roomId: string,
  uid: string,
  state: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    kicking: boolean;
    keyMask?: number;
  },
  profileFallback?: { nickname: string; jerseyNumber: number; team: TeamColor }
): Promise<void> {
  const now = Date.now();
  const nextSeq = realtimeWsBroker.nextMonotonicSeq();
  const safeX = Math.round(clamp(state.x, 0, CANVAS_WIDTH) * 10000) / 10000;
  const safeY = Math.round(clamp(state.y, 0, CANVAS_HEIGHT) * 10000) / 10000;
  const safeVx =
    Math.round(clamp(state.vx, -PLAYER_MAX_SPEED * 2, PLAYER_MAX_SPEED * 2) * 10000) /
    10000;
  const safeVy =
    Math.round(clamp(state.vy, -PLAYER_MAX_SPEED * 2, PLAYER_MAX_SPEED * 2) * 10000) /
    10000;
  const safeKicking = Boolean(state.kicking);
  const pingMs = realtimeWsBroker.getLocalPingMs();

  const pMap = memoryPlayers.get(roomId) || {};
  const existing =
    pMap[uid] || realtimeWsBroker.getRoomPlayers(roomId)[uid];

  const updatedPlayer: SyncedPlayerRecord = {
    playerId: uid,
    roomId,
    nickname: existing?.nickname || profileFallback?.nickname || 'Player',
    jerseyNumber: existing?.jerseyNumber || profileFallback?.jerseyNumber || 10,
    team: existing?.team || profileFallback?.team || 'red',
    x: safeX,
    y: safeY,
    vx: safeVx,
    vy: safeVy,
    kicking: safeKicking,
    keyMask: state.keyMask,
    pingMs,
    seq: nextSeq,
    updatedAtMs: now,
  };

  pMap[uid] = updatedPlayer;
  memoryPlayers.set(roomId, pMap);
  bc?.postMessage({ type: 'player', player: updatedPlayer });

  // Non-retained 80-byte WebSocket fast tick (<5ms delivery on /ws!)
  realtimeWsBroker.publishFastPlayerTick(
    roomId,
    uid,
    safeX,
    safeY,
    safeVx,
    safeVy,
    safeKicking,
    pingMs,
    nextSeq,
    profileFallback
      ? { ...profileFallback, keyMask: state.keyMask }
      : undefined
  );
}

const hostAuthoritativePlayers = new Map<
  string,
  Record<
    string,
    {
      x: number;
      y: number;
      vx: number;
      vy: number;
      kicking: boolean;
      ts: number;
    }
  >
>();

export function getHostAuthoritativePlayerState(
  roomId: string,
  uid: string
): {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kicking: boolean;
  ts: number;
} | null {
  const rMap = hostAuthoritativePlayers.get(roomId);
  return rMap ? rMap[uid] || null : null;
}

export function applyWebRTCAuthoritativeSnapshot(
  roomId: string,
  hostUid: string,
  snap: FastAuthoritativeSnapshot,
  localUid?: string
): void {
  const now = Date.now();
  const nextSeq = realtimeWsBroker.nextMonotonicSeq();
  const baseRoom = memoryRooms.get(roomId) || realtimeWsBroker.getRoom(roomId);
  const wsRoom = realtimeWsBroker.getRoom(roomId);
  const isEchoOfLocalBall = Boolean(localUid && snap.actorUid === localUid);
  // Prevent dual-stream jitter when /ws is actively delivering ball ticks (<80ms)
  const wsBallFresh = Boolean(
    wsRoom &&
      now - (wsRoom.updatedAtMs || 0) < 80 &&
      snap.eventState === 'normal'
  );

  if (baseRoom && !isEchoOfLocalBall && !wsBallFresh) {
    memoryRooms.set(roomId, {
      ...baseRoom,
      redScore: Math.max(baseRoom.redScore, snap.redScore),
      blueScore: Math.max(baseRoom.blueScore, snap.blueScore),
      ballX: snap.ballX,
      ballY: snap.ballY,
      ballVx: snap.ballVx,
      ballVy: snap.ballVy,
      eventState: snap.eventState,
      eventTeam: snap.eventTeam,
      eventUntilMs: snap.eventUntilMs,
      lastTouchTeam: snap.lastTouchTeam,
      actorUid: snap.actorUid,
      seq: nextSeq,
      updatedAtMs: now,
      heartbeatAtMs: now,
    });
  }

  const authMap = hostAuthoritativePlayers.get(roomId) || {};
  const pMap = memoryPlayers.get(roomId) || {};
  const wsPlayers = realtimeWsBroker.getRoomPlayers(roomId);

  for (const [uid, pState] of Object.entries(snap.players)) {
    authMap[uid] = {
      x: pState.x,
      y: pState.y,
      vx: pState.vx,
      vy: pState.vy,
      kicking: pState.kicking,
      ts: now,
    };
    if (localUid && uid === localUid) continue;

    // Only write into memoryPlayers if /ws hasn't delivered a fresh fast tick for this player in the last 120ms.
    // This eliminates dual-channel packet fighting (WebRTC vs /ws) that caused 0.5s sawtooth shudder!
    const wsP = wsPlayers[uid];
    if (wsP && now - (wsP.updatedAtMs || 0) < 120) {
      continue;
    }

    const existing = pMap[uid] || wsP;
    pMap[uid] = {
      playerId: uid,
      roomId,
      nickname: existing?.nickname || (uid === hostUid ? baseRoom?.hostName || 'Host' : 'Player'),
      jerseyNumber: existing?.jerseyNumber || 10,
      team: existing?.team || (baseRoom?.blueUids.includes(uid) ? 'blue' : 'red'),
      x: pState.x,
      y: pState.y,
      vx: pState.vx,
      vy: pState.vy,
      kicking: pState.kicking,
      keyMask: existing?.keyMask,
      pingMs: existing?.pingMs || 18,
      seq: nextSeq,
      updatedAtMs: now,
    };
  }
  hostAuthoritativePlayers.set(roomId, authMap);
  memoryPlayers.set(roomId, pMap);
}

export async function syncRoomGameplayState(
  roomId: string,
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
    actorUid?: string;
  }
): Promise<void> {
  const now = Date.now();
  const nextSeq = realtimeWsBroker.nextMonotonicSeq();
  const baseRoom =
    memoryRooms.get(roomId) || realtimeWsBroker.getRoom(roomId);

  const safeBallX =
    Math.round(clamp(patch.ballX, -100, CANVAS_WIDTH + 100) * 10000) / 10000;
  const safeBallY =
    Math.round(clamp(patch.ballY, -100, CANVAS_HEIGHT + 100) * 10000) / 10000;
  const safeBallVx =
    Math.round(clamp(patch.ballVx, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2) * 10000) /
    10000;
  const safeBallVy =
    Math.round(clamp(patch.ballVy, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2) * 10000) /
    10000;

  if (baseRoom) {
    const inGoalCelebration =
      baseRoom.eventState === 'goal' &&
      now < baseRoom.eventUntilMs &&
      patch.eventState !== 'goal';

    const updatedRoom: SyncedRoomRecord = inGoalCelebration
      ? {
          ...baseRoom,
          ballX: safeBallX,
          ballY: safeBallY,
          ballVx: safeBallVx,
          ballVy: safeBallVy,
          actorUid: patch.actorUid,
          seq: nextSeq,
          updatedAtMs: now,
          heartbeatAtMs: now,
        }
      : {
          ...baseRoom,
          redScore: Math.max(baseRoom.redScore, clamp(Math.round(patch.redScore), 0, 99)),
          blueScore: Math.max(
            baseRoom.blueScore,
            clamp(Math.round(patch.blueScore), 0, 99)
          ),
          ballX: safeBallX,
          ballY: safeBallY,
          ballVx: safeBallVx,
          ballVy: safeBallVy,
          eventState: patch.eventState,
          eventTeam: patch.eventTeam,
          eventUntilMs: Math.max(0, Math.round(patch.eventUntilMs)),
          lastTouchTeam: patch.lastTouchTeam,
          actorUid: patch.actorUid,
          seq: nextSeq,
          updatedAtMs: now,
          heartbeatAtMs: now,
        };

    memoryRooms.set(roomId, updatedRoom);
    bc?.postMessage({ type: 'room', room: updatedRoom });
  }

  realtimeWsBroker.publishFastBallTick(
    roomId,
    patch.actorUid || '',
    {
      redScore: clamp(Math.round(patch.redScore), 0, 99),
      blueScore: clamp(Math.round(patch.blueScore), 0, 99),
      ballX: safeBallX,
      ballY: safeBallY,
      ballVx: safeBallVx,
      ballVy: safeBallVy,
      eventState: patch.eventState,
      eventTeam: patch.eventTeam,
      eventUntilMs: Math.max(0, Math.round(patch.eventUntilMs)),
      lastTouchTeam: patch.lastTouchTeam,
    },
    nextSeq
  );
}

export async function registerGoalInNet(
  room: MatchRoomDoc,
  scoringTeam: TeamColor,
  newRedScore: number,
  newBlueScore: number,
  goalPauseUntilMs: number,
  ballState: { x: number; y: number; vx: number; vy: number }
): Promise<void> {
  const now = Date.now();
  const safeRed = clamp(Math.round(newRedScore), 0, 99);
  const safeBlue = clamp(Math.round(newBlueScore), 0, 99);
  const safeX = Math.round(clamp(ballState.x, -100, CANVAS_WIDTH + 100) * 10) / 10;
  const safeY = Math.round(clamp(ballState.y, -100, CANVAS_HEIGHT + 100) * 10) / 10;
  const safeVx =
    Math.round(clamp(ballState.vx, -BALL_MAX_SPEED, BALL_MAX_SPEED) * 100) / 100;
  const safeVy =
    Math.round(clamp(ballState.vy, -BALL_MAX_SPEED, BALL_MAX_SPEED) * 100) / 100;

  const baseRoom =
    memoryRooms.get(room.roomId) ||
    realtimeWsBroker.getRoom(room.roomId) ||
    ({ ...room, updatedAtMs: now } as SyncedRoomRecord);

  const updatedRoom: SyncedRoomRecord = {
    ...baseRoom,
    redScore: safeRed,
    blueScore: safeBlue,
    ballX: safeX,
    ballY: safeY,
    ballVx: safeVx,
    ballVy: safeVy,
    eventState: 'goal',
    eventTeam: scoringTeam,
    eventUntilMs: Math.round(goalPauseUntilMs),
    lastTouchTeam: 'none',
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
    heartbeatAtMs: now,
  };

  memoryRooms.set(room.roomId, updatedRoom);
  bc?.postMessage({ type: 'room', room: updatedRoom });

  realtimeWsBroker.publishRoom(updatedRoom, true);
  realtimeWsBroker.publishFastBallTick(
    room.roomId,
    room.hostUid,
    {
      redScore: safeRed,
      blueScore: safeBlue,
      ballX: safeX,
      ballY: safeY,
      ballVx: safeVx,
      ballVy: safeVy,
      eventState: 'goal',
      eventTeam: scoringTeam,
      eventUntilMs: Math.round(goalPauseUntilMs),
      lastTouchTeam: 'none',
    },
    now
  );

  if (apiReachable) {
    postApiJson('/api/mp/room/goal', {
      roomId: room.roomId,
      scoringTeam,
      newRedScore: safeRed,
      newBlueScore: safeBlue,
      goalPauseUntilMs,
      ballState: { x: safeX, y: safeY, vx: safeVx, vy: safeVy },
    }).catch(() => {});
  }

  if (!isFirestoreQuotaExceeded) {
    updateDoc(doc(db, 'rooms', room.roomId), {
      redScore: safeRed,
      blueScore: safeBlue,
      ballX: safeX,
      ballY: safeY,
      ballVx: safeVx,
      ballVy: safeVy,
      eventState: 'goal',
      eventTeam: scoringTeam,
      eventUntilMs: Math.round(goalPauseUntilMs),
      lastTouchTeam: 'none',
      updatedAt: serverTimestamp(),
    }).catch((err) => {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
    });
  }
}

export async function resetFormationAfterGoalDelay(
  room: MatchRoomDoc,
  playersMap: Record<string, RoomPlayerDoc>,
  currentUid: string
): Promise<void> {
  if (room.hostUid !== currentUid) return;

  const now = Date.now();
  const baseRoom =
    memoryRooms.get(room.roomId) ||
    realtimeWsBroker.getRoom(room.roomId) ||
    ({ ...room, updatedAtMs: now } as SyncedRoomRecord);

  const updatedRoom: SyncedRoomRecord = {
    ...baseRoom,
    ballX: FIELD_CENTER_X,
    ballY: FIELD_CENTER_Y,
    ballVx: 0,
    ballVy: 0,
    eventState: 'normal',
    eventTeam: 'none',
    eventUntilMs: 0,
    lastTouchTeam: 'none',
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
    heartbeatAtMs: now,
  };

  memoryRooms.set(room.roomId, updatedRoom);
  const pMap = memoryPlayers.get(room.roomId) || {};
  const resetPlayersList: SyncedPlayerRecord[] = [];

  updatedRoom.redUids.forEach((uid, idx) => {
    const existing =
      playersMap[uid] ||
      realtimeWsBroker.getRoomPlayers(room.roomId)[uid] ||
      pMap[uid];
    if (existing) {
      const sp = getTeamSpawnPosition('red', idx);
      const pDoc: SyncedPlayerRecord = {
        ...existing,
        x: sp.x,
        y: sp.y,
        vx: 0,
        vy: 0,
        kicking: false,
        seq: realtimeWsBroker.nextMonotonicSeq(),
        updatedAtMs: now,
      };
      pMap[uid] = pDoc;
      resetPlayersList.push(pDoc);
    }
  });

  updatedRoom.blueUids.forEach((uid, idx) => {
    const existing =
      playersMap[uid] ||
      realtimeWsBroker.getRoomPlayers(room.roomId)[uid] ||
      pMap[uid];
    if (existing) {
      const sp = getTeamSpawnPosition('blue', idx);
      const pDoc: SyncedPlayerRecord = {
        ...existing,
        x: sp.x,
        y: sp.y,
        vx: 0,
        vy: 0,
        kicking: false,
        seq: realtimeWsBroker.nextMonotonicSeq(),
        updatedAtMs: now,
      };
      pMap[uid] = pDoc;
      resetPlayersList.push(pDoc);
    }
  });

  memoryPlayers.set(room.roomId, pMap);
  bc?.postMessage({ type: 'room', room: updatedRoom });
  for (const pDoc of resetPlayersList) {
    bc?.postMessage({ type: 'player', player: pDoc });
    realtimeWsBroker.publishPlayer(pDoc, true);
  }
  realtimeWsBroker.publishRoom(updatedRoom, true);

  if (apiReachable) {
    postApiJson('/api/mp/room/reset-formation', { roomId: room.roomId }).catch(
      () => {}
    );
  }
}

export async function finishMatchRoom(
  room: MatchRoomDoc,
  currentUid?: string
): Promise<void> {
  if (room.status === 'finished') return;
  const now = Date.now();

  let winner: WinnerTeam = 'draw';
  if (room.redScore > room.blueScore) winner = 'red';
  else if (room.blueScore > room.redScore) winner = 'blue';

  const updatedRoom: SyncedRoomRecord = {
    ...room,
    status: 'finished',
    winnerTeam: winner,
    ballX: FIELD_CENTER_X,
    ballY: FIELD_CENTER_Y,
    ballVx: 0,
    ballVy: 0,
    eventState: 'normal',
    eventTeam: 'none',
    eventUntilMs: 0,
    seq: realtimeWsBroker.nextMonotonicSeq(),
    updatedAtMs: now,
    heartbeatAtMs: now,
  };

  memoryRooms.set(room.roomId, updatedRoom);
  bc?.postMessage({ type: 'room', room: updatedRoom });

  realtimeWsBroker.publishRoom(updatedRoom, false);
  realtimeWsBroker.deleteRoom(room.roomId, room.memberUids);

  if (apiReachable) {
    postApiJson('/api/mp/room/finish', { roomId: room.roomId }).catch(() => {});
  }

  if (!isFirestoreQuotaExceeded) {
    try {
      await updateDoc(doc(db, 'rooms', room.roomId), {
        status: 'finished',
        winnerTeam: winner,
        ballX: FIELD_CENTER_X,
        ballY: FIELD_CENTER_Y,
        ballVx: 0,
        ballVy: 0,
        eventState: 'normal',
        eventTeam: 'none',
        eventUntilMs: 0,
        updatedAt: serverTimestamp(),
      });
      if (currentUid) {
        await removeRoomIdFromFirestoreLobby(room.roomId, currentUid);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
    }
  }
}

export async function deleteOrLeaveMatchRoom(
  room: MatchRoomDoc,
  currentUid: string
): Promise<void> {
  const safeUid = sanitizeId(currentUid);

  if (apiReachable) {
    postApiJson('/api/mp/room/leave', {
      roomId: room.roomId,
      uid: safeUid,
    }).catch(() => {});
  }

  const currentRoom =
    realtimeWsBroker.getRoom(room.roomId) ||
    memoryRooms.get(room.roomId) ||
    ({ ...room, updatedAtMs: Date.now() } as SyncedRoomRecord);

  const remainingMembers = (currentRoom.memberUids || []).filter(
    (id) => id !== safeUid
  );
  const shouldDestroy =
    remainingMembers.length === 0 ||
    currentRoom.status === 'finished' ||
    currentRoom.status === 'playing' ||
    currentRoom.hostUid === safeUid;

  if (shouldDestroy) {
    memoryRooms.delete(room.roomId);
    memoryPlayers.delete(room.roomId);
    bc?.postMessage({ type: 'delete_room', roomId: room.roomId });

    realtimeWsBroker.deleteRoom(room.roomId, currentRoom.memberUids || [safeUid]);

    if (!isFirestoreQuotaExceeded) {
      try {
        await removeRoomIdFromFirestoreLobby(room.roomId, safeUid);
        await deleteDoc(doc(db, 'rooms', room.roomId, 'players', safeUid)).catch(
          () => {}
        );
        await deleteDoc(doc(db, 'rooms', room.roomId)).catch(() => {});
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `rooms/${room.roomId}`);
      }
    }
  } else {
    const nextRed = (currentRoom.redUids || []).filter((id) => id !== safeUid);
    const nextBlue = (currentRoom.blueUids || []).filter((id) => id !== safeUid);
    const pMap = memoryPlayers.get(room.roomId) || {};
    delete pMap[safeUid];
    memoryPlayers.set(room.roomId, pMap);

    const nextHostUid =
      currentRoom.hostUid === safeUid ? remainingMembers[0] : currentRoom.hostUid;
    const nextHostName =
      currentRoom.hostUid === safeUid
        ? pMap[nextHostUid]?.nickname || 'Хост'
        : currentRoom.hostName;
    const now = Date.now();

    const updatedRoom: SyncedRoomRecord = {
      ...currentRoom,
      hostUid: nextHostUid,
      hostName: nextHostName,
      memberUids: remainingMembers,
      redUids: nextRed,
      blueUids: nextBlue,
      seq: realtimeWsBroker.nextMonotonicSeq(),
      updatedAtMs: now,
      heartbeatAtMs: now,
    };

    memoryRooms.set(room.roomId, updatedRoom);
    bc?.postMessage({ type: 'room', room: updatedRoom });

    realtimeWsBroker.deletePlayer(room.roomId, safeUid);
    realtimeWsBroker.publishRoom(updatedRoom, true);

    if (!isFirestoreQuotaExceeded) {
      try {
        await updateDoc(doc(db, 'rooms', room.roomId), {
          hostUid: sanitizeId(nextHostUid),
          hostName: sanitizeNickname(nextHostName),
          memberUids: remainingMembers.map(sanitizeId).slice(0, 10),
          redUids: nextRed.map(sanitizeId).slice(0, 5),
          blueUids: nextBlue.map(sanitizeId).slice(0, 5),
          updatedAt: serverTimestamp(),
        });
        await deleteDoc(doc(db, 'rooms', room.roomId, 'players', safeUid)).catch(
          () => {}
        );
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
      }
    }
  }
}

export async function clearAllStaleRooms(
  roomsList: MatchRoomDoc[],
  currentUid: string
): Promise<void> {
  if (apiReachable) {
    postApiJson('/api/mp/lobby/clear', {}).catch(() => {});
  }
  for (const r of roomsList) {
    memoryRooms.delete(r.roomId);
    memoryPlayers.delete(r.roomId);
    realtimeWsBroker.deleteRoom(r.roomId, r.memberUids);
    if (!isFirestoreQuotaExceeded) {
      deleteDoc(doc(db, 'rooms', r.roomId)).catch(() => {});
    }
  }
  if (!isFirestoreQuotaExceeded) {
    updateDoc(doc(db, 'lobbies', 'main'), {
      roomIds: [],
      updatedBy: sanitizeId(currentUid),
      updatedAt: serverTimestamp(),
    }).catch(() => {});
  }
}

export async function pruneStaleRoomsFromLobby(
  staleRoomIds: string[],
  currentUid: string,
  _skipDeleteDocIds: string[] = []
): Promise<void> {
  for (const rId of staleRoomIds) {
    await deleteOrLeaveMatchRoom(
      { roomId: rId } as MatchRoomDoc,
      currentUid
    ).catch(() => {});
  }
}

/**
 * WebRTC Signaling Exchange (SDP Offer/Answer + ICE Candidates)
 * Relays across BroadcastChannel, WebSocket Broker, and Firebase signaling
 */
export function sendWebRTCSignal(signal: WebRTCSignalMessage): void {
  bc?.postMessage({ type: 'rtc_signal', signal });
  realtimeWsBroker.publishWebRTCSignal(signal.roomId, signal);
}

export function subscribeToWebRTCSignals(
  roomId: string,
  localUid: string,
  onSignal: (msg: WebRTCSignalMessage) => void
): () => void {
  const handleRaw = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as WebRTCSignalMessage;
    if (
      msg.roomId === roomId &&
      msg.toUid === localUid &&
      msg.fromUid !== localUid
    ) {
      onSignal(msg);
    }
  };

  const bcListener = (sig: WebRTCSignalMessage) => handleRaw(sig);
  localRtcSignalListeners.add(bcListener);
  const unsubWs = realtimeWsBroker.subscribeWebRTCSignals(roomId, handleRaw);

  return () => {
    localRtcSignalListeners.delete(bcListener);
    unsubWs();
  };
}

