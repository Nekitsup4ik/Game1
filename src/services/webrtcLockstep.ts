import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  setDoc,
} from 'firebase/firestore';
import { db, isFirestoreQuotaExceeded } from '../firebase';
import {
  BALL_BCOEF,
  BALL_DAMPING,
  BALL_INV_MASS,
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
  KICK_RADIUS,
  KICK_RATELIMIT_BURST,
  KICK_RATELIMIT_MIN,
  KICK_RATELIMIT_RATE,
  KICK_STRENGTH,
  PLAYER_ACCEL,
  PLAYER_BCOEF,
  PLAYER_DAMPING,
  PLAYER_INV_MASS,
  PLAYER_KICK_ACCEL,
  PLAYER_KICK_DAMPING,
  PLAYER_MAX_SPEED,
  PLAYER_RADIUS,
  POST_BCOEF,
  POST_RADIUS,
  POWERSHOT_IMPULSE,
  TeamColor,
  WALL_BCOEF,
} from '../types/game';
import { realtimeWsBroker } from './realtimeWsBroker';

// ============================================================================
// 1. ФУНДАМЕНТ: ДЕТЕРМИНИРОВАННАЯ МАТЕМАТИКА 60 ГЦ И СИДИРОВАННЫЙ PRNG
// ============================================================================
export const LOCKSTEP_FPS = 60;
export const LOCKSTEP_DT = 1 / LOCKSTEP_FPS; // Строго DT = 1/60 секунды
export const LOCKSTEP_STEP_MS = 1000 / LOCKSTEP_FPS; // 16.6667 мс
export const MAX_EXTRAPOLATION_MS = 200;
export const DEFAULT_EXTRAPOLATION_MS = 0; // Рекомендуемое значение — 0 мс
export const SMOOTHING_FACTOR = 0.2; // Коэффициент сглаживания Jitter Damper (0.2)
export const LOCKSTEP_WAIT_TIMEOUT_TICKS = 5; // 5 тиков (83 мс) -> пустой инпут
export const LOCKSTEP_DISCONNECT_TIMEOUT_TICKS = 60; // 60 тиков (1 сек) -> закрыть RTCPeerConnection
export const PING_INTERVAL_MS = 3000;
export const GOAL_PAUSE_TICKS = 3 * LOCKSTEP_FPS; // 180 тиков
export const POWERSHOT_CHARGE_TICKS = 4 * LOCKSTEP_FPS; // 240 тиков
export const POWERSHOT_WINDOW_TICKS = Math.round(2.5 * LOCKSTEP_FPS); // 150 тиков

export { KICK_RADIUS, KICK_STRENGTH };
export const FP_SCALE = 10000;

/**
 * Округление до 4 знаков после запятой после КАЖДОЙ арифметической операции
 */
export function round4(x: number): number {
  return Math.round(x * FP_SCALE) / FP_SCALE;
}

export function fpAdd(a: number, b: number): number {
  return round4(round4(a) + round4(b));
}

export function fpSub(a: number, b: number): number {
  return round4(round4(a) - round4(b));
}

export function fpMul(a: number, b: number): number {
  return round4(round4(a) * round4(b));
}

export function fpDiv(a: number, b: number): number {
  const denom = round4(b);
  if (denom === 0) return 0;
  return round4(round4(a) / denom);
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

/**
 * Сидированный детерминированный PRNG (Mulberry32) вместо Math.random()
 */
export function mulberry32(seed: number): { next: () => number; getState: () => number } {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return round4(((t ^ (t >>> 14)) >>> 0) / 4294967296);
    },
    getState(): number {
      return state >>> 0;
    },
  };
}

// ============================================================================
// 2. ИНПУТЫ И БИТОВАЯ МАСКА КНОПОК (1 БАЙТ: up=1, down=2, left=4, right=8, kick=16)
// ============================================================================
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
// 3. СТЕНЫ (СЕГМЕНТЫ С ФЛАГОМ wall) И СТОЛКНОВЕНИЯ БЕЗ АУТОВ
// ============================================================================
export interface WallSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  nx: number; // Единичная нормаль внутрь поля X
  ny: number; // Единичная нормаль внутрь поля Y
  bCoef: number; // Коэффициент упругости стены
  wall: boolean;
}

/**
 * Сегменты стен стадиона HaxBall (без аутов!).
 * Ворота открыты между GOAL_TOP и GOAL_BOTTOM, но ограничены задним и боковыми сегментами ворот.
 */
export const PITCH_WALL_SEGMENTS: WallSegment[] = [
  // Верхняя боковая стена поля (нормаль вниз: 0, +1)
  { x0: FIELD_LEFT, y0: FIELD_TOP, x1: FIELD_RIGHT, y1: FIELD_TOP, nx: 0, ny: 1, bCoef: WALL_BCOEF, wall: true },
  // Нижняя боковая стена поля (нормаль вверх: 0, -1)
  { x0: FIELD_LEFT, y0: FIELD_BOTTOM, x1: FIELD_RIGHT, y1: FIELD_BOTTOM, nx: 0, ny: -1, bCoef: WALL_BCOEF, wall: true },
  // Левая лицевая стена выше ворот (нормаль вправо: +1, 0)
  { x0: FIELD_LEFT, y0: FIELD_TOP, x1: FIELD_LEFT, y1: GOAL_TOP, nx: 1, ny: 0, bCoef: WALL_BCOEF, wall: true },
  // Левая лицевая стена ниже ворот (нормаль вправо: +1, 0)
  { x0: FIELD_LEFT, y0: GOAL_BOTTOM, x1: FIELD_LEFT, y1: FIELD_BOTTOM, nx: 1, ny: 0, bCoef: WALL_BCOEF, wall: true },
  // Правая лицевая стена выше ворот (нормаль влево: -1, 0)
  { x0: FIELD_RIGHT, y0: FIELD_TOP, x1: FIELD_RIGHT, y1: GOAL_TOP, nx: -1, ny: 0, bCoef: WALL_BCOEF, wall: true },
  // Правая лицевая стена ниже ворот (нормаль влево: -1, 0)
  { x0: FIELD_RIGHT, y0: GOAL_BOTTOM, x1: FIELD_RIGHT, y1: FIELD_BOTTOM, nx: -1, ny: 0, bCoef: WALL_BCOEF, wall: true },
];

