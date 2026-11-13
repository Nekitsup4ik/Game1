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
  launchAtMs?: number;
  readyUids?: string[];
  countdownEndsAtMs?: number;
  kickoffTeam?: TeamColor;
  kickoffActive?: boolean;
  elapsedMatchMs?: number;
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

// Logical Canvas Arena Dimensions
export const CANVAS_WIDTH = 1400;
export const CANVAS_HEIGHT = 760;

// Pitch Boundaries (Inside Arena: 1200x640 Pitch)
export const FIELD_LEFT = 100;
export const FIELD_RIGHT = 1300;
export const FIELD_TOP = 60;
export const FIELD_BOTTOM = 700;
export const FIELD_CENTER_X = (FIELD_LEFT + FIELD_RIGHT) / 2; // 700
export const FIELD_CENTER_Y = (FIELD_TOP + FIELD_BOTTOM) / 2; // 380
export const CENTER_CIRCLE_RADIUS = 82;

// Goal Dimensions
export const GOAL_HALF_WIDTH = 108;
export const GOAL_TOP = FIELD_CENTER_Y - GOAL_HALF_WIDTH; // 272
export const GOAL_BOTTOM = FIELD_CENTER_Y + GOAL_HALF_WIDTH; // 488
export const GOAL_DEPTH = 56;
export const POST_RADIUS = 8;
export const POST_BCOEF = 0.5;

// ============================================================================
// Official HaxBall Stadium Physics Constants (60 Hz Deterministic Step)
// ============================================================================
export const PLAYER_RADIUS = 15;
export const PLAYER_BCOEF = 0.5;
export const PLAYER_INV_MASS = 0.5;
export const PLAYER_DAMPING = 0.96;
export const PLAYER_ACCEL = 0.12;
export const PLAYER_KICK_ACCEL = 0.07;
export const PLAYER_KICK_DAMPING = 0.96;
export const KICK_STRENGTH = 5.65;
export const KICK_IMPULSE = KICK_STRENGTH;
export const KICK_RADIUS = 4;
export const KICK_RANGE = PLAYER_RADIUS + 10 + KICK_RADIUS; // 15 + 10 + 4 = 29

export const BALL_RADIUS = 10;
export const BALL_BCOEF = 0.5;
export const BALL_INV_MASS = 1.0;
export const BALL_DAMPING = 0.99;

export const WALL_BCOEF = 1.0;

// Kick Rate-Limit Constants (/kick_ratelimit 2 15 3)
export const KICK_RATELIMIT_MIN = 2;
export const KICK_RATELIMIT_RATE = 15;
export const KICK_RATELIMIT_BURST = 3;

// Legacy compatibility exports
export const PLAYER_MAX_SPEED = 5.0;
export const BALL_MAX_SPEED = 18.0;
export const CORNER_KICK_IMPULSE = 5.65;
export const POWERSHOT_IMPULSE = 8.5;
export const POWERSHOT_CHARGE_MS = 4000;
export const POWERSHOT_WINDOW_MS = 2500;

// Match Rules Constants (4v4)
export const MAX_TEAM_SIZE = 4;
export const MATCH_DURATION_SEC = 300; // 5 minutes (300 seconds)
export const MATCH_DURATION_MS = MATCH_DURATION_SEC * 1000;
export const OUT_PAUSE_MS = 0; // Outs removed completely
export const GOAL_PAUSE_MS = 3000; // 3 seconds after goal
export const PREMATCH_MAX_WAIT_MS = 10000; // 10 seconds max wait for slow loaders
export const COUNTDOWN_DURATION_MS = 3000; // 3-2-1 synchronized countdown

/**
 * Computes starting 4v4 formation coordinates on each team's half of the pitch.
 * Slot 0 stands in front right outside the center circle; Slot 1 stands in back as goalkeeper;
 * Slots 2 & 3 stand on the top and bottom wings.
 */
export function getTeamSpawnPosition(team: TeamColor, indexInTeam: number): { x: number; y: number } {
  const safeIndex = Math.max(0, Math.min(3, indexInTeam));
  const redFormation: Array<{ x: number; y: number }> = [
    { x: FIELD_CENTER_X - 102, y: FIELD_CENTER_Y },
    { x: FIELD_LEFT + 52, y: FIELD_CENTER_Y },
    { x: FIELD_CENTER_X - 250, y: FIELD_CENTER_Y - 105 },
    { x: FIELD_CENTER_X - 250, y: FIELD_CENTER_Y + 105 },
  ];

  const blueFormation: Array<{ x: number; y: number }> = [
    { x: FIELD_CENTER_X + 102, y: FIELD_CENTER_Y },
    { x: FIELD_RIGHT - 52, y: FIELD_CENTER_Y },
    { x: FIELD_CENTER_X + 250, y: FIELD_CENTER_Y - 105 },
    { x: FIELD_CENTER_X + 250, y: FIELD_CENTER_Y + 105 },
  ];

  return team === 'red' ? redFormation[safeIndex] : blueFormation[safeIndex];
}

