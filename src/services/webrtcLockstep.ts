import {
  BALL_DAMPING,
  BALL_MAX_SPEED,
  BALL_RADIUS,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  EventState,
  EventTeam,
  FIELD_BOTTOM,
  FIELD_CENTER_X,
  FIELD_CENTER_Y,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  getTeamSpawnPosition,
  GOAL_BOTTOM,
  GOAL_TOP,
  KICK_IMPULSE,
  PLAYER_ACCEL,
  PLAYER_DAMPING,
  PLAYER_KICK_ACCEL,
  PLAYER_MAX_SPEED,
  PLAYER_RADIUS,
  POST_RADIUS,
  POWERSHOT_IMPULSE,
  TeamColor,
} from '../types/game';
import { realtimeWsBroker } from './realtimeWsBroker';

// Fixed Lockstep Timestep: 60 Hz (DT = 1/60 s)
export const LOCKSTEP_FPS = 60;
export const LOCKSTEP_DT = 1 / LOCKSTEP_FPS;
export const LOCKSTEP_STEP_MS = 1000 / LOCKSTEP_FPS; // 16.6667 ms
export const MAX_EXTRAPOLATION_MS = 200;
export const LOCKSTEP_WAIT_TIMEOUT_TICKS = 5; // > 5 ticks without input -> substitute EMPTY_INPUT_KEYS
export const LOCKSTEP_DISCONNECT_TIMEOUT_TICKS = 60; // > 60 ticks (1.0 s) on active channel -> close RTCPeerConnection
export const PING_INTERVAL_MS = 3000; // Measure ping strictly every 3 seconds

// Deterministic Tick Durations (at 60 Hz)
export const POWERSHOT_CHARGE_TICKS = 4 * LOCKSTEP_FPS; // 240 ticks (4.0s)
export const POWERSHOT_WINDOW_TICKS = Math.round(2.5 * LOCKSTEP_FPS); // 150 ticks (2.5s)
export const GOAL_PAUSE_TICKS = 3 * LOCKSTEP_FPS; // 180 ticks (3.0s)

// HaxBall Kick Constants: 4 map units radius & KICK_STRENGTH
export const KICK_RADIUS = 4.0;
export const KICK_STRENGTH = KICK_IMPULSE;
export const WALL_BCOEF = 1.0; // Perfectly elastic wall reflection (bCoef = 1.0)

// ============================================================================
// MODULE (b): Fixed-Point / Strict 4-Decimal Deterministic Math
// ============================================================================
export const FP_SCALE = 10000;

export function round4(val: number): number {
  return Math.round(val * FP_SCALE) / FP_SCALE;
}

export function fpAdd(a: number, b: number): number {
  return (Math.round(a * FP_SCALE) + Math.round(b * FP_SCALE)) / FP_SCALE;
}

export function fpSub(a: number, b: number): number {
  return (Math.round(a * FP_SCALE) - Math.round(b * FP_SCALE)) / FP_SCALE;
}

export function fpMul(a: number, b: number): number {
  return Math.round((Math.round(a * FP_SCALE) * Math.round(b * FP_SCALE)) / FP_SCALE) / FP_SCALE;
}

export function fpDiv(a: number, b: number): number {
  const denom = Math.round(b * FP_SCALE);
  if (denom === 0) return 0;
  return Math.round((Math.round(a * FP_SCALE) * FP_SCALE) / denom) / FP_SCALE;
}

export function fpSin(rad: number): number {
  return round4(Math.sin(round4(rad)));
}

export function fpCos(rad: number): number {
  return round4(Math.cos(round4(rad)));
}

export function fpAtan2(y: number, x: number): number {
  return round4(Math.atan2(round4(y), round4(x)));
}

export function fpHypot(dx: number, dy: number): number {
  return round4(Math.hypot(round4(dx), round4(dy)));
}

export interface PlayerInputKeys {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  kick: boolean;
}

export const EMPTY_INPUT_KEYS: PlayerInputKeys = {
  up: false,
  down: false,
  left: false,
  right: false,
  kick: false,
};

export function encodeKeyMask(k: PlayerInputKeys): number {
  return (
    (k.up ? 1 : 0) |
    (k.down ? 2 : 0) |
    (k.left ? 4 : 0) |
    (k.right ? 8 : 0) |
    (k.kick ? 16 : 0)
  );
}

export function decodeKeyMask(mask: number): PlayerInputKeys {
  return {
    up: (mask & 1) !== 0,
    down: (mask & 2) !== 0,
    left: (mask & 4) !== 0,
    right: (mask & 8) !== 0,
    kick: (mask & 16) !== 0,
  };
}

// ============================================================================
// MODULE (a): Pitch Wall Segments & Elastic Ball Reflection (Zero Outs!)
// ============================================================================
export interface WallSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  nx: number; // Unit inward normal X
  ny: number; // Unit inward normal Y
  bCoef: number; // Elastic bounce coefficient (1.0)
  wall: boolean;
}

/**
 * Field boundary wall segments (with goal openings on Left and Right between GOAL_TOP and GOAL_BOTTOM).
 * All walls have `wall: true` and `bCoef: 1.0` for elastic reflection without outs or resets.
 */
export const PITCH_WALL_SEGMENTS: WallSegment[] = [
  // Top touchline wall (inward normal points down: 0, +1)
  {
    x0: FIELD_LEFT,
    y0: FIELD_TOP,
    x1: FIELD_RIGHT,
    y1: FIELD_TOP,
    nx: 0,
    ny: 1,
    bCoef: WALL_BCOEF,
    wall: true,
  },
  // Bottom touchline wall (inward normal points up: 0, -1)
  {
    x0: FIELD_LEFT,
    y0: FIELD_BOTTOM,
    x1: FIELD_RIGHT,
    y1: FIELD_BOTTOM,
    nx: 0,
    ny: -1,
    bCoef: WALL_BCOEF,
    wall: true,
  },
  // Left goal-line upper wall (above goal mouth, inward normal points right: +1, 0)
  {
    x0: FIELD_LEFT,
    y0: FIELD_TOP,
    x1: FIELD_LEFT,
    y1: GOAL_TOP,
    nx: 1,
    ny: 0,
    bCoef: WALL_BCOEF,
    wall: true,
  },
  // Left goal-line lower wall (below goal mouth, inward normal points right: +1, 0)
  {
    x0: FIELD_LEFT,
    y0: GOAL_BOTTOM,
    x1: FIELD_LEFT,
    y1: FIELD_BOTTOM,
    nx: 1,
    ny: 0,
    bCoef: WALL_BCOEF,
    wall: true,
  },
  // Right goal-line upper wall (above goal mouth, inward normal points left: -1, 0)
  {
    x0: FIELD_RIGHT,
    y0: FIELD_TOP,
    x1: FIELD_RIGHT,
    y1: GOAL_TOP,
    nx: -1,
    ny: 0,
    bCoef: WALL_BCOEF,
    wall: true,
  },
  // Right goal-line lower wall (below goal mouth, inward normal points left: -1, 0)
  {
    x0: FIELD_RIGHT,
    y0: GOAL_BOTTOM,
    x1: FIELD_RIGHT,
    y1: FIELD_BOTTOM,
    nx: -1,
    ny: 0,
    bCoef: WALL_BCOEF,
    wall: true,
  },
];

/**
 * Elastic reflection + position correction ("выталкивание") of the ball against pitch wall segments.
 * Angle of incidence equals angle of reflection: normal velocity reverses sign (scaled by bCoef),
 * tangential velocity is preserved. No outs or center resets ever occur.
 */
