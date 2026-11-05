import {
  BALL_DAMPING,
  BALL_MAX_SPEED,
  BALL_RADIUS,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CORNER_KICK_IMPULSE,
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
export const MAX_EXTRAPOLATION_MS = 200;
export const LOCKSTEP_WAIT_TIMEOUT_TICKS = 5; // 5 ticks (~83 ms) before empty input substitution
export const LOCKSTEP_DISCONNECT_TIMEOUT_TICKS = 60; // 60 ticks (1.0 s) before closing peer connection
export const PING_INTERVAL_MS = 3000; // Measure ping strictly every 3 seconds

// Deterministic Tick Durations (at 60 Hz)
export const POWERSHOT_CHARGE_TICKS = 4 * LOCKSTEP_FPS; // 240 ticks (4.0s)
export const POWERSHOT_WINDOW_TICKS = Math.round(2.5 * LOCKSTEP_FPS); // 150 ticks (2.5s)
export const GOAL_PAUSE_TICKS = 3 * LOCKSTEP_FPS; // 180 ticks (3.0s)
export const OUT_PAUSE_TICKS = Math.round(0.45 * LOCKSTEP_FPS); // 27 ticks (0.45s)
export const SET_PIECE_EXPIRE_TICKS = Math.round(4.5 * LOCKSTEP_FPS); // 270 ticks (4.5s)
export const KICK_RADIUS = 8.0;

/**
 * Mandatory 4-decimal float rounding for deterministic lockstep across machines
 */
export function round4(val: number): number {
  return Math.round(val * 10000) / 10000;
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

/**
 * 1. Pure Input Transmission Packet
 */
export interface InputPacket {
  tick: number;
  playerId: string;
  keys: PlayerInputKeys;
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
  goalScoredBy: TeamColor | null;
  outOrCornerTriggered: boolean;
}

const GOALPOSTS = [
  { x: FIELD_LEFT, y: GOAL_TOP },
  { x: FIELD_LEFT, y: GOAL_BOTTOM },
  { x: FIELD_RIGHT, y: GOAL_TOP },
  { x: FIELD_RIGHT, y: GOAL_BOTTOM },
];

/**
 * 4. Deterministic Kick Mechanics (`attemptKick(player, ball, input)`)
 * Follows exact specification: Math.hypot, Math.atan2, Math.cos, Math.sin, 4-decimal rounding.
 */
export function attemptKick(
  player: { x: number; y: number; vx: number; vy: number; radius: number },
  ball: { x: number; y: number; vx: number; vy: number; radius: number },
  input: { keys: PlayerInputKeys },
  kickStrength: number = KICK_IMPULSE,
  kickRadius: number = KICK_RADIUS
): { impulseX: number; impulseY: number } | null {
  if (input.keys.kick === false) {
    return null;
  }

  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const distance = Math.hypot(dx, dy);

  if (distance >= player.radius + ball.radius + kickRadius || distance <= 0.0001) {
    return null;
  }

  const angle = Math.atan2(dy, dx);
  const nx = round4(Math.cos(angle));
  const ny = round4(Math.sin(angle));

  const impulseX = Math.round(nx * kickStrength * 10000) / 10000;
  const impulseY = Math.round(ny * kickStrength * 10000) / 10000;

  // Preserve slight player momentum transfer while keeping 4-decimal determinism
  const transferX = round4(player.vx * 0.25);
  const transferY = round4(player.vy * 0.25);

  ball.vx = Math.round((ball.vx * 0.2 + impulseX + transferX) * 10000) / 10000;
  ball.vy = Math.round((ball.vy * 0.2 + impulseY + transferY) * 10000) / 10000;

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
 * 2. Deterministic Lockstep Physics Step (Fixed DT = 1/60s, integer Tick ID, 4-decimal rounding)
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
    goalScoredBy: null,
    outOrCornerTriggered: false,
  };

  world.tick += 1;
  const currentTick = world.tick;

  // 1. Check expiration of Out/Corner pause or 3-second Post-Goal formation reset
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
        }
      });
    }
  }

  const isPausedForOutOrCorner =
    (world.eventState === 'out' || world.eventState === 'corner') &&
    currentTick < world.eventUntilTick;

  if (world.awaitingSetPieceTouch && currentTick > world.setPieceExpireTick) {
    world.awaitingSetPieceTouch = false;
    world.isCornerSetPiece = false;
  }

  const sortedUids = Object.keys(world.players).sort();

  // 2. Step each player disc deterministically
  for (const uid of sortedUids) {
    const pl = world.players[uid];
    const keys = inputs[uid] || EMPTY_INPUT_KEYS;

    if (isPausedForOutOrCorner) {
      pl.vx = 0;
      pl.vy = 0;
      pl.kicking = false;
      pl.kickLock = false;
      continue;
    }

    let dirX = 0;
    let dirY = 0;
    if (keys.left) dirX -= 1;
    if (keys.right) dirX += 1;
    if (keys.up) dirY -= 1;
    if (keys.down) dirY += 1;

    const accel = keys.kick ? PLAYER_KICK_ACCEL : PLAYER_ACCEL;
    if (dirX !== 0 || dirY !== 0) {
      const moveAngle = Math.atan2(dirY, dirX);
      const ax = round4(Math.cos(moveAngle) * accel);
      const ay = round4(Math.sin(moveAngle) * accel);
      pl.vx = round4((pl.vx + ax) * PLAYER_DAMPING);
      pl.vy = round4((pl.vy + ay) * PLAYER_DAMPING);
    } else {
      pl.vx = round4(pl.vx * PLAYER_DAMPING);
      pl.vy = round4(pl.vy * PLAYER_DAMPING);
    }

    const speed = Math.hypot(pl.vx, pl.vy);
    if (speed > PLAYER_MAX_SPEED) {
      const sAngle = Math.atan2(pl.vy, pl.vx);
      pl.vx = round4(Math.cos(sAngle) * PLAYER_MAX_SPEED);
      pl.vy = round4(Math.sin(sAngle) * PLAYER_MAX_SPEED);
    } else if (speed < 0.012 && dirX === 0 && dirY === 0) {
      pl.vx = 0;
      pl.vy = 0;
    }

    pl.x = round4(pl.x + pl.vx);
    pl.y = round4(pl.y + pl.vy);

    // Arena outer wall bounds
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
      const dxPost = pl.x - post.x;
      const dyPost = pl.y - post.y;
      const distPost = Math.hypot(dxPost, dyPost);
      const minPostDist = PLAYER_RADIUS + POST_RADIUS;
      if (distPost < minPostDist && distPost > 0.0001) {
        const angle = Math.atan2(dyPost, dxPost);
        const nx = round4(Math.cos(angle));
        const ny = round4(Math.sin(angle));
        pl.x = round4(post.x + nx * minPostDist);
        pl.y = round4(post.y + ny * minPostDist);
        const dot = pl.vx * nx + pl.vy * ny;
        if (dot < 0) {
          pl.vx = round4(pl.vx - dot * nx * 1.15);
          pl.vy = round4(pl.vy - dot * ny * 1.15);
        }
      }
    }

    // Set Piece 74px distance restriction for opposing team
    const setPieceTeamHasPlayers =
      world.eventTeam === 'red'
        ? redUids.length > 0
        : world.eventTeam === 'blue'
          ? blueUids.length > 0
          : false;

    if (
      world.awaitingSetPieceTouch &&
      setPieceTeamHasPlayers &&
      world.eventTeam !== 'none' &&
      pl.team !== world.eventTeam
    ) {
      const dxB = pl.x - world.ball.x;
      const dyB = pl.y - world.ball.y;
      const distB = Math.hypot(dxB, dyB);
      const minThrowInDist = 74;
      if (distB < minThrowInDist && distB > 0.0001) {
        const angle = Math.atan2(dyB, dxB);
        pl.x = round4(world.ball.x + Math.cos(angle) * minThrowInDist);
        pl.y = round4(world.ball.y + Math.sin(angle) * minThrowInDist);
      }
    }

    pl.kicking = keys.kick;
    if (!keys.kick) {
      pl.kickLock = false;
    }
  }

  // Player-to-Player Disc Collisions (Deterministic sorted order)
  for (let i = 0; i < sortedUids.length; i++) {
    for (let j = i + 1; j < sortedUids.length; j++) {
      const a = world.players[sortedUids[i]];
      const b = world.players[sortedUids[j]];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minDist = PLAYER_RADIUS * 2;
      if (dist < minDist && dist > 0.0001) {
        const angle = Math.atan2(dy, dx);
        const nx = round4(Math.cos(angle));
        const ny = round4(Math.sin(angle));
        const overlap = round4((minDist - dist) * 0.5);
        a.x = round4(a.x - nx * overlap);
        a.y = round4(a.y - ny * overlap);
        b.x = round4(b.x + nx * overlap);
        b.y = round4(b.y + ny * overlap);
      }
    }
  }

  if (isPausedForOutOrCorner) {
    return events;
  }

  // 3. Powershot Hold Timer (in deterministic ticks: 240 ticks = 4s hold, 150 ticks = 2.5s window)
  const grayCircleHoldDist = PLAYER_RADIUS + BALL_RADIUS + KICK_RADIUS;
  let holderUid = '';
  let closestGrayDist = Infinity;

  if (world.eventState === 'normal' || world.eventState === 'goal') {
    for (const uid of sortedUids) {
      const pl = world.players[uid];
      const d = Math.hypot(world.ball.x - pl.x, world.ball.y - pl.y);
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

    // 4. Player-to-Ball Kick (`attemptKick`) & Pure 2D Normal Collision
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

      const kickStrength = hasChargedPowershot
        ? POWERSHOT_IMPULSE
        : world.isCornerSetPiece
          ? CORNER_KICK_IMPULSE
          : KICK_IMPULSE;

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
          world.lastTouchTeam = pl.team;
          world.awaitingSetPieceTouch = false;
          world.isCornerSetPiece = false;
          events.kickedByUid = uid;
          events.wasPowershot = hasChargedPowershot;

          if (hasChargedPowershot) {
            world.powershotMustExitRing = true;
            world.controlStartedTick = 0;
          }
          continue;
        }
      }

      // Pure 2D Normal Circle Collision (Independent ball physics, zero sideways sticking)
      const dx = world.ball.x - pl.x;
      const dy = world.ball.y - pl.y;
      const dist = Math.hypot(dx, dy);
      const minDist = PLAYER_RADIUS + BALL_RADIUS;

      if (dist < minDist && dist > 0.0001) {
        const angle = Math.atan2(dy, dx);
        const nx = round4(Math.cos(angle));
        const ny = round4(Math.sin(angle));
        const overlap = round4(minDist - dist);

        world.ball.x = round4(world.ball.x + nx * overlap * 0.88);
        world.ball.y = round4(world.ball.y + ny * overlap * 0.88);
        pl.x = round4(pl.x - nx * overlap * 0.12);
        pl.y = round4(pl.y - ny * overlap * 0.12);

        const relVx = world.ball.vx - pl.vx;
        const relVy = world.ball.vy - pl.vy;
        const normalVel = relVx * nx + relVy * ny;

        if (normalVel < 0) {
          const restitution = 0.12;
          const impulse = round4(-(1 + restitution) * normalVel);
          world.ball.vx = round4(world.ball.vx + impulse * nx);
          world.ball.vy = round4(world.ball.vy + impulse * ny);
        }

        world.lastTouchTeam = pl.team;
        world.awaitingSetPieceTouch = false;
        world.isCornerSetPiece = false;
      }
    }
  }

  // 5. Sub-stepped Ball Movement & Goalpost / Goal Line / Out / Corner Detection
  const subSteps = 2;
  for (let step = 0; step < subSteps; step++) {
    world.ball.x = round4(world.ball.x + world.ball.vx / subSteps);
    world.ball.y = round4(world.ball.y + world.ball.vy / subSteps);

    for (const post of GOALPOSTS) {
      const dx = world.ball.x - post.x;
      const dy = world.ball.y - post.y;
      const dist = Math.hypot(dx, dy);
      const minDist = BALL_RADIUS + POST_RADIUS;
      if (dist < minDist && dist > 0.0001) {
        const angle = Math.atan2(dy, dx);
        const nx = round4(Math.cos(angle));
        const ny = round4(Math.sin(angle));
        world.ball.x = round4(post.x + nx * minDist);
        world.ball.y = round4(post.y + ny * minDist);
        const dot = world.ball.vx * nx + world.ball.vy * ny;
        if (dot < 0) {
          world.ball.vx = round4((world.ball.vx - 2 * dot * nx) * 0.82);
          world.ball.vy = round4((world.ball.vy - 2 * dot * ny) * 0.82);
          events.postHit = true;
        }
      }
    }

    // Check for Goal
    if (world.eventState === 'normal') {
      const inGoalY = world.ball.y > GOAL_TOP && world.ball.y < GOAL_BOTTOM;
      if (inGoalY && world.ball.x + BALL_RADIUS * 0.6 < FIELD_LEFT) {
        world.blueScore += 1;
        world.eventState = 'goal';
        world.eventTeam = 'blue';
        world.eventUntilTick = currentTick + GOAL_PAUSE_TICKS;
        world.awaitingSetPieceTouch = false;
        world.isCornerSetPiece = false;
        world.controllingUid = '';
        world.controlStartedTick = 0;
        events.goalScoredBy = 'blue';
      } else if (inGoalY && world.ball.x - BALL_RADIUS * 0.6 > FIELD_RIGHT) {
        world.redScore += 1;
        world.eventState = 'goal';
        world.eventTeam = 'red';
        world.eventUntilTick = currentTick + GOAL_PAUSE_TICKS;
        world.awaitingSetPieceTouch = false;
        world.isCornerSetPiece = false;
        world.controllingUid = '';
        world.controlStartedTick = 0;
        events.goalScoredBy = 'red';
      }
    }
  }

  // Ball damping & max speed clamp (4-decimal rounded)
  world.ball.vx = round4(world.ball.vx * BALL_DAMPING);
  world.ball.vy = round4(world.ball.vy * BALL_DAMPING);
  const bSpeed = Math.hypot(world.ball.vx, world.ball.vy);
  if (bSpeed > BALL_MAX_SPEED) {
    const bAngle = Math.atan2(world.ball.vy, world.ball.vx);
    world.ball.vx = round4(Math.cos(bAngle) * BALL_MAX_SPEED);
    world.ball.vy = round4(Math.sin(bAngle) * BALL_MAX_SPEED);
  } else if (bSpeed < 0.03) {
    world.ball.vx = 0;
    world.ball.vy = 0;
  }

  // Soft goal-pocket containment inside deterministic world so ball stays in goal pocket
  const inGoalMouthY =
    world.ball.y > GOAL_TOP - BALL_RADIUS &&
    world.ball.y < GOAL_BOTTOM + BALL_RADIUS;
  if (inGoalMouthY && world.ball.x < FIELD_LEFT) {
    const minBackX = FIELD_LEFT - 56 + BALL_RADIUS;
    if (world.ball.x < minBackX) {
      world.ball.x = round4(minBackX);
      world.ball.vx = round4(Math.abs(world.ball.vx) * 0.08);
      world.ball.vy = round4(world.ball.vy * 0.5);
    }
    if (world.ball.y - BALL_RADIUS < GOAL_TOP) {
      world.ball.y = round4(GOAL_TOP + BALL_RADIUS);
      world.ball.vy = round4(Math.abs(world.ball.vy) * 0.12);
    } else if (world.ball.y + BALL_RADIUS > GOAL_BOTTOM) {
      world.ball.y = round4(GOAL_BOTTOM - BALL_RADIUS);
      world.ball.vy = round4(-Math.abs(world.ball.vy) * 0.12);
    }
  } else if (inGoalMouthY && world.ball.x > FIELD_RIGHT) {
    const maxBackX = FIELD_RIGHT + 56 - BALL_RADIUS;
    if (world.ball.x > maxBackX) {
      world.ball.x = round4(maxBackX);
      world.ball.vx = round4(-Math.abs(world.ball.vx) * 0.08);
      world.ball.vy = round4(world.ball.vy * 0.5);
    }
    if (world.ball.y - BALL_RADIUS < GOAL_TOP) {
      world.ball.y = round4(GOAL_TOP + BALL_RADIUS);
      world.ball.vy = round4(Math.abs(world.ball.vy) * 0.12);
    } else if (world.ball.y + BALL_RADIUS > GOAL_BOTTOM) {
      world.ball.y = round4(GOAL_BOTTOM - BALL_RADIUS);
      world.ball.vy = round4(-Math.abs(world.ball.vy) * 0.12);
    }
  }

  // Check Corner & Touchline Out during normal play
  if (world.eventState === 'normal') {
    const inGoalY = world.ball.y > GOAL_TOP && world.ball.y < GOAL_BOTTOM;
    const crossedLeftOut = !inGoalY && world.ball.x + BALL_RADIUS < FIELD_LEFT;
    const crossedRightOut = !inGoalY && world.ball.x - BALL_RADIUS > FIELD_RIGHT;

    if (crossedLeftOut || crossedRightOut) {
      const cornerX = crossedLeftOut ? FIELD_LEFT + 6 : FIELD_RIGHT - 6;
      const cornerY =
        world.ball.y < FIELD_CENTER_Y ? FIELD_TOP + 6 : FIELD_BOTTOM - 6;
      const cornerTeam: EventTeam =
        world.lastTouchTeam === 'red'
          ? 'blue'
          : world.lastTouchTeam === 'blue'
            ? 'red'
            : crossedLeftOut
              ? 'blue'
              : 'red';

      world.eventState = 'corner';
      world.eventTeam = cornerTeam;
      world.eventUntilTick = currentTick + OUT_PAUSE_TICKS;
      world.ball.x = round4(cornerX);
      world.ball.y = round4(cornerY);
      world.ball.vx = 0;
      world.ball.vy = 0;
      world.awaitingSetPieceTouch = true;
      world.isCornerSetPiece = true;
      world.setPieceExpireTick = currentTick + OUT_PAUSE_TICKS + SET_PIECE_EXPIRE_TICKS;
      events.outOrCornerTriggered = true;
    } else {
      const crossedTop = world.ball.y + BALL_RADIUS < FIELD_TOP;
      const crossedBottom = world.ball.y - BALL_RADIUS > FIELD_BOTTOM;
      if (crossedTop || crossedBottom) {
        const exitX = Math.max(
          FIELD_LEFT + 36,
          Math.min(FIELD_RIGHT - 36, world.ball.x)
        );
        const returnY = crossedTop ? FIELD_TOP + 4 : FIELD_BOTTOM - 4;
        const throwTeam: EventTeam =
          world.lastTouchTeam === 'red'
            ? 'blue'
            : world.lastTouchTeam === 'blue'
              ? 'red'
              : 'red';

        world.eventState = 'out';
        world.eventTeam = throwTeam;
        world.eventUntilTick = currentTick + OUT_PAUSE_TICKS;
        world.ball.x = round4(exitX);
        world.ball.y = round4(returnY);
        world.ball.vx = 0;
        world.ball.vy = 0;
        world.awaitingSetPieceTouch = true;
        world.isCornerSetPiece = false;
        world.setPieceExpireTick = currentTick + OUT_PAUSE_TICKS + SET_PIECE_EXPIRE_TICKS;
        events.outOrCornerTriggered = true;
      }
    }
  }

  return events;
}