export interface PhysicsDisc {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  bCoef: number;
  invMass: number;
  damping: number;
}

/**
 * Алгоритм столкновения диска со стеной (сегментом) по спецификации HaxBall:
 * 1. Обнаружение перекрытия (расстояние от центра диска до сегмента < радиуса диска + защита от туннелирования).
 * 2. Разделение (position correction): сдвиг диска по нормали от стены на минимальное расстояние.
 * 3. Отражение скорости: разложение на нормальную и тангенциальную компоненты;
 *    нормальная компонента меняет знак и умножается на (disc.bCoef * segment.bCoef), тангенциальная сохраняется.
 */
export function collideDiscWithWallSegment(
  disc: { x: number; y: number; vx: number; vy: number; radius: number; bCoef?: number },
  seg: WallSegment
): boolean {
  if (!seg.wall) return false;

  // Для мяча используем мягкий упругий отскок HaxBall (BALL_BCOEF = 0.5), чтобы мяч не отлетал слишком сильно от стен
  const discBCoef = disc.bCoef ?? BALL_BCOEF;
  const combinedBCoef = round4(discBCoef * seg.bCoef);

  // Горизонтальная стена (верхняя y = FIELD_TOP или нижняя y = FIELD_BOTTOM)
  if (seg.ny !== 0 && seg.nx === 0) {
    const minX = Math.min(seg.x0, seg.x1) - disc.radius;
    const maxX = Math.max(seg.x0, seg.x1) + disc.radius;
    if (disc.x < minX || disc.x > maxX) return false;

    const wallY = seg.y0;
    // Верхняя стена (нормаль вниз ny = +1)
    if (seg.ny > 0) {
      const penetration = round4(wallY + disc.radius - disc.y);
      if (penetration > 0) {
        disc.y = round4(wallY + disc.radius);
        if (disc.vy < 0) {
          disc.vy = round4(-disc.vy * combinedBCoef);
        }
        return true;
      }
    } else {
      // Нижняя стена (нормаль вверх ny = -1)
      const penetration = round4(disc.y + disc.radius - wallY);
      if (penetration > 0) {
        disc.y = round4(wallY - disc.radius);
        if (disc.vy > 0) {
          disc.vy = round4(-disc.vy * combinedBCoef);
        }
        return true;
      }
    }
    return false;
  }

  // Вертикальная лицевая стена (левая x = FIELD_LEFT или правая x = FIELD_RIGHT)
  if (seg.nx !== 0 && seg.ny === 0) {
    const minY = Math.min(seg.y0, seg.y1);
    const maxY = Math.max(seg.y0, seg.y1);

    // Не перехватываем мяч в створе ворот и возле штанг (штанги обрабатываются круговыми коллизиями GOALPOSTS)
    if (disc.y > GOAL_TOP - POST_RADIUS * 0.5 && disc.y < GOAL_BOTTOM + POST_RADIUS * 0.5) {
      return false;
    }
    if (disc.y < minY - disc.radius || disc.y > maxY + disc.radius) {
      return false;
    }

    const wallX = seg.x0;
    // Левая стена (нормаль вправо nx = +1)
    if (seg.nx > 0) {
      const penetration = round4(wallX + disc.radius - disc.x);
      if (penetration > 0 && disc.x >= wallX - disc.radius * 3) {
        disc.x = round4(wallX + disc.radius);
        if (disc.vx < 0) {
          disc.vx = round4(-disc.vx * combinedBCoef);
        }
        return true;
      }
    } else {
      // Правая стена (нормаль влево nx = -1)
      const penetration = round4(disc.x + disc.radius - wallX);
      if (penetration > 0 && disc.x <= wallX + disc.radius * 3) {
        disc.x = round4(wallX - disc.radius);
        if (disc.vx > 0) {
          disc.vx = round4(-disc.vx * combinedBCoef);
        }
        return true;
      }
    }
    return false;
  }

  // Общий случай для произвольного наклонного сегмента
  const abx = round4(seg.x1 - seg.x0);
  const aby = round4(seg.y1 - seg.y0);
  const abLenSq = round4(round4(abx * abx) + round4(aby * aby));
  if (abLenSq <= 0.0001) return false;

  const apx = round4(disc.x - seg.x0);
  const apy = round4(disc.y - seg.y0);
  const dotAP = round4(round4(apx * abx) + round4(apy * aby));
  const t = Math.max(0, Math.min(1, round4(dotAP / abLenSq)));

  const closestX = round4(seg.x0 + round4(abx * t));
  const closestY = round4(seg.y0 + round4(aby * t));

  const dx = round4(disc.x - closestX);
  const dy = round4(disc.y - closestY);
  const dist = fpHypot(dx, dy);
  if (dist >= disc.radius || dist <= 0.0001) return false;

  const nx = seg.nx;
  const ny = seg.ny;
  const tx = -ny;
  const ty = nx;

  const pushDist = round4(disc.radius - dist);
  disc.x = round4(disc.x + round4(nx * pushDist));
  disc.y = round4(disc.y + round4(ny * pushDist));

  const vn = round4(round4(disc.vx * nx) + round4(disc.vy * ny));
  const vt = round4(round4(disc.vx * tx) + round4(disc.vy * ty));

  if (vn < 0) {
    const reflectedVn = round4(-vn * combinedBCoef);
    disc.vx = round4(round4(reflectedVn * nx) + round4(vt * tx));
    disc.vy = round4(round4(reflectedVn * ny) + round4(vt * ty));
  }

  return true;
}

/**
 * Столкновение мяча/диска со всеми сегментами стен поля (без аутов и сбросов в центр!)
 */