export function collideBallWithWallSegments(
  ball: { x: number; y: number; vx: number; vy: number; radius: number },
  segments: WallSegment[] = PITCH_WALL_SEGMENTS
): boolean {
  let bounced = false;
  const inGoalMouthY = ball.y > GOAL_TOP && ball.y < GOAL_BOTTOM;

  for (const seg of segments) {
    if (!seg.wall) continue;

    // Horizontal walls (Top & Bottom)
    if (seg.ny !== 0) {
      if (seg.ny === 1) {
        // Top wall at y = FIELD_TOP (normal points +Y inside field)
        const minBallY = fpAdd(seg.y0, ball.radius);
        if (ball.y < minBallY) {
          // Position correction: push ball inside field
          ball.y = minBallY;
          // Reflect normal velocity component (vy) while preserving tangential component (vx)
          if (ball.vy < 0) {
            ball.vy = fpMul(-ball.vy, seg.bCoef);
          }
          bounced = true;
        }
      } else if (seg.ny === -1) {
        // Bottom wall at y = FIELD_BOTTOM (normal points -Y inside field)
        const maxBallY = fpSub(seg.y0, ball.radius);
        if (ball.y > maxBallY) {
          ball.y = maxBallY;
          if (ball.vy > 0) {
            ball.vy = fpMul(-ball.vy, seg.bCoef);
          }
          bounced = true;
        }
      }
      continue;
    }

    // Vertical walls (Left & Right goal-line segments outside the goal mouth)
    if (seg.nx !== 0 && !inGoalMouthY) {
      const segMinY = Math.min(seg.y0, seg.y1);
      const segMaxY = Math.max(seg.y0, seg.y1);
      if (ball.y >= segMinY - ball.radius && ball.y <= segMaxY + ball.radius) {
        if (seg.nx === 1) {
          // Left wall at x = FIELD_LEFT (normal points +X inside field)
          const minBallX = fpAdd(seg.x0, ball.radius);
          if (ball.x < minBallX) {
            ball.x = minBallX;
            if (ball.vx < 0) {
              ball.vx = fpMul(-ball.vx, seg.bCoef);
            }
            bounced = true;
          }
        } else if (seg.nx === -1) {
          // Right wall at x = FIELD_RIGHT (normal points -X inside field)
          const maxBallX = fpSub(seg.x0, ball.radius);
          if (ball.x > maxBallX) {
            ball.x = maxBallX;
            if (ball.vx > 0) {
              ball.vx = fpMul(-ball.vx, seg.bCoef);
            }
            bounced = true;
          }
        }
      }
    }
  }

  return bounced;
}

// ============================================================================
// MODULE (d): Client Jitter Damper / Spring-Lerp Visual Smoothing
// ============================================================================
export class JitterDamper2D {
  public offsetX = 0;
  public offsetY = 0;

  /**
   * When a confirmed position arrives and differs from the predicted position,
   * absorb the difference into (offsetX, offsetY) so the rendered position does NOT jump.
   */
  public absorbCorrection(
    prevVisualX: number,
    prevVisualY: number,
    newAuthX: number,
    newAuthY: number,
    maxSnapDist = 220
  ) {
    const dx = fpSub(prevVisualX, newAuthX);
    const dy = fpSub(prevVisualY, newAuthY);
    const dist = fpHypot(dx, dy);
    if (dist < maxSnapDist) {
      this.offsetX = dx;
      this.offsetY = dy;
    } else {
      this.offsetX = 0;
      this.offsetY = 0;
    }
  }

  /**
   * Smoothly decays the visual offset toward 0 over several frames (critically damped lerp).
   */
  public stepDecay(decayFactor = 0.78) {
    this.offsetX =
      Math.abs(this.offsetX) > 0.12 ? fpMul(this.offsetX, decayFactor) : 0;
    this.offsetY =
      Math.abs(this.offsetY) > 0.12 ? fpMul(this.offsetY, decayFactor) : 0;
  }

  public reset() {
    this.offsetX = 0;
    this.offsetY = 0;
  }
}

export interface InputPacket {
  tick: number;
  playerId: string;
  keys: PlayerInputKeys;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  kicking?: boolean;
  keyMask?: number;
}

export interface DeterministicPlayerState {
  playerId: string;
  team: TeamColor;
  slotIndex: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  kicking: boolean;
  kickLock: boolean;
}

export interface DeterministicBallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface DeterministicWorldState {
  tick: number;
  players: Record<string, DeterministicPlayerState>;
  ball: DeterministicBallState;
  redScore: number;
  blueScore: number;
  eventState: EventState;
  eventTeam: EventTeam;
  eventUntilTick: number;
  lastTouchTeam: EventTeam;
  awaitingSetPieceTouch: boolean;
  isCornerSetPiece: boolean;
  setPieceExpireTick: number;
  controllingUid: string;
  controlStartedTick: number;
  powershotMustExitRing: boolean;
}

export interface StepEvents {
  kickedByUid: string | null;
  wasPowershot: boolean;
  postHit: boolean;
  wallHit: boolean;
  goalScoredBy: TeamColor | null;
}

const GOALPOSTS = [
  { x: FIELD_LEFT, y: GOAL_TOP },
  { x: FIELD_LEFT, y: GOAL_BOTTOM },
  { x: FIELD_RIGHT, y: GOAL_TOP },
  { x: FIELD_RIGHT, y: GOAL_BOTTOM },
];

/**
 * Deterministic Kick Mechanics (`attemptKick(player, ball, input)`)
 * Distance = Math.hypot(dx, dy). Radius in HaxBall = 4 map units (KICK_RADIUS = 4.0).
 * Impulse directed from player to ball via Math.atan2 -> Math.cos/sin -> 4-decimal rounding.
 */
export function attemptKick(
  player: { x: number; y: number; vx: number; vy: number; radius: number },
  ball: { x: number; y: number; vx: number; vy: number; radius: number },
  input: { keys: PlayerInputKeys },
  kickStrength: number = KICK_STRENGTH,
  kickRadius: number = KICK_RADIUS
): { impulseX: number; impulseY: number } | null {
  if (input.keys.kick === false) {
    return null;
  }

  const dx = fpSub(ball.x, player.x);
  const dy = fpSub(ball.y, player.y);
  const distance = fpHypot(dx, dy);
  const maxKickDist = fpAdd(fpAdd(player.radius, ball.radius), kickRadius);

  if (distance >= maxKickDist || distance <= 0.0001) {
    return null;
  }

  const angle = fpAtan2(dy, dx);
  const nx = fpCos(angle);
  const ny = fpSin(angle);

  const impulseX = fpMul(nx, kickStrength);
  const impulseY = fpMul(ny, kickStrength);

  const transferX = fpMul(player.vx, 0.25);
  const transferY = fpMul(player.vy, 0.25);

  ball.vx = fpAdd(fpAdd(fpMul(ball.vx, 0.2), impulseX), transferX);
  ball.vy = fpAdd(fpAdd(fpMul(ball.vy, 0.2), impulseY), transferY);

  return { impulseX, impulseY };
}

export function cloneWorldState(state: DeterministicWorldState): DeterministicWorldState {
  const playersCopy: Record<string, DeterministicPlayerState> = {};
  for (const [uid, p] of Object.entries(state.players)) {
    playersCopy[uid] = { ...p };
  }
  return {
    ...state,
    players: playersCopy,
    ball: { ...state.ball },
  };
}

/**
 * Deterministic Lockstep Physics Step (Fixed DT = 1/60s, integer Tick ID, 4-decimal fixed-point rounding, zero outs)
 */
