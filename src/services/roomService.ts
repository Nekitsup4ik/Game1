import {
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
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

const LOCAL_ROOMS_KEY = 'haxarena_fallback_rooms_v1';
const LOCAL_PLAYERS_KEY = 'haxarena_fallback_players_v1';
const REMOTE_API_ORIGIN = 'https://ais-pre-j66jesv2sgfs4qsfj6vovy-801904163984.us-east1.run.app';

// Start global WebSocket multiplayer broker immediately
realtimeWsBroker.start();

const bc =
  typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel('haxarena_mp_channel')
    : null;

function notifyPeers(roomId?: string) {
  try {
    bc?.postMessage({ type: 'sync', roomId, ts: Date.now() });
  } catch {
    // ignore
  }
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

function loadLocalRooms(): Record<string, SyncedRoomRecord> {
  try {
    const raw = localStorage.getItem(LOCAL_ROOMS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalRooms(rooms: Record<string, SyncedRoomRecord>) {
  try {
    localStorage.setItem(LOCAL_ROOMS_KEY, JSON.stringify(rooms));
  } catch {
    // ignore
  }
}

function loadLocalPlayers(): Record<string, Record<string, SyncedPlayerRecord>> {
  try {
    const raw = localStorage.getItem(LOCAL_PLAYERS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalPlayers(
  players: Record<string, Record<string, SyncedPlayerRecord>>
) {
  try {
    localStorage.setItem(LOCAL_PLAYERS_KEY, JSON.stringify(players));
  } catch {
    // ignore
  }
}

function getApiBaseUrls(): string[] {
  if (typeof window === 'undefined') return [''];
  const host = window.location.hostname;
  if (host.endsWith('.run.app') || host === 'localhost' || host === '127.0.0.1') {
    return [''];
  }
  // When running on GitHub Pages or another static host, try remote backend if reachable
  return [REMOTE_API_ORIGIN];
}

async function fetchApiJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  for (const base of getApiBaseUrls()) {
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 1800);
      const res = await fetch(`${base}${path}`, {
        ...init,
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        return (await res.json()) as T;
      }
    } catch {
      // ignore and fall through
    }
  }
  return null;
}

async function postApiJson<T>(path: string, body: unknown): Promise<T | null> {
  return fetchApiJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
      ].slice(0, 20);
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
    const nextIds = existingIds.filter((id) => id !== roomId).slice(0, 20);
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
  let firestoreRooms: MatchRoomDoc[] = [];
  let apiRooms: MatchRoomDoc[] = [];

  const mergeAndEmit = () => {
    if (cancelled) return;
    const mergedMap = new Map<string, SyncedRoomRecord>();

    // 1. Local storage rooms
    for (const r of Object.values(loadLocalRooms())) {
      if (r.status !== 'finished' && r.memberUids.length > 0) {
        mergedMap.set(r.roomId, r);
      }
    }

    // 2. Firestore rooms
    for (const r of firestoreRooms) {
      if (r.status !== 'finished' && r.memberUids.length > 0) {
        const prev = mergedMap.get(r.roomId);
        const rUp = (r as SyncedRoomRecord).updatedAtMs || Date.now();
        if (!prev || rUp >= (prev.updatedAtMs || 0)) {
          mergedMap.set(r.roomId, { ...r, updatedAtMs: rUp });
        }
      }
    }

    // 3. Express API rooms
    for (const r of apiRooms) {
      if (r.status !== 'finished' && r.memberUids.length > 0) {
        const prev = mergedMap.get(r.roomId);
        const rUp = (r as SyncedRoomRecord).updatedAtMs || Date.now();
        if (!prev || rUp >= (prev.updatedAtMs || 0)) {
          mergedMap.set(r.roomId, { ...r, updatedAtMs: rUp });
        }
      }
    }

    // 4. Real-time WebSocket Broker rooms (works across all browsers & GitHub Pages!)
    for (const r of realtimeWsBroker.getActiveLobbyRooms()) {
      if (r.status !== 'finished' && r.memberUids.length > 0) {
        const prev = mergedMap.get(r.roomId);
        if (!prev || (r.updatedAtMs || 0) >= (prev.updatedAtMs || 0) - 500) {
          mergedMap.set(r.roomId, r);
        }
      }
    }

    const sorted = Array.from(mergedMap.values()).sort(
      (a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0)
    );
    onUpdate(sorted);
  };

  // Subscribe to WebSocket Broker updates
  const unsubWs = realtimeWsBroker.subscribe(() => {
    mergeAndEmit();
  });

  // Subscribe to Google Firebase Firestore /lobbies/main
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
        const ids = Array.isArray(data.roomIds) ? data.roomIds.slice(0, 15) : [];
        const loaded: MatchRoomDoc[] = [];
        for (const id of ids) {
          if (isFirestoreQuotaExceeded) break;
          try {
            const rSnap = await getDoc(doc(db, 'rooms', id));
            if (rSnap.exists()) {
              const rData = rSnap.data() as MatchRoomDoc;
              if (rData.status !== 'finished' && rData.memberUids?.length > 0) {
                loaded.push(rData);
                realtimeWsBroker.publishRoom(
                  { ...rData, updatedAtMs: Date.now() },
                  true
                );
              }
            }
          } catch (err) {
            handleFirestoreError(err, OperationType.GET, `rooms/${id}`);
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

  // Poll Express API if available
  const fetchLobbyApi = async () => {
    if (cancelled) return;
    const data = await fetchApiJson<{ rooms?: MatchRoomDoc[] }>('/api/mp/lobby');
    if (!cancelled && data && Array.isArray(data.rooms)) {
      apiRooms = data.rooms;
    }
    mergeAndEmit();
  };

  fetchLobbyApi();
  const intervalId = window.setInterval(fetchLobbyApi, 900);

  const handleMessage = () => {
    mergeAndEmit();
  };
  bc?.addEventListener('message', handleMessage);

  return () => {
    cancelled = true;
    unsubWs();
    if (unsubFirestore) unsubFirestore();
    window.clearInterval(intervalId);
    bc?.removeEventListener('message', handleMessage);
  };
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
  let fsRoom: SyncedRoomRecord | null = null;
  const fsPlayers: Record<string, SyncedPlayerRecord> = {};
  let apiRoom: SyncedRoomRecord | null = null;
  let apiPlayers: Record<string, SyncedPlayerRecord> = {};

  const mergeRoomAndEmit = () => {
    if (cancelled) return;
    const localRooms = loadLocalRooms();
    const localPlayers = loadLocalPlayers()[roomId] || {};
    const wsRoom = realtimeWsBroker.getRoom(roomId);
    const wsPlayers = realtimeWsBroker.getRoomPlayers(roomId);

    // Pick freshest room state across WS, API, Firestore, and LocalStorage
    const candidates = [
      localRooms[roomId],
      fsRoom,
      apiRoom,
      wsRoom,
    ].filter(Boolean) as SyncedRoomRecord[];

    if (candidates.length === 0) {
      onUpdate(null, {});
      return;
    }

    candidates.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    const bestRoom = { ...candidates[0] };

    // Always preserve highest goal score & active goal celebration state
    for (const c of candidates) {
      if (c.redScore > bestRoom.redScore) bestRoom.redScore = c.redScore;
      if (c.blueScore > bestRoom.blueScore) bestRoom.blueScore = c.blueScore;
      if (
        c.eventState === 'goal' &&
        c.eventUntilMs > Date.now() &&
        bestRoom.eventState !== 'goal'
      ) {
        bestRoom.eventState = 'goal';
        bestRoom.eventTeam = c.eventTeam;
        bestRoom.eventUntilMs = c.eventUntilMs;
      }
      if (c.status === 'playing' && bestRoom.status === 'waiting') {
        bestRoom.status = 'playing';
        bestRoom.matchStartedAtMs = c.matchStartedAtMs || bestRoom.matchStartedAtMs;
      }
      if (c.status === 'finished') {
        bestRoom.status = 'finished';
        bestRoom.winnerTeam = c.winnerTeam;
      }
    }

    // Merge players across all sources by freshest updatedAtMs
    const mergedPlayers: Record<string, SyncedPlayerRecord> = {};
    const allPlayerMaps = [localPlayers, fsPlayers, apiPlayers, wsPlayers];
    for (const pMap of allPlayerMaps) {
      for (const [uid, pDoc] of Object.entries(pMap)) {
        if (!pDoc) continue;
        const prev = mergedPlayers[uid];
        if (!prev || (pDoc.updatedAtMs || 0) >= (prev.updatedAtMs || 0)) {
          mergedPlayers[uid] = pDoc;
        }
      }
    }

    // Ensure memberUids includes any known active players in waiting state
    const finalPlayers: Record<string, RoomPlayerDoc> = {};
    for (const uid of bestRoom.memberUids) {
      if (mergedPlayers[uid]) {
        finalPlayers[uid] = mergedPlayers[uid];
      }
    }
    for (const [uid, pDoc] of Object.entries(mergedPlayers)) {
      if (!finalPlayers[uid] && bestRoom.memberUids.includes(uid)) {
        finalPlayers[uid] = pDoc;
      }
    }

    onUpdate(bestRoom, finalPlayers);
  };

  // 1. Real-time WebSocket Broker listener (instant ~20ms updates)
  const unsubWs = realtimeWsBroker.subscribe((changedRoomId) => {
    if (!changedRoomId || changedRoomId === roomId) {
      mergeRoomAndEmit();
    }
  });

  // 2. Google Firebase Firestore onSnapshot listener for room + member players
  let unsubFsRoom: (() => void) | null = null;
  const playerUnsubs = new Map<string, () => void>();

  if (!isFirestoreQuotaExceeded) {
    const roomRef = doc(db, 'rooms', roomId);
    unsubFsRoom = onSnapshot(
      roomRef,
      (snap) => {
        if (cancelled || isFirestoreQuotaExceeded) return;
        if (!snap.exists()) {
          fsRoom = null;
          mergeRoomAndEmit();
          return;
        }
        const data = snap.data() as MatchRoomDoc;
        fsRoom = { ...data, updatedAtMs: Date.now() };

        const currentMembers = new Set(data.memberUids || []);
        for (const [uid, unsub] of playerUnsubs.entries()) {
          if (!currentMembers.has(uid)) {
            unsub();
            playerUnsubs.delete(uid);
            delete fsPlayers[uid];
          }
        }

        for (const uid of currentMembers) {
          if (!playerUnsubs.has(uid) && !isFirestoreQuotaExceeded) {
            const pRef = doc(db, 'rooms', roomId, 'players', uid);
            const pUnsub = onSnapshot(
              pRef,
              (pSnap) => {
                if (cancelled) return;
                if (pSnap.exists()) {
                  fsPlayers[uid] = {
                    ...(pSnap.data() as RoomPlayerDoc),
                    updatedAtMs: Date.now(),
                  };
                  mergeRoomAndEmit();
                }
              },
              (err) => {
                handleFirestoreError(
                  err,
                  OperationType.GET,
                  `rooms/${roomId}/players/${uid}`
                );
              }
            );
            playerUnsubs.set(uid, pUnsub);
          }
        }

        mergeRoomAndEmit();
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, `rooms/${roomId}`);
      }
    );
  }

  // 3. Express API polling if backend server is reachable
  const fetchRoomApi = async () => {
    if (cancelled || inFlight) return;
    inFlight = true;
    const data = await fetchApiJson<{
      room: SyncedRoomRecord | null;
      players: Record<string, SyncedPlayerRecord>;
    }>(`/api/mp/room/${encodeURIComponent(roomId)}`);
    if (!cancelled && data && data.room) {
      apiRoom = { ...data.room, updatedAtMs: data.room.updatedAtMs || Date.now() };
      apiPlayers = data.players || {};
      mergeRoomAndEmit();
    } else if (!cancelled) {
      mergeRoomAndEmit();
    }
    inFlight = false;
  };

  fetchRoomApi();
  const intervalId = window.setInterval(fetchRoomApi, 70);

  const handleMessage = (ev: MessageEvent) => {
    if (!ev.data?.roomId || ev.data.roomId === roomId) {
      mergeRoomAndEmit();
    }
  };
  bc?.addEventListener('message', handleMessage);

  return () => {
    cancelled = true;
    unsubWs();
    if (unsubFsRoom) unsubFsRoom();
    for (const unsub of playerUnsubs.values()) {
      unsub();
    }
    playerUnsubs.clear();
    window.clearInterval(intervalId);
    bc?.removeEventListener('message', handleMessage);
  };
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

  let roomId = `room_${now}_${Math.random()
    .toString(36)
    .slice(2, 7)
    .replace(/[^a-zA-Z0-9]/g, '')}`;

  // 1. Try Express API
  const apiRes = await postApiJson<{ roomId: string; room: SyncedRoomRecord }>(
    '/api/mp/room/create',
    { profile: { uid: safeUid, nickname, jerseyNumber }, customTitle: title }
  );
  if (apiRes?.roomId) {
    roomId = apiRes.roomId;
  }

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
    updatedAtMs: now,
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
    updatedAtMs: now,
  };

  // 2. Save to LocalStorage & BroadcastChannel
  const rooms = loadLocalRooms();
  const players = loadLocalPlayers();
  rooms[roomId] = newRoom;
  players[roomId] = { [safeUid]: hostPlayer };
  saveLocalRooms(rooms);
  saveLocalPlayers(players);

  // 3. Publish to Global Real-Time WebSocket Broker (retained so all clients see it immediately!)
  realtimeWsBroker.publishPlayer(hostPlayer, true);
  realtimeWsBroker.publishRoom(newRoom, true);

  // 4. Write atomically to Google Firebase Firestore
  if (!isFirestoreQuotaExceeded) {
    try {
      const batch = writeBatch(db);
      const roomRef = doc(db, 'rooms', roomId);
      const playerRef = doc(db, 'rooms', roomId, 'players', safeUid);
      batch.set(roomRef, {
        ...toFirestoreRoomPayload(newRoom),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(playerRef, {
        ...toFirestorePlayerPayload(hostPlayer),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      await addRoomIdToFirestoreLobby(roomId, safeUid);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `rooms/${roomId}`);
    }
  }

  notifyPeers(roomId);
  return roomId;
}

export async function joinMatchRoom(
  roomId: string,
  profile: PlayerProfile
): Promise<{ joined: boolean; reason?: string }> {
  const safeUid = sanitizeId(profile.uid);
  const nickname = sanitizeNickname(profile.nickname);
  const jerseyNumber = clamp(Math.round(profile.jerseyNumber || 10), 1, 99);

  // 1. Try Express API first if available
  const apiRes = await postApiJson<{
    joined: boolean;
    reason?: string;
    room?: SyncedRoomRecord;
  }>('/api/mp/room/join', {
    roomId,
    profile: { uid: safeUid, nickname, jerseyNumber },
  });

  // 2. Locate room from WebSocket Broker, LocalStorage, API, or Firestore
  const rooms = loadLocalRooms();
  const players = loadLocalPlayers();
  let room: SyncedRoomRecord | null =
    apiRes?.room ||
    realtimeWsBroker.getRoom(roomId) ||
    rooms[roomId] ||
    null;

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
    updatedAtMs: now,
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
    updatedAtMs: now,
  };

  rooms[roomId] = updatedRoom;
  if (!players[roomId]) players[roomId] = {};
  players[roomId][safeUid] = joinedPlayer;
  saveLocalRooms(rooms);
  saveLocalPlayers(players);

  // Publish to WebSocket Broker
  realtimeWsBroker.publishPlayer(joinedPlayer, true);
  realtimeWsBroker.publishRoom(updatedRoom, true);

  // Sync to Google Firebase Firestore
  if (!isFirestoreQuotaExceeded) {
    try {
      const batch = writeBatch(db);
      const roomRef = doc(db, 'rooms', roomId);
      const playerRef = doc(db, 'rooms', roomId, 'players', safeUid);
      batch.update(roomRef, {
        hostUid: sanitizeId(updatedRoom.hostUid),
        hostName: sanitizeNickname(updatedRoom.hostName),
        memberUids: updatedRoom.memberUids.map(sanitizeId).slice(0, 10),
        redUids: updatedRoom.redUids.map(sanitizeId).slice(0, 5),
        blueUids: updatedRoom.blueUids.map(sanitizeId).slice(0, 5),
        updatedAt: serverTimestamp(),
      });
      batch.set(playerRef, {
        ...toFirestorePlayerPayload(joinedPlayer),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
    }
  }

  notifyPeers(roomId);
  return { joined: true };
}

export async function switchPlayerTeam(
  room: MatchRoomDoc,
  profile: PlayerProfile
): Promise<{ switched: boolean; reason?: string }> {
  const safeUid = sanitizeId(profile.uid);
  const nickname = sanitizeNickname(profile.nickname);
  const jerseyNumber = clamp(Math.round(profile.jerseyNumber || 10), 1, 99);

  await postApiJson('/api/mp/room/switch-team', {
    roomId: room.roomId,
    profile: { uid: safeUid, nickname, jerseyNumber },
  });

  const currentRoom =
    realtimeWsBroker.getRoom(room.roomId) ||
    loadLocalRooms()[room.roomId] ||
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
    updatedAtMs: now,
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
    updatedAtMs: now,
  };

  const rooms = loadLocalRooms();
  const players = loadLocalPlayers();
  rooms[room.roomId] = updatedRoom;
  if (!players[room.roomId]) players[room.roomId] = {};
  players[room.roomId][safeUid] = updatedPlayer;
  saveLocalRooms(rooms);
  saveLocalPlayers(players);

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
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
    }
  }

  notifyPeers(room.roomId);
  return { switched: true };
}

export async function startMatchByHost(
  room: MatchRoomDoc,
  playersMap: Record<string, RoomPlayerDoc>
): Promise<void> {
  await postApiJson('/api/mp/room/start', { roomId: room.roomId });

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
    updatedAtMs: now,
  };

  const rooms = loadLocalRooms();
  const localPlayersAll = loadLocalPlayers();
  rooms[room.roomId] = updatedRoom;
  if (!localPlayersAll[room.roomId]) localPlayersAll[room.roomId] = {};

  const resetPlayersList: SyncedPlayerRecord[] = [];

  room.redUids.forEach((uid, idx) => {
    const existing =
      playersMap[uid] ||
      realtimeWsBroker.getRoomPlayers(room.roomId)[uid] ||
      localPlayersAll[room.roomId][uid];
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
      updatedAtMs: now,
    };
    localPlayersAll[room.roomId][uid] = pDoc;
    resetPlayersList.push(pDoc);
  });

  room.blueUids.forEach((uid, idx) => {
    const existing =
      playersMap[uid] ||
      realtimeWsBroker.getRoomPlayers(room.roomId)[uid] ||
      localPlayersAll[room.roomId][uid];
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
      updatedAtMs: now,
    };
    localPlayersAll[room.roomId][uid] = pDoc;
    resetPlayersList.push(pDoc);
  });

  saveLocalRooms(rooms);
  saveLocalPlayers(localPlayersAll);

  for (const pDoc of resetPlayersList) {
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
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
    }
  }

  notifyPeers(room.roomId);
}

let lastFirestorePlayerSyncMs = 0;
let lastFirestoreBallSyncMs = 0;

export async function syncLocalPlayerDisc(
  roomId: string,
  uid: string,
  state: { x: number; y: number; vx: number; vy: number; kicking: boolean },
  profileFallback?: { nickname: string; jerseyNumber: number; team: TeamColor }
): Promise<void> {
  const now = Date.now();
  const safeX = Math.round(clamp(state.x, 0, CANVAS_WIDTH) * 10) / 10;
  const safeY = Math.round(clamp(state.y, 0, CANVAS_HEIGHT) * 10) / 10;
  const safeVx =
    Math.round(clamp(state.vx, -PLAYER_MAX_SPEED * 2, PLAYER_MAX_SPEED * 2) * 100) /
    100;
  const safeVy =
    Math.round(clamp(state.vy, -PLAYER_MAX_SPEED * 2, PLAYER_MAX_SPEED * 2) * 100) /
    100;
  const safeKicking = Boolean(state.kicking);

  const players = loadLocalPlayers();
  if (!players[roomId]) players[roomId] = {};
  const existing =
    realtimeWsBroker.getRoomPlayers(roomId)[uid] || players[roomId][uid];

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
    updatedAtMs: now,
  };

  players[roomId][uid] = updatedPlayer;
  saveLocalPlayers(players);

  // Instant WebSocket broadcast (~20ms latency across clients)
  realtimeWsBroker.publishPlayer(updatedPlayer, true);

  // Fire-and-forget Express API sync
  postApiJson('/api/mp/room/player-sync', {
    roomId,
    uid,
    state: { x: safeX, y: safeY, vx: safeVx, vy: safeVy, kicking: safeKicking },
  }).catch(() => {});

  // Throttled Firestore update (every 350ms to preserve daily quota)
  if (!isFirestoreQuotaExceeded && now - lastFirestorePlayerSyncMs >= 350) {
    lastFirestorePlayerSyncMs = now;
    updateDoc(doc(db, 'rooms', roomId, 'players', sanitizeId(uid)), {
      x: safeX,
      y: safeY,
      vx: safeVx,
      vy: safeVy,
      kicking: safeKicking,
      updatedAt: serverTimestamp(),
    }).catch((err) => {
      handleFirestoreError(
        err,
        OperationType.UPDATE,
        `rooms/${roomId}/players/${uid}`
      );
    });
  }

  notifyPeers(roomId);
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
  const rooms = loadLocalRooms();
  const baseRoom =
    realtimeWsBroker.getRoom(roomId) || rooms[roomId];

  const safeBallX = Math.round(clamp(patch.ballX, -100, CANVAS_WIDTH + 100) * 10) / 10;
  const safeBallY = Math.round(clamp(patch.ballY, -100, CANVAS_HEIGHT + 100) * 10) / 10;
  const safeBallVx =
    Math.round(clamp(patch.ballVx, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2) * 100) /
    100;
  const safeBallVy =
    Math.round(clamp(patch.ballVy, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2) * 100) /
    100;

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
          updatedAtMs: now,
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
          updatedAtMs: now,
        };

    rooms[roomId] = updatedRoom;
    saveLocalRooms(rooms);
    realtimeWsBroker.publishRoom(updatedRoom, true);
  }

  postApiJson('/api/mp/room/game-sync', { roomId, patch }).catch(() => {});

  // Sync to Firestore (immediately on set-piece/state change, or throttled every 350ms)
  const isImportantEvent = patch.eventState !== 'normal';
  if (
    !isFirestoreQuotaExceeded &&
    (isImportantEvent || now - lastFirestoreBallSyncMs >= 350)
  ) {
    lastFirestoreBallSyncMs = now;
    updateDoc(doc(db, 'rooms', roomId), {
      redScore: clamp(Math.round(patch.redScore), 0, 99),
      blueScore: clamp(Math.round(patch.blueScore), 0, 99),
      ballX: safeBallX,
      ballY: safeBallY,
      ballVx: safeBallVx,
      ballVy: safeBallVy,
      eventState: patch.eventState,
      eventTeam: patch.eventTeam,
      eventUntilMs: clamp(Math.round(patch.eventUntilMs || 0), 0, 9999999999999),
      lastTouchTeam: patch.lastTouchTeam,
      updatedAt: serverTimestamp(),
    }).catch((err) => {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
    });
  }

  notifyPeers(roomId);
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
    realtimeWsBroker.getRoom(room.roomId) ||
    loadLocalRooms()[room.roomId] ||
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
    updatedAtMs: now,
  };

  const rooms = loadLocalRooms();
  rooms[room.roomId] = updatedRoom;
  saveLocalRooms(rooms);

  realtimeWsBroker.publishRoom(updatedRoom, true);

  postApiJson('/api/mp/room/goal', {
    roomId: room.roomId,
    scoringTeam,
    newRedScore: safeRed,
    newBlueScore: safeBlue,
    goalPauseUntilMs,
    ballState: { x: safeX, y: safeY, vx: safeVx, vy: safeVy },
  }).catch(() => {});

  if (!isFirestoreQuotaExceeded) {
    try {
      await updateDoc(doc(db, 'rooms', room.roomId), {
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
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
    }
  }

  notifyPeers(room.roomId);
}

export async function resetFormationAfterGoalDelay(
  room: MatchRoomDoc,
  playersMap: Record<string, RoomPlayerDoc>,
  currentUid: string
): Promise<void> {
  if (room.hostUid !== currentUid) return;

  const now = Date.now();
  const baseRoom =
    realtimeWsBroker.getRoom(room.roomId) ||
    loadLocalRooms()[room.roomId] ||
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
    updatedAtMs: now,
  };

  const rooms = loadLocalRooms();
  const localPlayersAll = loadLocalPlayers();
  rooms[room.roomId] = updatedRoom;
  if (!localPlayersAll[room.roomId]) localPlayersAll[room.roomId] = {};

  const resetPlayersList: SyncedPlayerRecord[] = [];

  updatedRoom.redUids.forEach((uid, idx) => {
    const existing =
      playersMap[uid] ||
      realtimeWsBroker.getRoomPlayers(room.roomId)[uid] ||
      localPlayersAll[room.roomId][uid];
    if (existing) {
      const sp = getTeamSpawnPosition('red', idx);
      const pDoc: SyncedPlayerRecord = {
        ...existing,
        x: sp.x,
        y: sp.y,
        vx: 0,
        vy: 0,
        kicking: false,
        updatedAtMs: now,
      };
      localPlayersAll[room.roomId][uid] = pDoc;
      resetPlayersList.push(pDoc);
    }
  });

  updatedRoom.blueUids.forEach((uid, idx) => {
    const existing =
      playersMap[uid] ||
      realtimeWsBroker.getRoomPlayers(room.roomId)[uid] ||
      localPlayersAll[room.roomId][uid];
    if (existing) {
      const sp = getTeamSpawnPosition('blue', idx);
      const pDoc: SyncedPlayerRecord = {
        ...existing,
        x: sp.x,
        y: sp.y,
        vx: 0,
        vy: 0,
        kicking: false,
        updatedAtMs: now,
      };
      localPlayersAll[room.roomId][uid] = pDoc;
      resetPlayersList.push(pDoc);
    }
  });

  saveLocalRooms(rooms);
  saveLocalPlayers(localPlayersAll);

  for (const pDoc of resetPlayersList) {
    realtimeWsBroker.publishPlayer(pDoc, true);
  }
  realtimeWsBroker.publishRoom(updatedRoom, true);

  postApiJson('/api/mp/room/reset-formation', { roomId: room.roomId }).catch(() => {});

  if (!isFirestoreQuotaExceeded) {
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'rooms', room.roomId), {
        redScore: updatedRoom.redScore,
        blueScore: updatedRoom.blueScore,
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
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.roomId}`);
    }
  }

  notifyPeers(room.roomId);
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
    updatedAtMs: now,
  };

  const rooms = loadLocalRooms();
  rooms[room.roomId] = updatedRoom;
  saveLocalRooms(rooms);

  realtimeWsBroker.publishRoom(updatedRoom, true);

  postApiJson('/api/mp/room/finish', { roomId: room.roomId }).catch(() => {});

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

  notifyPeers(room.roomId);
}

export async function deleteOrLeaveMatchRoom(
  room: MatchRoomDoc,
  currentUid: string
): Promise<void> {
  const safeUid = sanitizeId(currentUid);

  postApiJson('/api/mp/room/leave', {
    roomId: room.roomId,
    uid: safeUid,
  }).catch(() => {});

  const rooms = loadLocalRooms();
  const players = loadLocalPlayers();
  const currentRoom =
    realtimeWsBroker.getRoom(room.roomId) ||
    rooms[room.roomId] ||
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
    delete rooms[room.roomId];
    delete players[room.roomId];
    saveLocalRooms(rooms);
    saveLocalPlayers(players);

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
    const rPlayers =
      realtimeWsBroker.getRoomPlayers(room.roomId) ||
      players[room.roomId] ||
      {};
    delete rPlayers[safeUid];

    const nextHostUid =
      currentRoom.hostUid === safeUid ? remainingMembers[0] : currentRoom.hostUid;
    const nextHostName =
      currentRoom.hostUid === safeUid
        ? rPlayers[nextHostUid]?.nickname || 'Хост'
        : currentRoom.hostName;

    const updatedRoom: SyncedRoomRecord = {
      ...currentRoom,
      hostUid: nextHostUid,
      hostName: nextHostName,
      memberUids: remainingMembers,
      redUids: nextRed,
      blueUids: nextBlue,
      updatedAtMs: Date.now(),
    };

    rooms[room.roomId] = updatedRoom;
    players[room.roomId] = rPlayers;
    saveLocalRooms(rooms);
    saveLocalPlayers(players);

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

  notifyPeers(room.roomId);
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
  notifyPeers();
}