export function collideBallWithWallSegments(
  ball: { x: number; y: number; vx: number; vy: number; radius: number; bCoef?: number },
  segments: WallSegment[] = PITCH_WALL_SEGMENTS
): boolean {
  let hit = false;
  // Если мяч уже влетел в карман ворот, не выталкиваем его лицевыми стенами поля
  const inGoalPocket =
    (ball.x < FIELD_LEFT || ball.x > FIELD_RIGHT) &&
    ball.y > GOAL_TOP - ball.radius * 1.5 &&
    ball.y < GOAL_BOTTOM + ball.radius * 1.5;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (inGoalPocket) continue;
    if (collideDiscWithWallSegment(ball, seg)) {
      hit = true;
    }
  }
  return hit;
}

/**
 * Столкновение двух дисков (игрок-игрок, игрок-мяч, диск-штанга) по физике HaxBall:
 * 1. Разделение пропорционально обратным массам invMass1 / (invMass1 + invMass2)
 * 2. Обмен импульсом с коэффициентом упругости bCoef = round4(d1.bCoef * d2.bCoef)
 */
export function collideDiscWithDisc(d1: PhysicsDisc, d2: PhysicsDisc): boolean {
  const totalInvMass = round4(d1.invMass + d2.invMass);
  if (totalInvMass <= 0) return false;

  const dx = round4(d2.x - d1.x);
  const dy = round4(d2.y - d1.y);
  const dist = fpHypot(dx, dy);
  const minDist = round4(d1.radius + d2.radius);

  if (dist >= minDist || dist <= 0.0001) return false;

  const angle = fpAtan2(dy, dx);
  const nx = fpCos(angle);
  const ny = fpSin(angle);
  const overlap = round4(minDist - dist);

  // 1. Position correction (разделение пропорционально invMass)
  const ratio1 = round4(d1.invMass / totalInvMass);
  const ratio2 = round4(d2.invMass / totalInvMass);
  d1.x = round4(d1.x - round4(nx * round4(overlap * ratio1)));
  d1.y = round4(d1.y - round4(ny * round4(overlap * ratio1)));
  d2.x = round4(d2.x + round4(nx * round4(overlap * ratio2)));
  d2.y = round4(d2.y + round4(ny * round4(overlap * ratio2)));

  // 2. Отражение относительной нормальной скорости
  const rvx = round4(d2.vx - d1.vx);
  const rvy = round4(d2.vy - d1.vy);
  const vn = round4(round4(rvx * nx) + round4(rvy * ny));

  if (vn < 0) {
    const combinedBCoef = round4(d1.bCoef * d2.bCoef);
    const j = round4(round4(-(1 + combinedBCoef) * vn) / totalInvMass);
    const impX = round4(nx * j);
    const impY = round4(ny * j);

    d1.vx = round4(d1.vx - round4(impX * d1.invMass));
    d1.vy = round4(d1.vy - round4(impY * d1.invMass));
    d2.vx = round4(d2.vx + round4(impX * d2.invMass));
    d2.vy = round4(d2.vy + round4(impY * d2.invMass));
  }

  return true;
}

// ============================================================================
// 4. УДАР (KICK) — ДЕТЕРМИНИРОВАННАЯ ФУНКЦИЯ С RATE-LIMIT (/kick_ratelimit 2 15 3)
// ============================================================================
export interface KickRateLimitState {
  cooldownTicks: number;
  burstUsed: number;
  lastKickTick: number;
}

/**
 * Детерминированная функция удара `attemptKick(player, ball, input)`:
 * - Если input.keys.kick === false -> null
 * - Вычисляет dx, dy, distance = Math.hypot(dx, dy)
 * - Если distance >= player.radius + ball.radius + KICK_RADIUS (KICK_RADIUS = 4) -> null
 * - Вычисляет angle = Math.atan2(dy, dx), nx = round4(Math.cos(angle)), ny = round4(Math.sin(angle))
 * - Применяет импульс к мячу: ball.vx = round4(ball.vx + impulseX), ball.vy = round4(ball.vy + impulseY)
 * - Скорость игрока при ударе НЕ меняется.
 * - Поддерживает rate-limit (/kick_ratelimit 2 15 3).
 */
export function attemptKick(
  player: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    kickCooldown?: number;
    kickBurstCount?: number;
  },
  ball: { x: number; y: number; vx: number; vy: number; radius: number },
  input: { keys: PlayerInputKeys },
  kickStrength: number = KICK_STRENGTH,
  kickRadius: number = KICK_RADIUS
): { impulseX: number; impulseY: number } | null {
  if (input.keys.kick === false) {
    return null;
  }

  // Проверка rate-limit (/kick_ratelimit 2 15 3)
  if ((player.kickCooldown ?? 0) > 0) {
    return null;
  }

  const dx = round4(ball.x - player.x);
  const dy = round4(ball.y - player.y);
  const distance = round4(Math.hypot(dx, dy));
  const maxKickDist = round4(player.radius + ball.radius + kickRadius);

  if (distance >= maxKickDist || distance <= 0.0001) {
    return null;
  }

  const angle = Math.atan2(dy, dx);
  const nx = round4(Math.cos(angle));
  const ny = round4(Math.sin(angle));

  const impulseX = round4(nx * kickStrength);
  const impulseY = round4(ny * kickStrength);

  ball.vx = round4(ball.vx + impulseX);
  ball.vy = round4(ball.vy + impulseY);

  // Обновление счетчика rate-limit: первые (BURST + 1 = 4) удара каждые 2 кадра, затем раз в 15 кадров
  const used = (player.kickBurstCount ?? 0) + 1;
  player.kickBurstCount = used;
  player.kickCooldown =
    used <= KICK_RATELIMIT_BURST + 1 ? KICK_RATELIMIT_MIN : KICK_RATELIMIT_RATE;

  return { impulseX, impulseY };
}