export function stepDeterministicWorld(
  world: DeterministicWorldState,
  inputs: Record<string, PlayerInputKeys>,
  redUids: string[],
  blueUids: string[]
): StepEvents {
  const events: StepEvents = {
    kickedByUid: null,
    wasPowershot: false,
    postHit: false,
    wallHit: false,
    goalScoredBy: null,
  };

  world.tick += 1;
  const currentTick = world.tick;

  // 1. Check expiration of 3-second Post-Goal formation reset
  if (world.eventState !== 'normal' && currentTick >= world.eventUntilTick) {
    const finishedEvent = world.eventState;
    world.eventState = 'normal';
    world.eventUntilTick = 0;

    if (finishedEvent === 'goal') {
      world.ball.x = FIELD_CENTER_X;
      world.ball.y = FIELD_CENTER_Y;
      world.ball.vx = 0;
      world.ball.vy = 0;
      world.eventTeam = 'none';
      world.awaitingSetPieceTouch = false;
      world.isCornerSetPiece = false;
      world.controllingUid = '';
      world.controlStartedTick = 0;
      world.powershotMustExitRing = false;

      redUids.forEach((uid, idx) => {
        if (world.players[uid]) {
          const sp = getTeamSpawnPosition('red', idx);
          world.players[uid].x = round4(sp.x);
          world.players[uid].y = round4(sp.y);
          world.players[uid].vx = 0;
          world.players[uid].vy = 0;
          world.players[uid].kicking = false;
          world.players[uid].kickLock = false;
        }
      });
      blueUids.forEach((uid, idx) => {
        if (world.players[uid]) {
          const sp = getTeamSpawnPosition('blue', idx);
          world.players[uid].x = round4(sp.x);
          world.players[uid].y = round4(sp.y);
          world.players[uid].vx = 0;
          world.players[uid].vy = 0;
          world.players[uid].kicking = false;
          world.players[uid].kickLock = false;
        }
      });
    }
  }

  const sortedUids = Object.keys(world.players).sort();

  // 2. Step each player disc deterministically (strictly per-operation 4-decimal rounding)
  for (const uid of sortedUids) {
    const pl = world.players[uid];
    const keys = inputs[uid] || EMPTY_INPUT_KEYS;

    let dirX = 0;
    let dirY = 0;
    if (keys.left) dirX -= 1;
    if (keys.right) dirX += 1;
    if (keys.up) dirY -= 1;
    if (keys.down) dirY += 1;

    const accel = keys.kick ? PLAYER_KICK_ACCEL : PLAYER_ACCEL;
    if (dirX !== 0 || dirY !== 0) {
      const moveAngle = fpAtan2(dirY, dirX);
      const ax = fpMul(fpCos(moveAngle), accel);
      const ay = fpMul(fpSin(moveAngle), accel);
      pl.vx = fpMul(fpAdd(pl.vx, ax), PLAYER_DAMPING);
      pl.vy = fpMul(fpAdd(pl.vy, ay), PLAYER_DAMPING);
    } else {
      pl.vx = fpMul(pl.vx, PLAYER_DAMPING);
      pl.vy = fpMul(pl.vy, PLAYER_DAMPING);
    }

    const speed = fpHypot(pl.vx, pl.vy);
    if (speed > PLAYER_MAX_SPEED) {
      const sAngle = fpAtan2(pl.vy, pl.vx);
      pl.vx = fpMul(fpCos(sAngle), PLAYER_MAX_SPEED);
      pl.vy = fpMul(fpSin(sAngle), PLAYER_MAX_SPEED);
    } else if (speed < 0.012 && dirX === 0 && dirY === 0) {
      pl.vx = 0;
      pl.vy = 0;
    }

    pl.x = fpAdd(pl.x, pl.vx);
    pl.y = fpAdd(pl.y, pl.vy);

    // Arena outer wall bounds for player discs
    const minX = PLAYER_RADIUS + 12;
    const maxX = CANVAS_WIDTH - PLAYER_RADIUS - 12;
    const minY = PLAYER_RADIUS + 12;
    const maxY = CANVAS_HEIGHT - PLAYER_RADIUS - 12;
    if (pl.x < minX) pl.x = minX;
    if (pl.x > maxX) pl.x = maxX;
    if (pl.y < minY) pl.y = minY;
    if (pl.y > maxY) pl.y = maxY;

    // Solid Goalpost Hitboxes for Player Disc
    for (const post of GOALPOSTS) {
      const dxPost = fpSub(pl.x, post.x);
      const dyPost = fpSub(pl.y, post.y);
      const distPost = fpHypot(dxPost, dyPost);
      const minPostDist = fpAdd(PLAYER_RADIUS, POST_RADIUS);
      if (distPost < minPostDist && distPost > 0.0001) {
        const angle = fpAtan2(dyPost, dxPost);
        const nx = fpCos(angle);
        const ny = fpSin(angle);
        pl.x = fpAdd(post.x, fpMul(nx, minPostDist));
        pl.y = fpAdd(post.y, fpMul(ny, minPostDist));
        const dot = fpAdd(fpMul(pl.vx, nx), fpMul(pl.vy, ny));
        if (dot < 0) {
          pl.vx = fpSub(pl.vx, fpMul(fpMul(dot, nx), 1.15));
          pl.vy = fpSub(pl.vy, fpMul(fpMul(dot, ny), 1.15));
        }
      }
    }

    if (!keys.kick) {
      pl.kickLock = false;
    }
    // White circle indicator is active only while holding kick BEFORE the kick locks
    pl.kicking = Boolean(keys.kick && !pl.kickLock);
  }

  // 3. Player-to-Player Disc Collisions (Deterministic sorted order with momentum exchange)
  for (let i = 0; i < sortedUids.length; i++) {
    for (let j = i + 1; j < sortedUids.length; j++) {
      const a = world.players[sortedUids[i]];
      const b = world.players[sortedUids[j]];
      const dx = fpSub(b.x, a.x);
      const dy = fpSub(b.y, a.y);
      const dist = fpHypot(dx, dy);
      const minDist = PLAYER_RADIUS * 2;
      if (dist < minDist && dist > 0.0001) {
        const angle = fpAtan2(dy, dx);
        const nx = fpCos(angle);
        const ny = fpSin(angle);
        const overlap = fpMul(fpSub(minDist, dist), 0.5);
        a.x = fpSub(a.x, fpMul(nx, overlap));
        a.y = fpSub(a.y, fpMul(ny, overlap));
        b.x = fpAdd(b.x, fpMul(nx, overlap));
        b.y = fpAdd(b.y, fpMul(ny, overlap));

        const relVx = fpSub(a.vx, b.vx);
        const relVy = fpSub(a.vy, b.vy);
        const normalVel = fpAdd(fpMul(relVx, nx), fpMul(relVy, ny));
        if (normalVel > 0) {
          const impulse = fpMul(normalVel, 0.55);
          a.vx = fpSub(a.vx, fpMul(impulse, nx));
          a.vy = fpSub(a.vy, fpMul(impulse, ny));
          b.vx = fpAdd(b.vx, fpMul(impulse, nx));
          b.vy = fpAdd(b.vy, fpMul(impulse, ny));
        }
      }
    }
  }

  // 4. Powershot Hold Timer & Player-to-Ball Kick (`attemptKick`) + Disc-to-Ball Collision
  const grayCircleHoldDist = fpAdd(fpAdd(PLAYER_RADIUS, BALL_RADIUS), KICK_RADIUS);
  let holderUid = '';
  let closestGrayDist = Infinity;

  if (world.eventState === 'normal' || world.eventState === 'goal') {
    for (const uid of sortedUids) {
      const pl = world.players[uid];
      const d = fpHypot(fpSub(world.ball.x, pl.x), fpSub(world.ball.y, pl.y));
      if (d <= grayCircleHoldDist && d < closestGrayDist) {
        closestGrayDist = d;
        holderUid = uid;
      }
    }

    if (holderUid === '') {
      world.controllingUid = '';
      world.controlStartedTick = 0;
      world.powershotMustExitRing = false;
    } else if (world.controllingUid !== holderUid) {
      world.controllingUid = holderUid;
      world.controlStartedTick = currentTick;
      world.powershotMustExitRing = false;
    } else if (!world.powershotMustExitRing && world.controlStartedTick > 0) {
      const heldTicks = currentTick - world.controlStartedTick;
      if (heldTicks > POWERSHOT_CHARGE_TICKS + POWERSHOT_WINDOW_TICKS) {
        world.powershotMustExitRing = true;
        world.controlStartedTick = 0;
      }
    }

    for (const uid of sortedUids) {
      const pl = world.players[uid];
      const keys = inputs[uid] || EMPTY_INPUT_KEYS;

      const heldTicks =
        world.controllingUid === uid &&
        !world.powershotMustExitRing &&
        world.controlStartedTick > 0
          ? currentTick - world.controlStartedTick
          : 0;
      const hasChargedPowershot =
        heldTicks >= POWERSHOT_CHARGE_TICKS &&
        heldTicks <= POWERSHOT_CHARGE_TICKS + POWERSHOT_WINDOW_TICKS;

      const kickStrength = hasChargedPowershot ? POWERSHOT_IMPULSE : KICK_STRENGTH;

      if (!pl.kickLock) {
        const kickRes = attemptKick(
          pl,
          world.ball,
          { keys },
          kickStrength,
          KICK_RADIUS
        );
        if (kickRes) {
          pl.kickLock = true;
          pl.kicking = false;
          world.lastTouchTeam = pl.team;
          events.kickedByUid = uid;
          events.wasPowershot = hasChargedPowershot;

          if (hasChargedPowershot) {
            world.powershotMustExitRing = true;
            world.controlStartedTick = 0;
          }
          continue;
        }
      }

      // Pure 2D Normal Disc-to-Ball Collision
      const dx = fpSub(world.ball.x, pl.x);
      const dy = fpSub(world.ball.y, pl.y);
      const dist = fpHypot(dx, dy);
      const minDist = fpAdd(PLAYER_RADIUS, BALL_RADIUS);

      if (dist < minDist && dist > 0.0001) {
        const angle = fpAtan2(dy, dx);
        const nx = fpCos(angle);
        const ny = fpSin(angle);

        world.ball.x = fpAdd(pl.x, fpMul(nx, minDist));
        world.ball.y = fpAdd(pl.y, fpMul(ny, minDist));

        const relVx = fpSub(world.ball.vx, pl.vx);
        const relVy = fpSub(world.ball.vy, pl.vy);
        const normalVel = fpAdd(fpMul(relVx, nx), fpMul(relVy, ny));

        if (normalVel < 0) {
          const restitution = -normalVel > 1.85 ? 0.08 : 0.0;
          const impulse = fpMul(-(1 + restitution), normalVel);
          world.ball.vx = fpAdd(world.ball.vx, fpMul(impulse, nx));
          world.ball.vy = fpAdd(world.ball.vy, fpMul(impulse, ny));
        }

        world.lastTouchTeam = pl.team;
      }
    }
  }

  // 5. Sub-stepped Ball Movement, Wall Segment Elastic Reflection (NO OUTS!), Goalposts & Goal Line
  const subSteps = 2;
  for (let step = 0; step < subSteps; step++) {
    world.ball.x = fpAdd(world.ball.x, fpDiv(world.ball.vx, subSteps));
    world.ball.y = fpAdd(world.ball.y, fpDiv(world.ball.vy, subSteps));

    // Elastic reflection off pitch wall segments (bCoef = 1.0, wall = true)
    if (world.eventState === 'normal') {
      if (collideBallWithWallSegments(world.ball, PITCH_WALL_SEGMENTS)) {
        events.wallHit = true;
      }
    }

    // Goalpost Circle Collisions
    for (const post of GOALPOSTS) {
      const dx = fpSub(world.ball.x, post.x);
      const dy = fpSub(world.ball.y, post.y);
      const dist = fpHypot(dx, dy);
      const minDist = fpAdd(BALL_RADIUS, POST_RADIUS);
      if (dist < minDist && dist > 0.0001) {
        const angle = fpAtan2(dy, dx);
        const nx = fpCos(angle);
        const ny = fpSin(angle);
        world.ball.x = fpAdd(post.x, fpMul(nx, minDist));
        world.ball.y = fpAdd(post.y, fpMul(ny, minDist));
        const dot = fpAdd(fpMul(world.ball.vx, nx), fpMul(world.ball.vy, ny));
        if (dot < 0) {
          world.ball.vx = fpMul(fpSub(world.ball.vx, fpMul(2 * dot, nx)), 0.85);
          world.ball.vy = fpMul(fpSub(world.ball.vy, fpMul(2 * dot, ny)), 0.85);
          events.postHit = true;
        }
      }
    }

    // Check for Goal (ball crosses goal line between GOAL_TOP and GOAL_BOTTOM)
    if (world.eventState === 'normal') {
      const inGoalY = world.ball.y > GOAL_TOP && world.ball.y < GOAL_BOTTOM;
      if (inGoalY && world.ball.x + BALL_RADIUS * 0.6 < FIELD_LEFT) {
        world.blueScore += 1;
        world.eventState = 'goal';
        world.eventTeam = 'blue';
        world.eventUntilTick = currentTick + GOAL_PAUSE_TICKS;
        world.controllingUid = '';
        world.controlStartedTick = 0;
        events.goalScoredBy = 'blue';
      } else if (inGoalY && world.ball.x - BALL_RADIUS * 0.6 > FIELD_RIGHT) {
        world.redScore += 1;
        world.eventState = 'goal';
        world.eventTeam = 'red';
        world.eventUntilTick = currentTick + GOAL_PAUSE_TICKS;
        world.controllingUid = '';
        world.controlStartedTick = 0;
        events.goalScoredBy = 'red';
      }
    }
  }

  // Ball damping & max speed clamp (4-decimal fixed-point rounded)
  world.ball.vx = fpMul(world.ball.vx, BALL_DAMPING);
  world.ball.vy = fpMul(world.ball.vy, BALL_DAMPING);
  const bSpeed = fpHypot(world.ball.vx, world.ball.vy);
  if (bSpeed > BALL_MAX_SPEED) {
    const bAngle = fpAtan2(world.ball.vy, world.ball.vx);
    world.ball.vx = fpMul(fpCos(bAngle), BALL_MAX_SPEED);
    world.ball.vy = fpMul(fpSin(bAngle), BALL_MAX_SPEED);
  } else if (bSpeed < 0.03) {
    world.ball.vx = 0;
    world.ball.vy = 0;
  }

  // Goal-pocket containment when ball is inside left or right goal net
  const inGoalMouthY =
    world.ball.y > GOAL_TOP - BALL_RADIUS &&
    world.ball.y < GOAL_BOTTOM + BALL_RADIUS;
  if (inGoalMouthY && world.ball.x < FIELD_LEFT) {
    const minBackX = FIELD_LEFT - 56 + BALL_RADIUS;
    if (world.ball.x < minBackX) {
      world.ball.x = round4(minBackX);
      world.ball.vx = fpMul(Math.abs(world.ball.vx), 0.15);
    }
    if (world.ball.y - BALL_RADIUS < GOAL_TOP) {
      world.ball.y = round4(GOAL_TOP + BALL_RADIUS);
      world.ball.vy = fpMul(Math.abs(world.ball.vy), 0.25);
    } else if (world.ball.y + BALL_RADIUS > GOAL_BOTTOM) {
      world.ball.y = round4(GOAL_BOTTOM - BALL_RADIUS);
      world.ball.vy = fpMul(-Math.abs(world.ball.vy), 0.25);
    }
  } else if (inGoalMouthY && world.ball.x > FIELD_RIGHT) {
    const maxBackX = FIELD_RIGHT + 56 - BALL_RADIUS;
    if (world.ball.x > maxBackX) {
      world.ball.x = round4(maxBackX);
      world.ball.vx = fpMul(-Math.abs(world.ball.vx), 0.15);
    }
    if (world.ball.y - BALL_RADIUS < GOAL_TOP) {
      world.ball.y = round4(GOAL_TOP + BALL_RADIUS);
      world.ball.vy = fpMul(Math.abs(world.ball.vy), 0.25);
    } else if (world.ball.y + BALL_RADIUS > GOAL_BOTTOM) {
      world.ball.y = round4(GOAL_BOTTOM - BALL_RADIUS);
      world.ball.vy = fpMul(-Math.abs(world.ball.vy), 0.25);
    }
  }

  return events;
}