/**
 * 3. Extrapolation (`extrapolateWorld`)
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

/**
 * 5 & 6. WebRTC P2P DataChannel + Firebase Signaling + Lockstep Timeout Manager
 */
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
  players: Record<
    string,
    {
      x: number;
      y: number;
      vx: number;
      vy: number;
      kicking: boolean;
    }
  >;
}

type DataChannelPacket =
  | ({ kind: 'input' } & InputPacket)
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
      kind: 'frame';
      tick: number;
      inputs: Record<string, PlayerInputKeys>;
      snap?: FastAuthoritativeSnapshot;
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

  // Map of peerUid -> RTCPeerConnection & RTCDataChannel
  private peers = new Map<
    string,
    {
      pc: RTCPeerConnection;
      dc: RTCDataChannel | null;
      open: boolean;
      createdAtPerf: number;
      pendingCandidates: RTCIceCandidateInit[];
      missingTicks: number;
      waitTicksForCurrentFrame: number;
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
    this.onClientBallCallback = opts.onClientBall || null;
    this.onStateSeedCallback = opts.onStateSeed || null;
    this.onPeerDisconnectedCallback = opts.onPeerDisconnected || null;
    this.playerPings[this.localUid] = realtimeWsBroker.getLocalPingMs();

    // 3-Second Ping Probe Timer (strictly every 3000ms to avoid traffic overhead)
    if (typeof window !== 'undefined') {
      this.pingIntervalId = window.setInterval(() => {
        this.sendPingProbes();
      }, PING_INTERVAL_MS);

      // Automatic WebRTC Handshake Retry only if connection is missing or stalled > 6.5s
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
                nowPerf - entry.createdAtPerf > 6500));
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
      }, 4500);
    }
  }

  /**
   * 3. setExtrapolation(extrapolationMs) (analogous to node-haxball)
   * Validates 0..200ms; if > 200ms, Host triggers desync.
   */
  public setExtrapolation(ms: number) {
    this.extrapolationMs = Math.round(ms);
    if (!this.isHost) {
      this.broadcastToPeers({
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

  public connectToMemberPeers(memberUids: string[]) {
    this.targetMemberUids = [...memberUids];
    for (const uid of memberUids) {
      if (uid === this.localUid) continue;
      const existing = this.peers.get(uid);
      if (!existing) {
        if (this.isHost) {
          this.initiateHostPeerConnection(uid);
        } else {
          // Client announces readiness so Host sends WebRTC offer
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

  /**
   * 5. Create RTCPeerConnection strictly with Google STUN server:
   * { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
   * Host creates Data Channel: createDataChannel('gameChannel', { ordered: false, maxRetransmits: 0 })
   */
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
      missingTicks: 0,
      waitTicksForCurrentFrame: 0,
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
    entry.dc = dc;
    dc.onopen = () => {
      entry.open = true;
      entry.missingTicks = 0;
      entry.lastInputAtPerf = performance.now();
      this.sendPingProbes();
    };
    dc.onclose = () => {
      entry.open = false;
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const pkt = JSON.parse(ev.data) as DataChannelPacket;
        this.handleDataChannelPacket(peerUid, entry, pkt);
      } catch {
        // ignore malformed packet
      }
    };
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
      // Never kill an active handshake that is less than 6 seconds old!
      if (!force && !failed && ageMs < 6000) {
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
          // Queue ICE candidate until remoteDescription is set!
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
    entry.missingTicks = 0;
    entry.waitTicksForCurrentFrame = 0;
    entry.lastInputAtPerf = performance.now();
    entry.lastInputKeys = pkt.keys;
    entry.inputBuffer.set(pkt.tick, pkt.keys);
    if (entry.inputBuffer.size > 120) {
      const firstKey = entry.inputBuffer.keys().next().value;
      if (typeof firstKey === 'number') entry.inputBuffer.delete(firstKey);
    }
  }

  private handleDataChannelPacket(
    peerUid: string,
    entry: NonNullable<ReturnType<typeof this.peers.get>>,
    pkt: DataChannelPacket
  ) {
    if (pkt.kind === 'input' && this.isHost) {
      entry.missingTicks = 0;
      entry.waitTicksForCurrentFrame = 0;
      entry.lastInputAtPerf = performance.now();
      entry.lastInputKeys = pkt.keys;
      entry.inputBuffer.set(pkt.tick, pkt.keys);
      if (entry.inputBuffer.size > 120) {
        const firstKey = entry.inputBuffer.keys().next().value;
        if (typeof firstKey === 'number') entry.inputBuffer.delete(firstKey);
      }
    } else if (pkt.kind === 'client_ball' && this.isHost) {
      if (this.onClientBallCallback) {
        this.onClientBallCallback(pkt);
      }
    } else if (pkt.kind === 'frame' && !this.isHost) {
      if (this.onFrameInputsCallback) {
        this.onFrameInputsCallback(pkt.tick, pkt.inputs, pkt.snap);
      }
    } else if (pkt.kind === 'state_seed' && !this.isHost) {
      if (this.onStateSeedCallback) {
        this.onStateSeedCallback(pkt.world);
      }
    } else if (pkt.kind === 'extrapolation' && this.isHost) {
      if (pkt.extrapolationMs < 0 || pkt.extrapolationMs > MAX_EXTRAPOLATION_MS) {
        // Disconnect desynced client exceeding 200ms extrapolation
        this.sendToPeer(peerUid, {
          kind: 'desync',
          reason: `Extrapolation ${pkt.extrapolationMs}ms exceeds maximum allowed 200ms.`,
        });
        this.closeAndRemovePeer(peerUid);
      }
    } else if (pkt.kind === 'desync') {
      this.desynced = true;
      this.desyncReason = pkt.reason;
    } else if (pkt.kind === 'ping') {
      this.sendToPeer(peerUid, {
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
   * 1. Client sends pure input packet `{ tick, playerId, keys }` to Host every tick (60 Hz)
   */
  public sendClientInput(tick: number, keys: PlayerInputKeys) {
    const pkt: DataChannelPacket = {
      kind: 'input',
      tick,
      playerId: this.localUid,
      keys,
    };
    this.broadcastToPeers(pkt);
  }

  /**
   * Fast UDP-like ball touch relay over WebRTC DataChannel when Client touches/kicks ball
   */
  public sendClientBallTouch(ball: {
    ballX: number;
    ballY: number;
    ballVx: number;
    ballVy: number;
    lastTouchTeam: EventTeam;
  }) {
    if (this.isHost) return;
    this.broadcastToPeers({
      kind: 'client_ball',
      playerId: this.localUid,
      ...ball,
    });
  }

  /**
   * 2 & 6. Host Lockstep Resolution for Frame `targetTick` with 5-tick timeout & 60-tick disconnect guard
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
    const nowPerf = performance.now();

    for (const [peerUid, entry] of this.peers.entries()) {
      const buffered = entry.inputBuffer.get(targetTick);
      if (buffered) {
        entry.inputBuffer.delete(targetTick);
        entry.waitTicksForCurrentFrame = 0;
        entry.missingTicks = 0;
        entry.lastInputKeys = buffered;
        frameInputs[peerUid] = buffered;
        continue;
      }

      // Check how many ticks (~16.67ms each) since the peer last sent an input packet
      const silenceMs = nowPerf - entry.lastInputAtPerf;
      const silenceTicks = Math.floor(silenceMs / (1000 / LOCKSTEP_FPS));

      if (silenceTicks < LOCKSTEP_WAIT_TIMEOUT_TICKS) {
        // Peer is actively streaming 60Hz inputs; use latest received input for smooth 60Hz lockstep
        entry.missingTicks = 0;
        frameInputs[peerUid] = entry.lastInputKeys || { ...EMPTY_INPUT_KEYS };
      } else {
        entry.missingTicks = silenceTicks;

        // 6. If inputs are missing for 60 consecutive ticks (1 second) on an open WebRTC channel, close RTCPeerConnection
        if (entry.open && entry.missingTicks >= LOCKSTEP_DISCONNECT_TIMEOUT_TICKS) {
          this.closeAndRemovePeer(peerUid);
          continue;
        }

        // 6. After 5 frames (83 ms) without input, substitute empty input so simulation never freezes
        frameInputs[peerUid] = { ...EMPTY_INPUT_KEYS };
      }
    }

    // Broadcast confirmed inputs of all players (+ authoritative snapshot) to every Client over WebRTC DataChannel
    this.broadcastToPeers({
      kind: 'frame',
      tick: targetTick,
      inputs: frameInputs,
      snap,
    });

    return { ready: true, frameInputs };
  }

  public broadcastStateSeed(world: DeterministicWorldState) {
    if (!this.isHost) return;
    this.broadcastToPeers({
      kind: 'state_seed',
      world,
    });
  }

  private sendPingProbes() {
    const nowPerf = performance.now();
    this.broadcastToPeers({
      kind: 'ping',
      t0: nowPerf,
    });
  }

  private sendToPeer(peerUid: string, pkt: DataChannelPacket) {
    const entry = this.peers.get(peerUid);
    if (entry && entry.open && entry.dc && entry.dc.readyState === 'open') {
      try {
        entry.dc.send(JSON.stringify(pkt));
      } catch {
        // ignore
      }
    }
  }

  private broadcastToPeers(pkt: DataChannelPacket) {
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