// ============================================================================
// МОДУЛЬ (а): ПОЛНОЕ ФИЗИЧЕСКОЕ ЯДРО `stepPhysics(state, inputs, tick)`
// ============================================================================
export interface DeterministicPlayerState {
  playerId: string;
  slotIndex: number;
  team: TeamColor;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  bCoef: number;
  invMass: number;
  damping: number;
  kicking: boolean;
  kickLock: boolean;
  kickCooldown?: number;
  kickBurstCount?: number;
}

export interface DeterministicBallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  bCoef: number;
  invMass: number;
  damping: number;
}

export interface DeterministicWorldState {
  tick: number;
  prngSeed: number;
  playerOrder: string[]; // Фиксированный массив игроков (никакого несортированного Object.keys!)
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

const GOALPOST_DISCS: PhysicsDisc[] = [
  { x: FIELD_LEFT, y: GOAL_TOP, vx: 0, vy: 0, radius: POST_RADIUS, bCoef: POST_BCOEF, invMass: 0, damping: 1 },
  { x: FIELD_LEFT, y: GOAL_BOTTOM, vx: 0, vy: 0, radius: POST_RADIUS, bCoef: POST_BCOEF, invMass: 0, damping: 1 },
  { x: FIELD_RIGHT, y: GOAL_TOP, vx: 0, vy: 0, radius: POST_RADIUS, bCoef: POST_BCOEF, invMass: 0, damping: 1 },
  { x: FIELD_RIGHT, y: GOAL_BOTTOM, vx: 0, vy: 0, radius: POST_RADIUS, bCoef: POST_BCOEF, invMass: 0, damping: 1 },
];

/**
 * Детерминированный шаг физики HaxBall (60 Гц, DT = 1/60, строго целочисленный tick, round4 после каждой операции)
 * @param state Состояние мира (обновляется in-place)
 * @param inputs Массив или словарь инпутов на текущий тик
 * @param tick Целочисленный номер тика
 */
export function stepPhysics(
  state: DeterministicWorldState,
  inputs: PlayerInputKeys[] | Record<string, PlayerInputKeys>,
  tick: number
): StepEvents {
  state.tick = tick;

  const events: StepEvents = {
    kickedByUid: null,
    wasPowershot: false,
    postHit: false,
    wallHit: false,
    goalScoredBy: null,
  };

  // Гарантированный фиксированный порядок массива игроков
  const orderedIds =
    state.playerOrder && state.playerOrder.length > 0
      ? state.playerOrder
      : Object.keys(state.players).sort();

  // Helper для получения инпута игрока по индексу в массиве или по UID
  const getInputForPlayer = (uid: string, idx: number): PlayerInputKeys => {
    if (Array.isArray(inputs)) {
      return inputs[idx] || EMPTY_INPUT_KEYS;
    }
    return inputs[uid] || EMPTY_INPUT_KEYS;
  };

  // 1. Движение игроков, ускорение (0.12 или 0.07 при зажатом ударе) и damping (0.96)
  for (let i = 0; i < orderedIds.length; i++) {
    const uid = orderedIds[i];
    const pl = state.players[uid];
    if (!pl) continue;

    const keys = getInputForPlayer(uid, i);

    if ((pl.kickCooldown ?? 0) > 0) {
      pl.kickCooldown = (pl.kickCooldown ?? 0) - 1;
    }
    if (!keys.kick) {
      pl.kickLock = false;
      if ((pl.kickCooldown ?? 0) === 0) {
        pl.kickBurstCount = 0;
      }
    }

    const isTryingToKick = Boolean(keys.kick && !pl.kickLock);
    pl.kicking = isTryingToKick;

    let dirX = 0;
    let dirY = 0;
    if (keys.left) dirX -= 1;
    if (keys.right) dirX += 1;
    if (keys.up) dirY -= 1;
    if (keys.down) dirY += 1;

    const accel = isTryingToKick ? PLAYER_KICK_ACCEL : PLAYER_ACCEL;
    const damp = isTryingToKick ? PLAYER_KICK_DAMPING : (pl.damping ?? PLAYER_DAMPING);

    if (dirX !== 0 || dirY !== 0) {
      const angle = Math.atan2(dirY, dirX);
      const nx = round4(Math.cos(angle));
      const ny = round4(Math.sin(angle));
      pl.vx = round4(pl.vx + round4(nx * accel));
      pl.vy = round4(pl.vy + round4(ny * accel));
    }

    // Damping применяется каждый тик: speed *= damping
    pl.vx = round4(pl.vx * damp);
    pl.vy = round4(pl.vy * damp);

    // Обновление позиции игрока
    pl.x = round4(pl.x + pl.vx);
    pl.y = round4(pl.y + pl.vy);
  }

  // 2. Движение мяча и его damping (0.99)
  const ball = state.ball;
  ball.x = round4(ball.x + ball.vx);
  ball.y = round4(ball.y + ball.vy);
  ball.vx = round4(ball.vx * (ball.damping ?? BALL_DAMPING));
  ball.vy = round4(ball.vy * (ball.damping ?? BALL_DAMPING));

  // 3. Столкновения между игроками (фиксированный порядок пар i < j)
  for (let i = 0; i < orderedIds.length; i++) {
    const p1 = state.players[orderedIds[i]];
    if (!p1) continue;
    for (let j = i + 1; j < orderedIds.length; j++) {
      const p2 = state.players[orderedIds[j]];
      if (!p2) continue;
      collideDiscWithDisc(p1, p2);
    }
  }

  // 4. Удар (attemptKick) и столкновения игроков с мячом, стенами и штангами
  for (let i = 0; i < orderedIds.length; i++) {
    const uid = orderedIds[i];
    const pl = state.players[uid];
    if (!pl) continue;
    const keys = getInputForPlayer(uid, i);

    // Сначала проверяем детерминированный удар attemptKick
    if (!pl.kickLock) {
      const kickRes = attemptKick(pl, ball, { keys }, KICK_STRENGTH, KICK_RADIUS);
      if (kickRes) {
        pl.kickLock = true;
        pl.kicking = false;
        state.lastTouchTeam = pl.team;
        events.kickedByUid = uid;
      }
    }

    // Столкновение диска игрока с диском мяча (разделение + передача импульса)
    if (collideDiscWithDisc(pl, ball)) {
      state.lastTouchTeam = pl.team;
    }

    // Столкновение игрока со штангами ворот
    for (let pIdx = 0; pIdx < GOALPOST_DISCS.length; pIdx++) {
      collideDiscWithDisc(pl, GOALPOST_DISCS[pIdx]);
    }

    // Ограничение игрока внешними бортами арены
    const minX = pl.radius + 12;
    const maxX = CANVAS_WIDTH - pl.radius - 12;
    const minY = pl.radius + 12;
    const maxY = CANVAS_HEIGHT - pl.radius - 12;
    if (pl.x < minX) {
      pl.x = minX;
      if (pl.vx < 0) pl.vx = round4(-pl.vx * round4(pl.bCoef * WALL_BCOEF));
    } else if (pl.x > maxX) {
      pl.x = maxX;
      if (pl.vx > 0) pl.vx = round4(-pl.vx * round4(pl.bCoef * WALL_BCOEF));
    }
    if (pl.y < minY) {
      pl.y = minY;
      if (pl.vy < 0) pl.vy = round4(-pl.vy * round4(pl.bCoef * WALL_BCOEF));
    } else if (pl.y > maxY) {
      pl.y = maxY;
      if (pl.vy > 0) pl.vy = round4(-pl.vy * round4(pl.bCoef * WALL_BCOEF));
    }
  }

  // 5. Столкновение мяча со стенами (сегментами с флагом wall, БЕЗ АУТОВ!) и штангами
  if (state.eventState === 'normal') {
    if (collideBallWithWallSegments(ball, PITCH_WALL_SEGMENTS)) {
      events.wallHit = true;
    }
  }

  for (let pIdx = 0; pIdx < GOALPOST_DISCS.length; pIdx++) {
    if (collideDiscWithDisc(ball, GOALPOST_DISCS[pIdx])) {
      events.postHit = true;
    }
  }

  // 6. Проверка взятия ворот (если мяч пересёк линию ворот между GOAL_TOP и GOAL_BOTTOM)
  if (state.eventState === 'normal') {
    const inGoalY = ball.y > GOAL_TOP && ball.y < GOAL_BOTTOM;
    if (inGoalY && ball.x + round4(ball.radius * 0.6) < FIELD_LEFT) {
      state.blueScore += 1;
      state.eventState = 'goal';
      state.eventTeam = 'blue';
      state.eventUntilTick = tick + GOAL_PAUSE_TICKS;
      events.goalScoredBy = 'blue';
    } else if (inGoalY && ball.x - round4(ball.radius * 0.6) > FIELD_RIGHT) {
      state.redScore += 1;
      state.eventState = 'goal';
      state.eventTeam = 'red';
      state.eventUntilTick = tick + GOAL_PAUSE_TICKS;
      events.goalScoredBy = 'red';
    }
  }

  return events;
}

/**
 * Совместимый обёрточный вызов для детерминированного шага мира
 */
export function stepDeterministicWorld(
  world: DeterministicWorldState,
  inputs: Record<string, PlayerInputKeys>,
  redUids: string[],
  blueUids: string[]
): StepEvents {
  const nextTick = world.tick + 1;

  // Завершение паузы после гола
  if (world.eventState === 'goal' && nextTick >= world.eventUntilTick) {
    world.eventState = 'normal';
    world.eventUntilTick = 0;
    world.ball.x = FIELD_CENTER_X;
    world.ball.y = FIELD_CENTER_Y;
    world.ball.vx = 0;
    world.ball.vy = 0;
    world.eventTeam = 'none';

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

  world.playerOrder = [...redUids, ...blueUids];
  return stepPhysics(world, inputs, nextTick);
}

export function cloneWorldState(state: DeterministicWorldState): DeterministicWorldState {
  const playersCopy: Record<string, DeterministicPlayerState> = {};
  const order = state.playerOrder || Object.keys(state.players).sort();
  for (let i = 0; i < order.length; i++) {
    const uid = order[i];
    if (state.players[uid]) {
      playersCopy[uid] = { ...state.players[uid] };
    }
  }
  return {
    ...state,
    playerOrder: [...order],
    players: playersCopy,
    ball: { ...state.ball },
  };
}

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
// 5. БИНАРНЫЙ ПРОТОКОЛ (4 БАЙТА ArrayBuffer: tick 2B, playerId 1B, keyMask 1B)
// ============================================================================
/**
 * Упаковка инпута клиента ровно в 4 байта ArrayBuffer (спецификация п. 5):
 * Байты [0..1]: Uint16 tick (0..65535, little-endian)
 * Байт  [2]:    Uint8  playerSlotId (0..255)
 * Байт  [3]:    Uint8  keyMask (up=1, down=2, left=4, right=8, kick=16)
 * Никаких координат мяча или игроков в пакете — только инпуты!
 */
export function encodeBinaryClientInput4B(
  tick: number,
  playerSlotId: number,
  keys: PlayerInputKeys
): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  view.setUint16(0, tick & 0xffff, true);
  view.setUint8(2, playerSlotId & 0xff);
  view.setUint8(3, encodeKeyMask(keys));
  return buf;
}

export function decodeBinaryClientInput4B(
  buf: ArrayBuffer
): { tick16: number; playerSlotId: number; keyMask: number; keys: PlayerInputKeys } | null {
  if (buf.byteLength !== 4) return null;
  const view = new DataView(buf);
  const tick16 = view.getUint16(0, true);
  const playerSlotId = view.getUint8(2);
  const keyMask = view.getUint8(3);
  return {
    tick16,
    playerSlotId,
    keyMask,
    keys: decodeKeyMask(keyMask),
  };
}

/**
 * Упаковка подтверждённого тика от Хоста в бинарный ArrayBuffer:
 * Байты [0..1]: Uint16 tick
 * Байт  [2]:    Uint8  количество игроков N
 * Далее N пар байт: [playerSlotId: Uint8, keyMask: Uint8]
 */
export function encodeBinaryHostFrameInputs(
  tick: number,
  orderedMemberUids: string[],
  frameInputs: Record<string, PlayerInputKeys>
): ArrayBuffer {
  const count = Math.min(16, orderedMemberUids.length);
  const buf = new ArrayBuffer(3 + count * 2);
  const view = new DataView(buf);
  view.setUint16(0, tick & 0xffff, true);
  view.setUint8(2, count);
  for (let i = 0; i < count; i++) {
    const uid = orderedMemberUids[i];
    const keys = frameInputs[uid] || EMPTY_INPUT_KEYS;
    view.setUint8(3 + i * 2, i);
    view.setUint8(3 + i * 2 + 1, encodeKeyMask(keys));
  }
  return buf;
}

export function decodeBinaryHostFrameInputs(
  buf: ArrayBuffer,
  orderedMemberUids: string[]
): { tick: number; inputs: Record<string, PlayerInputKeys> } | null {
  if (buf.byteLength < 3) return null;
  const view = new DataView(buf);
  const tick = view.getUint16(0, true);
  const count = view.getUint8(2);
  if (buf.byteLength !== 3 + count * 2) return null;
  const inputs: Record<string, PlayerInputKeys> = {};
  for (let i = 0; i < count; i++) {
    const slotIdx = view.getUint8(3 + i * 2);
    const keyMask = view.getUint8(3 + i * 2 + 1);
    const uid = orderedMemberUids[slotIdx];
    if (uid) {
      inputs[uid] = decodeKeyMask(keyMask);
    }
  }
  return { tick, inputs };
}

// ============================================================================
// 7. КЛИЕНТСКИЙ JITTER DAMPER (visualX += (targetX - visualX) * SMOOTHING_FACTOR)
// ============================================================================
export class JitterDamper2D {
  public visualX: number;
  public visualY: number;
  public offsetX = 0;
  public offsetY = 0;
  private initialized = false;

