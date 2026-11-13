import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Gamepad2,
  Loader2,
  LogOut,
  RotateCcw,
  Shield,
  Trophy,
  Users,
  Volume2,
  VolumeX,
  Wifi,
} from 'lucide-react';
import {
  BALL_DAMPING,
  BALL_MAX_SPEED,
  BALL_RADIUS,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CENTER_CIRCLE_RADIUS,
  COUNTDOWN_DURATION_MS,
  EventState,
  EventTeam,
  FIELD_BOTTOM,
  FIELD_CENTER_X,
  FIELD_CENTER_Y,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  GOAL_BOTTOM,
  GOAL_DEPTH,
  GOAL_PAUSE_MS,
  GOAL_TOP,
  KICK_IMPULSE,
  KICK_RANGE,
  MATCH_DURATION_MS,
  MATCH_DURATION_SEC,
  MatchRoomDoc,
  PLAYER_ACCEL,
  PLAYER_DAMPING,
  PLAYER_KICK_ACCEL,
  PLAYER_MAX_SPEED,
  PLAYER_RADIUS,
  POST_RADIUS,
  POWERSHOT_CHARGE_MS,
  POWERSHOT_IMPULSE,
  POWERSHOT_WINDOW_MS,
  PREMATCH_MAX_WAIT_MS,
  PlayerProfile,
  RoomPlayerDoc,
  TeamColor,
  enforceKickoffZoneConstraint,
  getTeamSpawnPosition,
} from '../types/game';
import {
  applyWebRTCAuthoritativeSnapshot,
  applyWebRTCClientInputState,
  finishMatchRoom,
  getHostAuthoritativePlayerState,
  getLiveMatchSnapshot,
  getLocalPingMs,
  markPlayerLoadedOnPitch,
  registerGoalInNet,
  resetFormationAfterGoalDelay,
  sendRoomHeartbeat,
  sendWebRTCSignal,
  subscribeToWebRTCSignals,
  syncLocalPlayerDisc,
  syncRoomGameplayState,
} from '../services/roomService';
import {
  KICK_STRENGTH,
  LOCKSTEP_STEP_MS,
  PING_INTERVAL_MS,
  PITCH_WALL_SEGMENTS,
  PlayerInputKeys,
  WebRTCLockstepSession,
  collideBallWithWallSegments,
  fpAdd,
  fpAtan2,
  fpCos,
  fpHypot,
  fpMul,
  fpSin,
  fpSub,
  round4,
} from '../services/webrtcLockstep';
import { soundFX } from '../utils/sound';

const MAX_EXTRAPOLATION_MS = 200;
const POWERSHOT_MAX_SPEED = BALL_MAX_SPEED;

interface MatchArenaProps {
  room: MatchRoomDoc;
  players: Record<string, RoomPlayerDoc>;
  profile: PlayerProfile;
  onExitToLobby: () => void;
  onCreateRematch: () => void;
}

interface GoalNetNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  restX: number;
  restY: number;
  pinned: boolean;
}

interface LocalPhysicsState {
  myX: number;
  myY: number;
  myOffsetX: number;
  myOffsetY: number;
  myVx: number;
  myVy: number;
  myKicking: boolean;
  myKickConsumed?: boolean;
  ballX: number;
  ballY: number;
  ballVx: number;
  ballVy: number;
  ballOffsetX: number;
  ballOffsetY: number;
  ballAngle: number;
  lastTouchTeam: EventTeam;
  eventState: EventState;
  eventTeam: EventTeam;
  eventUntilMs: number;
  kickoffTeam: TeamColor;
  kickoffActive: boolean;
  elapsedMatchMs: number;
  lastNetSwishMs: number;
  controllingUid: string;
  controlStartedAtMs: number;
  powershotMustExitRing: boolean;
  powershotFlightUntilMs: number;
  leftNet: GoalNetNode[];
  rightNet: GoalNetNode[];
  remoteRenderPos: Record<
    string,
    {
      x: number;
      y: number;
      offsetX: number;
      offsetY: number;
      simX: number;
      simY: number;
      vx: number;
      vy: number;
      lastSeq: number;
      kicking: boolean;
    }
  >;
}

const NET_SIDE_SEGMENTS = 6;
const NET_BACK_SEGMENTS = 14;
const NET_TOTAL_NODES = NET_SIDE_SEGMENTS * 2 + NET_BACK_SEGMENTS + 1; // 27 nodes per goal
const MAX_NET_STRETCH = 38; // Max deep pocket bulge when ball blasts into the net

function createGoalNetNodes(side: 'left' | 'right'): GoalNetNode[] {
  const lineX = side === 'left' ? FIELD_LEFT : FIELD_RIGHT;
  const backX = side === 'left' ? FIELD_LEFT - GOAL_DEPTH : FIELD_RIGHT + GOAL_DEPTH;
  const nodes: GoalNetNode[] = [];

  for (let i = 0; i <= NET_SIDE_SEGMENTS; i++) {
    const t = i / NET_SIDE_SEGMENTS;
    const x = lineX + (backX - lineX) * t;
    const y = GOAL_TOP;
    nodes.push({
      x,
      y,
      vx: 0,
      vy: 0,
      restX: x,
      restY: y,
      pinned: i === 0,
    });
  }

  for (let i = 1; i <= NET_BACK_SEGMENTS; i++) {
    const t = i / NET_BACK_SEGMENTS;
    const x = backX;
    const y = GOAL_TOP + (GOAL_BOTTOM - GOAL_TOP) * t;
    nodes.push({
      x,
      y,
      vx: 0,
      vy: 0,
      restX: x,
      restY: y,
      pinned: false,
    });
  }

  for (let i = 1; i <= NET_SIDE_SEGMENTS; i++) {
    const t = i / NET_SIDE_SEGMENTS;
    const x = backX + (lineX - backX) * t;
    const y = GOAL_BOTTOM;
    nodes.push({
      x,
      y,
      vx: 0,
      vy: 0,
      restX: x,
      restY: y,
      pinned: i === NET_SIDE_SEGMENTS,
    });
  }

  return nodes;
}

function moldNetPocketAroundBall(
  nodes: GoalNetNode[],
  centerIdxFloat: number,
  targetX: number,
  targetY: number,
  ballVx: number,
  ballVy: number
) {
  const spreadRadius = 5.2;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.pinned) continue;
    const distIdx = Math.abs(i - centerIdxFloat);
    if (distIdx < spreadRadius) {
      const weight = Math.pow(
        Math.cos((distIdx / spreadRadius) * (Math.PI * 0.5)),
        1.6
      );
      const desiredX = node.restX + (targetX - node.restX) * weight;
      const desiredY = node.restY + (targetY - node.restY) * weight;

      node.x = node.x + (desiredX - node.x) * (0.48 * weight);
      node.y = node.y + (desiredY - node.y) * (0.48 * weight);
      node.vx = (node.vx + ballVx * 0.16 * weight) * 0.65;
      node.vy = (node.vy + ballVy * 0.16 * weight) * 0.65;
    }
  }
}

function updateAndCollideGoalNet(
  nodes: GoalNetNode[],
  side: 'left' | 'right',
  p: LocalPhysicsState,
  soundEnabled: boolean,
  now: number
) {
  const restStiffness = 0.085;
  const neighborStiffness = 0.28;
  const damping = 0.82;

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.pinned) continue;
    n.vx += (n.restX - n.x) * restStiffness;
    n.vy += (n.restY - n.y) * restStiffness;
  }

  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const restDx = b.restX - a.restX;
      const restDy = b.restY - a.restY;
      const curDx = b.x - a.x;
      const curDy = b.y - a.y;
      const forceX = (curDx - restDx) * neighborStiffness;
      const forceY = (curDy - restDy) * neighborStiffness;

      if (!a.pinned) {
        a.vx += forceX;
        a.vy += forceY;
      }
      if (!b.pinned) {
        b.vx -= forceX;
        b.vy -= forceY;
      }
    }
  }

  const lineX = side === 'left' ? FIELD_LEFT : FIELD_RIGHT;

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.pinned) continue;
    n.vx *= damping;
    n.vy *= damping;
    n.x += n.vx;
    n.y += n.vy;

    const dxRest = n.x - n.restX;
    const dyRest = n.y - n.restY;
    const distRest = Math.hypot(dxRest, dyRest);
    if (distRest > MAX_NET_STRETCH) {
      n.x = n.restX + (dxRest / distRest) * MAX_NET_STRETCH;
      n.y = n.restY + (dyRest / distRest) * MAX_NET_STRETCH;
      n.vx *= 0.4;
      n.vy *= 0.4;
    }

    if (side === 'left' && n.x > lineX - 2) {
      n.x = lineX - 2;
      if (n.vx > 0) n.vx = 0;
    }
    if (side === 'right' && n.x < lineX + 2) {
      n.x = lineX + 2;
      if (n.vx < 0) n.vx = 0;
    }
  }

  let contactedNet = false;
  let strongestImpactSpeed = 0;

  const backRestX =
    side === 'left' ? FIELD_LEFT - GOAL_DEPTH : FIELD_RIGHT + GOAL_DEPTH;
  const isInsideGoalMouthY =
    p.ballY >= GOAL_TOP - BALL_RADIUS * 0.6 &&
    p.ballY <= GOAL_BOTTOM + BALL_RADIUS * 0.6;
  const isInsideGoalDepthX =
    side === 'left'
      ? p.ballX < FIELD_LEFT + BALL_RADIUS * 0.4 &&
        p.ballX >= backRestX - MAX_NET_STRETCH - BALL_RADIUS * 2
      : p.ballX > FIELD_RIGHT - BALL_RADIUS * 0.4 &&
        p.ballX <= backRestX + MAX_NET_STRETCH + BALL_RADIUS * 2;

  if (isInsideGoalMouthY && isInsideGoalDepthX) {
    const yRatio = Math.max(
      0,
      Math.min(1, (p.ballY - GOAL_TOP) / (GOAL_BOTTOM - GOAL_TOP))
    );
    const backIdx = NET_SIDE_SEGMENTS + yRatio * NET_BACK_SEGMENTS;

    if (side === 'left') {
      const penetration = backRestX + BALL_RADIUS - p.ballX;
      if (penetration > 0) {
        const stretch = Math.min(MAX_NET_STRETCH, penetration);
        const pocketX = backRestX - stretch;
        const pocketY = p.ballY + p.ballVy * 1.4;
        moldNetPocketAroundBall(
          nodes,
          backIdx,
          pocketX,
          pocketY,
          p.ballVx,
          p.ballVy
        );

        const minAllowedBallX = backRestX - MAX_NET_STRETCH + BALL_RADIUS;
        if (p.ballX < minAllowedBallX) {
          p.ballX = minAllowedBallX;
          if (p.ballVx < 0) p.ballVx *= -0.06;
        }

        if (p.ballVx < 0) {
          strongestImpactSpeed = Math.max(
            strongestImpactSpeed,
            Math.hypot(p.ballVx, p.ballVy)
          );
          p.ballVx *= 0.86;
          p.ballVy *= 0.88;
        }
        p.ballVx += stretch * 0.008;
        p.ballVy *= 0.94;
        contactedNet = true;
      }
    } else {
      const penetration = p.ballX + BALL_RADIUS - backRestX;
      if (penetration > 0) {
        const stretch = Math.min(MAX_NET_STRETCH, penetration);
        const pocketX = backRestX + stretch;
        const pocketY = p.ballY + p.ballVy * 1.4;
        moldNetPocketAroundBall(
          nodes,
          backIdx,
          pocketX,
          pocketY,
          p.ballVx,
          p.ballVy
        );

        const maxAllowedBallX = backRestX + MAX_NET_STRETCH - BALL_RADIUS;
        if (p.ballX > maxAllowedBallX) {
          p.ballX = maxAllowedBallX;
          if (p.ballVx > 0) p.ballVx *= -0.06;
        }

        if (p.ballVx > 0) {
          strongestImpactSpeed = Math.max(
            strongestImpactSpeed,
            Math.hypot(p.ballVx, p.ballVy)
          );
          p.ballVx *= 0.86;
          p.ballVy *= 0.88;
        }
        p.ballVx -= stretch * 0.008;
        p.ballVy *= 0.94;
        contactedNet = true;
      }
    }

    const depthRatio = Math.max(
      0,
      Math.min(1, Math.abs(p.ballX - lineX) / GOAL_DEPTH)
    );
    const topIdx = depthRatio * NET_SIDE_SEGMENTS;
    if (p.ballY - BALL_RADIUS < GOAL_TOP) {
      const stretchY = Math.min(
        MAX_NET_STRETCH * 0.75,
        GOAL_TOP - (p.ballY - BALL_RADIUS)
      );
      const restTopX = lineX + (backRestX - lineX) * depthRatio;
      moldNetPocketAroundBall(
        nodes,
        topIdx,
        restTopX + p.ballVx * 1.2,
        GOAL_TOP - stretchY,
        p.ballVx,
        p.ballVy
      );
      const minAllowedY = GOAL_TOP - MAX_NET_STRETCH * 0.75 + BALL_RADIUS;
      if (p.ballY < minAllowedY) {
        p.ballY = minAllowedY;
        if (p.ballVy < 0) p.ballVy *= -0.08;
      }
      if (p.ballVy < 0) {
        strongestImpactSpeed = Math.max(strongestImpactSpeed, -p.ballVy);
        p.ballVy *= 0.85;
        p.ballVx *= 0.9;
      }
      p.ballVy += stretchY * 0.009;
      contactedNet = true;
    }

    const botIdx =
      NET_SIDE_SEGMENTS + NET_BACK_SEGMENTS + (1 - depthRatio) * NET_SIDE_SEGMENTS;
    if (p.ballY + BALL_RADIUS > GOAL_BOTTOM) {
      const stretchY = Math.min(
        MAX_NET_STRETCH * 0.75,
        p.ballY + BALL_RADIUS - GOAL_BOTTOM
      );
      const restBotX = lineX + (backRestX - lineX) * depthRatio;
      moldNetPocketAroundBall(
        nodes,
        botIdx,
        restBotX + p.ballVx * 1.2,
        GOAL_BOTTOM + stretchY,
        p.ballVx,
        p.ballVy
      );
      const maxAllowedY = GOAL_BOTTOM + MAX_NET_STRETCH * 0.75 - BALL_RADIUS;
      if (p.ballY > maxAllowedY) {
        p.ballY = maxAllowedY;
        if (p.ballVy > 0) p.ballVy *= -0.08;
      }
      if (p.ballVy > 0) {
        strongestImpactSpeed = Math.max(strongestImpactSpeed, p.ballVy);
        p.ballVy *= 0.85;
        p.ballVx *= 0.9;
      }
      p.ballVy -= stretchY * 0.009;
      contactedNet = true;
    }
  } else {
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const abLenSq = abx * abx + aby * aby;
      if (abLenSq < 0.0001) continue;

      const t = Math.max(
        0,
        Math.min(1, ((p.ballX - a.x) * abx + (p.ballY - a.y) * aby) / abLenSq)
      );
      const cx = a.x + t * abx;
      const cy = a.y + t * aby;

      const dx = p.ballX - cx;
      const dy = p.ballY - cy;
      const dist = Math.hypot(dx, dy);
      const contactRadius = BALL_RADIUS + 2;

      if (dist < contactRadius && dist > 0.0001) {
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = contactRadius - dist;
        const restCx = a.restX * (1 - t) + b.restX * t;
        const restCy = a.restY * (1 - t) + b.restY * t;

        moldNetPocketAroundBall(
          nodes,
          i + t,
          restCx - nx * Math.min(16, overlap * 2.2),
          restCy - ny * Math.min(16, overlap * 2.2),
          p.ballVx,
          p.ballVy
        );

        p.ballX += nx * overlap * 0.45;
        p.ballY += ny * overlap * 0.45;
        p.ballVx *= 0.86;
        p.ballVy *= 0.86;
        contactedNet = true;
      }
    }
  }

  if (
    contactedNet &&
    strongestImpactSpeed > 1.6 &&
    soundEnabled &&
    now - p.lastNetSwishMs > 220
  ) {
    p.lastNetSwishMs = now;
    soundFX.playNetSwish(strongestImpactSpeed / 9);
  }
}