/**
 * Enforces HaxBall / Rocket League kickoff half-line and center-circle restrictions
 * while `kickoffActive === true` (before the kickoff team touches the ball):
 * - The kicking team (`playerTeam === kickoffTeam`) can move on their own half AND inside the
 *   opponent's half of the white center circle (`CENTER_CIRCLE_RADIUS`), but cannot cross onto
 *   the opponent's half outside the center circle.
 * - The defending team (`playerTeam !== kickoffTeam`) cannot cross the halfway line onto the
 *   kicking team's half AND cannot enter the white center circle.
 */
export function enforceKickoffZoneConstraint(
  x: number,
  y: number,
  vx: number,
  vy: number,
  playerTeam: TeamColor,
  kickoffTeam: TeamColor
): { x: number; y: number; vx: number; vy: number } {
  let nx = x;
  let ny = y;
  let nvx = vx;
  let nvy = vy;

  const isKickingTeam = playerTeam === kickoffTeam;
  const maxCircleInsideR = CENTER_CIRCLE_RADIUS - 2; // Allow kicking team inside the white circle
  const minCircleOutsideR = CENTER_CIRCLE_RADIUS + PLAYER_RADIUS; // Keep defending team outside the white circle

  if (isKickingTeam) {
    if (playerTeam === 'red') {
      // Red has kickoff: can be anywhere with x <= FIELD_CENTER_X, OR inside the right half of the white center circle
      if (nx > FIELD_CENTER_X - PLAYER_RADIUS) {
        const dx = nx - FIELD_CENTER_X;
        const dy = ny - FIELD_CENTER_Y;
        const dist = Math.hypot(dx, dy);
        if (Math.abs(dy) >= maxCircleInsideR && nx > FIELD_CENTER_X - PLAYER_RADIUS) {
          nx = FIELD_CENTER_X - PLAYER_RADIUS;
          if (nvx > 0) nvx = 0;
        } else if (nx > FIELD_CENTER_X && dist > maxCircleInsideR && dist > 0.001) {
          const ux = dx / dist;
          const uy = dy / dist;
          nx = FIELD_CENTER_X + ux * maxCircleInsideR;
          ny = FIELD_CENTER_Y + uy * maxCircleInsideR;
          const radialV = nvx * ux + nvy * uy;
          if (radialV > 0) {
            nvx -= radialV * ux;
            nvy -= radialV * uy;
          }
        }
      }
    } else {
      // Blue has kickoff: can be anywhere with x >= FIELD_CENTER_X, OR inside the left half of the white center circle
      if (nx < FIELD_CENTER_X + PLAYER_RADIUS) {
        const dx = nx - FIELD_CENTER_X;
        const dy = ny - FIELD_CENTER_Y;
        const dist = Math.hypot(dx, dy);
        if (Math.abs(dy) >= maxCircleInsideR && nx < FIELD_CENTER_X + PLAYER_RADIUS) {
          nx = FIELD_CENTER_X + PLAYER_RADIUS;
          if (nvx < 0) nvx = 0;
        } else if (nx < FIELD_CENTER_X && dist > maxCircleInsideR && dist > 0.001) {
          const ux = dx / dist;
          const uy = dy / dist;
          nx = FIELD_CENTER_X + ux * maxCircleInsideR;
          ny = FIELD_CENTER_Y + uy * maxCircleInsideR;
          const radialV = nvx * ux + nvy * uy;
          if (radialV > 0) {
            nvx -= radialV * ux;
            nvy -= radialV * uy;
          }
        }
      }
    }
  } else {
    // Defending team: cannot cross halfway line AND cannot enter the white center circle
    if (playerTeam === 'blue') {
      if (nx < FIELD_CENTER_X + PLAYER_RADIUS) {
        nx = FIELD_CENTER_X + PLAYER_RADIUS;
        if (nvx < 0) nvx = 0;
      }
    } else {
      if (nx > FIELD_CENTER_X - PLAYER_RADIUS) {
        nx = FIELD_CENTER_X - PLAYER_RADIUS;
        if (nvx > 0) nvx = 0;
      }
    }

    const dx = nx - FIELD_CENTER_X;
    const dy = ny - FIELD_CENTER_Y;
    const dist = Math.hypot(dx, dy);
    if (dist < minCircleOutsideR) {
      const safeDist = dist > 0.001 ? dist : 1;
      const ux = dist > 0.001 ? dx / safeDist : playerTeam === 'blue' ? 1 : -1;
      const uy = dist > 0.001 ? dy / safeDist : 0;
      nx = FIELD_CENTER_X + ux * minCircleOutsideR;
      ny = FIELD_CENTER_Y + uy * minCircleOutsideR;
      if (playerTeam === 'blue' && nx < FIELD_CENTER_X + PLAYER_RADIUS) {
        nx = FIELD_CENTER_X + PLAYER_RADIUS;
      }
      if (playerTeam === 'red' && nx > FIELD_CENTER_X - PLAYER_RADIUS) {
        nx = FIELD_CENTER_X - PLAYER_RADIUS;
      }
      const radialV = nvx * ux + nvy * uy;
      if (radialV < 0) {
        nvx -= radialV * ux;
        nvy -= radialV * uy;
      }
    }
  }

  return {
    x: Math.round(nx * 10000) / 10000,
    y: Math.round(ny * 10000) / 10000,
    vx: Math.round(nvx * 10000) / 10000,
    vy: Math.round(nvy * 10000) / 10000,
  };
}