  constructor(initialX = 0, initialY = 0) {
    this.visualX = initialX;
    this.visualY = initialY;
  }

  /**
   * Плавное подтягивание визуальной позиции к подтверждённой/предсказанной физической позиции:
   * visualX += (targetX - visualX) * SMOOTHING_FACTOR (где SMOOTHING_FACTOR = 0.2)
   */
  public updateTowards(
    targetX: number,
    targetY: number,
    smoothingFactor: number = SMOOTHING_FACTOR
  ): { x: number; y: number } {
    if (!this.initialized) {
      this.visualX = targetX;
      this.visualY = targetY;
      this.initialized = true;
      return { x: this.visualX, y: this.visualY };
    }
    const errDist = Math.hypot(targetX - this.visualX, targetY - this.visualY);
    if (errDist > 260) {
      // Только при полном респауне после гола (смена половины поля)
      this.visualX = targetX;
      this.visualY = targetY;
    } else {
      this.visualX = round4(this.visualX + (targetX - this.visualX) * smoothingFactor);
      this.visualY = round4(this.visualY + (targetY - this.visualY) * smoothingFactor);
    }
    this.offsetX = round4(this.visualX - targetX);
    this.offsetY = round4(this.visualY - targetY);
    return { x: this.visualX, y: this.visualY };
  }

