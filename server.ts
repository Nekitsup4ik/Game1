import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
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
} from './src/types/game.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const roomsStore = new Map<string, MatchRoomDoc & { updatedAtMs: number }>();
const playersStore = new Map<string, Record<string, RoomPlayerDoc & { updatedAtMs: number }>>();

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

function sanitizeNickname(raw: string): string {
  const cleaned = String(raw || '').trim().slice(0, 24);
  return cleaned.length > 0 ? cleaned : 'Player';
}

function sanitizeRoomTitle(raw: string): string {
  const cleaned = String(raw || '').trim().slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'Матч HaxArena';
}

function sanitizeJerseyNumber(num: number): number {
  const intVal = Math.round(Number(num) || 1);
  return clamp(intVal, 1, 99);
}

function cleanupStaleRooms() {
  const now = Date.now();
  for (const [roomId, room] of roomsStore.entries()) {
    const isStaleWaiting = room.status === 'waiting' && now - room.updatedAtMs > 25 * 60 * 1000;
    const isStalePlaying = room.status === 'playing' && now - room.updatedAtMs > 10 * 60 * 1000;
    const isFinishedOld = room.status === 'finished' && now - room.updatedAtMs > 15 * 1000;
    if (
      room.memberUids.length === 0 ||
      isStaleWaiting ||
      isStalePlaying ||
      isFinishedOld
    ) {
      roomsStore.delete(roomId);
      playersStore.delete(roomId);
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // 1. Get all active lobby rooms
  app.get('/api/mp/lobby', (_req, res) => {
    cleanupStaleRooms();
    const activeRooms = Array.from(roomsStore.values())
      .filter((r) => r.status !== 'finished' && r.memberUids.length > 0)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, 20);
    res.json({ rooms: activeRooms });
  });

  // 2. Get specific room and its players
  app.get('/api/mp/room/:roomId', (req, res) => {
    const { roomId } = req.params;
    const room = roomsStore.get(roomId) || null;
    const players = playersStore.get(roomId) || {};
    res.json({ room, players });
  });

  // 3. Create a new match room
  app.post('/api/mp/room/create', (req, res) => {
    cleanupStaleRooms();
    const { profile, customTitle } = req.body as {
      profile: PlayerProfile;
      customTitle?: string;
    };
    if (!profile || !profile.uid) {
      res.status(400).json({ error: 'Invalid player profile' });
      return;
    }

    const roomId = `room_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 7)
      .replace(/[^a-zA-Z0-9]/g, '')}`;
    const nickname = sanitizeNickname(profile.nickname);
    const jerseyNumber = sanitizeJerseyNumber(profile.jerseyNumber);
    const title = sanitizeRoomTitle(customTitle || `Матч игрока ${nickname}`);
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

    roomsStore.set(roomId, newRoom);
    playersStore.set(roomId, { [profile.uid]: hostPlayer });

    res.json({ roomId, room: newRoom });
  });

  // 4. Join an existing match room
  app.post('/api/mp/room/join', (req, res) => {
    const { roomId, profile } = req.body as {
      roomId: string;
      profile: PlayerProfile;
    };
    const room = roomsStore.get(roomId);
    if (!room) {
      res.json({ joined: false, reason: 'Комната не найдена или уже закрыта.' });
      return;
    }

    const nickname = sanitizeNickname(profile.nickname);
    const jerseyNumber = sanitizeJerseyNumber(profile.jerseyNumber);
    const now = Date.now();
    const roomPlayers = playersStore.get(roomId) || {};

    if (room.memberUids.includes(profile.uid)) {
      if (room.status === 'waiting' && roomPlayers[profile.uid]) {
        roomPlayers[profile.uid] = {
          ...roomPlayers[profile.uid],
          nickname,
          jerseyNumber,
          updatedAtMs: now,
        };
        playersStore.set(roomId, roomPlayers);
      }
      room.updatedAtMs = now;
      res.json({ joined: true, room });
      return;
    }

    if (room.status !== 'waiting') {
      res.json({
        joined: false,
        reason: 'Матч в этой комнате уже начался или завершён.',
      });
      return;
    }

    if (room.memberUids.length >= MAX_TEAM_SIZE * 2) {
      res.json({
        joined: false,
        reason: `Комната заполнена (максимум ${MAX_TEAM_SIZE * 2} игроков, формат 4×4).`,
      });
      return;
    }

    let assignedTeam: TeamColor = 'red';
    if (room.redUids.length >= MAX_TEAM_SIZE) {
      assignedTeam = 'blue';
    } else if (
      room.blueUids.length < MAX_TEAM_SIZE &&
      room.blueUids.length < room.redUids.length
    ) {
      assignedTeam = 'blue';
    }

    room.memberUids = [...room.memberUids, profile.uid].slice(0, MAX_TEAM_SIZE * 2);
    if (assignedTeam === 'red') {
      room.redUids = [...room.redUids, profile.uid].slice(0, MAX_TEAM_SIZE);
    } else {
      room.blueUids = [...room.blueUids, profile.uid].slice(0, MAX_TEAM_SIZE);
    }
    room.updatedAtMs = now;

    const teamIndex =
      assignedTeam === 'red' ? room.redUids.length - 1 : room.blueUids.length - 1;
    const spawn = getTeamSpawnPosition(assignedTeam, teamIndex);

    roomPlayers[profile.uid] = {
      playerId: profile.uid,
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
    playersStore.set(roomId, roomPlayers);

    res.json({ joined: true, room });
  });

  // 5. Switch player team in lobby
  app.post('/api/mp/room/switch-team', (req, res) => {
    const { roomId, profile } = req.body as {
      roomId: string;
      profile: PlayerProfile;
    };
    const room = roomsStore.get(roomId);
    if (!room || room.status !== 'waiting') {
      res.json({
        switched: false,
        reason: 'Сменить команду можно только до начала матча.',
      });
      return;
    }

    const isCurrentlyRed = room.redUids.includes(profile.uid);
    const targetTeam: TeamColor = isCurrentlyRed ? 'blue' : 'red';

    if (targetTeam === 'red' && room.redUids.length >= MAX_TEAM_SIZE) {
      res.json({
        switched: false,
        reason: `Красная команда уже укомплектована (${MAX_TEAM_SIZE}/${MAX_TEAM_SIZE}).`,
      });
      return;
    }
    if (targetTeam === 'blue' && room.blueUids.length >= MAX_TEAM_SIZE) {
      res.json({
        switched: false,
        reason: `Синяя команда уже укомплектована (${MAX_TEAM_SIZE}/${MAX_TEAM_SIZE}).`,
      });
      return;
    }

    room.redUids =
      targetTeam === 'red'
        ? [...room.redUids.filter((id) => id !== profile.uid), profile.uid]
        : room.redUids.filter((id) => id !== profile.uid);

    room.blueUids =
      targetTeam === 'blue'
        ? [...room.blueUids.filter((id) => id !== profile.uid), profile.uid]
        : room.blueUids.filter((id) => id !== profile.uid);

    const slotIndex =
      targetTeam === 'red'
        ? room.redUids.indexOf(profile.uid)
        : room.blueUids.indexOf(profile.uid);
    const spawn = getTeamSpawnPosition(targetTeam, Math.max(0, slotIndex));
    const now = Date.now();
    room.updatedAtMs = now;

    const roomPlayers = playersStore.get(roomId) || {};
    if (roomPlayers[profile.uid]) {
      roomPlayers[profile.uid] = {
        ...roomPlayers[profile.uid],
        team: targetTeam,
        nickname: sanitizeNickname(profile.nickname),
        jerseyNumber: sanitizeJerseyNumber(profile.jerseyNumber),
        x: spawn.x,
        y: spawn.y,
        vx: 0,
        vy: 0,
        kicking: false,
        updatedAtMs: now,
      };
      playersStore.set(roomId, roomPlayers);
    }

    res.json({ switched: true, room });
  });

  // 6. Start Match by Host
  app.post('/api/mp/room/start', (req, res) => {
    const { roomId } = req.body as { roomId: string };
    const room = roomsStore.get(roomId);
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const now = Date.now();
    room.status = 'playing';
    room.matchStartedAtMs = now;
    room.ballX = FIELD_CENTER_X;
    room.ballY = FIELD_CENTER_Y;
    room.ballVx = 0;
    room.ballVy = 0;
    room.eventState = 'normal';
    room.eventTeam = 'none';
    room.eventUntilMs = 0;
    room.lastTouchTeam = 'none';
    room.updatedAtMs = now;

    const roomPlayers = playersStore.get(roomId) || {};
    room.redUids.forEach((uid, idx) => {
      if (roomPlayers[uid]) {
        const pos = getTeamSpawnPosition('red', idx);
        roomPlayers[uid] = {
          ...roomPlayers[uid],
          x: pos.x,
          y: pos.y,
          vx: 0,
          vy: 0,
          kicking: false,
          updatedAtMs: now,
        };
      }
    });
    room.blueUids.forEach((uid, idx) => {
      if (roomPlayers[uid]) {
        const pos = getTeamSpawnPosition('blue', idx);
        roomPlayers[uid] = {
          ...roomPlayers[uid],
          x: pos.x,
          y: pos.y,
          vx: 0,
          vy: 0,
          kicking: false,
          updatedAtMs: now,
        };
      }
    });
    playersStore.set(roomId, roomPlayers);

    res.json({ ok: true, room });
  });

  // 7. Sync Local Player Disc
  app.post('/api/mp/room/player-sync', (req, res) => {
    const { roomId, uid, state } = req.body as {
      roomId: string;
      uid: string;
      state: { x: number; y: number; vx: number; vy: number; kicking: boolean };
    };
    const roomPlayers = playersStore.get(roomId);
    if (!roomPlayers || !roomPlayers[uid]) {
      res.json({ ok: false });
      return;
    }
    const now = Date.now();
    roomPlayers[uid] = {
      ...roomPlayers[uid],
      x: Math.round(clamp(state.x, 0, CANVAS_WIDTH) * 10) / 10,
      y: Math.round(clamp(state.y, 0, CANVAS_HEIGHT) * 10) / 10,
      vx:
        Math.round(
          clamp(state.vx, -PLAYER_MAX_SPEED * 2, PLAYER_MAX_SPEED * 2) * 100
        ) / 100,
      vy:
        Math.round(
          clamp(state.vy, -PLAYER_MAX_SPEED * 2, PLAYER_MAX_SPEED * 2) * 100
        ) / 100,
      kicking: Boolean(state.kicking),
      updatedAtMs: now,
    };
    const room = roomsStore.get(roomId);
    if (room) room.updatedAtMs = now;
    res.json({ ok: true });
  });

  // 8. Sync Gameplay & Ball State
  app.post('/api/mp/room/game-sync', (req, res) => {
    const { roomId, patch } = req.body as {
      roomId: string;
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
      };
    };
    const room = roomsStore.get(roomId);
    if (!room) {
      res.json({ ok: false });
      return;
    }
    const now = Date.now();
    // Never let an in-flight pre-goal game-sync packet cancel the 3-second post-goal cooldown
    if (room.eventState === 'goal' && now < room.eventUntilMs) {
      room.ballX = Math.round(clamp(patch.ballX, -100, CANVAS_WIDTH + 100) * 10) / 10;
      room.ballY = Math.round(clamp(patch.ballY, -100, CANVAS_HEIGHT + 100) * 10) / 10;
      room.ballVx =
        Math.round(
          clamp(patch.ballVx, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2) * 100
        ) / 100;
      room.ballVy =
        Math.round(
          clamp(patch.ballVy, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2) * 100
        ) / 100;
      room.updatedAtMs = now;
      res.json({ ok: true, room });
      return;
    }

    room.redScore = Math.max(room.redScore, clamp(Math.round(patch.redScore), 0, 99));
    room.blueScore = Math.max(room.blueScore, clamp(Math.round(patch.blueScore), 0, 99));
    room.ballX = Math.round(clamp(patch.ballX, -100, CANVAS_WIDTH + 100) * 10) / 10;
    room.ballY = Math.round(clamp(patch.ballY, -100, CANVAS_HEIGHT + 100) * 10) / 10;
    room.ballVx =
      Math.round(
        clamp(patch.ballVx, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2) * 100
      ) / 100;
    room.ballVy =
      Math.round(
        clamp(patch.ballVy, -BALL_MAX_SPEED * 2, BALL_MAX_SPEED * 2) * 100
      ) / 100;
    room.eventState = patch.eventState;
    room.eventTeam = patch.eventTeam;
    room.eventUntilMs = Math.max(0, Math.round(patch.eventUntilMs));
    room.lastTouchTeam = patch.lastTouchTeam;
    room.updatedAtMs = now;
    res.json({ ok: true, room });
  });

  // 9. Register Goal in Net
  app.post('/api/mp/room/goal', (req, res) => {
    const {
      roomId,
      scoringTeam,
      newRedScore,
      newBlueScore,
      goalPauseUntilMs,
      ballState,
    } = req.body as {
      roomId: string;
      scoringTeam: TeamColor;
      newRedScore: number;
      newBlueScore: number;
      goalPauseUntilMs: number;
      ballState: { x: number; y: number; vx: number; vy: number };
    };
    const room = roomsStore.get(roomId);
    if (!room) {
      res.json({ ok: false });
      return;
    }
    const now = Date.now();
    room.redScore = clamp(Math.round(newRedScore), 0, 99);
    room.blueScore = clamp(Math.round(newBlueScore), 0, 99);
    room.ballX = Math.round(clamp(ballState.x, -100, CANVAS_WIDTH + 100) * 10) / 10;
    room.ballY = Math.round(clamp(ballState.y, -100, CANVAS_HEIGHT + 100) * 10) / 10;
    room.ballVx =
      Math.round(clamp(ballState.vx, -BALL_MAX_SPEED, BALL_MAX_SPEED) * 100) / 100;
    room.ballVy =
      Math.round(clamp(ballState.vy, -BALL_MAX_SPEED, BALL_MAX_SPEED) * 100) / 100;
    room.eventState = 'goal';
    room.eventTeam = scoringTeam;
    room.eventUntilMs = Math.round(goalPauseUntilMs);
    room.lastTouchTeam = 'none';
    room.updatedAtMs = now;
    res.json({ ok: true, room });
  });

  // 10. Reset Formation After 3s Goal Delay
  app.post('/api/mp/room/reset-formation', (req, res) => {
    const { roomId } = req.body as { roomId: string };
    const room = roomsStore.get(roomId);
    if (!room) {
      res.json({ ok: false });
      return;
    }
    const now = Date.now();
    room.ballX = FIELD_CENTER_X;
    room.ballY = FIELD_CENTER_Y;
    room.ballVx = 0;
    room.ballVy = 0;
    room.eventState = 'normal';
    room.eventTeam = 'none';
    room.eventUntilMs = 0;
    room.lastTouchTeam = 'none';
    room.updatedAtMs = now;

    const roomPlayers = playersStore.get(roomId) || {};
    room.redUids.forEach((uid, idx) => {
      if (roomPlayers[uid]) {
        const pos = getTeamSpawnPosition('red', idx);
        roomPlayers[uid] = {
          ...roomPlayers[uid],
          x: pos.x,
          y: pos.y,
          vx: 0,
          vy: 0,
          kicking: false,
          updatedAtMs: now,
        };
      }
    });
    room.blueUids.forEach((uid, idx) => {
      if (roomPlayers[uid]) {
        const pos = getTeamSpawnPosition('blue', idx);
        roomPlayers[uid] = {
          ...roomPlayers[uid],
          x: pos.x,
          y: pos.y,
          vx: 0,
          vy: 0,
          kicking: false,
          updatedAtMs: now,
        };
      }
    });
    playersStore.set(roomId, roomPlayers);

    res.json({ ok: true, room });
  });

  // 11. Finish Match Room
  app.post('/api/mp/room/finish', (req, res) => {
    const { roomId } = req.body as { roomId: string };
    const room = roomsStore.get(roomId);
    if (!room) {
      res.json({ ok: false });
      return;
    }
    let winnerTeam: WinnerTeam = 'draw';
    if (room.redScore > room.blueScore) {
      winnerTeam = 'red';
    } else if (room.blueScore > room.redScore) {
      winnerTeam = 'blue';
    }
    room.status = 'finished';
    room.winnerTeam = winnerTeam;
    room.ballX = FIELD_CENTER_X;
    room.ballY = FIELD_CENTER_Y;
    room.ballVx = 0;
    room.ballVy = 0;
    room.eventState = 'normal';
    room.eventTeam = 'none';
    room.eventUntilMs = 0;
    room.updatedAtMs = Date.now();
    res.json({ ok: true, room });
  });

  // 12. Leave or Delete Match Room
  app.post('/api/mp/room/leave', (req, res) => {
    const { roomId, uid } = req.body as { roomId: string; uid: string };
    const room = roomsStore.get(roomId);
    if (!room) {
      res.json({ ok: true, deleted: true });
      return;
    }

    const remainingMembers = room.memberUids.filter((id) => id !== uid);
    const shouldDestroyRoom =
      room.status === 'finished' ||
      remainingMembers.length === 0 ||
      room.hostUid === uid;

    if (shouldDestroyRoom) {
      roomsStore.delete(roomId);
      playersStore.delete(roomId);
      res.json({ ok: true, deleted: true });
      return;
    }

    room.memberUids = remainingMembers;
    room.redUids = room.redUids.filter((id) => id !== uid);
    room.blueUids = room.blueUids.filter((id) => id !== uid);
    room.updatedAtMs = Date.now();

    const roomPlayers = playersStore.get(roomId) || {};
    delete roomPlayers[uid];
    playersStore.set(roomId, roomPlayers);

    res.json({ ok: true, deleted: false, room });
  });

  // Vite middleware for development, static dist for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`HaxArena 2D Server running on http://localhost:${PORT}`);
  });
}

startServer();