/**
 * Extrapolation (`extrapolateWorld`)
 * Simulates the world forward by `extrapolationMs` (0..200ms) from the last confirmed state.
 */
export function extrapolateWorld(
  confirmed: DeterministicWorldState,
  latestInputs: Record<string, PlayerInputKeys>,
  extrapolationMs: number,
  redUids: string[],
  blueUids: string[]
): DeterministicWorldState {
  const clampedMs = Math.max(0, Math.min(MAX_EXTRAPOLATION_MS, extrapolationMs));
  const extraTicks = Math.round((clampedMs / 1000) * LOCKSTEP_FPS);
  if (extraTicks <= 0) {
    return confirmed;
  }
  const sim = cloneWorldState(confirmed);
  for (let i = 0; i < extraTicks; i++) {
    stepDeterministicWorld(sim, latestInputs, redUids, blueUids);
  }
  return sim;
}

// ============================================================================
// MODULE (c): Binary ArrayBuffer WebRTC DataChannel + Input Queue + Timeouts
// ============================================================================
const BIN_PKT_CLIENT_INPUT = 0x01;
const BIN_PKT_HOST_FRAME = 0x02;

/**
 * Encodes a single 60Hz client input packet into a compact 6-byte binary ArrayBuffer:
 * [0]: 0x01 (BIN_PKT_CLIENT_INPUT)
 * [1..4]: Uint32 tick (little-endian)
 * [5]: Uint8 keyMask (bit0=up, bit1=down, bit2=left, bit3=right, bit4=kick)
 */