const GOALPOSTS = [
  { x: FIELD_LEFT, y: GOAL_TOP, color: '#EF4444' },
  { x: FIELD_LEFT, y: GOAL_BOTTOM, color: '#EF4444' },
  { x: FIELD_RIGHT, y: GOAL_TOP, color: '#3B82F6' },
  { x: FIELD_RIGHT, y: GOAL_BOTTOM, color: '#3B82F6' },
];

interface GamepadInputSnapshot {
  connected: boolean;
  name: string;
  analogX: number;
  analogY: number;
  hasAnalogStick: boolean;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  kick: boolean;
  scoreboardHeld: boolean;
}

/**
 * Опрос геймпада (PS4 DualShock 4, PS5 DualSense, Xbox, Generic):
 * - Левый стик (axes[0], axes[1]) + крестовина (D-Pad buttons 12..15) — плавное 360° управление движением
 * - Кнопка ✕ (Икс / Cross на PS4/PS5 = buttons[0], либо buttons[1] в DirectInput, а также Square/R1/R2) — удар по мячу
 */
function readGamepadInputState(): GamepadInputSnapshot {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.getGamepads !== 'function'
  ) {
    return {
      connected: false,
      name: '',
      analogX: 0,
      analogY: 0,
      hasAnalogStick: false,
      up: false,
      down: false,
      left: false,
      right: false,
      kick: false,
      scoreboardHeld: false,
    };
  }

  let pads: (Gamepad | null)[] = [];
  try {
    pads = Array.from(navigator.getGamepads() || []);
  } catch {
    pads = [];
  }

  const DEADZONE = 0.16;
  const DIGITAL_THRESHOLD = 0.3;

  for (let i = 0; i < pads.length; i++) {
    const gp = pads[i];
    if (!gp || !gp.connected) continue;

    // Левый стик: axes[0] (горизонталь), axes[1] (вертикаль)
    const rawX = gp.axes[0] ?? 0;
    const rawY = gp.axes[1] ?? 0;
    const mag = Math.hypot(rawX, rawY);

    let analogX = 0;
    let analogY = 0;
    let hasAnalogStick = false;

    if (mag > DEADZONE) {
      const normMag = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE));
      analogX = round4((rawX / mag) * normMag);
      analogY = round4((rawY / mag) * normMag);
      hasAnalogStick = true;
    }

    // Крестовина D-Pad (12 = Вверх, 13 = Вниз, 14 = Влево, 15 = Вправо)
    const dpadUp = Boolean(gp.buttons[12]?.pressed);
    const dpadDown = Boolean(gp.buttons[13]?.pressed);
    const dpadLeft = Boolean(gp.buttons[14]?.pressed);
    const dpadRight = Boolean(gp.buttons[15]?.pressed);

    const up = dpadUp || analogY < -DIGITAL_THRESHOLD;
    const down = dpadDown || analogY > DIGITAL_THRESHOLD;
    const left = dpadLeft || analogX < -DIGITAL_THRESHOLD;
    const right = dpadRight || analogX > DIGITAL_THRESHOLD;

    if (!hasAnalogStick && (dpadUp || dpadDown || dpadLeft || dpadRight)) {
      let dx = 0;
      let dy = 0;
      if (dpadLeft) dx -= 1;
      if (dpadRight) dx += 1;
      if (dpadUp) dy -= 1;
      if (dpadDown) dy += 1;
      if (dx !== 0 || dy !== 0) {
        const dLen = Math.hypot(dx, dy);
        analogX = round4(dx / dLen);
        analogY = round4(dy / dLen);
        hasAnalogStick = true;
      }
    }

    // Удар (Икс / Cross ✕ на PS4/PS5 = buttons[0], также поддерживаем Circle/Square/R1/R2 для любых раскладок)
    const kick = Boolean(
      gp.buttons[0]?.pressed ||
        gp.buttons[1]?.pressed ||
        gp.buttons[2]?.pressed ||
        gp.buttons[5]?.pressed ||
        gp.buttons[7]?.pressed ||
        (gp.buttons[7]?.value ?? 0) > 0.35
    );

    // Кнопка Share / Touchpad (buttons[8] / buttons[17]) открывает таблицу (Tab)
    const scoreboardHeld = Boolean(
      gp.buttons[8]?.pressed || gp.buttons[17]?.pressed
    );

    return {
      connected: true,
      name: gp.id || 'PS4 / Gamepad',
      analogX,
      analogY,
      hasAnalogStick,
      up,
      down,
      left,
      right,
      kick,
      scoreboardHeld,
    };
  }

  return {
    connected: false,
    name: '',
    analogX: 0,
    analogY: 0,
    hasAnalogStick: false,
    up: false,
    down: false,
    left: false,
    right: false,
    kick: false,
    scoreboardHeld: false,
  };
}

