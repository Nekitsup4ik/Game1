import {
  EventState,
  EventTeam,
  MatchRoomDoc,
  PlayerProfile,
  RoomPlayerDoc,
  TeamColor,
} from '../types/game';

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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
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
      if (!res.ok) return;
      const data = (await res.json()) as { rooms?: MatchRoomDoc[] };
      if (!cancelled && Array.isArray(data.rooms)) {
        onUpdate(data.rooms);
      }
    } catch {
      // ignore transient network errors
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
      if (!res.ok) return;
      const data = (await res.json()) as {
        room: MatchRoomDoc | null;
        players: Record<string, RoomPlayerDoc>;
      };
      if (!cancelled) {
        onUpdate(data.room || null, data.players || {});
      }
    } catch {
      // ignore transient network errors
    } finally {
      inFlight = false;
    }
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
  const data = await postJson<{ roomId: string; room: MatchRoomDoc }>(
    '/api/mp/room/create',
    { profile, customTitle }
  );
  notifyPeers(data.roomId);
  return data.roomId;
}

export async function joinMatchRoom(
  roomId: string,
  profile: PlayerProfile
): Promise<{ joined: boolean; reason?: string }> {
  const data = await postJson<{ joined: boolean; reason?: string }>(
    '/api/mp/room/join',
    { roomId, profile }
  );
  notifyPeers(roomId);
  return data;
}

export async function switchPlayerTeam(
  room: MatchRoomDoc,
  profile: PlayerProfile
): Promise<{ switched: boolean; reason?: string }> {
  const data = await postJson<{ switched: boolean; reason?: string }>(
    '/api/mp/room/switch-team',
    { roomId: room.roomId, profile }
  );
  notifyPeers(room.roomId);
  return data;
}

export async function startMatchByHost(
  room: MatchRoomDoc,
  _players: Record<string, RoomPlayerDoc>
): Promise<void> {
  await postJson('/api/mp/room/start', { roomId: room.roomId });
  notifyPeers(room.roomId);
}

export async function syncLocalPlayerDisc(
  roomId: string,
  uid: string,
  state: { x: number; y: number; vx: number; vy: number; kicking: boolean }
): Promise<void> {
  await postJson('/api/mp/room/player-sync', { roomId, uid, state });
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
  await postJson('/api/mp/room/game-sync', { roomId, patch });
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
  await postJson('/api/mp/room/goal', {
    roomId: room.roomId,
    scoringTeam,
    newRedScore,
    newBlueScore,
    goalPauseUntilMs,
    ballState,
  });
  notifyPeers(room.roomId);
}

export async function resetFormationAfterGoalDelay(
  room: MatchRoomDoc,
  _players: Record<string, RoomPlayerDoc>,
  currentUid: string
): Promise<void> {
  if (room.hostUid === currentUid) {
    await postJson('/api/mp/room/reset-formation', { roomId: room.roomId });
    notifyPeers(room.roomId);
  }
}

export async function finishMatchRoom(
  room: MatchRoomDoc,
  _currentUid?: string
): Promise<void> {
  if (room.status === 'finished') return;
  await postJson('/api/mp/room/finish', { roomId: room.roomId });
  notifyPeers(room.roomId);
}

export async function deleteOrLeaveMatchRoom(
  room: MatchRoomDoc,
  currentUid: string
): Promise<void> {
  await postJson('/api/mp/room/leave', { roomId: room.roomId, uid: currentUid });
  notifyPeers(room.roomId);
}

export async function pruneStaleRoomsFromLobby(
  staleRoomIds: string[],
  currentUid: string,
  _skipDeleteDocIds: string[] = []
): Promise<void> {
  for (const rId of staleRoomIds) {
    await postJson('/api/mp/room/leave', { roomId: rId, uid: currentUid }).catch(
      () => {}
    );
  }
  notifyPeers();
}