  public absorbCorrection(
    prevVisualX: number,
    prevVisualY: number,
    newAuthX: number,
    newAuthY: number,
    maxSnapDist = 240
  ) {
    const dx = round4(prevVisualX - newAuthX);
    const dy = round4(prevVisualY - newAuthY);
    if (Math.hypot(dx, dy) < maxSnapDist) {
      this.offsetX = dx;
      this.offsetY = dy;
      this.visualX = prevVisualX;
      this.visualY = prevVisualY;
      this.initialized = true;
    } else {
      this.offsetX = 0;
      this.offsetY = 0;
      this.visualX = newAuthX;
      this.visualY = newAuthY;
      this.initialized = true;
    }
  }

  public stepDecay(smoothingFactor: number = SMOOTHING_FACTOR) {
    // Эквивалент visualX += (targetX - visualX) * SMOOTHING_FACTOR:
    // остаточная дельта умножается на (1 - SMOOTHING_FACTOR) = 0.8
    const keep = 1 - smoothingFactor;
    this.offsetX = Math.abs(this.offsetX) > 0.05 ? round4(this.offsetX * keep) : 0;
    this.offsetY = Math.abs(this.offsetY) > 0.05 ? round4(this.offsetY * keep) : 0;
  }

  public reset(x = 0, y = 0) {
    this.visualX = x;
    this.visualY = y;
    this.offsetX = 0;
    this.offsetY = 0;
    this.initialized = true;
  }
}

// ============================================================================
// МОДУЛЬ (г): ИНИЦИАЛИЗАЦИЯ WebRTC + FIREBASE СИГНАЛИНГ (rooms/[roomId]/iceCandidates)
// ============================================================================
export const HAXBALL_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

/**
 * Создаёт RTCPeerConnection со строгим STUN stun:stun.l.google.com:19302,
 * неупорядоченным DataChannel ('gameChannel', { ordered: false, maxRetransmits: 0 })
 * и обменом ICE-кандидатами через коллекцию rooms/[roomId]/iceCandidates.
 */
export function createHaxballPeerConnectionWithFirebaseSignaling(opts: {
  roomId: string;
  localUid: string;
  remoteUid: string;
  isInitiator: boolean;
  onDataChannelOpen?: (dc: RTCDataChannel) => void;
  onBinaryMessage?: (buf: ArrayBuffer) => void;
}): {
  pc: RTCPeerConnection;
  getDataChannel: () => RTCDataChannel | null;
  startHandshake: () => Promise<void>;
  cleanup: () => void;
} {
  const pc = new RTCPeerConnection(HAXBALL_RTC_CONFIG);
  let activeDc: RTCDataChannel | null = null;
  const unsubscribers: Array<() => void> = [];

  const configureChannel = (dc: RTCDataChannel) => {
    dc.binaryType = 'arraybuffer';
    activeDc = dc;
    dc.onopen = () => {
      opts.onDataChannelOpen?.(dc);
    };
    dc.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        opts.onBinaryMessage?.(event.data);
      }
    };
  };

  if (opts.isInitiator) {
    // Неупорядоченный UDP-подобный режим без ретрансляций (ordered: false, maxRetransmits: 0)
    const dc = pc.createDataChannel('gameChannel', {
      ordered: false,
      maxRetransmits: 0,
    });
    configureChannel(dc);
  } else {
    pc.ondatachannel = (event) => {
      configureChannel(event.channel);
    };
  }

  // Отправка локальных ICE-кандидатов в rooms/[roomId]/iceCandidates
  pc.onicecandidate = (event) => {
    if (!event.candidate || isFirestoreQuotaExceeded) return;
    const iceRef = collection(db, 'rooms', opts.roomId, 'iceCandidates');
    addDoc(iceRef, {
      fromUid: opts.localUid,
      toUid: opts.remoteUid,
      candidate: event.candidate.toJSON(),
      createdAtMs: Date.now(),
    }).catch(() => {});
  };

  // Подписка на новые ICE-кандидаты в rooms/[roomId]/iceCandidates
  if (!isFirestoreQuotaExceeded) {
    const iceRef = collection(db, 'rooms', opts.roomId, 'iceCandidates');
    const unsubIce = onSnapshot(
      iceRef,
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const data = change.doc.data();
            if (
              data.toUid === opts.localUid &&
              data.fromUid === opts.remoteUid &&
              data.candidate
            ) {
              pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
            }
          }
        });
      },
      () => {}
    );
    unsubscribers.push(unsubIce);
  }

  const startHandshake = async () => {
    if (!opts.isInitiator || isFirestoreQuotaExceeded) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await setDoc(
      doc(db, 'rooms', opts.roomId, 'sdpSignals', `${opts.localUid}_${opts.remoteUid}`),
      {
        fromUid: opts.localUid,
        toUid: opts.remoteUid,
        type: 'offer',
        sdp: pc.localDescription?.toJSON() ?? offer,
        updatedAtMs: Date.now(),
      }
    );
  };

  const cleanup = () => {
    unsubscribers.forEach((fn) => fn());
    try {
      activeDc?.close();
      pc.close();
    } catch {
      // ignore
    }
  };

  return {
    pc,
    getDataChannel: () => activeDc,
    startHandshake,
    cleanup,
  };
}

