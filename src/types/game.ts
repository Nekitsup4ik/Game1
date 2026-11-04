export type TeamColor = 'red' | 'blue';
export type RoomStatus = 'waiting' | 'playing' | 'finished';
export type WinnerTeam = 'none' | 'red' | 'blue' | 'draw';
export type EventState = 'normal' | 'out' | 'corner' | 'goal';
export type EventTeam = 'none' | 'red' | 'blue';

export interface PlayerProfile {
  uid: string;
  nickname: string;
  jerseyNumber: number;
}

export interface LobbyDirectoryDoc {
  lobbyId: string;
  roomIds: string[];
  updatedBy: string;
  updatedAt?: unknown;
}

export interface MatchRoomDoc {
  roomId: string;
  title: string;
  hostUid: string;
  hostName: string;
  status: RoomStatus;
  memberUids: string[];
  redUids: string[];
  blueUids: string[];
  redScore: number;
  blueScore: number;
  matchStartedAtMs: number;
  winnerTeam: WinnerTeam;
  ballX: number;
  ballY: number;
  ballVx: number;
  ballVy: number;
  eventState: EventState;
  eventTeam: EventTeam;
  eventUntilMs: number;
  lastTouchTeam: EventTeam;
  seq?: number;
  actorUid?: string;
  heartbeatAtMs?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface RoomPlayerDoc {
  playerId: string;
  roomId: string;
  nickname: string;
  jerseyNumber: number;
  team: TeamColor;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kicking: boolean;
  pingMs?: number;
  seq?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// Logical Canvas Arena Dimensions (Expanded for 4v4 Match with Deep Goal Space)
export const CANVAS_WIDTH = 1400;
export const CANVAS_HEIGHT = 760;

// Pitch Boundaries (Inside Arena: 1200x640 Pitch)
export const FIELD_LEFT = 100;
export const FIELD_RIGHT = 1300;
export const FIELD_TOP = 60;
export const FIELD_BOTTOM = 700;
export const FIELD_CENTER_X = (FIELD_LEFT + FIELD_RIGHT) / 2; // 700
export const FIELD_CENTER_Y = (FIELD_TOP + FIELD_BOTTOM) / 2; // 380

// Goal Dimensions (Larger Goals for 4v4 with Deep Back Space)
export const GOAL_HALF_WIDTH = 108;
export const GOAL_TOP = FIELD_CENTER_Y - GOAL_HALF_WIDTH; // 272
export const GOAL_BOTTOM = FIELD_CENTER_Y + GOAL_HALF_WIDTH; // 488
export const GOAL_DEPTH = 56;
export const POST_RADIUS = 8.5;

// Disc & Ball Physics Constants (Brisk Responsive Control & Smooth Turf Glide)
export const PLAYER_RADIUS = 18;
export const BALL_RADIUS = 9.5; // Smaller soccer ball
export const PLAYER_ACCEL = 0.235; // Brisk, responsive acceleration
export const PLAYER_KICK_ACCEL = 0.165;
export const PLAYER_DAMPING = 0.942; // Smooth turf glide when releasing keys
export const PLAYER_MAX_SPEED = 3.25; // Fast, comfortable top speed
export const BALL_DAMPING = 0.986;
export const BALL_MAX_SPEED = 16.2;
export const KICK_IMPULSE = 7.8;
export const CORNER_KICK_IMPULSE = 8.8; // Moderate cross power when kicking a corner
export const POWERSHOT_IMPULSE = 12.6; // Stronger Powershot after 4s of ball control
export const POWERSHOT_CHARGE_MS = 4000; // 4 seconds holding ball in gray circle to charge Powershot
export const POWERSHOT_WINDOW_MS = 2500; // 2.5 seconds window to hit Powershot before it expires
export const KICK_RANGE = PLAYER_RADIUS + BALL_RADIUS + 8;

// Match Rules Constants (4v4)
export const MAX_TEAM_SIZE = 4;
export const MATCH_DURATION_SEC = 300; // Strictly 5 minutes (300 seconds)
export const MATCH_DURATION_MS = MATCH_DURATION_SEC * 1000;
export const OUT_PAUSE_MS = 450; // Brief placement pause on Throw-In / Corner
export const GOAL_PAUSE_MS = 3000; // 3 seconds ball stays in net after goal before reset to formation

/**
 * Computes starting 4v4 formation coordinates on each team's half of the pitch:
 * - Slot 0: У мяча (Kickoff Striker near the center ball)
 * - Slot 1: У ворот (Goalkeeper right in front of the goal)
 * - Slot 2: Центр верх (Upper Central Midfielder)
 * - Slot 3: Центр низ (Lower Central Midfielder)
 */
export function getTeamSpawnPosition(team: TeamColor, indexInTeam: number): { x: number; y: number } {
  const safeIndex = Math.max(0, Math.min(3, indexInTeam));
  const redFormation: Array<{ x: number; y: number }> = [
    { x: FIELD_CENTER_X - 52, y: FIELD_CENTER_Y }, // 1. У мяча (в центре у точки развода)
    { x: FIELD_LEFT + 44, y: FIELD_CENTER_Y }, // 2. У ворот (вратарь)
    { x: FIELD_CENTER_X - 250, y: FIELD_CENTER_Y - 105 }, // 3. Центр (верхний полузащитник)
    { x: FIELD_CENTER_X - 250, y: FIELD_CENTER_Y + 105 }, // 4. Центр (нижний полузащитник)
  ];

  const blueFormation: Array<{ x: number; y: number }> = [
    { x: FIELD_CENTER_X + 52, y: FIELD_CENTER_Y }, // 1. У мяча (в центре у точки развода)
    { x: FIELD_RIGHT - 44, y: FIELD_CENTER_Y }, // 2. У ворот (вратарь)
    { x: FIELD_CENTER_X + 250, y: FIELD_CENTER_Y - 105 }, // 3. Центр (верхний полузащитник)
    { x: FIELD_CENTER_X + 250, y: FIELD_CENTER_Y + 105 }, // 4. Центр (нижний полузащитник)
  ];

  return team === 'red' ? redFormation[safeIndex] : blueFormation[safeIndex];
}