function formatTimerMMSS(elapsedSec: number): string {
  const clamped = Math.max(0, Math.min(MATCH_DURATION_SEC, Math.floor(elapsedSec)));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const MatchArena: React.FC<MatchArenaProps> = ({
  room,
  players,
  profile,
  onExitToLobby,
  onCreateRematch,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  const myTeam: TeamColor = room.blueUids.includes(profile.uid) ? 'blue' : 'red';
  const myTeamIndex = Math.max(
    0,
    myTeam === 'red'
      ? room.redUids.indexOf(profile.uid)
      : room.blueUids.indexOf(profile.uid)
  );
  const initialSpawn = getTeamSpawnPosition(myTeam, myTeamIndex);

  const keysRef = useRef<{
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    kick: boolean;
  }>({
    up: false,
    down: false,
    left: false,
    right: false,
    kick: false,
  });

  const isFreshKickoff =
    (room.kickoffActive ?? true) ||
    !room.countdownEndsAtMs ||
    (room.matchStartedAtMs > 0 && Date.now() - room.matchStartedAtMs < 6000);

  const physRef = useRef<LocalPhysicsState>({
    myX: isFreshKickoff
      ? initialSpawn.x
      : (players[profile.uid]?.x ?? initialSpawn.x),
    myY: isFreshKickoff
      ? initialSpawn.y
      : (players[profile.uid]?.y ?? initialSpawn.y),
    myOffsetX: 0,
    myOffsetY: 0,
    myVx: 0,
    myVy: 0,
    myKicking: false,
    myKickConsumed: false,
    ballX: room.ballX ?? FIELD_CENTER_X,
    ballY: room.ballY ?? FIELD_CENTER_Y,
    ballVx: room.ballVx ?? 0,
    ballVy: room.ballVy ?? 0,
    ballOffsetX: 0,
    ballOffsetY: 0,
    ballAngle: 0,
    lastTouchTeam: room.lastTouchTeam ?? 'none',
    eventState: room.eventState === 'goal' ? 'goal' : 'normal',
    eventTeam: room.eventTeam ?? 'none',
    eventUntilMs: room.eventUntilMs ?? 0,
    kickoffTeam: room.kickoffTeam || 'red',
    kickoffActive: room.kickoffActive ?? true,
    elapsedMatchMs: room.elapsedMatchMs ?? 0,
    lastNetSwishMs: 0,
    controllingUid: '',
    controlStartedAtMs: 0,
    powershotMustExitRing: false,
    powershotFlightUntilMs: 0,
    leftNet: createGoalNetNodes('left'),
    rightNet: createGoalNetNodes('right'),
    remoteRenderPos: {},
  });

  const roomRef = useRef<MatchRoomDoc>(room);
  const playersRef = useRef<Record<string, RoomPlayerDoc>>(players);
  const soundEnabledRef = useRef<boolean>(soundEnabled);
  const lastPlayerSyncMsRef = useRef<number>(0);
  const lastBallSyncMsRef = useRef<number>(0);
  const lastLocalBallTouchMsRef = useRef<number>(0);
  const lastLocalActiveMoveMsRef = useRef<number>(Date.now());
  const remoteBallGraceUntilMsRef = useRef<number>(0);
  const remoteBallActorUidRef = useRef<string>('');
  const lastPlayerCollisionMsRef = useRef<number>(0);
  const lastSentPosRef = useRef<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    keyMask: number;
    kicking: boolean;
  }>({ x: -1, y: -1, vx: 0, vy: 0, keyMask: -1, kicking: false });
  const lastAppliedBallSeqRef = useRef<number>(
    room.seq && room.seq < 1000000000 ? room.seq : 0
  );
  const lastHandledEventUntilRef = useRef<number>(0);
  const pendingRtcBallRef = useRef<{
    ballX: number;
    ballY: number;
    ballVx: number;
    ballVy: number;
    lastTouchTeam: EventTeam;
    playerId: string;
    ts: number;
  } | null>(null);
  const finishTriggeredRef = useRef<boolean>(false);
  const tickCounterRef = useRef<number>(0);
  const webrtcSessionRef = useRef<WebRTCLockstepSession | null>(null);
  const peerInputsRef = useRef<Record<string, PlayerInputKeys>>({});
  const [localPing, setLocalPing] = useState<number>(() => getLocalPingMs());
  const [peerPings, setPeerPings] = useState<Record<string, number>>({});
  const [tabOpen, setTabOpen] = useState<boolean>(false);
  const [gamepadConnected, setGamepadConnected] = useState<boolean>(() =>
    readGamepadInputState().connected
  );
  const gamepadConnectedRef = useRef<boolean>(gamepadConnected);
  const gamepadTabWasHeldRef = useRef<boolean>(false);
  const [extrapolationMs, setExtrapolationMs] = useState<number>(0);
  const extrapolationMsRef = useRef<number>(0);
  const lastCountdownBeepRef = useRef<number>(99);
  const [preMatchUi, setPreMatchUi] = useState<{
    phase: 'waiting_players' | 'countdown' | 'live';
    waitSecondsLeft: number;
    countdownNumber: number;
    goBannerActive: boolean;
    kickoffActive: boolean;
    kickoffTeam: TeamColor;
  }>(() => ({
    phase: 'waiting_players',
    waitSecondsLeft: 10,
    countdownNumber: 3,
    goBannerActive: false,
    kickoffActive: room.kickoffActive ?? true,
    kickoffTeam: room.kickoffTeam || 'red',
  }));

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  // Rocket League Pre-Match Loading & 10-Second Max Wait + Synchronized 3-2-1 Countdown
  useEffect(() => {
    markPlayerLoadedOnPitch(room.roomId, profile.uid).catch(() => {});

    const checkPreMatchStatus = () => {
      const curRoom = roomRef.current;
      const nowMs = Date.now();
      const readyList = curRoom.readyUids || [];
      const memberList = curRoom.memberUids || [];

      if (!readyList.includes(profile.uid)) {
        markPlayerLoadedOnPitch(curRoom.roomId, profile.uid).catch(() => {});
      }

      const launchAt =
        curRoom.launchAtMs && curRoom.launchAtMs > 0
          ? curRoom.launchAtMs
          : curRoom.matchStartedAtMs > 0
            ? curRoom.matchStartedAtMs
            : nowMs;
      const waitElapsedMs = Math.max(0, nowMs - launchAt);
      const waitSecondsLeft = Math.max(
        0,
        Math.ceil((PREMATCH_MAX_WAIT_MS - waitElapsedMs) / 1000)
      );

      const allMembersReady =
        memberList.length > 0 &&
        memberList.every((uid) => readyList.includes(uid) || uid === profile.uid);
      const waitTimedOut = waitElapsedMs >= PREMATCH_MAX_WAIT_MS;

      let countdownEndsAt = curRoom.countdownEndsAtMs || 0;
      if (countdownEndsAt === 0 && (allMembersReady || waitTimedOut)) {
        countdownEndsAt = nowMs + COUNTDOWN_DURATION_MS;
        curRoom.countdownEndsAtMs = countdownEndsAt;
        markPlayerLoadedOnPitch(
          curRoom.roomId,
          profile.uid,
          countdownEndsAt
        ).catch(() => {});
      }

      const phys = physRef.current;
      if (countdownEndsAt === 0) {
        setPreMatchUi({
          phase: 'waiting_players',
          waitSecondsLeft,
          countdownNumber: 3,
          goBannerActive: false,
          kickoffActive: phys.kickoffActive,
          kickoffTeam: phys.kickoffTeam,
        });
      } else if (nowMs < countdownEndsAt) {
        const cNum = Math.max(
          1,
          Math.min(3, Math.ceil((countdownEndsAt - nowMs) / 1000))
        );
        setPreMatchUi({
          phase: 'countdown',
          waitSecondsLeft: 0,
          countdownNumber: cNum,
          goBannerActive: false,
          kickoffActive: phys.kickoffActive,
          kickoffTeam: phys.kickoffTeam,
        });
      } else {
        const goActive = nowMs - countdownEndsAt < 1400;
        setPreMatchUi({
          phase: 'live',
          waitSecondsLeft: 0,
          countdownNumber: 0,
          goBannerActive: goActive,
          kickoffActive: phys.kickoffActive,
          kickoffTeam: phys.kickoffTeam,
        });
      }
    };

    checkPreMatchStatus();
    const id = window.setInterval(checkPreMatchStatus, 150);
    return () => window.clearInterval(id);
  }, [room.roomId, profile.uid]);

  // Initialize P2P WebRTC DataChannel Lockstep Session (Binary ArrayBuffer, Unordered, maxRetransmits: 0)
  useEffect(() => {
    const isHost = room.hostUid === profile.uid;
    const session = new WebRTCLockstepSession({
      roomId: room.roomId,
      localUid: profile.uid,
      isHost,
      onSignalOut: (sig) => {
        sendWebRTCSignal(sig);
      },
      onFrameInputs: (tick, frameInputs, snap) => {
        tickCounterRef.current = Math.max(tickCounterRef.current, tick);
        peerInputsRef.current = frameInputs;
        if (snap) {
          applyWebRTCAuthoritativeSnapshot(
            roomRef.current.roomId,
            roomRef.current.hostUid,
            snap,
            profile.uid
          );
        }
      },
      onClientInputState: (pkt) => {
        if (pkt.keys) {
          peerInputsRef.current[pkt.playerId] = pkt.keys;
        }
        applyWebRTCClientInputState(roomRef.current.roomId, pkt);
      },
      onClientBall: (pkt) => {
        const nowMs = Date.now();
        remoteBallGraceUntilMsRef.current = nowMs + 420;
        remoteBallActorUidRef.current = pkt.playerId;
        pendingRtcBallRef.current = {
          ballX: pkt.ballX,
          ballY: pkt.ballY,
          ballVx: pkt.ballVx,
          ballVy: pkt.ballVy,
          lastTouchTeam: pkt.lastTouchTeam,
          playerId: pkt.playerId,
          ts: nowMs,
        };
      },
    });
    webrtcSessionRef.current = session;

    const unsubSignals = subscribeToWebRTCSignals(
      room.roomId,
      profile.uid,
      (sig) => {
        session.handleIncomingSignal(sig).catch(() => {});
      }
    );

    session.connectToMemberPeers(roomRef.current.memberUids);

    return () => {
      unsubSignals();
      session.destroy();
      webrtcSessionRef.current = null;
    };
  }, [room.roomId, room.hostUid, profile.uid]);

  useEffect(() => {
    webrtcSessionRef.current?.connectToMemberPeers(room.memberUids);
  }, [room.memberUids]);

  // Keep room alive & refresh ping strictly every 3000ms (3 seconds)
  useEffect(() => {
    sendRoomHeartbeat(room.roomId, profile.uid).catch(() => {});
    const hbId = window.setInterval(() => {
      setLocalPing(getLocalPingMs());
      if (webrtcSessionRef.current) {
        setPeerPings(webrtcSessionRef.current.getPlayerPings());
      }
      sendRoomHeartbeat(roomRef.current.roomId, profile.uid).catch(() => {});
    }, PING_INTERVAL_MS);
    return () => window.clearInterval(hbId);
  }, [room.roomId, profile.uid]);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  // Match 5-Minute Active Play Timer (Paused during Pre-Match Loading, 3-2-1 Countdown, and Kickoff Wait!)
  useEffect(() => {
    const updateTimer = () => {
      const currentRoom = roomRef.current;
      const phys = physRef.current;
      if (currentRoom.status === 'finished') {
        setElapsedSeconds(MATCH_DURATION_SEC);
        return;
      }

      const syncedElapsedMs = Math.max(
        phys.elapsedMatchMs || 0,
        currentRoom.elapsedMatchMs || 0
      );
      phys.elapsedMatchMs = syncedElapsedMs;
      const sec = Math.min(
        MATCH_DURATION_SEC,
        Math.floor(syncedElapsedMs / 1000)
      );
      setElapsedSeconds(sec);

      if (syncedElapsedMs >= MATCH_DURATION_MS && !finishTriggeredRef.current) {
        finishTriggeredRef.current = true;
        if (soundEnabledRef.current) {
          soundFX.playMatchEndWhistle();
        }
        finishMatchRoom(currentRoom, profile.uid).catch(() => {});
      }
    };

    updateTimer();
    const interval = window.setInterval(updateTimer, 150);
    return () => window.clearInterval(interval);
  }, [profile.uid]);

  // Keyboard Listeners (WASD + Arrow Keys + Space/X Kick + Tab Scoreboard)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Tab' || e.key === 'Tab') {
        e.preventDefault();
        setTabOpen(true);
        return;
      }
      if (
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', ' '].includes(e.key)
      ) {
        e.preventDefault();
      }
      const code = e.code;
      if (code === 'KeyW' || code === 'ArrowUp') keysRef.current.up = true;
      if (code === 'KeyS' || code === 'ArrowDown') keysRef.current.down = true;
      if (code === 'KeyA' || code === 'ArrowLeft') keysRef.current.left = true;
      if (code === 'KeyD' || code === 'ArrowRight') keysRef.current.right = true;
      if (
        code === 'Space' ||
        code === 'KeyX' ||
        code === 'ShiftLeft' ||
        code === 'ShiftRight'
      ) {
        keysRef.current.kick = true;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Tab' || e.key === 'Tab') {
        e.preventDefault();
        setTabOpen(false);
        return;
      }
      const code = e.code;
      if (code === 'KeyW' || code === 'ArrowUp') keysRef.current.up = false;
      if (code === 'KeyS' || code === 'ArrowDown') keysRef.current.down = false;
      if (code === 'KeyA' || code === 'ArrowLeft') keysRef.current.left = false;
      if (code === 'KeyD' || code === 'ArrowRight') keysRef.current.right = false;
      if (
        code === 'Space' ||
        code === 'KeyX' ||
        code === 'ShiftLeft' ||
        code === 'ShiftRight'
      ) {
        keysRef.current.kick = false;
      }
    };

    const handleGamepadConnected = () => {
      gamepadConnectedRef.current = true;
      setGamepadConnected(true);
    };
    const handleGamepadDisconnected = () => {
      const state = readGamepadInputState();
      gamepadConnectedRef.current = state.connected;
      setGamepadConnected(state.connected);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('gamepadconnected', handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', handleGamepadDisconnected);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('gamepadconnected', handleGamepadConnected);
      window.removeEventListener('gamepaddisconnected', handleGamepadDisconnected);
    };
  }, []);

  // Main Fixed-Step DT = 1/60s Deterministic Physics Loop + Jitter-Damped Canvas Renderer
  useEffect(() => {
    let animationFrameId: number;
    let lastPerfTime = performance.now();
    let accumulatorMs = 0;

    // Pure Fixed-Step Physics Tick (DT = 1/60s, integer tick, 4-decimal rounding after every operation)
    const runFixedPhysicsTick = (now: number) => {
      const p = physRef.current;

      // Direct 60 FPS Snapshot Pull
      const liveSnap = getLiveMatchSnapshot(roomRef.current.roomId);
      if (Object.keys(liveSnap.players).length > 0) {
        const nextPlayers = { ...playersRef.current };
        for (const [uid, pl] of Object.entries(liveSnap.players)) {
          if (uid === profile.uid) continue;
          nextPlayers[uid] = pl;
        }
        playersRef.current = nextPlayers;
      }

      const myDistToBallBefore = fpHypot(
        fpSub(p.ballX, p.myX),
        fpSub(p.ballY, p.myY)
      );
      let closestRemoteDistToBall = Infinity;
      for (const rp of Object.values(playersRef.current)) {
        if (rp.playerId === profile.uid) continue;
        const rPos = p.remoteRenderPos[rp.playerId] || rp;
        const d = fpHypot(fpSub(p.ballX, rPos.x), fpSub(p.ballY, rPos.y));
        if (d < closestRemoteDistToBall) closestRemoteDistToBall = d;
      }

      const isLocalSoleDribbler =
        myDistToBallBefore <= PLAYER_RADIUS + BALL_RADIUS + 18 &&
        myDistToBallBefore < closestRemoteDistToBall - 4;
      const recentlyTouchedLocally =
        now - lastLocalBallTouchMsRef.current < 360 || isLocalSoleDribbler;
      const isRemoteContestingClose =
        closestRemoteDistToBall <= PLAYER_RADIUS + BALL_RADIUS + 10;

      if (liveSnap.room) {
        const netRoom = liveSnap.room;
        const prevEventState = roomRef.current.eventState;

        if (typeof netRoom.elapsedMatchMs === 'number') {
          p.elapsedMatchMs = Math.max(p.elapsedMatchMs, netRoom.elapsedMatchMs);
        }
        if (netRoom.kickoffTeam && p.eventState !== 'goal') {
          p.kickoffTeam = netRoom.kickoffTeam;
        }
        if (netRoom.kickoffActive === false && p.kickoffActive) {
          p.kickoffActive = false;
        } else if (
          netRoom.kickoffActive === true &&
          !p.kickoffActive &&
          Math.hypot(netRoom.ballX - FIELD_CENTER_X, netRoom.ballY - FIELD_CENTER_Y) < 2 &&
          Math.hypot(netRoom.ballVx, netRoom.ballVy) < 0.05 &&
          now - lastLocalBallTouchMsRef.current > 600
        ) {
          p.kickoffActive = true;
        }

        if (p.eventState === 'goal' && now < p.eventUntilMs - 100) {
          roomRef.current = {
            ...netRoom,
            redScore: Math.max(roomRef.current.redScore, netRoom.redScore),
            blueScore: Math.max(roomRef.current.blueScore, netRoom.blueScore),
            eventState: 'goal',
            eventTeam: p.eventTeam,
            eventUntilMs: p.eventUntilMs,
          };
        } else {
          roomRef.current = {
            ...netRoom,
            redScore: Math.max(roomRef.current.redScore, netRoom.redScore),
            blueScore: Math.max(roomRef.current.blueScore, netRoom.blueScore),
          };

          // Only GOAL events exist (no outs or corners!)
          if (
            netRoom.eventState === 'goal' &&
            netRoom.eventUntilMs > 0 &&
            netRoom.eventUntilMs !== lastHandledEventUntilRef.current
          ) {
            lastHandledEventUntilRef.current = netRoom.eventUntilMs;
            if (typeof netRoom.seq === 'number' && netRoom.seq < 1000000000) {
              lastAppliedBallSeqRef.current = Math.max(
                lastAppliedBallSeqRef.current,
                netRoom.seq
              );
            }
            p.eventState = 'goal';
            p.eventTeam = netRoom.eventTeam;
            p.eventUntilMs = now + GOAL_PAUSE_MS;
            p.kickoffActive = false;
            p.ballX = netRoom.ballX;
            p.ballY = netRoom.ballY;
            p.ballVx = netRoom.ballVx;
            p.ballVy = netRoom.ballVy;
            p.ballOffsetX = 0;
            p.ballOffsetY = 0;
            pendingRtcBallRef.current = null;

            if (soundEnabledRef.current && prevEventState !== 'goal') {
              soundFX.playGoalFanfare();
            }
          }
        }
      }

      // Jitter Damper: smoothly decay visual offsets on each 60Hz tick
      const discDecay = 0.8;
      p.myOffsetX =
        Math.abs(p.myOffsetX) > 0.15 ? fpMul(p.myOffsetX, discDecay) : 0;
      p.myOffsetY =
        Math.abs(p.myOffsetY) > 0.15 ? fpMul(p.myOffsetY, discDecay) : 0;

      const currentRoom = roomRef.current;
      const allPlayers = playersRef.current;
      const isMatchFinished =
        currentRoom.status === 'finished' ||
        p.elapsedMatchMs >= MATCH_DURATION_MS;

      const localTeam: TeamColor = currentRoom.blueUids.includes(profile.uid)
        ? 'blue'
        : 'red';
      const localSlotIdx = Math.max(
        0,
        localTeam === 'red'
          ? currentRoom.redUids.indexOf(profile.uid)
          : currentRoom.blueUids.indexOf(profile.uid)
      );

      // Rocket League Pre-Match Loading & 3-2-1 Countdown Lock
      const countdownEndsAtMs = currentRoom.countdownEndsAtMs || 0;
      const isWaitingForPlayers = countdownEndsAtMs === 0;
      const isCountdownActive =
        countdownEndsAtMs > 0 && now < countdownEndsAtMs;
      const isPreMatchLocked = isWaitingForPlayers || isCountdownActive;

      if (isCountdownActive) {
        const secLeft = Math.max(
          1,
          Math.min(3, Math.ceil((countdownEndsAtMs - now) / 1000))
        );
        if (secLeft !== lastCountdownBeepRef.current) {
          lastCountdownBeepRef.current = secLeft;
          if (soundEnabledRef.current) {
            soundFX.playKick();
          }
        }
      } else if (
        !isPreMatchLocked &&
        lastCountdownBeepRef.current !== 0 &&
        countdownEndsAtMs > 0
      ) {
        lastCountdownBeepRef.current = 0;
        if (soundEnabledRef.current) {
          soundFX.playKick();
        }
      }

      // Handle 3-second Post-Goal formation reset -> Conceding Team gets Kickoff!
      if (p.eventState === 'goal' && now >= p.eventUntilMs) {
        const scoredTeam = p.eventTeam;
        const concedingTeam: TeamColor =
          scoredTeam === 'red' ? 'blue' : 'red';

        p.eventState = 'normal';
        p.eventUntilMs = 0;
        p.ballX = FIELD_CENTER_X;
        p.ballY = FIELD_CENTER_Y;
        p.ballVx = 0;
        p.ballVy = 0;
        p.ballOffsetX = 0;
        p.ballOffsetY = 0;
        p.eventTeam = 'none';
        p.kickoffTeam = concedingTeam;
        p.kickoffActive = true;
        roomRef.current.kickoffTeam = concedingTeam;
        roomRef.current.kickoffActive = true;

        const spawn = getTeamSpawnPosition(localTeam, localSlotIdx);
        p.myX = spawn.x;
        p.myY = spawn.y;
        p.myOffsetX = 0;
        p.myOffsetY = 0;
        p.myVx = 0;
        p.myVy = 0;

        currentRoom.redUids.forEach((uid, idx) => {
          if (uid === profile.uid) return;
          const rSp = getTeamSpawnPosition('red', idx);
          if (p.remoteRenderPos[uid]) {
            p.remoteRenderPos[uid].x = rSp.x;
            p.remoteRenderPos[uid].y = rSp.y;
            p.remoteRenderPos[uid].offsetX = 0;
            p.remoteRenderPos[uid].offsetY = 0;
            p.remoteRenderPos[uid].vx = 0;
            p.remoteRenderPos[uid].vy = 0;
          }
        });
        currentRoom.blueUids.forEach((uid, idx) => {
          if (uid === profile.uid) return;
          const bSp = getTeamSpawnPosition('blue', idx);
          if (p.remoteRenderPos[uid]) {
            p.remoteRenderPos[uid].x = bSp.x;
            p.remoteRenderPos[uid].y = bSp.y;
            p.remoteRenderPos[uid].offsetX = 0;
            p.remoteRenderPos[uid].offsetY = 0;
            p.remoteRenderPos[uid].vx = 0;
            p.remoteRenderPos[uid].vy = 0;
          }
        });

        resetFormationAfterGoalDelay(
          currentRoom,
          allPlayers,
          profile.uid,
          concedingTeam
        ).catch(() => {});
      }

      // Advance Match Clock ONLY when players are loaded, 3-2-1 is finished, and kickoff ball has been touched!
      if (
        !isPreMatchLocked &&
        !p.kickoffActive &&
        p.eventState === 'normal' &&
        !isMatchFinished
      ) {
        p.elapsedMatchMs = Math.min(
          MATCH_DURATION_MS,
          p.elapsedMatchMs + 1000 / 60
        );
        roomRef.current.elapsedMatchMs = Math.floor(p.elapsedMatchMs);
      }

      // 1. Fixed-Step Local Player Disc Movement (DT = 1/60s, Keyboard + PS4/Xbox Gamepad Left Stick & Cross Kick)
      tickCounterRef.current += 1;
      const currentTick = tickCounterRef.current;
      const rtcSession = webrtcSessionRef.current;
      const extrapFrames = Math.min(8, (extrapolationMsRef.current / 1000) * 60);

      // Опрос геймпада (PS4 DualShock/DualSense, Xbox и др.) на каждом 60 Гц тике
      const gp = readGamepadInputState();
      if (gp.connected !== gamepadConnectedRef.current) {
        gamepadConnectedRef.current = gp.connected;
        setGamepadConnected(gp.connected);
      }
      if (gp.scoreboardHeld !== gamepadTabWasHeldRef.current) {
        gamepadTabWasHeldRef.current = gp.scoreboardHeld;
        setTabOpen(gp.scoreboardHeld);
      }

      const k = keysRef.current;
      const effectiveUp = !isPreMatchLocked && (k.up || gp.up);
      const effectiveDown = !isPreMatchLocked && (k.down || gp.down);
      const effectiveLeft = !isPreMatchLocked && (k.left || gp.left);
      const effectiveRight = !isPreMatchLocked && (k.right || gp.right);
      const effectiveKickHeld = !isPreMatchLocked && (k.kick || gp.kick);

      let localMovedOrChanged = false;
      if (isPreMatchLocked) {
        // Rocket League Pre-Match & 3-2-1 Lock: All players stand strictly in their formation positions!
        const spawn = getTeamSpawnPosition(localTeam, localSlotIdx);
        p.myX = spawn.x;
        p.myY = spawn.y;
        p.myOffsetX = 0;
        p.myOffsetY = 0;
        p.myVx = 0;
        p.myVy = 0;
        p.myKicking = false;
        p.myKickConsumed = false;
        p.ballX = FIELD_CENTER_X;
        p.ballY = FIELD_CENTER_Y;
        p.ballVx = 0;
        p.ballVy = 0;
        p.ballOffsetX = 0;
        p.ballOffsetY = 0;
        p.kickoffActive = true;
        p.kickoffTeam = 'red';
      } else if (!isMatchFinished) {
        if (!effectiveKickHeld) {
          p.myKickConsumed = false;
        }
        const activeKickIndicator = Boolean(
          effectiveKickHeld && !p.myKickConsumed
        );

        let dirX = 0;
        let dirY = 0;
        if (k.left) dirX -= 1;
        if (k.right) dirX += 1;
        if (k.up) dirY -= 1;
        if (k.down) dirY += 1;

        const accel = activeKickIndicator ? PLAYER_KICK_ACCEL : PLAYER_ACCEL;

        // Если игрок отклоняет левый стик геймпада — используем плавный 360° вектор стика
        if (gp.hasAnalogStick && dirX === 0 && dirY === 0) {
          const ax = fpMul(gp.analogX, accel);
          const ay = fpMul(gp.analogY, accel);
          p.myVx = fpMul(fpAdd(p.myVx, ax), PLAYER_DAMPING);
          p.myVy = fpMul(fpAdd(p.myVy, ay), PLAYER_DAMPING);
          dirX = gp.analogX;
          dirY = gp.analogY;
        } else if (dirX !== 0 || dirY !== 0) {
          const moveAngle = fpAtan2(dirY, dirX);
          const ax = fpMul(fpCos(moveAngle), accel);
          const ay = fpMul(fpSin(moveAngle), accel);
          p.myVx = fpMul(fpAdd(p.myVx, ax), PLAYER_DAMPING);
          p.myVy = fpMul(fpAdd(p.myVy, ay), PLAYER_DAMPING);
        } else {
          p.myVx = fpMul(p.myVx, PLAYER_DAMPING);
          p.myVy = fpMul(p.myVy, PLAYER_DAMPING);
        }

        const speed = fpHypot(p.myVx, p.myVy);
        if (speed > PLAYER_MAX_SPEED) {
          const sAngle = fpAtan2(p.myVy, p.myVx);
          p.myVx = fpMul(fpCos(sAngle), PLAYER_MAX_SPEED);
          p.myVy = fpMul(fpSin(sAngle), PLAYER_MAX_SPEED);
        }
        if (speed < 0.012 && dirX === 0 && dirY === 0) {
          p.myVx = 0;
          p.myVy = 0;
        }

        p.myX = fpAdd(p.myX, p.myVx);
        p.myY = fpAdd(p.myY, p.myVy);

        // Enforce Kickoff Half-Line & Center Circle Barrier while kickoffActive === true
        if (p.kickoffActive && p.eventState === 'normal') {
          const clamped = enforceKickoffZoneConstraint(
            p.myX,
            p.myY,
            p.myVx,
            p.myVy,
            localTeam,
            p.kickoffTeam
          );
          p.myX = clamped.x;
          p.myY = clamped.y;
          p.myVx = clamped.vx;
          p.myVy = clamped.vy;
        }

        if (
          dirX !== 0 ||
          dirY !== 0 ||
          Math.abs(p.myVx) > 0.005 ||
          Math.abs(p.myVy) > 0.005 ||
          p.myKicking !== activeKickIndicator
        ) {
          localMovedOrChanged = true;
          lastLocalActiveMoveMsRef.current = now;
        }
        // White circle indicator: turns on immediately when holding kick (Space / X / PS4 Cross ✕), turns off the exact frame released or kick consumed
        p.myKicking = activeKickIndicator;
      } else {
        p.myVx = 0;
        p.myVy = 0;
        p.myKicking = false;
      }

      // 1a. Remote Players Fixed-Step Dead-Reckoning + Jitter Damper Reconciliation
      Object.values(allPlayers).forEach((rp) => {
        if (rp.playerId === profile.uid) return;
        const pktSeq =
          typeof rp.seq === 'number'
            ? rp.seq
            : typeof rp.updatedAt === 'number'
              ? rp.updatedAt
              : 0;
        let state = p.remoteRenderPos[rp.playerId];

        const rpSlotIdx = Math.max(
          0,
          rp.team === 'red'
            ? currentRoom.redUids.indexOf(rp.playerId)
            : currentRoom.blueUids.indexOf(rp.playerId)
        );
        const rpSpawn = getTeamSpawnPosition(rp.team, rpSlotIdx);

        if (!state) {
          state = {
            x: isPreMatchLocked ? rpSpawn.x : rp.x,
            y: isPreMatchLocked ? rpSpawn.y : rp.y,
            offsetX: 0,
            offsetY: 0,
            simX: isPreMatchLocked ? rpSpawn.x : rp.x,
            simY: isPreMatchLocked ? rpSpawn.y : rp.y,
            vx: isPreMatchLocked ? 0 : rp.vx || 0,
            vy: isPreMatchLocked ? 0 : rp.vy || 0,
            lastSeq: pktSeq,
            kicking: isPreMatchLocked ? false : Boolean(rp.kicking),
          };
          p.remoteRenderPos[rp.playerId] = state;
          return;
        }

        if (isPreMatchLocked) {
          state.x = rpSpawn.x;
          state.y = rpSpawn.y;
          state.offsetX = 0;
          state.offsetY = 0;
          state.simX = rpSpawn.x;
          state.simY = rpSpawn.y;
          state.vx = 0;
          state.vy = 0;
          state.kicking = false;
          state.lastSeq = pktSeq;
          return;
        }

        const km = (rp as { keyMask?: number }).keyMask;
        const peerKey =
          peerInputsRef.current[rp.playerId] ||
          (typeof km === 'number'
            ? {
                up: (km & 1) !== 0,
                down: (km & 2) !== 0,
                left: (km & 4) !== 0,
                right: (km & 8) !== 0,
                kick: (km & 16) !== 0,
              }
            : null);

        // Live white circle state for opponent: turns off immediately as soon as opponent releases kick
        state.kicking = Boolean(peerKey ? peerKey.kick : rp.kicking);

        if (!isMatchFinished) {
          if (peerKey) {
            let pdx = 0;
            let pdy = 0;
            if (peerKey.left) pdx -= 1;
            if (peerKey.right) pdx += 1;
            if (peerKey.up) pdy -= 1;
            if (peerKey.down) pdy += 1;
            if (pdx !== 0 || pdy !== 0) {
              const ang = fpAtan2(pdy, pdx);
              const acc = state.kicking ? PLAYER_KICK_ACCEL : PLAYER_ACCEL;
              state.vx = fpMul(
                fpAdd(state.vx, fpMul(fpCos(ang), acc)),
                PLAYER_DAMPING
              );
              state.vy = fpMul(
                fpAdd(state.vy, fpMul(fpSin(ang), acc)),
                PLAYER_DAMPING
              );
            } else {
              state.vx = fpMul(state.vx, PLAYER_DAMPING);
              state.vy = fpMul(state.vy, PLAYER_DAMPING);
            }
          } else {
            state.vx = fpMul(state.vx, PLAYER_DAMPING);
            state.vy = fpMul(state.vy, PLAYER_DAMPING);
          }

          const rSpeed = fpHypot(state.vx, state.vy);
          if (rSpeed > PLAYER_MAX_SPEED) {
            const sAng = fpAtan2(state.vy, state.vx);
            state.vx = fpMul(fpCos(sAng), PLAYER_MAX_SPEED);
            state.vy = fpMul(fpSin(sAng), PLAYER_MAX_SPEED);
          } else if (rSpeed < 0.012) {
            state.vx = 0;
            state.vy = 0;
          }

          state.x = round4(
            Math.max(
              PLAYER_RADIUS + 12,
              Math.min(CANVAS_WIDTH - PLAYER_RADIUS - 12, fpAdd(state.x, state.vx))
            )
          );
          state.y = round4(
            Math.max(
              PLAYER_RADIUS + 12,
              Math.min(CANVAS_HEIGHT - PLAYER_RADIUS - 12, fpAdd(state.y, state.vy))
            )
          );

          if (p.kickoffActive && p.eventState === 'normal') {
            const clampedRem = enforceKickoffZoneConstraint(
              state.x,
              state.y,
              state.vx,
              state.vy,
              rp.team,
              p.kickoffTeam
            );
            state.x = clampedRem.x;
            state.y = clampedRem.y;
            state.vx = clampedRem.vx;
            state.vy = clampedRem.vy;
          }

          for (const post of GOALPOSTS) {
            const dxPost = fpSub(state.x, post.x);
            const dyPost = fpSub(state.y, post.y);
            const distPost = fpHypot(dxPost, dyPost);
            const minPostDist = PLAYER_RADIUS + POST_RADIUS;
            if (distPost < minPostDist && distPost > 0.001) {
              const pAngle = fpAtan2(dyPost, dxPost);
              const nx = fpCos(pAngle);
              const ny = fpSin(pAngle);
              state.x = fpAdd(post.x, fpMul(nx, minPostDist));
              state.y = fpAdd(post.y, fpMul(ny, minPostDist));
            }
          }
        }

        // Jitter Damper Reconciliation on new network packet
        if (pktSeq !== state.lastSeq) {
          const prevVisX = fpAdd(state.x, state.offsetX);
          const prevVisY = fpAdd(state.y, state.offsetY);
          state.lastSeq = pktSeq;
          const rVx = rp.vx || 0;
          const rVy = rp.vy || 0;
          state.vx = rVx;
          state.vy = rVy;
          state.x = round4(
            Math.max(
              PLAYER_RADIUS + 12,
              Math.min(
                CANVAS_WIDTH - PLAYER_RADIUS - 12,
                rp.x + rVx * extrapFrames * 0.25
              )
            )
          );
          state.y = round4(
            Math.max(
              PLAYER_RADIUS + 12,
              Math.min(
                CANVAS_HEIGHT - PLAYER_RADIUS - 12,
                rp.y + rVy * extrapFrames * 0.25
              )
            )
          );

          if (p.kickoffActive && p.eventState === 'normal') {
            const clampedRem = enforceKickoffZoneConstraint(
              state.x,
              state.y,
              state.vx,
              state.vy,
              rp.team,
              p.kickoffTeam
            );
            state.x = clampedRem.x;
            state.y = clampedRem.y;
            state.vx = clampedRem.vx;
            state.vy = clampedRem.vy;
          }

          const errX = fpSub(prevVisX, state.x);
          const errY = fpSub(prevVisY, state.y);
          const errDist = fpHypot(errX, errY);
          if (errDist < 260) {
            state.offsetX = errX;
            state.offsetY = errY;
          } else {
            state.offsetX = 0;
            state.offsetY = 0;
          }
        }

        state.offsetX =
          Math.abs(state.offsetX) > 0.15 ? fpMul(state.offsetX, discDecay) : 0;
        state.offsetY =
          Math.abs(state.offsetY) > 0.15 ? fpMul(state.offsetY, discDecay) : 0;

        state.simX = state.x;
        state.simY = state.y;
      });

      // 1b. Symmetric Player-to-Player Disc Collisions + Jitter-Damped Convergence
      if (!isMatchFinished && !isPreMatchLocked) {
        const minPlayerDist = PLAYER_RADIUS * 2;
        Object.values(allPlayers).forEach((rp) => {
          if (rp.playerId === profile.uid) return;
          const rState = p.remoteRenderPos[rp.playerId];
          if (!rState) return;

          const dxP = fpSub(p.myX, rState.x);
          const dyP = fpSub(p.myY, rState.y);
          const distP = fpHypot(dxP, dyP);

          if (distP < minPlayerDist && distP > 0.001) {
            const pAngle = fpAtan2(dyP, dxP);
            const nx = fpCos(pAngle);
            const ny = fpSin(pAngle);
            const overlap = fpSub(minPlayerDist, distP);
            const halfOverlap = fpMul(overlap, 0.5);

            const prevMyVisX = fpAdd(p.myX, p.myOffsetX);
            const prevMyVisY = fpAdd(p.myY, p.myOffsetY);
            const prevRemVisX = fpAdd(rState.x, rState.offsetX);
            const prevRemVisY = fpAdd(rState.y, rState.offsetY);

            p.myX = fpAdd(p.myX, fpMul(nx, halfOverlap));
            p.myY = fpAdd(p.myY, fpMul(ny, halfOverlap));
            rState.x = fpSub(rState.x, fpMul(nx, halfOverlap));
            rState.y = fpSub(rState.y, fpMul(ny, halfOverlap));

            p.myOffsetX = fpSub(prevMyVisX, p.myX);
            p.myOffsetY = fpSub(prevMyVisY, p.myY);
            rState.offsetX = fpSub(prevRemVisX, rState.x);
            rState.offsetY = fpSub(prevRemVisY, rState.y);

            const relVx = fpSub(p.myVx, rState.vx);
            const relVy = fpSub(p.myVy, rState.vy);
            const normalVel = fpAdd(fpMul(relVx, nx), fpMul(relVy, ny));
            const contactPush = fpMul(overlap, 0.26);
            if (normalVel < 0) {
              const playerRestitution = 0.14;
              const impulse = Math.max(
                contactPush,
                round4(-(1 + playerRestitution) * normalVel * 0.5)
              );
              p.myVx = fpAdd(p.myVx, fpMul(impulse, nx));
              p.myVy = fpAdd(p.myVy, fpMul(impulse, ny));
              rState.vx = fpSub(rState.vx, fpMul(impulse, nx));
              rState.vy = fpSub(rState.vy, fpMul(impulse, ny));
            } else {
              p.myVx = fpAdd(p.myVx, fpMul(contactPush, nx));
              p.myVy = fpAdd(p.myVy, fpMul(contactPush, ny));
              rState.vx = fpSub(rState.vx, fpMul(contactPush, nx));
              rState.vy = fpSub(rState.vy, fpMul(contactPush, ny));
            }
            lastPlayerCollisionMsRef.current = now;
            lastLocalActiveMoveMsRef.current = now;
            localMovedOrChanged = true;
          }
        });

        // Only reconcile local player position with Host on extreme collision desync (> 95px)
        // so normal client movement never rubberbands against 1-RTT-old snapshots.
        if (currentRoom.hostUid !== profile.uid) {
          const hostAuthMe = getHostAuthoritativePlayerState(
            currentRoom.roomId,
            profile.uid
          );
          if (hostAuthMe && now - hostAuthMe.ts < 120) {
            const diffX = fpSub(hostAuthMe.x, p.myX);
            const diffY = fpSub(hostAuthMe.y, p.myY);
            const diffDist = fpHypot(diffX, diffY);
            if (diffDist > 95) {
              const prevVisX = fpAdd(p.myX, p.myOffsetX);
              const prevVisY = fpAdd(p.myY, p.myOffsetY);
              p.myX = fpAdd(p.myX, fpMul(diffX, 0.35));
              p.myY = fpAdd(p.myY, fpMul(diffY, 0.35));
              p.myOffsetX = fpSub(prevVisX, p.myX);
              p.myOffsetY = fpSub(prevVisY, p.myY);
              lastLocalActiveMoveMsRef.current = now;
              localMovedOrChanged = true;
            }
          }
        }

        // Re-verify kickoff constraint after disc-disc collision
        if (p.kickoffActive && p.eventState === 'normal') {
          const clamped = enforceKickoffZoneConstraint(
            p.myX,
            p.myY,
            p.myVx,
            p.myVy,
            localTeam,
            p.kickoffTeam
          );
          p.myX = clamped.x;
          p.myY = clamped.y;
          p.myVx = clamped.vx;
          p.myVy = clamped.vy;
        }

        // Keep local player within outer stadium walls & goalposts
        p.myX = round4(
          Math.max(PLAYER_RADIUS + 12, Math.min(CANVAS_WIDTH - PLAYER_RADIUS - 12, p.myX))
        );
        p.myY = round4(
          Math.max(PLAYER_RADIUS + 12, Math.min(CANVAS_HEIGHT - PLAYER_RADIUS - 12, p.myY))
        );

        for (const post of GOALPOSTS) {
          const dxPost = fpSub(p.myX, post.x);
          const dyPost = fpSub(p.myY, post.y);
          const distPost = fpHypot(dxPost, dyPost);
          const minPostDist = PLAYER_RADIUS + POST_RADIUS;
          if (distPost < minPostDist && distPost > 0.001) {
            const pAngle = fpAtan2(dyPost, dxPost);
            const nx = fpCos(pAngle);
            const ny = fpSin(pAngle);
            p.myX = fpAdd(post.x, fpMul(nx, minPostDist));
            p.myY = fpAdd(post.y, fpMul(ny, minPostDist));
            const dot = fpAdd(fpMul(p.myVx, nx), fpMul(p.myVy, ny));
            if (dot < 0) {
              p.myVx = fpSub(p.myVx, fpMul(fpMul(dot, nx), 1.15));
              p.myVy = fpSub(p.myVy, fpMul(fpMul(dot, ny), 1.15));
            }
          }
        }
      }

      // Send strictly 1 Binary ArrayBuffer Input Packet per 60Hz Physics Tick over WebRTC DataChannel
      const currentKeyMask =
        (effectiveUp ? 1 : 0) |
        (effectiveDown ? 2 : 0) |
        (effectiveLeft ? 4 : 0) |
        (effectiveRight ? 8 : 0) |
        (p.myKicking ? 16 : 0);

      if (rtcSession && !isMatchFinished && !rtcSession.isHost) {
        rtcSession.sendClientInput(
          currentTick,
          {
            up: effectiveUp,
            down: effectiveDown,
            left: effectiveLeft,
            right: effectiveRight,
            kick: p.myKicking,
          },
          {
            x: p.myX,
            y: p.myY,
            vx: p.myVx,
            vy: p.myVy,
            kicking: p.myKicking,
            keyMask: currentKeyMask,
          }
        );
      }

      // 2. Step Ball Movement + Elastic Wall Segment Reflection (NO OUTS!) + Disc Contact & Kick
      let localTouchedBall = false;
      if (!isMatchFinished && !isPreMatchLocked) {
        const activeDiscs: Array<{
          uid: string;
          team: TeamColor;
          x: number;
          y: number;
          vx: number;
          vy: number;
          kicking: boolean;
        }> = [
          {
            uid: profile.uid,
            team: localTeam,
            x: p.myX,
            y: p.myY,
            vx: p.myVx,
            vy: p.myVy,
            kicking: p.myKicking,
          },
        ];

        Object.values(allPlayers).forEach((rp) => {
          if (rp.playerId === profile.uid) return;
          const interp = p.remoteRenderPos[rp.playerId] || {
            x: rp.x,
            y: rp.y,
            vx: rp.vx || 0,
            vy: rp.vy || 0,
            kicking: Boolean(rp.kicking),
          };
          activeDiscs.push({
            uid: rp.playerId,
            team: rp.team,
            x: interp.x,
            y: interp.y,
            vx: interp.vx,
            vy: interp.vy,
            kicking: interp.kicking,
          });
        });

        const subSteps = 2;
        for (let step = 0; step < subSteps; step++) {
          p.ballX = fpAdd(p.ballX, fpMul(p.ballVx, 0.5));
          p.ballY = fpAdd(p.ballY, fpMul(p.ballVy, 0.5));

          // Disc-to-Ball Contact for ALL players (during kickoff, only kickoffTeam can touch the ball)
          if (p.eventState === 'normal' || p.eventState === 'goal') {
            for (const disc of activeDiscs) {
              if (
                p.kickoffActive &&
                p.eventState === 'normal' &&
                disc.team !== p.kickoffTeam
              ) {
                continue;
              }
              const dx = fpSub(p.ballX, disc.x);
              const dy = fpSub(p.ballY, disc.y);
              const dist = fpHypot(dx, dy);
              const minDist = PLAYER_RADIUS + BALL_RADIUS;

              if (dist < minDist && dist > 0.001) {
                const cAngle = fpAtan2(dy, dx);
                const nx = fpCos(cAngle);
                const ny = fpSin(cAngle);

                // Выталкивание мяча из кружка игрока (без застревания внутри фишки)
                p.ballX = fpAdd(disc.x, fpMul(nx, minDist));
                p.ballY = fpAdd(disc.y, fpMul(ny, minDist));

                const relVx = fpSub(p.ballVx, disc.vx);
                const relVy = fpSub(p.ballVy, disc.vy);
                const normalVel = fpAdd(fpMul(relVx, nx), fpMul(relVy, ny));

                if (normalVel < 0) {
                  // Упругий контакт фишки и мяча по HaxBall (bCoef = 0.5 * 0.5 = 0.25)
                  const restitution = -normalVel > 1.4 ? 0.25 : 0.08;
                  const impulse = round4(-(1 + restitution) * normalVel);
                  p.ballVx = fpAdd(p.ballVx, fpMul(impulse, nx));
                  p.ballVy = fpAdd(p.ballVy, fpMul(impulse, ny));
                }

                p.lastTouchTeam = disc.team;
                if (p.kickoffActive && disc.team === p.kickoffTeam) {
                  p.kickoffActive = false;
                  roomRef.current.kickoffActive = false;
                }
                if (disc.uid === profile.uid) {
                  localTouchedBall = true;
                }
              }
            }
          }

          // Goalpost Circle Collisions (Плавный упругий отскок от штанг)
          for (const post of GOALPOSTS) {
            const dx = fpSub(p.ballX, post.x);
            const dy = fpSub(p.ballY, post.y);
            const dist = fpHypot(dx, dy);
            const minDist = BALL_RADIUS + POST_RADIUS;
            if (dist < minDist && dist > 0.001) {
              const pAng = fpAtan2(dy, dx);
              const nx = fpCos(pAng);
              const ny = fpSin(pAng);
              p.ballX = fpAdd(post.x, fpMul(nx, minDist));
              p.ballY = fpAdd(post.y, fpMul(ny, minDist));
              const vn = fpAdd(fpMul(p.ballVx, nx), fpMul(p.ballVy, ny));
              if (vn < 0) {
                const tx = -ny;
                const ty = nx;
                const vt = fpAdd(fpMul(p.ballVx, tx), fpMul(p.ballVy, ty));
                const reflectedVn = fpMul(-vn, 0.6);
                p.ballVx = fpAdd(fpMul(reflectedVn, nx), fpMul(vt, tx));
                p.ballVy = fpAdd(fpMul(reflectedVn, ny), fpMul(vt, ty));
                if (soundEnabledRef.current) {
                  soundFX.playPostHit();
                }
              }
            }
          }

          const canTriggerGoal =
            currentRoom.hostUid === profile.uid ||
            localTouchedBall ||
            now - lastLocalBallTouchMsRef.current < 2500;

          // Goal Line Detection BEFORE wall/net rebound
          if (p.eventState === 'normal' && canTriggerGoal) {
            const inGoalY = p.ballY > GOAL_TOP && p.ballY < GOAL_BOTTOM;
            if (inGoalY && p.ballX + BALL_RADIUS * 0.6 < FIELD_LEFT) {
              const newBlueScore = roomRef.current.blueScore + 1;
              const pauseUntil = now + GOAL_PAUSE_MS;
              p.eventState = 'goal';
              p.eventTeam = 'blue';
              p.eventUntilMs = pauseUntil;
              p.kickoffActive = false;
              p.kickoffTeam = 'red';
              lastHandledEventUntilRef.current = pauseUntil;
              roomRef.current.blueScore = newBlueScore;
              roomRef.current.eventState = 'goal';
              roomRef.current.eventTeam = 'blue';
              roomRef.current.eventUntilMs = pauseUntil;
              roomRef.current.kickoffTeam = 'red';
              if (soundEnabledRef.current) {
                soundFX.playGoalFanfare();
              }
              registerGoalInNet(
                currentRoom,
                'blue',
                roomRef.current.redScore,
                newBlueScore,
                pauseUntil,
                {
                  x: p.ballX,
                  y: p.ballY,
                  vx: p.ballVx,
                  vy: p.ballVy,
                }
              ).catch(() => {});
            } else if (inGoalY && p.ballX - BALL_RADIUS * 0.6 > FIELD_RIGHT) {
              const newRedScore = roomRef.current.redScore + 1;
              const pauseUntil = now + GOAL_PAUSE_MS;
              p.eventState = 'goal';
              p.eventTeam = 'red';
              p.eventUntilMs = pauseUntil;
              p.kickoffActive = false;
              p.kickoffTeam = 'blue';
              lastHandledEventUntilRef.current = pauseUntil;
              roomRef.current.redScore = newRedScore;
              roomRef.current.eventState = 'goal';
              roomRef.current.eventTeam = 'red';
              roomRef.current.eventUntilMs = pauseUntil;
              roomRef.current.kickoffTeam = 'blue';
              if (soundEnabledRef.current) {
                soundFX.playGoalFanfare();
              }
              registerGoalInNet(
                currentRoom,
                'red',
                newRedScore,
                roomRef.current.blueScore,
                pauseUntil,
                {
                  x: p.ballX,
                  y: p.ballY,
                  vx: p.ballVx,
                  vy: p.ballVy,
                }
              ).catch(() => {});
            }
          }

          // Module (a): Elastic Wall Segment Reflection (wall: true, bCoef = 0.5) + Position Correction ("выталкивание")
          // Zero outs, zero corners!
          if (p.eventState === 'normal') {
            const wallState = {
              x: p.ballX,
              y: p.ballY,
              vx: p.ballVx,
              vy: p.ballVy,
              radius: BALL_RADIUS,
              bCoef: 0.5,
            };
            collideBallWithWallSegments(wallState, PITCH_WALL_SEGMENTS);
            p.ballX = wallState.x;
            p.ballY = wallState.y;
            p.ballVx = wallState.vx;
            p.ballVy = wallState.vy;
          }

          // Deformable Goal Nets when ball is inside the goal mouth
          updateAndCollideGoalNet(
            p.leftNet,
            'left',
            p,
            soundEnabledRef.current,
            now
          );
          updateAndCollideGoalNet(
            p.rightNet,
            'right',
            p,
            soundEnabledRef.current,
            now
          );
        }

        // HaxBall Dribble & Powershot Charge Ring Tracking
        const controlRadius = PLAYER_RADIUS + BALL_RADIUS + 18;
        let closestControllerUid = '';
        let closestControlDist = Infinity;

        for (const disc of activeDiscs) {
          const dist = fpHypot(fpSub(p.ballX, disc.x), fpSub(p.ballY, disc.y));
          if (dist <= controlRadius && dist < closestControlDist) {
            closestControlDist = dist;
            closestControllerUid = disc.uid;
          }
        }

        if (closestControllerUid !== '') {
          if (p.controllingUid !== closestControllerUid) {
            p.controllingUid = closestControllerUid;
            p.controlStartedAtMs = now;
            p.powershotMustExitRing = false;
          }
        } else {
          p.controllingUid = '';
          p.controlStartedAtMs = 0;
          p.powershotMustExitRing = false;
        }

        // Module (b): Deterministic `attemptKick` (distance = Math.hypot(dx, dy), kickRadius = 4.0 -> KICK_RANGE)
        if (p.eventState === 'normal' || p.eventState === 'goal') {
          const dxMyKick = fpSub(p.ballX, p.myX);
          const dyMyKick = fpSub(p.ballY, p.myY);
          const distMyKick = fpHypot(dxMyKick, dyMyKick);
          const canLocalKick =
            !p.kickoffActive ||
            p.eventState === 'goal' ||
            localTeam === p.kickoffTeam;

          if (
            canLocalKick &&
            p.myKicking &&
            !p.myKickConsumed &&
            distMyKick <= KICK_RANGE
          ) {
            const heldDurationMs =
              p.controllingUid === profile.uid &&
              !p.powershotMustExitRing &&
              p.controlStartedAtMs > 0
                ? now - p.controlStartedAtMs
                : 0;
            const isPowershotReady =
              heldDurationMs >= POWERSHOT_CHARGE_MS &&
              heldDurationMs <= POWERSHOT_CHARGE_MS + POWERSHOT_WINDOW_MS;

            const kAngle = fpAtan2(dyMyKick, dxMyKick);
            const nx = fpCos(kAngle);
            const ny = fpSin(kAngle);
            const shotPower = isPowershotReady ? POWERSHOT_IMPULSE : KICK_STRENGTH;

            const impulseX = fpMul(nx, shotPower);
            const impulseY = fpMul(ny, shotPower);
            p.ballVx = fpAdd(p.ballVx, impulseX);
            p.ballVy = fpAdd(p.ballVy, impulseY);
            p.lastTouchTeam = localTeam;
            localTouchedBall = true;
            if (p.kickoffActive && localTeam === p.kickoffTeam) {
              p.kickoffActive = false;
              roomRef.current.kickoffActive = false;
            }
            // Immediately extinguish white kick circle on kick execution until key is released and pressed again
            p.myKickConsumed = true;
            p.myKicking = false;

            if (isPowershotReady) {
              p.powershotFlightUntilMs = now + 950;
            }
            p.powershotMustExitRing = true;
            p.controlStartedAtMs = 0;

            if (soundEnabledRef.current) {
              soundFX.playKick();
            }
          }

          // Deterministic remote kick execution on Host so P2P client kicks take effect immediately
          for (const disc of activeDiscs) {
            if (disc.uid !== profile.uid && disc.kicking) {
              if (
                p.kickoffActive &&
                p.eventState === 'normal' &&
                disc.team !== p.kickoffTeam
              ) {
                continue;
              }
              const dxRemKick = fpSub(p.ballX, disc.x);
              const dyRemKick = fpSub(p.ballY, disc.y);
              const distRemKick = fpHypot(dxRemKick, dyRemKick);
              if (distRemKick <= KICK_RANGE && distRemKick > 0.001) {
                const kAngle = fpAtan2(dyRemKick, dxRemKick);
                const nx = fpCos(kAngle);
                const ny = fpSin(kAngle);
                p.ballVx = fpAdd(p.ballVx, fpMul(nx, KICK_STRENGTH));
                p.ballVy = fpAdd(p.ballVy, fpMul(ny, KICK_STRENGTH));
                p.lastTouchTeam = disc.team;
                if (p.kickoffActive && disc.team === p.kickoffTeam) {
                  p.kickoffActive = false;
                  roomRef.current.kickoffActive = false;
                }
                const rState = p.remoteRenderPos[disc.uid];
                if (rState) {
                  rState.kicking = false;
                }
                if (soundEnabledRef.current) {
                  soundFX.playKick();
                }
              }
            }
          }
        }

        // Release kickoff barrier as soon as ball moves away from center spot
        if (
          p.kickoffActive &&
          p.eventState === 'normal' &&
          (Math.hypot(p.ballX - FIELD_CENTER_X, p.ballY - FIELD_CENTER_Y) > 1.5 ||
            Math.hypot(p.ballVx, p.ballVy) > 0.08)
        ) {
          p.kickoffActive = false;
          roomRef.current.kickoffActive = false;
        }

        // Fixed-Step Ball Damping & Max Speed Clamp
        p.ballVx = fpMul(p.ballVx, BALL_DAMPING);
        p.ballVy = fpMul(p.ballVy, BALL_DAMPING);
        const bSpeed = fpHypot(p.ballVx, p.ballVy);
        const activeMaxSpeed =
          now < p.powershotFlightUntilMs ? POWERSHOT_MAX_SPEED : BALL_MAX_SPEED;
        if (bSpeed > activeMaxSpeed) {
          const bAng = fpAtan2(p.ballVy, p.ballVx);
          p.ballVx = fpMul(fpCos(bAng), activeMaxSpeed);
          p.ballVy = fpMul(fpSin(bAng), activeMaxSpeed);
        }
        if (bSpeed < 0.02) {
          p.ballVx = 0;
          p.ballVy = 0;
        }
        p.ballAngle = round4(p.ballAngle + bSpeed * 0.045);

        if (localTouchedBall) {
          lastLocalBallTouchMsRef.current = now;
          remoteBallGraceUntilMsRef.current = 0;
          pendingRtcBallRef.current = null;
          p.ballOffsetX = 0;
          p.ballOffsetY = 0;
        }

        // Module (d): Jitter Damper for Ball Reconciliation (Zero Self-Echo Overwrite!)
        const isHost = currentRoom.hostUid === profile.uid;
        if (!localTouchedBall && p.eventState === 'normal') {
          const rtcBall = pendingRtcBallRef.current;
          if (
            rtcBall &&
            rtcBall.playerId !== profile.uid &&
            now - rtcBall.ts < 350
          ) {
            pendingRtcBallRef.current = null;
            const prevVisualX = fpAdd(p.ballX, p.ballOffsetX);
            const prevVisualY = fpAdd(p.ballY, p.ballOffsetY);

            p.ballVx = rtcBall.ballVx;
            p.ballVy = rtcBall.ballVy;
            p.ballX = fpAdd(
              rtcBall.ballX,
              fpMul(rtcBall.ballVx, extrapFrames * 0.25)
            );
            p.ballY = fpAdd(
              rtcBall.ballY,
              fpMul(rtcBall.ballVy, extrapFrames * 0.25)
            );
            p.lastTouchTeam = rtcBall.lastTouchTeam;
            if (
              p.kickoffActive &&
              (Math.hypot(p.ballX - FIELD_CENTER_X, p.ballY - FIELD_CENTER_Y) > 1.5 ||
                Math.hypot(p.ballVx, p.ballVy) > 0.08)
            ) {
              p.kickoffActive = false;
              roomRef.current.kickoffActive = false;
            }

            if (p.eventState === 'normal') {
              const wallState = {
                x: p.ballX,
                y: p.ballY,
                vx: p.ballVx,
                vy: p.ballVy,
                radius: BALL_RADIUS,
                bCoef: 0.5,
              };
              collideBallWithWallSegments(wallState, PITCH_WALL_SEGMENTS);
              p.ballX = wallState.x;
              p.ballY = wallState.y;
              p.ballVx = wallState.vx;
              p.ballVy = wallState.vy;
            }

            const errX = fpSub(prevVisualX, p.ballX);
            const errY = fpSub(prevVisualY, p.ballY);
            if (fpHypot(errX, errY) < 280) {
              p.ballOffsetX = errX;
              p.ballOffsetY = errY;
            } else {
              p.ballOffsetX = 0;
              p.ballOffsetY = 0;
            }
          } else if (liveSnap.room) {
            const netRoom = liveSnap.room;
            const incomingSeq =
              typeof netRoom.seq === 'number' && netRoom.seq < 1000000000
                ? netRoom.seq
                : 0;
            const isFromOtherPlayer =
              Boolean(netRoom.actorUid) && netRoom.actorUid !== profile.uid;

            // Если пакет в памяти/WS наш собственный (actorUid === profile.uid), просто продвигаем seq и НЕ откатываем свой мяч!
            if (netRoom.actorUid === profile.uid) {
              if (incomingSeq > lastAppliedBallSeqRef.current) {
                lastAppliedBallSeqRef.current = incomingSeq;
              }
            } else if (
              incomingSeq > lastAppliedBallSeqRef.current &&
              isFromOtherPlayer &&
              (!isHost || isRemoteContestingClose) &&
              (!recentlyTouchedLocally || isRemoteContestingClose)
            ) {
              lastAppliedBallSeqRef.current = incomingSeq;
              const prevVisualX = fpAdd(p.ballX, p.ballOffsetX);
              const prevVisualY = fpAdd(p.ballY, p.ballOffsetY);

              p.ballVx = netRoom.ballVx;
              p.ballVy = netRoom.ballVy;
              p.ballX = fpAdd(
                netRoom.ballX,
                fpMul(netRoom.ballVx, extrapFrames * 0.25)
              );
              p.ballY = fpAdd(
                netRoom.ballY,
                fpMul(netRoom.ballVy, extrapFrames * 0.25)
              );
              p.lastTouchTeam = netRoom.lastTouchTeam;
              if (
                p.kickoffActive &&
                (Math.hypot(p.ballX - FIELD_CENTER_X, p.ballY - FIELD_CENTER_Y) > 1.5 ||
                  Math.hypot(p.ballVx, p.ballVy) > 0.08)
              ) {
                p.kickoffActive = false;
                roomRef.current.kickoffActive = false;
              }

              if (p.eventState === 'normal') {
                const wallState = {
                  x: p.ballX,
                  y: p.ballY,
                  vx: p.ballVx,
                  vy: p.ballVy,
                  radius: BALL_RADIUS,
                  bCoef: 0.5,
                };
                collideBallWithWallSegments(wallState, PITCH_WALL_SEGMENTS);
                p.ballX = wallState.x;
                p.ballY = wallState.y;
                p.ballVx = wallState.vx;
                p.ballVy = wallState.vy;
              }

              const errX = fpSub(prevVisualX, p.ballX);
              const errY = fpSub(prevVisualY, p.ballY);
              if (fpHypot(errX, errY) < 280) {
                p.ballOffsetX = errX;
                p.ballOffsetY = errY;
              } else {
                p.ballOffsetX = 0;
                p.ballOffsetY = 0;
              }
            }
          }
        }

        const ballDecay = 0.8;
        p.ballOffsetX =
          Math.abs(p.ballOffsetX) > 0.15 ? fpMul(p.ballOffsetX, ballDecay) : 0;
        p.ballOffsetY =
          Math.abs(p.ballOffsetY) > 0.15 ? fpMul(p.ballOffsetY, ballDecay) : 0;
      }

      // Host Authoritative Lockstep Tick Broadcast (60Hz Binary ArrayBuffer)
      if (rtcSession && !isMatchFinished && rtcSession.isHost) {
        const snapshotPlayers: Record<
          string,
          {
            x: number;
            y: number;
            vx: number;
            vy: number;
            kicking: boolean;
            keyMask?: number;
          }
        > = {
          [profile.uid]: {
            x: p.myX,
            y: p.myY,
            vx: p.myVx,
            vy: p.myVy,
            kicking: p.myKicking,
            keyMask: currentKeyMask,
          },
        };
        Object.values(allPlayers).forEach((rp) => {
          if (rp.playerId === profile.uid) return;
          const rPos = p.remoteRenderPos[rp.playerId];
          const pIn = peerInputsRef.current[rp.playerId];
          const pMask = pIn
            ? (pIn.up ? 1 : 0) |
              (pIn.down ? 2 : 0) |
              (pIn.left ? 4 : 0) |
              (pIn.right ? 8 : 0) |
              (pIn.kick ? 16 : 0)
            : (rp as { keyMask?: number }).keyMask ?? 0;
          snapshotPlayers[rp.playerId] = {
            x: rPos ? rPos.x : rp.x,
            y: rPos ? rPos.y : rp.y,
            vx: rPos ? rPos.vx : rp.vx || 0,
            vy: rPos ? rPos.vy : rp.vy || 0,
            kicking: rPos ? rPos.kicking : Boolean(rp.kicking),
            keyMask: pMask,
          };
        });

        const resolved = rtcSession.resolveHostLockstepFrame(
          currentTick,
          {
            up: effectiveUp,
            down: effectiveDown,
            left: effectiveLeft,
            right: effectiveRight,
            kick: p.myKicking,
          },
          {
            tick: currentTick,
            roomStatus: currentRoom.status,
            matchStartedAtMs: currentRoom.matchStartedAtMs,
            launchAtMs: currentRoom.launchAtMs,
            readyUids: currentRoom.readyUids,
            countdownEndsAtMs: currentRoom.countdownEndsAtMs,
            kickoffTeam: p.kickoffTeam,
            kickoffActive: p.kickoffActive,
            elapsedMatchMs: Math.floor(p.elapsedMatchMs),
            ballX: p.ballX,
            ballY: p.ballY,
            ballVx: p.ballVx,
            ballVy: p.ballVy,
            redScore: roomRef.current.redScore,
            blueScore: roomRef.current.blueScore,
            eventState: p.eventState,
            eventTeam: p.eventTeam,
            eventUntilMs: p.eventUntilMs,
            lastTouchTeam: p.lastTouchTeam,
            actorUid: profile.uid,
            players: snapshotPlayers,
          }
        );
        peerInputsRef.current = resolved.frameInputs;
      }

      if (
        rtcSession &&
        !isMatchFinished &&
        !rtcSession.isHost &&
        localTouchedBall
      ) {
        rtcSession.sendClientBallTouch({
          ballX: p.ballX,
          ballY: p.ballY,
          ballVx: p.ballVx,
          ballVy: p.ballVy,
          lastTouchTeam: p.lastTouchTeam,
        });
      }

      // WebSocket Fallback Sync (when P2P DataChannel is still establishing)
      const hasOpenP2P = rtcSession ? rtcSession.hasOpenDataChannel() : false;
      const playerSyncIntervalMs = hasOpenP2P ? 120 : 16;

      if (!isMatchFinished && now - lastPlayerSyncMsRef.current >= playerSyncIntervalMs) {
        const last = lastSentPosRef.current;
        const posDelta =
          Math.abs(p.myX - last.x) +
          Math.abs(p.myY - last.y) +
          Math.abs(p.myVx - last.vx) +
          Math.abs(p.myVy - last.vy);
        const stateChanged =
          posDelta > 0.25 ||
          currentKeyMask !== last.keyMask ||
          p.myKicking !== last.kicking ||
          localMovedOrChanged;
        const recentlyActive = now - lastLocalActiveMoveMsRef.current < 320;

        if (stateChanged || recentlyActive) {
          lastPlayerSyncMsRef.current = now;
          lastSentPosRef.current = {
            x: p.myX,
            y: p.myY,
            vx: p.myVx,
            vy: p.myVy,
            keyMask: currentKeyMask,
            kicking: p.myKicking,
          };
          syncLocalPlayerDisc(
            currentRoom.roomId,
            profile.uid,
            {
              x: p.myX,
              y: p.myY,
              vx: p.myVx,
              vy: p.myVy,
              kicking: p.myKicking,
              keyMask: currentKeyMask,
            },
            {
              nickname:
                allPlayers[profile.uid]?.nickname || profile.nickname,
              jerseyNumber:
                allPlayers[profile.uid]?.jerseyNumber || profile.jerseyNumber,
              team: localTeam,
            }
          ).catch(() => {});
        }
      }

      const isHost = currentRoom.hostUid === profile.uid;
      const remoteGraceActive = now < remoteBallGraceUntilMsRef.current;
      const shouldSyncBall =
        localTouchedBall ||
        (!remoteGraceActive && now - lastLocalBallTouchMsRef.current < 650) ||
        (isHost && !remoteGraceActive);

      const ballSyncIntervalMs = hasOpenP2P && !localTouchedBall ? 120 : 16;

      if (
        !isMatchFinished &&
        shouldSyncBall &&
        (localTouchedBall || now - lastBallSyncMsRef.current >= ballSyncIntervalMs)
      ) {
        lastBallSyncMsRef.current = now;
        syncRoomGameplayState(currentRoom.roomId, {
          redScore: roomRef.current.redScore,
          blueScore: roomRef.current.blueScore,
          ballX: p.ballX,
          ballY: p.ballY,
          ballVx: p.ballVx,
          ballVy: p.ballVy,
          eventState: p.eventState,
          eventTeam: p.eventTeam,
          eventUntilMs: p.eventUntilMs,
          lastTouchTeam: p.lastTouchTeam,
          actorUid: profile.uid,
          kickoffTeam: p.kickoffTeam,
          kickoffActive: p.kickoffActive,
          elapsedMatchMs: Math.floor(p.elapsedMatchMs),
          countdownEndsAtMs: currentRoom.countdownEndsAtMs,
          readyUids: currentRoom.readyUids,
        })
          .then((assignedSeq) => {
            if (assignedSeq > lastAppliedBallSeqRef.current) {
              lastAppliedBallSeqRef.current = assignedSeq;
            }
          })
          .catch(() => {});
      }
    };

    const stepPhysicsAndRender = () => {
      const perfNow = performance.now();
      const frameDeltaMs = Math.min(100, Math.max(0, perfNow - lastPerfTime));
      lastPerfTime = perfNow;
      accumulatorMs += frameDeltaMs;

      // Elastic Clock: slightly accelerate step duration (15.7ms instead of 16.666ms) when >2 ticks are buffered
      const targetStepMs =
        webrtcSessionRef.current?.getElasticStepMs() ?? LOCKSTEP_STEP_MS;

      let steps = 0;
      while (accumulatorMs >= targetStepMs && steps < 4) {
        runFixedPhysicsTick(Date.now());
        accumulatorMs -= targetStepMs;
        steps += 1;
      }

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          drawArena(ctx, roomRef.current, playersRef.current, physRef.current, profile);
        }
      }

      animationFrameId = window.requestAnimationFrame(stepPhysicsAndRender);
    };

    animationFrameId = window.requestAnimationFrame(stepPhysicsAndRender);
    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [profile]);

  const isFinished =
    room.status === 'finished' || elapsedSeconds >= MATCH_DURATION_SEC;

  const getWinnerBannerText = () => {
    if (room.redScore > room.blueScore) {
      return {
        headline: 'Матч окончен! Победила Красная команда',
        subtext: `Итоговый счёт ${room.redScore} : ${room.blueScore}`,
        accentClass: 'border-red-500/60 bg-red-950/90 text-red-200',
      };
    }
    if (room.blueScore > room.redScore) {
      return {
        headline: 'Матч окончен! Победила Синяя команда',
        subtext: `Итоговый счёт ${room.redScore} : ${room.blueScore}`,
        accentClass: 'border-blue-500/60 bg-blue-950/90 text-blue-200',
      };
    }
    return {
      headline: 'Матч окончен! Боевая ничья',
      subtext: `Итоговый счёт ${room.redScore} : ${room.blueScore}`,
      accentClass: 'border-amber-500/60 bg-amber-950/90 text-amber-200',
    };
  };

  const getEventBanner = () => {
    if (room.eventState === 'goal') {
      const scorer =
        room.eventTeam === 'red' ? 'КРАСНАЯ КОМАНДА' : 'СИНЯЯ КОМАНДА';
      return {
        text: `⚽ ГОЛ! Забивает ${scorer}!`,
        cls:
          room.eventTeam === 'red'
            ? 'bg-red-600/95 text-white border-red-400'
            : 'bg-blue-600/95 text-white border-blue-400',
      };
    }
    return null;
  };

  const eventBanner = getEventBanner();

  const redTeamRoster = room.redUids
    .map((uid) => players[uid])
    .filter((p): p is RoomPlayerDoc => Boolean(p));
  const blueTeamRoster = room.blueUids
    .map((uid) => players[uid])
    .filter((p): p is RoomPlayerDoc => Boolean(p));

  const handleExtrapolationChange = (val: number) => {
    const clamped = Math.max(0, Math.min(MAX_EXTRAPOLATION_MS, val));
    setExtrapolationMs(clamped);
    extrapolationMsRef.current = clamped;
  };

  return (
    <div className="h-screen w-screen overflow-hidden bg-slate-950 text-slate-50 flex flex-col items-center justify-between px-2 py-1.5 select-none">
      {/* Compact Single-Row Top Scoreboard HUD */}
      <div className="w-full max-w-[1560px] flex items-center justify-between gap-2 bg-slate-900/95 border border-slate-800 rounded-xl px-3 py-1.5 shadow-xl shrink-0">
        {/* Left: Room Title & Elastic Walls + Gamepad Badge */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" />
          <div className="truncate">
            <div className="text-xs font-display font-bold text-white truncate">
              {room.title}
            </div>
            <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <span>Код: {room.roomId}</span>
              <span>•</span>
              <span className="text-emerald-400 font-medium">
                P2P 60Hz · Стены без аутов
              </span>
              {gamepadConnected && (
                <>
                  <span>•</span>
                  <span className="inline-flex items-center gap-1 text-sky-400 font-semibold">
                    <Gamepad2 className="w-3.5 h-3.5" />
                    <span>Геймпад (Л. стик + ✕)</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Center: Scoreboard + 5-Minute Match Timer */}
        <div className="flex items-center gap-2 sm:gap-4 bg-slate-950 border border-slate-800 px-3.5 py-1 rounded-xl">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-500 shadow-sm shadow-red-500/50" />
            <span className="text-xs font-display font-bold uppercase tracking-wider text-red-400 hidden sm:inline">
              Красные
            </span>
            <span className="text-xl sm:text-2xl font-mono-tabular font-extrabold text-white">
              {room.redScore}
            </span>
          </div>

          <div className="flex flex-col items-center px-2.5 py-0.5 rounded-lg bg-slate-900 border border-slate-800">
            <span className="text-[9px] uppercase tracking-widest text-slate-400 font-semibold">
              {preMatchUi.phase !== 'live'
                ? 'Старт'
                : preMatchUi.kickoffActive && room.eventState !== 'goal'
                  ? 'Пауза (развод)'
                  : 'Время'}
            </span>
            <span
              className={`text-sm sm:text-base font-mono-tabular font-bold ${
                preMatchUi.phase !== 'live' ||
                (preMatchUi.kickoffActive && room.eventState !== 'goal')
                  ? 'text-amber-400'
                  : elapsedSeconds >= MATCH_DURATION_SEC - 30
                    ? 'text-amber-400'
                    : 'text-emerald-400'
              }`}
            >
              {formatTimerMMSS(elapsedSeconds)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xl sm:text-2xl font-mono-tabular font-extrabold text-white">
              {room.blueScore}
            </span>
            <span className="text-xs font-display font-bold uppercase tracking-wider text-blue-400 hidden sm:inline">
              Синие
            </span>
            <span className="w-3 h-3 rounded-full bg-blue-500 shadow-sm shadow-blue-500/50" />
          </div>
        </div>

        {/* Right: Event Banner + Tab Button + Sound Toggle + Exit to Lobby */}
        <div className="flex items-center gap-2">
          {eventBanner && (
            <div
              className={`hidden lg:flex items-center px-3 py-1 rounded-lg border font-display font-bold text-xs tracking-wide shadow-md ${eventBanner.cls}`}
            >
              {eventBanner.text}
            </div>
          )}
          <button
            type="button"
            onMouseDown={() => setTabOpen(true)}
            onMouseUp={() => setTabOpen(false)}
            onClick={() => setTabOpen((prev) => !prev)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono-tabular text-slate-300 hover:text-white hover:border-slate-700 transition-colors cursor-pointer"
            title="Таблица команд и пинг (удерживайте Tab)"
          >
            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-bold text-emerald-400">
              TAB
            </span>
            <span className="hidden sm:inline font-sans font-medium">Команды</span>
          </button>
          <button
            type="button"
            onClick={() => setSoundEnabled((prev) => !prev)}
            className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:border-slate-700 transition-colors cursor-pointer"
            title={soundEnabled ? 'Выключить звук' : 'Включить звук'}
          >
            {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onExitToLobby}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white hover:border-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>В лобби</span>
          </button>
        </div>
      </div>

      {/* Main HTML5 Canvas Stadium Container */}
      <div className="relative w-full max-w-[min(98vw,calc((100vh-3.75rem)*1400/760))] aspect-[1400/760] rounded-2xl overflow-hidden border-2 border-slate-800 shadow-2xl bg-[#14532d] my-auto">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="w-full h-full block"
        />

        {/* Rocket League Top-Center 3-2-1 Countdown & Kickoff Status Banner */}
        {!isFinished && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-4">
            {preMatchUi.phase === 'waiting_players' && (
              <div className="flex items-center gap-2.5 px-4 py-2 rounded-xl bg-slate-950/90 border border-amber-500/50 shadow-xl">
                <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
                <span className="font-display font-bold text-xs sm:text-sm text-white">
                  Ожидание прогрузки игроков на позициях...
                </span>
                <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 font-mono-tabular font-bold text-xs text-amber-300">
                  Автостарт: {preMatchUi.waitSecondsLeft}с
                </span>
              </div>
            )}

            {preMatchUi.phase === 'countdown' && (
              <div className="flex flex-col items-center">
                <div className="px-3.5 py-1 rounded-full bg-slate-950/90 border border-red-500/50 text-[11px] font-display font-bold uppercase tracking-wider text-red-300 shadow-lg mb-1.5">
                  Все на позициях · Первый развод: Красная команда
                </div>
                <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl bg-slate-950/90 border-2 border-amber-400 flex items-center justify-center shadow-2xl">
                  <span className="font-display font-black text-5xl sm:text-6xl text-amber-400 font-mono-tabular">
                    {preMatchUi.countdownNumber}
                  </span>
                </div>
              </div>
            )}

            {preMatchUi.phase === 'live' && preMatchUi.goBannerActive && (
              <div className="px-6 py-2.5 rounded-2xl bg-emerald-500 text-slate-950 font-display font-black text-xl sm:text-2xl uppercase tracking-wider shadow-2xl border-2 border-white">
                МАТЧ НАЧАЛСЯ! РАЗВОД КРАСНЫХ!
              </div>
            )}

            {preMatchUi.phase === 'live' &&
              !preMatchUi.goBannerActive &&
              preMatchUi.kickoffActive &&
              room.eventState !== 'goal' && (
                <div
                  className={`flex flex-wrap items-center justify-center gap-2 px-4 py-1.5 rounded-xl border shadow-xl text-xs font-display font-bold ${
                    preMatchUi.kickoffTeam === 'red'
                      ? 'bg-red-950/90 border-red-500/60 text-red-100'
                      : 'bg-blue-950/90 border-blue-500/60 text-blue-100'
                  }`}
                >
                  <span>
                    ⚽ РАЗВОД МЯЧА:{' '}
                    {preMatchUi.kickoffTeam === 'red'
                      ? 'КРАСНАЯ КОМАНДА'
                      : 'СИНЯЯ КОМАНДА'}
                  </span>
                  <span className="text-white/60">•</span>
                  <span className="font-sans font-medium text-[11px] text-slate-200">
                    Таймер 05:00 на паузе до касания · Соперники ждут за белым кругом
                  </span>
                </div>
              )}
          </div>
        )}

        {/* Right-Side Rocket League Player Loading Status Panel («справа показывает кто все еще грузит а кто зашел») */}
        {!isFinished &&
          (preMatchUi.phase === 'waiting_players' ||
            preMatchUi.phase === 'countdown' ||
            preMatchUi.goBannerActive) && (
            <div className="pointer-events-none absolute right-3 top-3 z-20 w-64 sm:w-72 rounded-xl bg-slate-950/90 border border-slate-700/90 p-3.5 shadow-2xl">
              <div className="flex items-center justify-between gap-2 pb-2.5 mb-2.5 border-b border-slate-800">
                <div className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="font-display font-bold text-xs text-white">
                    Загрузка игроков ({(room.readyUids || []).length}/
                    {room.memberUids.length})
                  </span>
                </div>
                {preMatchUi.phase === 'waiting_players' ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 font-mono-tabular text-[10px] font-bold text-amber-300">
                    <Clock className="w-2.5 h-2.5" />
                    <span>{preMatchUi.waitSecondsLeft}с</span>
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 font-mono-tabular text-[10px] font-bold text-emerald-300">
                    Готовы ✓
                  </span>
                )}
              </div>

              <div className="space-y-1.5">
                {room.memberUids.map((uid) => {
                  const pl = players[uid];
                  const isPlayerReady =
                    (room.readyUids || []).includes(uid) ||
                    uid === profile.uid ||
                    preMatchUi.phase !== 'waiting_players';
                  const pTeam: TeamColor = room.blueUids.includes(uid)
                    ? 'blue'
                    : 'red';
                  const nick =
                    pl?.nickname ||
                    (uid === profile.uid ? profile.nickname : 'Игрок');
                  const num =
                    pl?.jerseyNumber ||
                    (uid === profile.uid ? profile.jerseyNumber : 10);

                  return (
                    <div
                      key={uid}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-slate-900/95 border border-slate-800"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-5 h-5 rounded-full flex items-center justify-center font-mono-tabular font-bold text-[10px] text-white shrink-0 ${
                            pTeam === 'red' ? 'bg-red-600' : 'bg-blue-600'
                          }`}
                        >
                          {num}
                        </span>
                        <span className="text-xs font-medium text-white truncate">
                          {nick}
                          {uid === profile.uid ? ' (Вы)' : ''}
                        </span>
                      </div>
                      {isPlayerReady ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400 shrink-0">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>В игре</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-400 shrink-0">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>Грузится...</span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-2.5 pt-2 border-t border-slate-800/90 text-[10px] text-slate-400 leading-tight">
                {preMatchUi.phase === 'waiting_players'
                  ? 'Все стоят по расстановке. Если кто-то долго грузится — старт через 10 сек.'
                  : 'Отсчёт 3 - 2 - 1! Первый развод мяча у Красной команды.'}
              </div>
            </div>
          )}

        {/* TAB Scoreboard Overlay: Teams, Nicknames, Ping (updated every 3s), and Extrapolation */}
        {tabOpen && !isFinished && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/75 p-4">
            <div className="w-full max-w-3xl rounded-2xl bg-slate-900/95 border border-slate-700/90 shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="px-6 py-4 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-xs text-emerald-400 font-semibold">
                    <Shield className="w-3.5 h-3.5" />
                    <span>Таблица матча · WebRTC P2P Lockstep (60 Hz Binary)</span>
                  </div>
                  <h3 className="font-display font-bold text-lg text-white mt-0.5">
                    {room.title}
                  </h3>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <span>Обновление пинга: каждые 3 сек</span>
                  <button
                    type="button"
                    onClick={() => setTabOpen(false)}
                    className="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white cursor-pointer"
                  >
                    Закрыть (Tab)
                  </button>
                </div>
              </div>

              {/* Two Team Columns: Red Team & Blue Team with Nicknames & Ping */}
              <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-5">
                {/* Red Team */}
                <div className="rounded-xl bg-slate-950/80 border border-red-500/30 p-4">
                  <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full bg-red-500" />
                      <span className="font-display font-bold text-sm text-red-400">
                        Красная команда
                      </span>
                    </div>
                    <span className="font-mono-tabular font-bold text-base text-white">
                      Счёт: {room.redScore}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {redTeamRoster.length === 0 ? (
                      <div className="py-4 text-center text-xs text-slate-500">
                        Нет игроков
                      </div>
                    ) : (
                      redTeamRoster.map((pl) => {
                        const isMe = pl.playerId === profile.uid;
                        const pVal = isMe
                          ? localPing
                          : peerPings[pl.playerId] ?? pl.pingMs ?? 24;
                        const pingColor =
                          pVal < 55
                            ? 'text-emerald-400 border-emerald-500/30 bg-emerald-950/40'
                            : pVal < 110
                              ? 'text-amber-400 border-amber-500/30 bg-amber-950/40'
                              : 'text-red-400 border-red-500/30 bg-red-950/40';
                        return (
                          <div
                            key={pl.playerId}
                            className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800/90"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-7 h-7 rounded-full bg-red-600 border border-red-300 flex items-center justify-center font-mono-tabular font-bold text-xs text-white shrink-0">
                                {pl.jerseyNumber}
                              </div>
                              <div className="truncate">
                                <div className="text-xs font-semibold text-white truncate">
                                  {pl.nickname}
                                  {isMe ? ' (Вы)' : ''}
                                </div>
                                <div className="text-[10px] text-slate-400">
                                  {pl.playerId === room.hostUid ? 'Хост P2P' : 'Клиент P2P'}
                                </div>
                              </div>
                            </div>
                            <div
                              className={`flex items-center gap-1 px-2 py-0.5 rounded border font-mono-tabular text-xs font-semibold shrink-0 ${pingColor}`}
                            >
                              <Wifi className="w-3 h-3" />
                              <span>{pVal} мс</span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Blue Team */}
                <div className="rounded-xl bg-slate-950/80 border border-blue-500/30 p-4">
                  <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full bg-blue-500" />
                      <span className="font-display font-bold text-sm text-blue-400">
                        Синяя команда
                      </span>
                    </div>
                    <span className="font-mono-tabular font-bold text-base text-white">
                      Счёт: {room.blueScore}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {blueTeamRoster.length === 0 ? (
                      <div className="py-4 text-center text-xs text-slate-500">
                        Нет игроков
                      </div>
                    ) : (
                      blueTeamRoster.map((pl) => {
                        const isMe = pl.playerId === profile.uid;
                        const pVal = isMe
                          ? localPing
                          : peerPings[pl.playerId] ?? pl.pingMs ?? 24;
                        const pingColor =
                          pVal < 55
                            ? 'text-emerald-400 border-emerald-500/30 bg-emerald-950/40'
                            : pVal < 110
                              ? 'text-amber-400 border-amber-500/30 bg-amber-950/40'
                              : 'text-red-400 border-red-500/30 bg-red-950/40';
                        return (
                          <div
                            key={pl.playerId}
                            className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800/90"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-7 h-7 rounded-full bg-blue-600 border border-blue-300 flex items-center justify-center font-mono-tabular font-bold text-xs text-white shrink-0">
                                {pl.jerseyNumber}
                              </div>
                              <div className="truncate">
                                <div className="text-xs font-semibold text-white truncate">
                                  {pl.nickname}
                                  {isMe ? ' (Вы)' : ''}
                                </div>
                                <div className="text-[10px] text-slate-400">
                                  {pl.playerId === room.hostUid ? 'Хост P2P' : 'Клиент P2P'}
                                </div>
                              </div>
                            </div>
                            <div
                              className={`flex items-center gap-1 px-2 py-0.5 rounded border font-mono-tabular text-xs font-semibold shrink-0 ${pingColor}`}
                            >
                              <Wifi className="w-3 h-3" />
                              <span>{pVal} мс</span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              {/* Footer: Extrapolation (0..200 ms) Compensation Setting */}
              <div className="px-6 py-3.5 bg-slate-950 border-t border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs">
                <div className="flex items-center gap-3">
                  <span className="text-slate-300 font-semibold">
                    Экстраполяция (сглаживание задержки):
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={MAX_EXTRAPOLATION_MS}
                    step={5}
                    value={extrapolationMs}
                    onChange={(e) => handleExtrapolationChange(Number(e.target.value))}
                    className="w-32 accent-emerald-500 cursor-pointer"
                  />
                  <span className="font-mono-tabular font-bold text-emerald-400">
                    {extrapolationMs} мс
                  </span>
                </div>
                <span className="text-slate-400">
                  Удерживайте <strong className="text-slate-200 font-mono-tabular">Tab</strong> для быстрого просмотра
                </span>
              </div>
            </div>
          </div>
        )}

        {/* 5-Minute Match Over Modal («Матч окончен! Победила команда [Цвет]») */}
        {isFinished && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 p-4">
            <div
              className={`max-w-lg w-full rounded-2xl border p-6 sm:p-8 text-center shadow-2xl ${
                getWinnerBannerText().accentClass
              }`}
            >
              <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center mx-auto mb-4">
                <Trophy className="w-6 h-6 text-amber-400" />
              </div>
              <h2 className="font-display font-extrabold text-2xl sm:text-3xl text-white text-balance">
                {getWinnerBannerText().headline}
              </h2>
              <p className="mt-2 text-sm text-slate-300 font-mono-tabular">
                {getWinnerBannerText().subtext} · Время матча 05:00 истекло
              </p>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={onCreateRematch}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>Создать новый матч</span>
                </button>
                <button
                  type="button"
                  onClick={onExitToLobby}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 font-medium text-sm border border-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Вернуться в лобби</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Pure Canvas 2D Renderer for HaxArena Pitch (Elastic Wall Boundaries, Goals, Players, and Soccer Ball)
 */
function drawArena(
  ctx: CanvasRenderingContext2D,
  room: MatchRoomDoc,
  players: Record<string, RoomPlayerDoc>,
  phys: LocalPhysicsState,
  localProfile: PlayerProfile
) {
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // 1. Outer Stadium Surround
  ctx.fillStyle = '#0f3923';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // 2. Mowed Turf Stripes Inside Pitch Boundaries
  const stripeCount = 12;
  const fieldWidth = FIELD_RIGHT - FIELD_LEFT;
  const fieldHeight = FIELD_BOTTOM - FIELD_TOP;
  const stripeWidth = fieldWidth / stripeCount;

  for (let i = 0; i < stripeCount; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#15803d' : '#166534';
    ctx.fillRect(FIELD_LEFT + i * stripeWidth, FIELD_TOP, stripeWidth, fieldHeight);
  }

  // 3. Pitch Elastic Wall Boundaries (Segments with wall: true, bCoef = 0.5)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 3.5;

  for (const seg of PITCH_WALL_SEGMENTS) {
    ctx.beginPath();
    ctx.moveTo(seg.x0, seg.y0);
    ctx.lineTo(seg.x1, seg.y1);
    ctx.stroke();
  }

  // Goal Line markings between goalposts
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(FIELD_LEFT, GOAL_TOP);
  ctx.lineTo(FIELD_LEFT, GOAL_BOTTOM);
  ctx.moveTo(FIELD_RIGHT, GOAL_TOP);
  ctx.lineTo(FIELD_RIGHT, GOAL_BOTTOM);
  ctx.stroke();

  // Halfway Line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(FIELD_CENTER_X, FIELD_TOP);
  ctx.lineTo(FIELD_CENTER_X, FIELD_BOTTOM);
  ctx.stroke();

  // Center Circle
  ctx.beginPath();
  ctx.arc(FIELD_CENTER_X, FIELD_CENTER_Y, CENTER_CIRCLE_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  // Kickoff Barrier Visual Highlight (Shows active half-line & white center circle rule until kickoff touch)
  if (phys.kickoffActive && phys.eventState === 'normal') {
    ctx.save();
    const isRedKickoff = phys.kickoffTeam === 'red';
    ctx.fillStyle = isRedKickoff
      ? 'rgba(239, 68, 68, 0.14)'
      : 'rgba(59, 130, 246, 0.14)';
    ctx.beginPath();
    ctx.arc(
      FIELD_CENTER_X,
      FIELD_CENTER_Y,
      CENTER_CIRCLE_RADIUS,
      0,
      Math.PI * 2
    );
    ctx.fill();

    // Highlight active kickoff barrier line & circle rim
    ctx.strokeStyle = isRedKickoff
      ? 'rgba(248, 113, 113, 0.92)'
      : 'rgba(96, 165, 250, 0.92)';
    ctx.lineWidth = 3.5;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.arc(
      FIELD_CENTER_X,
      FIELD_CENTER_Y,
      CENTER_CIRCLE_RADIUS,
      0,
      Math.PI * 2
    );
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(FIELD_CENTER_X, FIELD_TOP);
    ctx.lineTo(FIELD_CENTER_X, FIELD_CENTER_Y - CENTER_CIRCLE_RADIUS);
    ctx.moveTo(FIELD_CENTER_X, FIELD_CENTER_Y + CENTER_CIRCLE_RADIUS);
    ctx.lineTo(FIELD_CENTER_X, FIELD_BOTTOM);
    ctx.stroke();
    ctx.restore();
  }

  // Center Kickoff Spot
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.beginPath();
  ctx.arc(FIELD_CENTER_X, FIELD_CENTER_Y, 4.5, 0, Math.PI * 2);
  ctx.fill();

  // Left (Red) Penalty Area
  ctx.strokeRect(FIELD_LEFT, FIELD_CENTER_Y - 135, 130, 270);
  // Right (Blue) Penalty Area
  ctx.strokeRect(FIELD_RIGHT - 130, FIELD_CENTER_Y - 135, 130, 270);

  // 4. Left Goal (Red) & Right Goal (Blue) Deformable Woven Football Nets
  drawDeformableGoalNet(ctx, phys.leftNet, 'left');
  drawDeformableGoalNet(ctx, phys.rightNet, 'right');

  // Goalposts
  for (const post of GOALPOSTS) {
    ctx.beginPath();
    ctx.arc(post.x, post.y, POST_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = post.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  // 5. Draw All Player Discs (Red & Blue)
  const localTeam: TeamColor = room.blueUids.includes(localProfile.uid)
    ? 'blue'
    : 'red';

  const renderList: Array<{
    uid: string;
    nickname: string;
    jerseyNumber: number;
    team: TeamColor;
    x: number;
    y: number;
    kicking: boolean;
    pingMs: number;
    isMe: boolean;
  }> = [];

  // Add remote players (white circle turns off the exact frame they release kick!)
  Object.values(players).forEach((rp) => {
    if (rp.playerId === localProfile.uid) return;
    const pos = phys.remoteRenderPos[rp.playerId] || {
      x: rp.x,
      y: rp.y,
      offsetX: 0,
      offsetY: 0,
      kicking: Boolean(rp.kicking),
    };
    const km = (rp as { keyMask?: number }).keyMask;
    const isRemoteKicking = Boolean(
      pos.kicking || (typeof km === 'number' && (km & 16) !== 0)
    );
    renderList.push({
      uid: rp.playerId,
      nickname: rp.nickname,
      jerseyNumber: rp.jerseyNumber,
      team: rp.team,
      x: pos.x + (pos.offsetX || 0),
      y: pos.y + (pos.offsetY || 0),
      kicking: isRemoteKicking,
      pingMs: rp.pingMs ?? 24,
      isMe: false,
    });
  });

  // Add local player on top (white circle turns off the exact frame key is released!)
  renderList.push({
    uid: localProfile.uid,
    nickname: players[localProfile.uid]?.nickname || localProfile.nickname,
    jerseyNumber:
      players[localProfile.uid]?.jerseyNumber || localProfile.jerseyNumber,
    team: localTeam,
    x: phys.myX + (phys.myOffsetX || 0),
    y: phys.myY + (phys.myOffsetY || 0),
    kicking: Boolean(phys.myKicking),
    pingMs: getLocalPingMs(),
    isMe: true,
  });

  for (const pl of renderList) {
    // Subtle Ground Shadow
    ctx.beginPath();
    ctx.arc(pl.x, pl.y + 3, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.fill();

    // Local Player Halo Indicator
    if (pl.isMe) {
      ctx.beginPath();
      ctx.arc(pl.x, pl.y, PLAYER_RADIUS + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Player Disc Fill (Red #DC2626 or Blue #2563EB)
    ctx.beginPath();
    ctx.arc(pl.x, pl.y, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = pl.team === 'red' ? '#dc2626' : '#2563eb';
    ctx.fill();

    // Outer Disc Stroke (Turns bright white immediately while kicking, turns off immediately on release!)
    ctx.lineWidth = pl.kicking ? 4 : 2.5;
    ctx.strokeStyle = pl.kicking
      ? '#ffffff'
      : pl.team === 'red'
        ? '#7f1d1d'
        : '#1e3a8a';
    ctx.stroke();

    // Jersey Number inside disc
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 14px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(pl.jerseyNumber), pl.x, pl.y + 0.5);

    // Player Nickname above disc
    ctx.font = '600 11.5px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const labelY = pl.y - PLAYER_RADIUS - 6;

    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
    ctx.strokeText(pl.nickname, pl.x, labelY);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(pl.nickname, pl.x, labelY);
  }

  // 6. Draw Soccer Ball
  const nowMs = Date.now();
  const heldDurationMs =
    phys.controllingUid !== '' &&
    !phys.powershotMustExitRing &&
    phys.controlStartedAtMs > 0
      ? nowMs - phys.controlStartedAtMs
      : 0;
  const isPowershotCharged =
    heldDurationMs >= POWERSHOT_CHARGE_MS &&
    heldDurationMs <= POWERSHOT_CHARGE_MS + POWERSHOT_WINDOW_MS;

  const renderBallX = phys.ballX + (phys.ballOffsetX || 0);
  const renderBallY = phys.ballY + (phys.ballOffsetY || 0);

  ctx.save();
  // Drop shadow under ball
  ctx.beginPath();
  ctx.arc(renderBallX, renderBallY + 2, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fill();

  // Translate & rotate ball around its center
  ctx.translate(renderBallX, renderBallY);
  ctx.rotate(phys.ballAngle);

  // White spherical backing so the soccer ball is always solid & bright
  ctx.beginPath();
  ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Soccer Ball ⚽ Emoji rendered inside the ball radius
  ctx.font = '18px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚽', 0, 1);

  if (isPowershotCharged) {
    ctx.shadowColor = 'rgba(34, 197, 94, 0.6)';
    ctx.shadowBlur = 5;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#22c55e';
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = '#0f172a';
    ctx.stroke();
  }

  ctx.restore();

  // 7. When the ball is inside either goal mouth, render the top roof net cords over the ball
  if (phys.ballY > GOAL_TOP - 16 && phys.ballY < GOAL_BOTTOM + 16) {
    if (phys.ballX < FIELD_LEFT + BALL_RADIUS) {
      drawDeformableGoalNet(ctx, phys.leftNet, 'left', true);
    } else if (phys.ballX > FIELD_RIGHT - BALL_RADIUS) {
      drawDeformableGoalNet(ctx, phys.rightNet, 'right', true);
    }
  }
}

/**
 * Renders a deformable 2D stadium goal net using the live spring-mass nodes
 */
function drawDeformableGoalNet(
  ctx: CanvasRenderingContext2D,
  nodes: GoalNetNode[],
  side: 'left' | 'right',
  overlayPass = false
) {
  if (nodes.length < NET_TOTAL_NODES) return;

  const lineX = side === 'left' ? FIELD_LEFT : FIELD_RIGHT;
  const stanchionBackX =
    side === 'left' ? FIELD_LEFT - GOAL_DEPTH - 6 : FIELD_RIGHT + GOAL_DEPTH + 6;
  const topCornerNode = nodes[NET_SIDE_SEGMENTS];
  const botCornerNode = nodes[NET_SIDE_SEGMENTS + NET_BACK_SEGMENTS];

  const sampleNetSurface = (u: number, v: number): { x: number; y: number } => {
    const topF = u * NET_SIDE_SEGMENTS;
    const t0 = Math.floor(topF);
    const t1 = Math.min(NET_SIDE_SEGMENTS, t0 + 1);
    const tf = topF - t0;
    const topX = nodes[t0].x * (1 - tf) + nodes[t1].x * tf;
    const topY = nodes[t0].y * (1 - tf) + nodes[t1].y * tf;

    const botF = NET_TOTAL_NODES - 1 - u * NET_SIDE_SEGMENTS;
    const b0 = Math.floor(botF);
    const b1 = Math.max(
      NET_SIDE_SEGMENTS + NET_BACK_SEGMENTS,
      Math.min(NET_TOTAL_NODES - 1, b0 + 1)
    );
    const bf = botF - b0;
    const botX = nodes[b0].x * (1 - bf) + nodes[b1].x * bf;
    const botY = nodes[b0].y * (1 - bf) + nodes[b1].y * bf;

    const backF = NET_SIDE_SEGMENTS + v * NET_BACK_SEGMENTS;
    const k0 = Math.floor(backF);
    const k1 = Math.min(NET_SIDE_SEGMENTS + NET_BACK_SEGMENTS, k0 + 1);
    const kf = backF - k0;
    const backNode = nodes[k0];
    const backNodeNext = nodes[k1];
    const backDx =
      (backNode.x - backNode.restX) * (1 - kf) +
      (backNodeNext.x - backNodeNext.restX) * kf;
    const backDy =
      (backNode.y - backNode.restY) * (1 - kf) +
      (backNodeNext.y - backNodeNext.restY) * kf;

    const depthWeight = Math.pow(u, 1.15);
    const x = topX * (1 - v) + botX * v + backDx * depthWeight;
    const y = topY * (1 - v) + botY * v + backDy * depthWeight * 0.65;
    return { x, y };
  };

  ctx.save();

  if (!overlayPass) {
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(lineX, GOAL_TOP);
    ctx.lineTo(stanchionBackX, GOAL_TOP - 4);
    ctx.moveTo(lineX, GOAL_BOTTOM);
    ctx.lineTo(stanchionBackX, GOAL_BOTTOM + 4);
    ctx.stroke();

    ctx.strokeStyle =
      side === 'left' ? 'rgba(248, 113, 113, 0.65)' : 'rgba(96, 165, 250, 0.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(stanchionBackX, GOAL_TOP - 4);
    ctx.lineTo(topCornerNode.x, topCornerNode.y);
    ctx.moveTo(stanchionBackX, GOAL_BOTTOM + 4);
    ctx.lineTo(botCornerNode.x, botCornerNode.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(nodes[0].x, nodes[0].y);
    for (let i = 1; i < nodes.length; i++) {
      ctx.lineTo(nodes[i].x, nodes[i].y);
    }
    ctx.closePath();
    ctx.fillStyle =
      side === 'left' ? 'rgba(239, 68, 68, 0.14)' : 'rgba(59, 130, 246, 0.14)';
    ctx.fill();
  }

  const uSteps = NET_SIDE_SEGMENTS;
  const vSteps = NET_BACK_SEGMENTS;

  ctx.lineWidth = overlayPass ? 1.15 : 1.1;
  ctx.strokeStyle = overlayPass
    ? 'rgba(255, 255, 255, 0.34)'
    : side === 'left'
      ? 'rgba(254, 202, 202, 0.38)'
      : 'rgba(191, 219, 254, 0.38)';

  ctx.beginPath();
  for (let iu = 1; iu < uSteps; iu++) {
    const u = iu / uSteps;
    for (let iv = 0; iv <= vSteps; iv++) {
      const v = iv / vSteps;
      const pt = sampleNetSurface(u, v);
      if (iv === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
  }
  for (let iv = 1; iv < vSteps; iv++) {
    const v = iv / vSteps;
    for (let iu = 0; iu <= uSteps; iu++) {
      const u = iu / uSteps;
      const pt = sampleNetSurface(u, v);
      if (iu === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(nodes[0].x, nodes[0].y);
  for (let i = 1; i < nodes.length; i++) {
    ctx.lineTo(nodes[i].x, nodes[i].y);
  }
  ctx.lineWidth = overlayPass ? 2.2 : 3.2;
  ctx.strokeStyle =
    side === 'left'
      ? overlayPass
        ? 'rgba(252, 165, 165, 0.7)'
        : '#fca5a5'
      : overlayPass
        ? 'rgba(147, 197, 253, 0.7)'
        : '#93c5fd';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.restore();
}