export function encodeBinaryClientInput(tick: number, keys: PlayerInputKeys): ArrayBuffer {
  const buf = new ArrayBuffer(6);
  const view = new DataView(buf);
  view.setUint8(0, BIN_PKT_CLIENT_INPUT);
  view.setUint32(1, tick >>> 0, true);
  view.setUint8(5, encodeKeyMask(keys));
  return buf;
}

export function decodeBinaryClientInput(
  buf: ArrayBuffer
): { tick: number; keys: PlayerInputKeys; keyMask: number } | null {
  if (buf.byteLength < 6) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== BIN_PKT_CLIENT_INPUT) return null;
  const tick = view.getUint32(1, true);
  const keyMask = view.getUint8(5);
  return {
    tick,
    keyMask,
    keys: decodeKeyMask(keyMask),
  };
}

/**
 * Encodes Host's confirmed frame inputs for all players into a compact binary ArrayBuffer:
 * [0]: 0x02 (BIN_PKT_HOST_FRAME)
 * [1..4]: Uint32 tick (little-endian)
 * [5]: Uint8 playerCount
 * For each player: [slotIdx: Uint8, keyMask: Uint8] (2 bytes per player)
 */
export function encodeBinaryHostFrameInputs(
  tick: number,
  orderedMemberUids: string[],
  frameInputs: Record<string, PlayerInputKeys>
): ArrayBuffer {
  const count = Math.min(16, orderedMemberUids.length);
  const buf = new ArrayBuffer(6 + count * 2);
  const view = new DataView(buf);
  view.setUint8(0, BIN_PKT_HOST_FRAME);
  view.setUint32(1, tick >>> 0, true);
  view.setUint8(5, count);
  for (let i = 0; i < count; i++) {
    const uid = orderedMemberUids[i];
    const keys = frameInputs[uid] || EMPTY_INPUT_KEYS;
    view.setUint8(6 + i * 2, i);
    view.setUint8(6 + i * 2 + 1, encodeKeyMask(keys));
  }
  return buf;
}

export function decodeBinaryHostFrameInputs(
  buf: ArrayBuffer,
  orderedMemberUids: string[]
): { tick: number; inputs: Record<string, PlayerInputKeys> } | null {
  if (buf.byteLength < 6) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== BIN_PKT_HOST_FRAME) return null;
  const tick = view.getUint32(1, true);
  const count = view.getUint8(5);
  if (buf.byteLength < 6 + count * 2) return null;
  const inputs: Record<string, PlayerInputKeys> = {};
  for (let i = 0; i < count; i++) {
    const slotIdx = view.getUint8(6 + i * 2);
    const keyMask = view.getUint8(6 + i * 2 + 1);
    const uid = orderedMemberUids[slotIdx];
    if (uid) {
      inputs[uid] = decodeKeyMask(keyMask);
    }
  }
  return { tick, inputs };
}

export interface WebRTCSignalMessage {
  roomId: string;
  fromUid: string;
  toUid: string;
  type: 'offer' | 'answer' | 'ice' | 'join_request';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  ts: number;
}

export interface FastAuthoritativeSnapshot {
  tick: number;
  roomStatus?: 'waiting' | 'playing' | 'finished';
  matchStartedAtMs?: number;
  ballX: number;
  ballY: number;
  ballVx: number;
  ballVy: number;
  redScore: number;
  blueScore: number;
  eventState: EventState;
  eventTeam: EventTeam;
  eventUntilMs: number;
  lastTouchTeam: EventTeam;
  actorUid?: string;
  players: Record<
    string,
    {
      x: number;
      y: number;
      vx: number;
      vy: number;
      kicking: boolean;
      keyMask?: number;
    }
  >;
}

type DataChannelControlPacket =
  | {
      kind: 'frame';
      tick: number;
      inputs: Record<string, PlayerInputKeys>;
      snap?: FastAuthoritativeSnapshot;
    }
  | {
      kind: 'client_ball';
      playerId: string;
      ballX: number;
      ballY: number;
      ballVx: number;
      ballVy: number;
      lastTouchTeam: EventTeam;
    }
  | {
      kind: 'state_seed';
      world: DeterministicWorldState;
    }
  | {
      kind: 'extrapolation';
      playerId: string;
      extrapolationMs: number;
    }
  | {
      kind: 'desync';
      reason: string;
    }
  | {
      kind: 'ping';
      t0: number;
    }
  | {
      kind: 'pong';
      t0: number;
      pings: Record<string, number>;
    };

export class WebRTCLockstepSession {
  public readonly roomId: string;
  public readonly localUid: string;
  public readonly isHost: boolean;
  private extrapolationMs = 20;
  private desynced = false;
  private desyncReason = '';
  private targetMemberUids: string[] = [];
  private lastSentInputTick = -1;
  private clientLastProcessedTick = -1;
  private clientFutureFrameQueue = new Map<
    number,
    { inputs: Record<string, PlayerInputKeys>; snap?: FastAuthoritativeSnapshot }
  >();

