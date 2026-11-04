import {
  BALL_MAX_SPEED,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  EventState,
  EventTeam,
  FIELD_CENTER_X,
  FIELD_CENTER_Y,
  getTeamSpawnPosition,
  MatchRoomDoc,
  MAX_TEAM_SIZE,
  PLAYER_MAX_SPEED,
  PlayerProfile,
  RoomPlayerDoc,
  TeamColor,
  WinnerTeam,
} from '../types/game';

const LOCAL_ROOMS_KEY = 'haxarena_fallback_rooms_v1';
const LOCAL_PLAYERS_KEY = 'haxarena_fallback_players_v1';

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

function loadLocalRooms(): Record<string, MatchRoomDoc & { updatedAtMs: number }> {
  try {
    const raw = localStorage.getItem(LOCAL_ROOMS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalRooms(rooms: Record<string, MatchRoomDoc & { updatedAtMs: number }>) {
  try {
    localStorage.setItem(LOCAL_ROOMS_KEY, JSON.stringify(rooms));
  } catch {
    // ignore
  }
}

function loadLocalPlayers(): Record<
  string,
  Record<string, RoomPlayerDoc & { updatedAtMs: number }>
> {
  try {
    const raw = localStorage.getItem(LOCAL_PLAYERS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalPlayers(
  players: Record<string, Record<string, RoomPlayerDoc & { updatedAtMs: number }>>
) {
  try {
    localStorage.setItem(LOCAL_PLAYERS_KEY, JSON.stringify(players));
  } catch {
    // ignore
  }
}

function cleanupLocalRooms() {
  const now = Date.now();
  const rooms = loadLocalRooms();
  const players = loadLocalPlayers();
  let changed = false;

  for (const [roomId, room] of Object.entries(rooms)) {
    const isStaleWaiting =
      room.status === 'waiting' && now - room.updatedAtMs > 25 * 60 * 1000;
    const isStalePlaying =
      room.status === 'playing' && now - room.updatedAtMs > 10 * 60 * 1000;
    const isFinishedOld =
      room.status === 'finished' && now - room.updatedAtMs > 15 * 1000;
    if (
      room.memberUids.length === 0 ||
      isStaleWaiting ||
      isStalePlaying ||
      isFinishedOld
    ) {
      delete rooms[roomId];
      delete players[roomId];
      changed = true;
    }
  }

  if (changed) {
    saveLocalRooms(rooms);
    saveLocalPlayers(players);
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.includes('application/json')) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function subscribeToLobbyRooms(
  onUpdate: (rooms: MatchRoomDoc[]) => void
): () => void {
  let cancelled = false;

  const fetchLobby = async () => {
    if (cancelled) return;
    try {
      const res = await fetch('/api/mp/lobby');
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = (await res.json()) as { rooms?: MatchRoomDoc[] };
        if (!cancelled && Array.isArray(data.rooms)) {
          onUpdate(data.rooms);
          return;
        }
      }
    } catch {
      // Fall through to local fallback (e.g. GitHub Pages static hosting)
    }

    if (!cancelled) {
      cleanupLocalRooms();
      const rooms = Object.values(loadLocalRooms())
        .filter((r) => r.status !== 'finished' && r.memberUids.length > 0)
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      onUpdate(rooms);
    }
  };

  fetchLobby();
  const intervalId = window.setInterval(fetchLobby, 600);

  const handleMessage = () => {
    fetchLobby();
  };
  bc?.addEventListener('message', handleMessage);

  return () => {
    cancelled = true;
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

  const fetchRoom = async () => {
    if (cancelled || inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(`/api/mp/room/${encodeURIComponent(roomId)}`);
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = (await res.json()) as {
          room: MatchRoomDoc | null;
          players: Record<string, RoomPlayerDoc>;
        };
        if (!cancelled) {
          onUpdate(data.room || null, data.players || {});
          inFlight = false;
          return;
        }
      }
    } catch {
      // Fall through to local fallback (e.g. GitHub Pages static hosting)
    }

    if (!cancelled) {
      const rooms = loadLocalRooms();
      const players = loadLocalPlayers();
      onUpdate(rooms[roomId] || null, players[roomId] || {});
    }
    inFlight = false;
  };

  fetchRoom();
  const intervalId = window.setInterval(fetchRoom, 55);

  const handleMessage = (ev: MessageEvent) => {
    if (!ev.data?.roomId || ev.data.roomId === roomId) {
      fetchRoom();
    }
  };
  bc?.addEventListener('message', handleMessage);

  return () => {
    cancelled = true;
    window.clearInterval(intervalId);
    bc?.removeEventListener('message', handleMessage);
  };
}

export async function createMatchRoom(
  profile: PlayerProfile,
  customTitle?: string
): Promise<string> {
  try {
    const data = await postJson<{ roomId: string; room: MatchRoomDoc }>(
      '/api/mp/room/create',
      { profile, customTitle }
    );
    notifyPeers(data.roomId);
    return data.roomId;
  } catch {
    // Fallback for static hosting (GitHub Pages)
    cleanupLocalRooms();
    const roomId = `room_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 7)
      .replace(/[^a-zA-Z0-9]/g, '')}`;
    const nickname = (profile.nickname || 'Player').trim().slice(0, 24);
    const jerseyNumber = clamp(Math.round(profile.jerseyNumber || 10), 1, 99);
    const title = (customTitle || `Матч игрока ${nickname}`).trim().slice(0, 60);
    const spawn = getTeamSpawnPosition('red', 0);
    const now = Date.now();

    const newRoom: MatchRoomDoc & { updatedAtMs: number } = {
      roomId,
      title,
      hostUid: profile.uid,
      hostName: nickname,
      status: 'waiting',
      memberUids: [profile.uid],
      redUids: [profile.uid],
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

    const hostPlayer: RoomPlayerDoc & { updatedAtMs: number } = {
      playerId: profile.uid,
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

    const rooms = loadLocalRooms();
    const players = loadLocalPlayers();
    rooms[roomId] = newRoom;
    players[roomId] = { [profile.uid]: hostPlayer };
    saveLocalRooms(rooms);
    saveLocalPlayers(players);
    notifyPeers(roomId);
    return roomId;
  }
}

export async function joinMatchRoom(
  roomId: string,
  profile: PlayerProfile
): Promise<{ joined: boolean; reason?: string }> {
  try {
    const data = await postJson<{ joined: boolean; reason?: string }>(
      '/api/mp/room/join',
      { roomId, profile }
    );
    notifyPeers(roomId);
    return data;
  } catch {
    const rooms = loadLocalRooms();
    const players = loadLocalPlayers();
    const room = rooms[roomId];
    if (!room) {
      return { joined: false, reason: 'Комната не найдена или была закрыта.' };
    }
    if (room.status === 'finished') {
      delete rooms[roomId];
      delete players[roomId];
      saveLocalRooms(rooms);
      saveLocalPlayers(players);
      return { joined: false, reason: 'Этот матч уже завершён и комната закрыта.' };
    }
    if (room.status !== 'waiting' && !room.memberUids.includes(profile.uid)) {
      return { joined: false, reason: 'Матч в этой комнате уже начался.' };
    }
    if (!room.memberUids.includes(profile.uid) && room.memberUids.length >= MAX_TEAM_SIZE * 2) {
      return { joined: false, reason: 'Комната заполнена (максимум 8 игроков 4×4).' };
    }

    const redUids = [...room.redUids];
    const blueUids = [...room.blueUids];
    const memberUids = [...room.memberUids];
    let assignedTeam: TeamColor = 'red';

    if (redUids.includes(profile.uid)) {
      assignedTeam = 'red';
    } else if (blueUids.includes(profile.uid)) {
      assignedTeam = 'blue';
    } else {
      if (redUids.length <= blueUids.length && redUids.length < MAX_TEAM_SIZE) {
        assignedTeam = 'red';
        redUids.push(profile.uid);
      } else if (blueUids.length < MAX_TEAM_SIZE) {
        assignedTeam = 'blue';
        blueUids.push(profile.uid);
      } else {
        assignedTeam = 'red';
        redUids.push(profile.uid);
      }
      memberUids.push(profile.uid);
    }

    const indexInTeam =
      assignedTeam === 'red'
        ? Math.max(0, redUids.indexOf(profile.uid))
        : Math.max(0, blueUids.indexOf(profile.uid));
    const spawn = getTeamSpawnPosition(assignedTeam, indexInTeam);
    const now = Date.now();

    room.memberUids = memberUids;
    room.redUids = redUids;
    room.blueUids = blueUids;
    room.updatedAtMs = now;

    if (!players[roomId]) players[roomId] = {};
    players[roomId][profile.uid] = {
      playerId: profile.uid,
      roomId,
      nickname: (profile.nickname || 'Player').trim().slice(0, 24),
      jerseyNumber: clamp(Math.round(profile.jerseyNumber || 10), 1, 99),
      team: assignedTeam,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      kicking: false,
      updatedAtMs: now,
    };

    saveLocalRooms(rooms);
    saveLocalPlayers(players);
    notifyPeers(roomId);
    return { joined: true };
  }
}

export async function switchPlayerTeam(
  room: MatchRoomDoc,
  profile: PlayerProfile
): Promise<{ switched: boolean; reason?: string }> {
  try {
    const data = await postJson<{ switched: boolean; reason?: string }>(
      '/api/mp/room/switch-team',
      { roomId: room.roomId, profile }
    );
    notifyPeers(room.roomId);
    return data;
  } catch {
    const rooms = loadLocalRooms();
    const players = loadLocalPlayers();
    const currentRoom = rooms[room.roomId];
    if (!currentRoom || currentRoom.status !== 'waiting') {
      return { switched: false, reason: 'Смена команды доступна только до начала матча.' };
    }
    const isCurrentlyRed = currentRoom.redUids.includes(profile.uid);
    const targetTeam: TeamColor = isCurrentlyRed ? 'blue' : 'red';
    if (targetTeam === 'red' && currentRoom.redUids.length >= MAX_TEAM_SIZE) {
      return { switched: false, reason: 'В команде Красных уже 4 игрока.' };
    }
    if (targetTeam === 'blue' && currentRoom.blueUids.length >= MAX_TEAM_SIZE) {
      return { switched: false, reason: 'В команде Синих уже 4 игрока.' };
    }

    currentRoom.redUids = isCurrentlyRed
      ? currentRoom.redUids.filter((id) => id !== profile.uid)
      : [...currentRoom.redUids, profile.uid];
    currentRoom.blueUids = !isCurrentlyRed
      ? currentRoom.blueUids.filter((id) => id !== profile.uid)
      : [...currentRoom.blueUids, profile.uid];

    const newIndex =
      targetTeam === 'red'
        ? currentRoom.redUids.indexOf(profile.uid)
        : currentRoom.blueUids.indexOf(profile.uid);
    const spawn = getTeamSpawnPosition(targetTeam, Math.max(0, newIndex));
    const now = Date.now();
    currentRoom.updatedAtMs = now;

    if (!players[room.roomId]) players[room.roomId] = {};
    players[room.roomId][profile.uid] = {
      playerId: profile.uid,
      roomId: room.roomId,
      nickname: (profile.nickname || 'Player').trim().slice(0, 24),
      jerseyNumber: clamp(Math.round(profile.jerseyNumber || 10), 1, 99),
      team: targetTeam,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      kicking: false,
      updatedAtMs: now,
    };

    saveLocalRooms(rooms);
    saveLocalPlayers(players);
    notifyPeers(room.roomId);
    return { switched: true };
  }
}

export async function startMatchByHost(
  room: MatchRoomDoc,
  _players: Record<string, RoomPlayerDoc>
): Promise<void> {
  try {
    await postJson('/api/mp/room/start', { roomId: room.roomId });
  } catch {
    const rooms = loadLocalRooms();
    const players = loadLocalPlayers();
    const currentRoom = rooms[room.roomId];
    if (currentRoom) {
      const now = Date.now();
      const rPlayers = players[room.roomId] || {};
      currentRoom.redUids.forEach((uid, idx) => {
        if (rPlayers[uid]) {
          const sp = getTeamSpawnPosition('red', idx);
          rPlayers[uid].team = 'red';
          rPlayers[uid].x = sp.x;
          rPlayers[uid].y = sp.y;
          rPlayers[uid].vx = 0;
          rPlayers[uid].vy = 0;
          rPlayers[uid].kicking = false;
          rPlayers[uid].updatedAtMs = now;
        }
      });
      currentRoom.blueUids.forEach((uid, idx) => {
        if (rPlayers[uid]) {
          const sp = getTeamSpawnPosition('blue', idx);
          rPlayers[uid].team = 'blue';
          rPlayers[uid].x = sp.x;
          rPlayers[uid].y = sp.y;
          rPlayers[uid].vx = 0;
          rPlayers[uid].vy = 0;
          rPlayers[uid].kicking = false;
          rPlayers[uid].updatedAtMs = now;
        }
      });
      currentRoom.status = 'playing';
      currentRoom.redScore = 0;
      currentRoom.blueScore = 0;
      currentRoom.matchStartedAtMs = now;
      currentRoom.winnerTeam = 'none';
      currentRoom.ballX = FIELD_CENTER_X;
      currentRoom.ballY = FIELD_CENTER_Y;
      currentRoom.ballVx = 0;
      currentRoom.ballVy = 0;
      currentRoom.eventState = 'normal';
      currentRoom.eventTeam = 'none';
      currentRoom.eventUntilMs = 0;
      currentRoom.lastTouchTeam = 'none';
      currentRoom.updatedAtMs = now;
      saveLocalRooms(rooms);
      saveLocalPlayers(players);
    }
  }
  notifyPeers(room.roomId);
}

export async function syncLocalPlayerDisc(
  roomId: string,
  uid: string,
  state: { x: number; y: number; vx: number; vy: number; kicking: boolean }
): Promise<void> {
  try {
    await postJson('/api/mp/room/player-sync', { roomId, uid, state });
  } catch {
    const players = loadLocalPlayers();
    const rPlayers = players[roomId];
    if (rPlayers && rPlayers[uid]) {
      rPlayers[uid].x = clamp(state.x, 0, CANVAS_WIDTH);
      rPlayers[uid].y = clamp(state.y, 0, CANVAS_HEIGHT);
      rPlayers[uid].vx = clamp(state.vx, -PLAYER_MAX_SPEED * 2, PLAYER_MAX_SPEED * 2);
      rPlayers[uid].vy = clamp(state.vy, -PLAYER_MAX_SPEED * 2, PLAYER_MAX_SPEED * 2);
      rPlayers[uid].kicking = Boolean(state.kicking);
      rPlayers[uid].updatedAtMs = Date.now();
      saveLocalPlayers(players);
    }
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
  }
): Promise<void> {
  try {
    await postJson('/api/mp/room/game-sync', { roomId, patch });
  } catch {
    const rooms = loadLocalRooms();
    const currentRoom = rooms[roomId];
    if (currentRoom) {
      const now = Date.now();
      if (
        currentRoom.eventState === 'goal' &&
        now < currentRoom.eventUntilMs &&
        patch.eventState !== 'goal'
      ) {
        currentRoom.ballX = clamp(patch.ballX, 0, CANVAS_WIDTH);
        currentRoom.ballY = clamp(patch.ballY, 0, CANVAS_HEIGHT);
        currentRoom.ballVx = clamp(patch.ballVx, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2);
        currentRoom.ballVy = clamp(patch.ballVy, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2);
        currentRoom.updatedAtMs = now;
      } else {
        currentRoom.redScore = clamp(Math.round(patch.redScore), 0, 999);
        currentRoom.blueScore = clamp(Math.round(patch.blueScore), 0, 999);
        currentRoom.ballX = clamp(patch.ballX, 0, CANVAS_WIDTH);
        currentRoom.ballY = clamp(patch.ballY, 0, CANVAS_HEIGHT);
        currentRoom.ballVx = clamp(patch.ballVx, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2);
        currentRoom.ballVy = clamp(patch.ballVy, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2);
        currentRoom.eventState = patch.eventState;
        currentRoom.eventTeam = patch.eventTeam;
        currentRoom.eventUntilMs = patch.eventUntilMs;
        currentRoom.lastTouchTeam = patch.lastTouchTeam;
        currentRoom.updatedAtMs = now;
      }
      saveLocalRooms(rooms);
    }
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
  try {
    await postJson('/api/mp/room/goal', {
      roomId: room.roomId,
      scoringTeam,
      newRedScore,
      newBlueScore,
      goalPauseUntilMs,
      ballState,
    });
  } catch {
    const rooms = loadLocalRooms();
    const currentRoom = rooms[room.roomId];
    if (currentRoom) {
      currentRoom.redScore = clamp(Math.round(newRedScore), 0, 999);
      currentRoom.blueScore = clamp(Math.round(newBlueScore), 0, 999);
      currentRoom.ballX = clamp(ballState.x, 0, CANVAS_WIDTH);
      currentRoom.ballY = clamp(ballState.y, 0, CANVAS_HEIGHT);
      currentRoom.ballVx = clamp(ballState.vx, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2);
      currentRoom.ballVy = clamp(ballState.vy, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2);
      currentRoom.eventState = 'goal';
      currentRoom.eventTeam = scoringTeam;
      currentRoom.eventUntilMs = goalPauseUntilMs;
      currentRoom.lastTouchTeam = 'none';
      currentRoom.updatedAtMs = Date.now();
      saveLocalRooms(rooms);
    }
  }
  notifyPeers(room.roomId);
}

export async function resetFormationAfterGoalDelay(
  room: MatchRoomDoc,
  _players: Record<string, RoomPlayerDoc>,
  currentUid: string
): Promise<void> {
  if (room.hostUid === currentUid) {
    try {
      await postJson('/api/mp/room/reset-formation', { roomId: room.roomId });
    } catch {
      const rooms = loadLocalRooms();
      const players = loadLocalPlayers();
      const currentRoom = rooms[room.roomId];
      if (currentRoom) {
        const now = Date.now();
        const rPlayers = players[room.roomId] || {};
        currentRoom.redUids.forEach((uid, idx) => {
          if (rPlayers[uid]) {
            const sp = getTeamSpawnPosition('red', idx);
            rPlayers[uid].x = sp.x;
            rPlayers[uid].y = sp.y;
            rPlayers[uid].vx = 0;
            rPlayers[uid].vy = 0;
            rPlayers[uid].kicking = false;
            rPlayers[uid].updatedAtMs = now;
          }
        });
        currentRoom.blueUids.forEach((uid, idx) => {
          if (rPlayers[uid]) {
            const sp = getTeamSpawnPosition('blue', idx);
            rPlayers[uid].x = sp.x;
            rPlayers[uid].y = sp.y;
            rPlayers[uid].vx = 0;
            rPlayers[uid].vy = 0;
            rPlayers[uid].kicking = false;
            rPlayers[uid].updatedAtMs = now;
          }
        });
        currentRoom.ballX = FIELD_CENTER_X;
        currentRoom.ballY = FIELD_CENTER_Y;
        currentRoom.ballVx = 0;
        currentRoom.ballVy = 0;
        currentRoom.eventState = 'normal';
        currentRoom.eventTeam = 'none';
        currentRoom.eventUntilMs = 0;
        currentRoom.lastTouchTeam = 'none';
        currentRoom.updatedAtMs = now;
        saveLocalRooms(rooms);
        saveLocalPlayers(players);
      }
    }
    notifyPeers(room.roomId);
  }
}

export async function finishMatchRoom(
  room: MatchRoomDoc,
  _currentUid?: string
): Promise<void> {
  if (room.status === 'finished') return;
  try {
    await postJson('/api/mp/room/finish', { roomId: room.roomId });
  } catch {
    const rooms = loadLocalRooms();
    const currentRoom = rooms[room.roomId];
    if (currentRoom) {
      let winner: WinnerTeam = 'draw';
      if (currentRoom.redScore > currentRoom.blueScore) winner = 'red';
      else if (currentRoom.blueScore > currentRoom.redScore) winner = 'blue';
      currentRoom.status = 'finished';
      currentRoom.winnerTeam = winner;
      currentRoom.ballVx = 0;
      currentRoom.ballVy = 0;
      currentRoom.eventState = 'normal';
      currentRoom.updatedAtMs = Date.now();
      saveLocalRooms(rooms);
    }
  }
  notifyPeers(room.roomId);
}

export async function deleteOrLeaveMatchRoom(
  room: MatchRoomDoc,
  currentUid: string
): Promise<void> {
  try {
    await postJson('/api/mp/room/leave', { roomId: room.roomId, uid: currentUid });
  } catch {
    const rooms = loadLocalRooms();
    const players = loadLocalPlayers();
    const currentRoom = rooms[room.roomId];
    if (currentRoom) {
      const remainingMembers = currentRoom.memberUids.filter((id) => id !== currentUid);
      if (
        remainingMembers.length === 0 ||
        currentRoom.status === 'finished' ||
        currentRoom.status === 'playing'
      ) {
        delete rooms[room.roomId];
        delete players[room.roomId];
      } else {
        currentRoom.memberUids = remainingMembers;
        currentRoom.redUids = currentRoom.redUids.filter((id) => id !== currentUid);
        currentRoom.blueUids = currentRoom.blueUids.filter((id) => id !== currentUid);
        const rPlayers = players[room.roomId] || {};
        delete rPlayers[currentUid];
        if (currentRoom.hostUid === currentUid && remainingMembers.length > 0) {
          currentRoom.hostUid = remainingMembers[0];
          currentRoom.hostName = rPlayers[remainingMembers[0]]?.nickname || 'Хост';
        }
        currentRoom.updatedAtMs = Date.now();
      }
      saveLocalRooms(rooms);
      saveLocalPlayers(players);
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