// ============================================================================
// МОДУЛИ (б) И (в): СЕТЕВОЙ МЕНЕДЖЕР ХОСТА И КЛИЕНТА (LOCKSTEP + БУФЕРИЗАЦИЯ + ТАЙМАУТЫ)
// ============================================================================
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
  launchAtMs?: number;
  readyUids?: string[];
  countdownEndsAtMs?: number;
  kickoffTeam?: TeamColor;
  kickoffActive?: boolean;
  elapsedMatchMs?: number;
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
      kind: 'client_state';
      tick: number;
      playerId: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
      kicking: boolean;
      keyMask: number;
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
  private extrapolationMs = DEFAULT_EXTRAPOLATION_MS;
  private desynced = false;
  private desyncReason = '';
  private targetMemberUids: string[] = [];
  private lastSentInputTick = -1;
  private clientLastProcessedTick = -1;
  private clientFutureFrameQueue = new Map<
    number,
    { inputs: Record<string, PlayerInputKeys>; snap?: FastAuthoritativeSnapshot }
  >();

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

    if (typeof window !== 'undefined') {
      this.pingIntervalId = window.setInterval(() => {
        this.sendPingProbes();
      }, PING_INTERVAL_MS);

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

  /**
   * Установка экстраполяции (0..200 мс). Если > 200 мс — хост инициирует desync (защита от читерства).
   */
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
   * Elastic Clock: если в буфере скапливается больше 2–3 тиков, слегка ускоряем шаг,
   * чтобы буфер не раздувался.
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
    if (maxBuffered > 3) return LOCKSTEP_STEP_MS * 0.94;
    if (maxBuffered > 2) return LOCKSTEP_STEP_MS * 0.975;
    return LOCKSTEP_STEP_MS;
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

    // Строго STUN stun:stun.l.google.com:19302
    const pc = new RTCPeerConnection(HAXBALL_RTC_CONFIG);

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
      // Строго ordered: false, maxRetransmits: 0
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
      if (ev.data instanceof ArrayBuffer) {
        this.handleBinaryPacket(peerUid, entry, ev.data);
        return;
      }
      if (typeof ev.data === 'string') {
        try {
          const pkt = JSON.parse(ev.data) as DataChannelControlPacket;
          this.handleControlPacket(peerUid, entry, pkt);
        } catch {
          // ignore
        }
      }
    };
  }

  private handleBinaryPacket(
    peerUid: string,
    entry: NonNullable<ReturnType<typeof this.peers.get>>,
    buf: ArrayBuffer
  ) {
    // 1. На Хосте: приём 4-байтового бинарного пакета инпута от клиента
    if (this.isHost && buf.byteLength === 4) {
      const decoded = decodeBinaryClientInput4B(buf);
      if (!decoded) return;

      entry.ticksSinceLastInput = 0;
      entry.lastInputAtPerf = performance.now();
      entry.lastInputKeys = decoded.keys;
      entry.inputBuffer.set(decoded.tick16, decoded.keys);

      // Защита от раздувания буфера
      if (entry.inputBuffer.size > 6) {
        const sortedTicks = Array.from(entry.inputBuffer.keys()).sort((a, b) => a - b);
        while (sortedTicks.length > 3) {
          const oldTick = sortedTicks.shift()!;
          entry.inputBuffer.delete(oldTick);
        }
      }

      if (this.onClientInputStateCallback) {
        this.onClientInputStateCallback({
          tick: decoded.tick16,
          playerId: peerUid,
          keys: decoded.keys,
          kicking: decoded.keys.kick,
          keyMask: decoded.keyMask,
        });
      }
      return;
    }

    // 2. На Клиенте: приём подтверждённого бинарного кадра инпутов от Хоста
    if (!this.isHost && buf.byteLength >= 3) {
      const decoded = decodeBinaryHostFrameInputs(buf, this.targetMemberUids);
      if (!decoded) return;
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
    entry.ticksSinceLastInput = 0;
    entry.lastInputAtPerf = performance.now();
    entry.lastInputKeys = pkt.keys;
    entry.inputBuffer.set(pkt.tick & 0xffff, pkt.keys);
    if (entry.inputBuffer.size > 6) {
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
      this.clientLastProcessedTick = Math.max(this.clientLastProcessedTick, pkt.tick);
      if (this.onFrameInputsCallback) {
        this.onFrameInputsCallback(pkt.tick, pkt.inputs, pkt.snap);
      }
    } else if (pkt.kind === 'client_ball' && this.isHost) {
      if (this.onClientBallCallback) {
        this.onClientBallCallback(pkt);
      }
    } else if (pkt.kind === 'client_state' && this.isHost) {
      const keys = decodeKeyMask(pkt.keyMask);
      entry.ticksSinceLastInput = 0;
      entry.lastInputAtPerf = performance.now();
      entry.lastInputKeys = keys;
      if (this.onClientInputStateCallback) {
        this.onClientInputStateCallback({
          tick: pkt.tick,
          playerId: peerUid,
          keys,
          x: pkt.x,
          y: pkt.y,
          vx: pkt.vx,
          vy: pkt.vy,
          kicking: pkt.kicking,
          keyMask: pkt.keyMask,
        });
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
   * Клиент отправляет 4-байтовый бинарный пакет ArrayBuffer на каждый тик (60 Гц)
   * и синхронизирует состояние по P2P DataChannel без задержек.
   */
  public sendClientInput(
    tick: number,
    keys: PlayerInputKeys,
    state?: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      kicking: boolean;
      keyMask: number;
    }
  ) {
    if (tick <= this.lastSentInputTick) {
      return;
    }
    this.lastSentInputTick = tick;
    const mySlotId = Math.max(0, this.targetMemberUids.indexOf(this.localUid));
    const binBuf = encodeBinaryClientInput4B(tick, mySlotId, keys);
    this.broadcastBinaryToPeers(binBuf);

    if (state && (tick % 2 === 0 || state.kicking)) {
      this.broadcastControlToPeers({
        kind: 'client_state',
        tick,
        playerId: this.localUid,
        x: state.x,
        y: state.y,
        vx: state.vx,
        vy: state.vy,
        kicking: state.kicking,
        keyMask: state.keyMask,
      });
    }
  }

  public sendClientBallTouch(ball: {
    ballX: number;
    ballY: number;
    ballVx: number;
    ballVy: number;
    lastTouchTeam: EventTeam;
  }) {
    this.broadcastControlToPeers({
      kind: 'client_ball',
      playerId: this.localUid,
      ballX: ball.ballX,
      ballY: ball.ballY,
      ballVx: ball.ballVx,
      ballVy: ball.ballVy,
      lastTouchTeam: ball.lastTouchTeam,
    });
  }

  /**
   * Менеджер Lockstep на Хосте:
   * - Очередь инпутов по tick для каждого клиента
   * - Таймаут > 5 тиков (83 мс): подставляет пустой инпут EMPTY_INPUT_KEYS и продолжает симуляцию
   * - Таймаут > 60 тиков (1 сек): закрывает RTCPeerConnection и удаляет игрока
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

    const tick16 = targetTick & 0xffff;

    for (const [peerUid, entry] of this.peers.entries()) {
      let chosenInput: PlayerInputKeys | undefined = entry.inputBuffer.get(tick16);
      if (chosenInput) {
        entry.inputBuffer.delete(tick16);
        entry.lastProcessedTick = targetTick;
      } else if (entry.inputBuffer.size > 0) {
        const sortedTicks = Array.from(entry.inputBuffer.keys()).sort((a, b) => a - b);
        const nextTickKey = sortedTicks[0];
        chosenInput = entry.inputBuffer.get(nextTickKey);
        entry.inputBuffer.delete(nextTickKey);
        entry.lastProcessedTick = targetTick;
      }

      if (chosenInput) {
        entry.ticksSinceLastInput = 0;
        entry.lastInputKeys = chosenInput;
        frameInputs[peerUid] = chosenInput;
        continue;
      }

      entry.ticksSinceLastInput += 1;

      if (entry.ticksSinceLastInput <= LOCKSTEP_WAIT_TIMEOUT_TICKS) {
        // До 5 тиков (83 мс) удерживаем последний валидный инпут
        frameInputs[peerUid] = entry.lastInputKeys || { ...EMPTY_INPUT_KEYS };
      } else {
        // Более 60 тиков (1 сек) без пакетов -> закрываем RTCPeerConnection и удаляем игрока
        if (entry.open && entry.ticksSinceLastInput > LOCKSTEP_DISCONNECT_TIMEOUT_TICKS) {
          this.closeAndRemovePeer(peerUid);
          continue;
        }
        // Более 5 тиков (83 мс) -> подставляем пустой инпут { up:false, down:false, left:false, right:false, kick:false }
        frameInputs[peerUid] = { ...EMPTY_INPUT_KEYS };
      }
    }

    // Рассылаем подтверждённые инпуты всем клиентам в бинарном ArrayBuffer (60 Гц)
    const binFrame = encodeBinaryHostFrameInputs(
      targetTick,
      this.targetMemberUids,
      frameInputs
    );
    this.broadcastBinaryToPeers(binFrame);

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