  // Map of peerUid -> RTCPeerConnection & RTCDataChannel + Host Lockstep Input Queue
  private peers = new Map<
    string,
    {
      pc: RTCPeerConnection;
      dc: RTCDataChannel | null;
      open: boolean;
      createdAtPerf: number;
      pendingCandidates: RTCIceCandidateInit[];
      ticksSinceLastInput: number;
      lastProcessedTick: number;
      lastInputAtPerf: number;
      lastInputKeys: PlayerInputKeys;
      inputBuffer: Map<number, PlayerInputKeys>;
      pingMs: number;
    }
  >();

  private playerPings: Record<string, number> = {};
  private onFrameInputsCallback:
    | ((
        tick: number,
        inputs: Record<string, PlayerInputKeys>,
        snap?: FastAuthoritativeSnapshot
      ) => void)
    | null = null;
  private onClientInputStateCallback: ((pkt: InputPacket) => void) | null = null;
  private onClientBallCallback:
    | ((pkt: {
        playerId: string;
        ballX: number;
        ballY: number;
        ballVx: number;
        ballVy: number;
        lastTouchTeam: EventTeam;
      }) => void)
    | null = null;
  private onStateSeedCallback:
    | ((world: DeterministicWorldState) => void)
    | null = null;
  private onPeerDisconnectedCallback: ((peerUid: string) => void) | null = null;
  private onSignalOut: (msg: WebRTCSignalMessage) => void;
  private pingIntervalId: number | null = null;
  private handshakeRetryId: number | null = null;

  constructor(opts: {
    roomId: string;
    localUid: string;
    isHost: boolean;
    onSignalOut: (msg: WebRTCSignalMessage) => void;
    onFrameInputs?: (
      tick: number,
      inputs: Record<string, PlayerInputKeys>,
      snap?: FastAuthoritativeSnapshot
    ) => void;
    onClientInputState?: (pkt: InputPacket) => void;
    onClientBall?: (pkt: {
      playerId: string;
      ballX: number;
      ballY: number;
      ballVx: number;
      ballVy: number;
      lastTouchTeam: EventTeam;
    }) => void;
    onStateSeed?: (world: DeterministicWorldState) => void;
    onPeerDisconnected?: (peerUid: string) => void;
  }) {
    this.roomId = opts.roomId;
    this.localUid = opts.localUid;
    this.isHost = opts.isHost;
    this.onSignalOut = opts.onSignalOut;
    this.onFrameInputsCallback = opts.onFrameInputs || null;
    this.onClientInputStateCallback = opts.onClientInputState || null;
    this.onClientBallCallback = opts.onClientBall || null;
    this.onStateSeedCallback = opts.onStateSeed || null;
    this.onPeerDisconnectedCallback = opts.onPeerDisconnected || null;
    this.playerPings[this.localUid] = realtimeWsBroker.getLocalPingMs();

    // 3-Second Ping Probe Timer (strictly every 3000ms to avoid traffic overhead)
    if (typeof window !== 'undefined') {
      this.pingIntervalId = window.setInterval(() => {
        this.sendPingProbes();
      }, PING_INTERVAL_MS);

      // Fast WebRTC Handshake Retry if peer DataChannel is not open yet (> 3.0s)
      this.handshakeRetryId = window.setInterval(() => {
        const nowPerf = performance.now();
        for (const uid of this.targetMemberUids) {
          if (uid === this.localUid) continue;
          const entry = this.peers.get(uid);
          const isStalled =
            !entry ||
            (!entry.open &&
              (entry.pc.connectionState === 'failed' ||
                entry.pc.connectionState === 'closed' ||
                entry.pc.iceConnectionState === 'failed' ||
                nowPerf - entry.createdAtPerf > 3000));
          if (isStalled) {
            if (!this.isHost) {
              this.onSignalOut({
                roomId: this.roomId,
                fromUid: this.localUid,
                toUid: uid,
                type: 'join_request',
                ts: Date.now(),
              });
            } else {
              this.initiateHostPeerConnection(uid, true).catch(() => {});
            }
          }
        }
      }, 1600);
    }
  }

  public setExtrapolation(ms: number) {
    this.extrapolationMs = Math.round(ms);
    if (!this.isHost) {
      this.broadcastControlToPeers({
        kind: 'extrapolation',
        playerId: this.localUid,
        extrapolationMs: this.extrapolationMs,
      });
    } else if (this.extrapolationMs < 0 || this.extrapolationMs > MAX_EXTRAPOLATION_MS) {
      this.desynced = true;
      this.desyncReason = `Недопустимая экстраполяция (${this.extrapolationMs} мс > 200 мс)`;
    }
  }

  public getExtrapolation(): number {
    return Math.max(0, Math.min(MAX_EXTRAPOLATION_MS, this.extrapolationMs));
  }

  public isDesynced(): { desynced: boolean; reason: string } {
    return { desynced: this.desynced, reason: this.desyncReason };
  }

  public getPlayerPings(): Record<string, number> {
    this.playerPings[this.localUid] =
      this.playerPings[this.localUid] || realtimeWsBroker.getLocalPingMs();
    return { ...this.playerPings };
  }

  /**
   * Elastic Clock: If the incoming input queue has > 2 buffered ticks, slightly accelerate
   * the local tick interval by fractions of a millisecond (e.g. 16.25ms instead of 16.6667ms)
   * so the queue never bloats.
   */
  public getElasticStepMs(): number {
    let maxBuffered = this.clientFutureFrameQueue.size;
    if (this.isHost) {
      for (const entry of this.peers.values()) {
        if (entry.inputBuffer.size > maxBuffered) {
          maxBuffered = entry.inputBuffer.size;
        }
      }
    }
    if (maxBuffered > 3) return LOCKSTEP_STEP_MS * 0.94; // ~15.67ms (catch up smoothly)
    if (maxBuffered > 2) return LOCKSTEP_STEP_MS * 0.975; // ~16.25ms
    return LOCKSTEP_STEP_MS; // 16.6667ms (exact 60 Hz)
  }

  public connectToMemberPeers(memberUids: string[]) {
    this.targetMemberUids = [...memberUids];
    for (const uid of memberUids) {
      if (uid === this.localUid) continue;
      const existing = this.peers.get(uid);
      if (!existing) {
        if (this.isHost) {
          this.initiateHostPeerConnection(uid);
        } else {
          this.onSignalOut({
            roomId: this.roomId,
            fromUid: this.localUid,
            toUid: uid,
            type: 'join_request',
            ts: Date.now(),
          });
        }
      }
    }
  }

  private createPeerEntry(peerUid: string) {
    const existing = this.peers.get(peerUid);
    if (existing) {
      try {
        existing.dc?.close();
        existing.pc.close();
      } catch {
        // ignore
      }
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    const entry = {
      pc,
      dc: null as RTCDataChannel | null,
      open: false,
      createdAtPerf: performance.now(),
      pendingCandidates: [] as RTCIceCandidateInit[],
      ticksSinceLastInput: 0,
      lastProcessedTick: -1,
      lastInputAtPerf: performance.now(),
      lastInputKeys: { ...EMPTY_INPUT_KEYS },
      inputBuffer: new Map<number, PlayerInputKeys>(),
      pingMs: 18,
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onSignalOut({
          roomId: this.roomId,
          fromUid: this.localUid,
          toUid: peerUid,
          type: 'ice',
          candidate: event.candidate.toJSON(),
          ts: Date.now(),
        });
      }
    };

    if (this.isHost) {
      const dc = pc.createDataChannel('gameChannel', {
        ordered: false,
        maxRetransmits: 0,
      });
      this.attachDataChannel(peerUid, entry, dc);
    } else {
      pc.ondatachannel = (event) => {
        this.attachDataChannel(peerUid, entry, event.channel);
      };
    }

    this.peers.set(peerUid, entry);
    return entry;
  }

  private attachDataChannel(
    peerUid: string,
    entry: NonNullable<ReturnType<typeof this.peers.get>>,
    dc: RTCDataChannel
  ) {
    dc.binaryType = 'arraybuffer';
    entry.dc = dc;
    dc.onopen = () => {
      entry.open = true;
      entry.ticksSinceLastInput = 0;
      entry.lastInputAtPerf = performance.now();
      this.sendPingProbes();
    };
    dc.onclose = () => {
      entry.open = false;
    };
    dc.onmessage = (ev) => {
      // 1. Fast Path: Binary ArrayBuffer Packet (6-byte Client Input or Binary Host Frame)
      if (ev.data instanceof ArrayBuffer) {
        this.handleBinaryPacket(peerUid, entry, ev.data);
        return;
      }
      // 2. Control Packet Path (Ping/Pong, Extrapolation, State Seed)
      if (typeof ev.data === 'string') {
        try {
          const pkt = JSON.parse(ev.data) as DataChannelControlPacket;
          this.handleControlPacket(peerUid, entry, pkt);
        } catch {
          // ignore malformed packet
        }
      }
    };
  }

  private handleBinaryPacket(
    peerUid: string,
    entry: NonNullable<ReturnType<typeof this.peers.get>>,
    buf: ArrayBuffer
  ) {
    if (buf.byteLength < 6) return;
    const view = new DataView(buf);
    const kind = view.getUint8(0);

    if (kind === BIN_PKT_CLIENT_INPUT && this.isHost) {
      const decoded = decodeBinaryClientInput(buf);
      if (!decoded) return;

      // Ignore duplicate / already processed ticks
      if (decoded.tick <= entry.lastProcessedTick) {
        return;
      }

      entry.ticksSinceLastInput = 0;
      entry.lastInputAtPerf = performance.now();
      entry.lastInputKeys = decoded.keys;
      entry.inputBuffer.set(decoded.tick, decoded.keys);

      // Keep buffer bounded (drain oldest if > 8 ticks ahead)
      if (entry.inputBuffer.size > 8) {
        const sortedTicks = Array.from(entry.inputBuffer.keys()).sort((a, b) => a - b);
        while (sortedTicks.length > 4) {
          const oldTick = sortedTicks.shift()!;
          entry.inputBuffer.delete(oldTick);
        }
      }

      if (this.onClientInputStateCallback) {
        this.onClientInputStateCallback({
          tick: decoded.tick,
          playerId: peerUid,
          keys: decoded.keys,
          kicking: decoded.keys.kick,
          keyMask: decoded.keyMask,
        });
      }
      return;
    }

    if (kind === BIN_PKT_HOST_FRAME && !this.isHost) {
      const decoded = decodeBinaryHostFrameInputs(buf, this.targetMemberUids);
      if (!decoded) return;
      if (decoded.tick <= this.clientLastProcessedTick) {
        return; // Ignore duplicate tick
      }
      this.clientLastProcessedTick = decoded.tick;
      if (this.onFrameInputsCallback) {
        this.onFrameInputsCallback(decoded.tick, decoded.inputs);
      }
    }
  }

  private async flushPendingCandidates(
    entry: NonNullable<ReturnType<typeof this.peers.get>>
  ) {
    if (!entry.pc.remoteDescription || entry.pendingCandidates.length === 0) {
      return;
    }
    const queue = entry.pendingCandidates.splice(0, entry.pendingCandidates.length);
    for (const cand of queue) {
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch {
        // ignore
      }
    }
  }

  private async initiateHostPeerConnection(clientUid: string, force = false) {
    const existing = this.peers.get(clientUid);
    if (existing) {
      if (existing.open) return;
      const ageMs = performance.now() - existing.createdAtPerf;
      const failed =
        existing.pc.connectionState === 'failed' ||
        existing.pc.connectionState === 'closed' ||
        existing.pc.iceConnectionState === 'failed';
      if (!force && !failed && ageMs < 2800) {
        return;
      }
    }

    const entry = this.createPeerEntry(clientUid);
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.onSignalOut({
        roomId: this.roomId,
        fromUid: this.localUid,
        toUid: clientUid,
        type: 'offer',
        sdp: entry.pc.localDescription
          ? {
              type: entry.pc.localDescription.type,
              sdp: entry.pc.localDescription.sdp,
            }
          : offer,
        ts: Date.now(),
      });
    } catch {
      // ignore
    }
  }

  public async handleIncomingSignal(msg: WebRTCSignalMessage) {
    if (msg.roomId !== this.roomId || msg.toUid !== this.localUid) return;

    if (msg.type === 'join_request' && this.isHost) {
      await this.initiateHostPeerConnection(msg.fromUid);
      return;
    }

    if (msg.type === 'offer' && !this.isHost && msg.sdp) {
      const existing = this.peers.get(msg.fromUid);
      if (existing && existing.open) return;

      const entry = this.createPeerEntry(msg.fromUid);
      try {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await this.flushPendingCandidates(entry);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        this.onSignalOut({
          roomId: this.roomId,
          fromUid: this.localUid,
          toUid: msg.fromUid,
          type: 'answer',
          sdp: entry.pc.localDescription
            ? {
                type: entry.pc.localDescription.type,
                sdp: entry.pc.localDescription.sdp,
              }
            : answer,
          ts: Date.now(),
        });
      } catch {
        // ignore
      }
      return;
    }

    if (msg.type === 'answer' && this.isHost && msg.sdp) {
      const entry = this.peers.get(msg.fromUid);
      if (entry && entry.pc.signalingState === 'have-local-offer') {
        try {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          await this.flushPendingCandidates(entry);
        } catch {
          // ignore
        }
      }
      return;
    }

    if (msg.type === 'ice' && msg.candidate) {
      let entry = this.peers.get(msg.fromUid);
      if (!entry && !this.isHost) {
        entry = this.createPeerEntry(msg.fromUid);
      }
      if (entry) {
        if (entry.pc.remoteDescription && entry.pc.remoteDescription.type) {
          try {
            await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch {
            // ignore
          }
        } else {
          entry.pendingCandidates.push(msg.candidate);
        }
      }
    }
  }

  public receiveExternalInput(pkt: InputPacket) {
    if (!this.isHost) return;
    let entry = this.peers.get(pkt.playerId);
    if (!entry) {
      entry = this.createPeerEntry(pkt.playerId);
    }
    if (pkt.tick <= entry.lastProcessedTick) return;
    entry.ticksSinceLastInput = 0;
    entry.lastInputAtPerf = performance.now();
    entry.lastInputKeys = pkt.keys;
    entry.inputBuffer.set(pkt.tick, pkt.keys);
    if (entry.inputBuffer.size > 8) {
      const firstKey = entry.inputBuffer.keys().next().value;
      if (typeof firstKey === 'number') entry.inputBuffer.delete(firstKey);
    }
  }

  private handleControlPacket(
    peerUid: string,
    entry: NonNullable<ReturnType<typeof this.peers.get>>,
    pkt: DataChannelControlPacket
  ) {
    if (pkt.kind === 'frame' && !this.isHost) {
      if (pkt.tick <= this.clientLastProcessedTick && !pkt.snap) {
        return;
      }
      this.clientLastProcessedTick = Math.max(this.clientLastProcessedTick, pkt.tick);
      if (this.onFrameInputsCallback) {
        this.onFrameInputsCallback(pkt.tick, pkt.inputs, pkt.snap);
      }
    } else if (pkt.kind === 'client_ball' && this.isHost) {
      if (this.onClientBallCallback) {
        this.onClientBallCallback(pkt);
      }
    } else if (pkt.kind === 'state_seed' && !this.isHost) {
      if (this.onStateSeedCallback) {
        this.onStateSeedCallback(pkt.world);
      }
    } else if (pkt.kind === 'extrapolation' && this.isHost) {
      if (pkt.extrapolationMs < 0 || pkt.extrapolationMs > MAX_EXTRAPOLATION_MS) {
        this.sendControlToPeer(peerUid, {
          kind: 'desync',
          reason: `Extrapolation ${pkt.extrapolationMs}ms exceeds maximum allowed 200ms.`,
        });
        this.closeAndRemovePeer(peerUid);
      }
    } else if (pkt.kind === 'desync') {
      this.desynced = true;
      this.desyncReason = pkt.reason;
    } else if (pkt.kind === 'ping') {
      this.sendControlToPeer(peerUid, {
        kind: 'pong',
        t0: pkt.t0,
        pings: this.playerPings,
      });
    } else if (pkt.kind === 'pong') {
      const rtt = Math.max(2, Math.min(999, Math.round(performance.now() - pkt.t0)));
      entry.pingMs = rtt;
      this.playerPings[peerUid] = rtt;
      this.playerPings[this.localUid] = rtt;
      if (pkt.pings) {
        for (const [k, v] of Object.entries(pkt.pings)) {
          if (k !== this.localUid) {
            this.playerPings[k] = v;
          }
        }
      }
    }
  }

  /**
   * Client sends strictly ONE 6-byte binary ArrayBuffer input packet per 60Hz physics tick.
   * Never sends packets faster than the 60Hz tick counter.
   */
  public sendClientInput(
    tick: number,
    keys: PlayerInputKeys,
    _state?: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      kicking: boolean;
      keyMask: number;
    }
  ) {
    if (tick <= this.lastSentInputTick) {
      return; // Strictly 1 packet per physics tick (60 Hz)
    }
    this.lastSentInputTick = tick;
    const binBuf = encodeBinaryClientInput(tick, keys);
    this.broadcastBinaryToPeers(binBuf);
  }

  public sendClientBallTouch(ball: {
    ballX: number;
    ballY: number;
    ballVx: number;
    ballVy: number;
    lastTouchTeam: EventTeam;
  }) {
    if (this.isHost) return;
    this.broadcastControlToPeers({
      kind: 'client_ball',
      playerId: this.localUid,
      ...ball,
    });
  }

  /**
   * Host Lockstep Input Queue & Timeout Manager:
   * - Maintains `ticksSinceLastInput` per client peer.
   * - If `ticksSinceLastInput > 5`: substitutes `EMPTY_INPUT_KEYS` and continues simulation without blocking.
   * - If `ticksSinceLastInput > 60`: closes `RTCPeerConnection` and removes the lagging player.
   */
  public resolveHostLockstepFrame(
    targetTick: number,
    hostKeys: PlayerInputKeys,
    snap?: FastAuthoritativeSnapshot
  ): {
    ready: boolean;
    frameInputs: Record<string, PlayerInputKeys>;
  } {
    const frameInputs: Record<string, PlayerInputKeys> = {
      [this.localUid]: hostKeys,
    };

    for (const [peerUid, entry] of this.peers.entries()) {
      // 1. Pull exact or next queued input from peer's inputBuffer
      let chosenInput: PlayerInputKeys | undefined = entry.inputBuffer.get(targetTick);
      if (chosenInput) {
        entry.inputBuffer.delete(targetTick);
        entry.lastProcessedTick = targetTick;
      } else if (entry.inputBuffer.size > 0) {
        const sortedTicks = Array.from(entry.inputBuffer.keys()).sort((a, b) => a - b);
        const nextTick = sortedTicks[0];
        chosenInput = entry.inputBuffer.get(nextTick);
        entry.inputBuffer.delete(nextTick);
        entry.lastProcessedTick = Math.max(entry.lastProcessedTick, nextTick);
      }

      if (chosenInput) {
        entry.ticksSinceLastInput = 0;
        entry.lastInputKeys = chosenInput;
        frameInputs[peerUid] = chosenInput;
        continue;
      }

      // 2. No new input arrived this tick -> increment ticksSinceLastInput
      entry.ticksSinceLastInput += 1;

      if (entry.ticksSinceLastInput <= LOCKSTEP_WAIT_TIMEOUT_TICKS) {
        // Within 5 ticks (~83 ms): hold last known input
        frameInputs[peerUid] = entry.lastInputKeys || { ...EMPTY_INPUT_KEYS };
      } else {
        // > 60 consecutive ticks (1.0s) without input on an open channel -> close RTCPeerConnection & remove peer
        if (entry.open && entry.ticksSinceLastInput > LOCKSTEP_DISCONNECT_TIMEOUT_TICKS) {
          this.closeAndRemovePeer(peerUid);
          continue;
        }
        // > 5 ticks without input -> substitute EMPTY_INPUT_KEYS so simulation never blocks
        frameInputs[peerUid] = { ...EMPTY_INPUT_KEYS };
      }
    }

    // Broadcast compact binary ArrayBuffer frame inputs every tick (60 Hz)
    const binFrame = encodeBinaryHostFrameInputs(
      targetTick,
      this.targetMemberUids,
      frameInputs
    );
    this.broadcastBinaryToPeers(binFrame);

    // Send authoritative correction snapshot for client Jitter Damper every 2nd tick (30 Hz) or on score/event change
    if (snap && targetTick % 2 === 0) {
      this.broadcastControlToPeers({
        kind: 'frame',
        tick: targetTick,
        inputs: frameInputs,
        snap,
      });
    }

    return { ready: true, frameInputs };
  }

  public broadcastStateSeed(world: DeterministicWorldState) {
    if (!this.isHost) return;
    this.broadcastControlToPeers({
      kind: 'state_seed',
      world,
    });
  }

  private sendPingProbes() {
    const nowPerf = performance.now();
    this.broadcastControlToPeers({
      kind: 'ping',
      t0: nowPerf,
    });
  }

  private sendControlToPeer(peerUid: string, pkt: DataChannelControlPacket) {
    const entry = this.peers.get(peerUid);
    if (entry && entry.open && entry.dc && entry.dc.readyState === 'open') {
      try {
        entry.dc.send(JSON.stringify(pkt));
      } catch {
        // ignore
      }
    }
  }

  private broadcastBinaryToPeers(buf: ArrayBuffer) {
    for (const entry of this.peers.values()) {
      if (entry.open && entry.dc && entry.dc.readyState === 'open') {
        try {
          entry.dc.send(buf);
        } catch {
          // ignore
        }
      }
    }
  }

  private broadcastControlToPeers(pkt: DataChannelControlPacket) {
    const raw = JSON.stringify(pkt);
    for (const entry of this.peers.values()) {
      if (entry.open && entry.dc && entry.dc.readyState === 'open') {
        try {
          entry.dc.send(raw);
        } catch {
          // ignore
        }
      }
    }
  }

  public hasOpenDataChannel(): boolean {
    for (const entry of this.peers.values()) {
      if (entry.open && entry.dc?.readyState === 'open') return true;
    }
    return false;
  }

  private closeAndRemovePeer(peerUid: string) {
    const entry = this.peers.get(peerUid);
    if (entry) {
      try {
        entry.dc?.close();
        entry.pc.close();
      } catch {
        // ignore
      }
      this.peers.delete(peerUid);
      if (this.onPeerDisconnectedCallback) {
        this.onPeerDisconnectedCallback(peerUid);
      }
    }
  }

  public destroy() {
    if (this.pingIntervalId) {
      window.clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    if (this.handshakeRetryId) {
      window.clearInterval(this.handshakeRetryId);
      this.handshakeRetryId = null;
    }
    for (const [peerUid] of this.peers.entries()) {
      this.closeAndRemovePeer(peerUid);
    }
  }
}
