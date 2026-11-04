import React, { useEffect, useRef, useState } from 'react';
import { LogOut, RotateCcw, Shield, Trophy, Volume2, VolumeX } from 'lucide-react';
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
  GOAL_DEPTH,
  GOAL_PAUSE_MS,
  GOAL_TOP,
  KICK_IMPULSE,
  KICK_RANGE,
  MATCH_DURATION_MS,
  MATCH_DURATION_SEC,
  OUT_PAUSE_MS,
  PLAYER_ACCEL,
  PLAYER_DAMPING,
  PLAYER_KICK_ACCEL,
  PLAYER_MAX_SPEED,
  PLAYER_RADIUS,
  PlayerProfile,
  POST_RADIUS,
  POWERSHOT_CHARGE_MS,
  POWERSHOT_IMPULSE,
  POWERSHOT_WINDOW_MS,
  MatchRoomDoc,
  RoomPlayerDoc,
  TeamColor,
} from '../types/game';
import {
  finishMatchRoom,
  registerGoalInNet,
  resetFormationAfterGoalDelay,
  syncLocalPlayerDisc,
  syncRoomGameplayState,
} from '../services/roomService';
import { soundFX } from '../utils/sound';

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
  fixed: boolean;
  anchorK: number;
}

interface LocalPhysicsState {
  myX: number;
  myY: number;
  myVx: number;
  myVy: number;
  myKicking: boolean;
  ballX: number;
  ballY: number;
  ballVx: number;
  ballVy: number;
  ballAngle: number;
  lastTouchTeam: EventTeam;
  eventState: EventState;
  eventTeam: EventTeam;
  eventUntilMs: number;
  awaitingSetPieceTouch: boolean;
  isCornerSetPiece: boolean;
  setPieceExpireMs: number;
  lastNetSwishMs: number;
  controllingUid: string;
  controlStartedAtMs: number;
  powershotMustExitRing: boolean;
  powershotFlightUntilMs: number;
  leftNet: GoalNetNode[];
  rightNet: GoalNetNode[];
  remoteRenderPos: Record<string, { x: number; y: number }>;
}

const NET_SIDE_SEGMENTS = 6;
const NET_BACK_SEGMENTS = 14;
const NET_TOTAL_NODES = NET_SIDE_SEGMENTS * 2 + NET_BACK_SEGMENTS + 1; // 27 nodes (0..26)
const MAX_NET_STRETCH = 38;

function createGoalNetNodes(side: 'left' | 'right'): GoalNetNode[] {
  const lineX = side === 'left' ? FIELD_LEFT : FIELD_RIGHT;
  const backX = side === 'left' ? FIELD_LEFT - GOAL_DEPTH : FIELD_RIGHT + GOAL_DEPTH;
  const nodes: GoalNetNode[] = [];

  // 1. Top side net: from top goalpost (0) to back-top corner (NET_SIDE_SEGMENTS)
  for (let i = 0; i < NET_SIDE_SEGMENTS; i++) {
    const t = i / NET_SIDE_SEGMENTS;
    const rx = lineX + (backX - lineX) * t;
    const ry = GOAL_TOP;
    nodes.push({
      x: rx,
      y: ry,
      vx: 0,
      vy: 0,
      restX: rx,
      restY: ry,
      fixed: i === 0,
      anchorK: 0.012,
    });
  }

  // 2. Back net: from back-top corner (6) to back-bottom corner (20)
  for (let i = 0; i <= NET_BACK_SEGMENTS; i++) {
    const t = i / NET_BACK_SEGMENTS;
    const rx = backX;
    const ry = GOAL_TOP + (GOAL_BOTTOM - GOAL_TOP) * t;
    const isCorner = i === 0 || i === NET_BACK_SEGMENTS;
    nodes.push({
      x: rx,
      y: ry,
      vx: 0,
      vy: 0,
      restX: rx,
      restY: ry,
      fixed: false,
      anchorK: isCorner ? 0.032 : 0.01,
    });
  }

  // 3. Bottom side net: from back-bottom corner (21..26) to bottom goalpost (26)
  for (let i = 1; i <= NET_SIDE_SEGMENTS; i++) {
    const t = i / NET_SIDE_SEGMENTS;
    const rx = backX + (lineX - backX) * t;
    const ry = GOAL_BOTTOM;
    nodes.push({
      x: rx,
      y: ry,
      vx: 0,
      vy: 0,
      restX: rx,
      restY: ry,
      fixed: i === NET_SIDE_SEGMENTS,
      anchorK: 0.012,
    });
  }

  return nodes;
}

function stepGoalNetSprings(nodes: GoalNetNode[]) {
  const count = nodes.length;
  // Soft, viscous, slow-returning springs ("melted cheese" stretch -> gentle glide back)
  const neighborK = 0.11;
  const damping = 0.82;

  // Compute structural neighbor rope forces
  for (let i = 0; i < count - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const restDx = b.restX - a.restX;
    const restDy = b.restY - a.restY;
    const restLen = Math.hypot(restDx, restDy);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.0001) {
      const diff = (dist - restLen) / dist;
      const fx = dx * diff * neighborK;
      const fy = dy * diff * neighborK;
      if (!a.fixed) {
        a.vx += fx;
        a.vy += fy;
      }
      if (!b.fixed) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }
  }

  // Apply gentle anchor restoring tension & integrate positions
  for (let i = 0; i < count; i++) {
    const n = nodes[i];
    if (n.fixed) {
      n.x = n.restX;
      n.y = n.restY;
      n.vx = 0;
      n.vy = 0;
      continue;
    }

    const adx = n.restX - n.x;
    const ady = n.restY - n.y;
    n.vx = (n.vx + adx * n.anchorK) * damping;
    n.vy = (n.vy + ady * n.anchorK) * damping;
    n.x += n.vx;
    n.y += n.vy;

    // Clamp max stretch so the net never tears
    const stretch = Math.hypot(n.x - n.restX, n.y - n.restY);
    if (stretch > MAX_NET_STRETCH) {
      const scale = MAX_NET_STRETCH / stretch;
      n.x = n.restX + (n.x - n.restX) * scale;
      n.y = n.restY + (n.y - n.restY) * scale;
      n.vx *= 0.3;
      n.vy *= 0.3;
    }
  }
}

function moldNetPocketAroundBall(
  nodes: GoalNetNode[],
  centerIdxFloat: number,
  targetX: number,
  targetY: number,
  velX: number,
  velY: number
) {
  const spreadRadius = 5.8;
  for (let i = 1; i < nodes.length - 1; i++) {
    const n = nodes[i];
    if (n.fixed) continue;
    const dIdx = Math.abs(i - centerIdxFloat);
    if (dIdx > spreadRadius) continue;
    // Wide, smooth bell curve so the net stretches like warm melted cheese around the ball
    const weight = Math.exp(-(dIdx * dIdx) / 5.4);
    const desiredX = n.restX + (targetX - n.restX) * weight;
    const desiredY = n.restY + (targetY - n.restY) * weight;
    // Smoothly pull node toward the stretched pocket shape
    n.x += (desiredX - n.x) * (0.55 * weight);
    n.y += (desiredY - n.y) * (0.55 * weight);
    n.vx = n.vx * (1 - 0.35 * weight) + velX * 0.28 * weight;
    n.vy = n.vy * (1 - 0.35 * weight) + velY * 0.28 * weight;
  }
}

function collideBallWithGoalNet(
  p: LocalPhysicsState,
  side: 'left' | 'right',
  now: number,
  soundEnabled: boolean
) {
  const nodes = side === 'left' ? p.leftNet : p.rightNet;
  const lineX = side === 'left' ? FIELD_LEFT : FIELD_RIGHT;
  const backRestX = side === 'left' ? FIELD_LEFT - GOAL_DEPTH : FIELD_RIGHT + GOAL_DEPTH;

  // Quick bounding box check around goal
  if (side === 'left' && p.ballX - BALL_RADIUS > lineX + 16) return;
  if (side === 'right' && p.ballX + BALL_RADIUS < lineX - 16) return;
  if (p.ballY + BALL_RADIUS < GOAL_TOP - 44 || p.ballY - BALL_RADIUS > GOAL_BOTTOM + 44) {
    return;
  }

  const inGoalX =
    side === 'left'
      ? p.ballX <= lineX + BALL_RADIUS * 0.4
      : p.ballX >= lineX - BALL_RADIUS * 0.4;
  const inGoalMouthY = p.ballY >= GOAL_TOP - 12 && p.ballY <= GOAL_BOTTOM + 12;

  let strongestImpactSpeed = 0;
  let contactedNet = false;

  // 1. Viscous, stretchy pocket inside goal mouth:
  // Instead of stopping the ball at the rest line, the ball pulls the net deeply outward with it
  // while viscous drag gradually slows the ball down, and then the net gently glides back!
  if (inGoalX && inGoalMouthY) {
    // Check back net stretch
    const backIdx =
      NET_SIDE_SEGMENTS +
      Math.max(
        0,
        Math.min(
          NET_BACK_SEGMENTS,
          ((p.ballY - GOAL_TOP) / (GOAL_BOTTOM - GOAL_TOP)) * NET_BACK_SEGMENTS
        )
      );

    if (side === 'left' && p.ballX - BALL_RADIUS < backRestX) {
      const stretchDist = Math.min(
        MAX_NET_STRETCH,
        backRestX - (p.ballX - BALL_RADIUS)
      );
      const targetNetX = backRestX - stretchDist;
      const targetNetY =
        GOAL_TOP +
        ((backIdx - NET_SIDE_SEGMENTS) / NET_BACK_SEGMENTS) *
          (GOAL_BOTTOM - GOAL_TOP) +
        p.ballVy * 1.4;

      moldNetPocketAroundBall(
        nodes,
        backIdx,
        targetNetX,
        targetNetY,
        p.ballVx,
        p.ballVy
      );

      // Clamp only at the absolute maximum stretch limit
      const minAllowedBallX = backRestX - MAX_NET_STRETCH + BALL_RADIUS;
      if (p.ballX < minAllowedBallX) {
        p.ballX = minAllowedBallX;
        if (p.ballVx < 0) p.ballVx *= -0.08;
      }

      if (p.ballVx < 0) {
        strongestImpactSpeed = Math.max(strongestImpactSpeed, -p.ballVx);
        // Viscous "melted-cheese" drag: slows the ball smoothly over many frames as it stretches the net
        p.ballVx *= 0.86;
        p.ballVy *= 0.9;
      }
      // Gentle elastic pull back toward the goal interior as the stretched pocket contracts
      p.ballVx += stretchDist * 0.0085;
      p.ballVy *= 0.94;
      contactedNet = true;
    } else if (side === 'right' && p.ballX + BALL_RADIUS > backRestX) {
      const stretchDist = Math.min(
        MAX_NET_STRETCH,
        p.ballX + BALL_RADIUS - backRestX
      );
      const targetNetX = backRestX + stretchDist;
      const targetNetY =
        GOAL_TOP +
        ((backIdx - NET_SIDE_SEGMENTS) / NET_BACK_SEGMENTS) *
          (GOAL_BOTTOM - GOAL_TOP) +
        p.ballVy * 1.4;

      moldNetPocketAroundBall(
        nodes,
        backIdx,
        targetNetX,
        targetNetY,
        p.ballVx,
        p.ballVy
      );

      const maxAllowedBallX = backRestX + MAX_NET_STRETCH - BALL_RADIUS;
      if (p.ballX > maxAllowedBallX) {
        p.ballX = maxAllowedBallX;
        if (p.ballVx > 0) p.ballVx *= -0.08;
      }

      if (p.ballVx > 0) {
        strongestImpactSpeed = Math.max(strongestImpactSpeed, p.ballVx);
        // Viscous "melted-cheese" drag: slows the ball smoothly over many frames as it stretches the net
        p.ballVx *= 0.86;
        p.ballVy *= 0.9;
      }
      // Gentle elastic pull back toward the goal interior as the stretched pocket contracts
      p.ballVx -= stretchDist * 0.0085;
      p.ballVy *= 0.94;
      contactedNet = true;
    }

    // Check Top side net stretch inside goal
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

    // Check Bottom side net stretch inside goal
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
    // 2. Outside-of-goal side/back net contact (e.g. ball hitting side netting from outside)
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

  const physRef = useRef<LocalPhysicsState>({
    myX: players[profile.uid]?.x ?? initialSpawn.x,
    myY: players[profile.uid]?.y ?? initialSpawn.y,
    myVx: 0,
    myVy: 0,
    myKicking: false,
    ballX: room.ballX ?? FIELD_CENTER_X,
    ballY: room.ballY ?? FIELD_CENTER_Y,
    ballVx: room.ballVx ?? 0,
    ballVy: room.ballVy ?? 0,
    ballAngle: 0,
    lastTouchTeam: room.lastTouchTeam ?? 'none',
    eventState: room.eventState ?? 'normal',
    eventTeam: room.eventTeam ?? 'none',
    eventUntilMs: room.eventUntilMs ?? 0,
    awaitingSetPieceTouch: false,
    isCornerSetPiece: false,
    setPieceExpireMs: 0,
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
  const remoteBallGraceUntilMsRef = useRef<number>(0);
  const lastHandledEventUntilRef = useRef<number>(0);
  const finishTriggeredRef = useRef<boolean>(false);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  // Keep refs updated with incoming snapshots while protecting active 3-second post-goal cooldown
  useEffect(() => {
    const now = Date.now();
    const prevEventState = roomRef.current.eventState;
    const p = physRef.current;

    // If local physics is currently inside the 3-second post-goal celebration window,
    // do NOT allow a slightly older in-flight network poll to prematurely reset to formation!
    if (p.eventState === 'goal' && now < p.eventUntilMs - 100) {
      roomRef.current = {
        ...room,
        redScore: Math.max(roomRef.current.redScore, room.redScore),
        blueScore: Math.max(roomRef.current.blueScore, room.blueScore),
        eventState: 'goal',
        eventTeam: p.eventTeam,
        eventUntilMs: p.eventUntilMs,
      };
      return;
    }

    roomRef.current = room;

    // When a new goal, out, or corner event arrives from network
    if (
      room.eventState !== 'normal' &&
      room.eventUntilMs !== lastHandledEventUntilRef.current &&
      room.eventUntilMs > now - 500
    ) {
      lastHandledEventUntilRef.current = room.eventUntilMs;
      p.eventState = room.eventState;
      p.eventTeam = room.eventTeam;
      p.eventUntilMs = room.eventUntilMs;
      p.ballX = room.ballX;
      p.ballY = room.ballY;
      p.ballVx = room.ballVx;
      p.ballVy = room.ballVy;

      if (room.eventState === 'goal') {
        p.awaitingSetPieceTouch = false;
        p.isCornerSetPiece = false;
        if (soundEnabledRef.current && prevEventState !== 'goal') {
          soundFX.playGoalFanfare();
        }
      } else if (room.eventState === 'out' || room.eventState === 'corner') {
        p.awaitingSetPieceTouch = true;
        p.isCornerSetPiece = room.eventState === 'corner';
        p.setPieceExpireMs = room.eventUntilMs + 4500;
        if (soundEnabledRef.current && prevEventState !== room.eventState) {
          soundFX.playOutWhistle();
        }
      }
    } else if (
      prevEventState === 'goal' &&
      room.eventState === 'normal' &&
      p.eventState === 'goal' &&
      now >= p.eventUntilMs - 100
    ) {
      // Network triggered 3-second post-goal reset to formation after full 3s cooldown
      p.eventState = 'normal';
      p.eventTeam = 'none';
      p.eventUntilMs = 0;
      p.ballX = FIELD_CENTER_X;
      p.ballY = FIELD_CENTER_Y;
      p.ballVx = 0;
      p.ballVy = 0;
      const team: TeamColor = room.blueUids.includes(profile.uid) ? 'blue' : 'red';
      const idx = Math.max(
        0,
        team === 'red'
          ? room.redUids.indexOf(profile.uid)
          : room.blueUids.indexOf(profile.uid)
      );
      const spawn = getTeamSpawnPosition(team, idx);
      p.myX = spawn.x;
      p.myY = spawn.y;
      p.myVx = 0;
      p.myVy = 0;
    } else {
      const incomingActorUid = (room as MatchRoomDoc & { actorUid?: string }).actorUid;
      const isFromOtherPlayer = Boolean(
        incomingActorUid && incomingActorUid !== profile.uid
      );
      const recentlyTouchedLocally = now - lastLocalBallTouchMsRef.current < 150;

      if (isFromOtherPlayer) {
        remoteBallGraceUntilMsRef.current = now + 160;
      }

      if (
        !recentlyTouchedLocally &&
        (room.hostUid !== profile.uid || isFromOtherPlayer)
      ) {
        // Smoothly reconcile ball coordinates and velocity across all clients
        const dist = Math.hypot(room.ballX - p.ballX, room.ballY - p.ballY);
        if (dist > 44 || room.eventState !== 'normal' || isFromOtherPlayer) {
          p.ballX = room.ballX;
          p.ballY = room.ballY;
        } else {
          p.ballX += (room.ballX - p.ballX) * 0.42;
          p.ballY += (room.ballY - p.ballY) * 0.42;
        }
        p.ballVx = room.ballVx;
        p.ballVy = room.ballVy;
        p.lastTouchTeam = room.lastTouchTeam;
      }
    }
  }, [room, profile.uid]);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  // Match 5-Minute Forward Timer & Auto-Finish Check
  useEffect(() => {
    const updateTimer = () => {
      const currentRoom = roomRef.current;
      if (currentRoom.status === 'finished') {
        setElapsedSeconds(MATCH_DURATION_SEC);
        return;
      }
      if (!currentRoom.matchStartedAtMs) {
        setElapsedSeconds(0);
        return;
      }
      const elapsedMs = Math.max(0, Date.now() - currentRoom.matchStartedAtMs);
      const sec = Math.min(MATCH_DURATION_SEC, Math.floor(elapsedMs / 1000));
      setElapsedSeconds(sec);

      if (elapsedMs >= MATCH_DURATION_MS && !finishTriggeredRef.current) {
        finishTriggeredRef.current = true;
        if (soundEnabledRef.current) {
          soundFX.playMatchEndWhistle();
        }
        finishMatchRoom(currentRoom, profile.uid).catch(() => {});
      }
    };

    updateTimer();
    const interval = window.setInterval(updateTimer, 200);
    return () => window.clearInterval(interval);
  }, []);

  // Keyboard Listeners (WASD + Arrow Keys + Space/X Kick)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Main 60FPS HTML5 Canvas Physics & Rendering Loop
  useEffect(() => {
    let animationFrameId: number;
    let lastPerfTime = performance.now();

    const stepPhysicsAndRender = () => {
      const perfNow = performance.now();
      const rawDtMs = Math.max(4, Math.min(34, perfNow - lastPerfTime));
      lastPerfTime = perfNow;
      // Normalize physics to 60Hz so 120Hz/144Hz monitors don't double player/ball speed
      const dtScale = rawDtMs / (1000 / 60);

      const now = Date.now();
      const currentRoom = roomRef.current;
      const allPlayers = playersRef.current;
      const p = physRef.current;
      const isMatchFinished =
        currentRoom.status === 'finished' ||
        (currentRoom.matchStartedAtMs > 0 &&
          now - currentRoom.matchStartedAtMs >= MATCH_DURATION_MS);

      const localTeam: TeamColor = currentRoom.blueUids.includes(profile.uid)
        ? 'blue'
        : 'red';
      const localSlotIdx = Math.max(
        0,
        localTeam === 'red'
          ? currentRoom.redUids.indexOf(profile.uid)
          : currentRoom.blueUids.indexOf(profile.uid)
      );

      // Handle expiration of Out/Corner short placement pause OR 3-second Post-Goal formation reset
      if (p.eventState !== 'normal' && now >= p.eventUntilMs) {
        const finishedEvent = p.eventState;
        p.eventState = 'normal';
        p.eventUntilMs = 0;

        if (finishedEvent === 'goal') {
          // 3 seconds after goal: reset ball to center and reset players to starting formation
          p.ballX = FIELD_CENTER_X;
          p.ballY = FIELD_CENTER_Y;
          p.ballVx = 0;
          p.ballVy = 0;
          p.eventTeam = 'none';
          p.awaitingSetPieceTouch = false;
          p.isCornerSetPiece = false;

          const spawn = getTeamSpawnPosition(localTeam, localSlotIdx);
          p.myX = spawn.x;
          p.myY = spawn.y;
          p.myVx = 0;
          p.myVy = 0;

          resetFormationAfterGoalDelay(currentRoom, allPlayers, profile.uid).catch(
            () => {}
          );
        }
      }

      const isPausedForOutOrCorner =
        (p.eventState === 'out' || p.eventState === 'corner') &&
        now < p.eventUntilMs;

      if (p.awaitingSetPieceTouch && now > p.setPieceExpireMs) {
        p.awaitingSetPieceTouch = false;
        p.isCornerSetPiece = false;
      }

      // 1. Update Local Player Disc Movement (smooth acceleration + football turf glide)
      let localMovedOrChanged = false;
      if (!isMatchFinished && !isPausedForOutOrCorner) {
        const k = keysRef.current;
        let ax = 0;
        let ay = 0;
        if (k.left) ax -= 1;
        if (k.right) ax += 1;
        if (k.up) ay -= 1;
        if (k.down) ay += 1;

        if (ax !== 0 && ay !== 0) {
          const inv = 1 / Math.SQRT2;
          ax *= inv;
          ay *= inv;
        }

        const accel = k.kick ? PLAYER_KICK_ACCEL : PLAYER_ACCEL;
        const playerDamp = Math.pow(PLAYER_DAMPING, dtScale);
        p.myVx = (p.myVx + ax * accel * dtScale) * playerDamp;
        p.myVy = (p.myVy + ay * accel * dtScale) * playerDamp;

        const speed = Math.hypot(p.myVx, p.myVy);
        if (speed > PLAYER_MAX_SPEED) {
          p.myVx = (p.myVx / speed) * PLAYER_MAX_SPEED;
          p.myVy = (p.myVy / speed) * PLAYER_MAX_SPEED;
        }
        // Subtle football turf glide: allow natural deceleration down to 0.012 before stopping
        if (speed < 0.012 && ax === 0 && ay === 0) {
          p.myVx = 0;
          p.myVy = 0;
        }

        p.myX += p.myVx * dtScale;
        p.myY += p.myVy * dtScale;

        // Keep player within outer arena walls
        p.myX = Math.max(PLAYER_RADIUS + 12, Math.min(CANVAS_WIDTH - PLAYER_RADIUS - 12, p.myX));
        p.myY = Math.max(PLAYER_RADIUS + 12, Math.min(CANVAS_HEIGHT - PLAYER_RADIUS - 12, p.myY));

        // Solid Goalpost Hitboxes for Player Disc (Player cannot pass through goalposts)
        for (const post of GOALPOSTS) {
          const dxPost = p.myX - post.x;
          const dyPost = p.myY - post.y;
          const distPost = Math.hypot(dxPost, dyPost);
          const minPostDist = PLAYER_RADIUS + POST_RADIUS;
          if (distPost < minPostDist && distPost > 0.001) {
            const nx = dxPost / distPost;
            const ny = dyPost / distPost;
            p.myX = post.x + nx * minPostDist;
            p.myY = post.y + ny * minPostDist;
            const dot = p.myVx * nx + p.myVy * ny;
            if (dot < 0) {
              p.myVx -= dot * nx * 1.15;
              p.myVy -= dot * ny * 1.15;
            }
          }
        }

        // During Set Piece (Throw-In / Corner): keep opposing team outside 74px radius
        const setPieceTeamHasPlayers =
          p.eventTeam === 'red'
            ? currentRoom.redUids.length > 0
            : p.eventTeam === 'blue'
              ? currentRoom.blueUids.length > 0
              : false;

        if (
          p.awaitingSetPieceTouch &&
          setPieceTeamHasPlayers &&
          p.eventTeam !== 'none' &&
          localTeam !== p.eventTeam
        ) {
          const dxBall = p.myX - p.ballX;
          const dyBall = p.myY - p.ballY;
          const distBall = Math.hypot(dxBall, dyBall);
          const minThrowInDist = 74;
          if (distBall < minThrowInDist && distBall > 0.001) {
            const nx = dxBall / distBall;
            const ny = dyBall / distBall;
            p.myX = p.ballX + nx * minThrowInDist;
            p.myY = p.ballY + ny * minThrowInDist;
          }
        }

        if (
          Math.abs(p.myVx) > 0.015 ||
          Math.abs(p.myVy) > 0.015 ||
          p.myKicking !== k.kick
        ) {
          localMovedOrChanged = true;
        }
        p.myKicking = k.kick;
      } else {
        p.myVx = 0;
        p.myVy = 0;
        p.myKicking = false;
      }

      // Interpolate remote players smoothly at 60fps
      Object.values(allPlayers).forEach((rp) => {
        if (rp.playerId === profile.uid) return;
        const prev = p.remoteRenderPos[rp.playerId];
        if (!prev) {
          p.remoteRenderPos[rp.playerId] = { x: rp.x, y: rp.y };
        } else {
          const d = Math.hypot(rp.x - prev.x, rp.y - prev.y);
          if (d > 90) {
            prev.x = rp.x;
            prev.y = rp.y;
          } else {
            prev.x += (rp.x - prev.x) * 0.32;
            prev.y += (rp.y - prev.y) * 0.32;
          }
        }
      });

      // 2. Ball & Disc Collision + Kick + Real 2D Goal Net Physics
      let localTouchedBall = false;
      if (!isMatchFinished && !isPausedForOutOrCorner) {
        // Players can collide with and kick the ball both during normal play AND during the 3-second post-goal celebration!
        if (p.eventState === 'normal' || p.eventState === 'goal') {
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
            const interp = p.remoteRenderPos[rp.playerId] || { x: rp.x, y: rp.y };
            activeDiscs.push({
              uid: rp.playerId,
              team: rp.team,
              x: interp.x,
              y: interp.y,
              vx: rp.vx || 0,
              vy: rp.vy || 0,
              kicking: rp.kicking || false,
            });
          });

          // Gray circle radius around player disc (PLAYER_RADIUS + 5 + BALL_RADIUS + tolerance = KICK_RANGE)
          const grayCircleHoldDist = KICK_RANGE;

          // Determine which player (if any) currently holds the ball on/inside their gray circle
          let holderUid = '';
          let closestGrayDist = Infinity;
          for (const disc of activeDiscs) {
            const d = Math.hypot(p.ballX - disc.x, p.ballY - disc.y);
            if (d <= grayCircleHoldDist && d < closestGrayDist) {
              closestGrayDist = d;
              holderUid = disc.uid;
            }
          }

          if (holderUid === '') {
            // Ball left the gray circle! Reset lock so the player can hold it for 5s again
            p.controllingUid = '';
            p.controlStartedAtMs = 0;
            p.powershotMustExitRing = false;
          } else if (p.controllingUid !== holderUid) {
            // Ball entered a player's gray circle: start the 5-second hold timer
            p.controllingUid = holderUid;
            p.controlStartedAtMs = now;
            p.powershotMustExitRing = false;
          } else if (!p.powershotMustExitRing && p.controlStartedAtMs > 0) {
            // Same player is still holding the ball in their gray circle:
            // Check if the 5s charge + 2.5s active window (7.5s total) has expired without a kick
            const heldMs = now - p.controlStartedAtMs;
            if (heldMs > POWERSHOT_CHARGE_MS + POWERSHOT_WINDOW_MS) {
              // 2.5s window expired! Powershot disappears and player MUST remove ball from gray circle to recharge
              p.powershotMustExitRing = true;
              p.controlStartedAtMs = 0;
            }
          }

          for (const disc of activeDiscs) {
            const dx = p.ballX - disc.x;
            const dy = p.ballY - disc.y;
            const dist = Math.hypot(dx, dy);
            const minDist = PLAYER_RADIUS + BALL_RADIUS;

            // Active Kick (Space / X):
            // Powershot is only active during the 2.5s window after 5s of holding the ball in the gray circle
            if (disc.kicking && dist < KICK_RANGE && dist > 0.001) {
              const nx = dx / dist;
              const ny = dy / dist;
              const heldMs =
                p.controllingUid === disc.uid &&
                !p.powershotMustExitRing &&
                p.controlStartedAtMs > 0
                  ? now - p.controlStartedAtMs
                  : 0;
              const hasChargedPowershot =
                heldMs >= POWERSHOT_CHARGE_MS &&
                heldMs <= POWERSHOT_CHARGE_MS + POWERSHOT_WINDOW_MS;

              const impulse = hasChargedPowershot
                ? POWERSHOT_IMPULSE
                : p.isCornerSetPiece
                  ? CORNER_KICK_IMPULSE
                  : KICK_IMPULSE;

              p.ballVx = nx * impulse + disc.vx * 0.38;
              p.ballVy = ny * impulse + disc.vy * 0.38;
              p.lastTouchTeam = disc.team;
              p.awaitingSetPieceTouch = false;
              p.isCornerSetPiece = false;

              if (hasChargedPowershot) {
                // Immediately turn off the Powershot color as soon as the player kicks
                p.powershotFlightUntilMs = 0;
                p.powershotMustExitRing = true;
                p.controlStartedAtMs = 0;
              }

              if (disc.uid === profile.uid) {
                localTouchedBall = true;
                if (soundEnabledRef.current) {
                  if (hasChargedPowershot) {
                    soundFX.playPowerShot();
                  } else {
                    soundFX.playKick();
                  }
                }
              }
            }

            // Pure 2D Normal Circle Collision (Independent ball physics, zero sideways sticking, no kick sound on touch)
            if (dist < minDist && dist > 0.001 && !disc.kicking) {
              const nx = dx / dist;
              const ny = dy / dist;
              const overlap = minDist - dist;

              p.ballX += nx * overlap * 0.88;
              p.ballY += ny * overlap * 0.88;
              if (disc.uid === profile.uid) {
                p.myX -= nx * overlap * 0.12;
                p.myY -= ny * overlap * 0.12;
              }

              const relVx = p.ballVx - disc.vx;
              const relVy = p.ballVy - disc.vy;
              const normalVel = relVx * nx + relVy * ny;

              if (normalVel < 0) {
                // Pure normal-only impulse with soft restitution (0.12):
                // Ball has its own independent 2D physics and never sticks sideways when turning left/right
                const restitution = 0.12;
                const impulse = -(1 + restitution) * normalVel;
                p.ballVx += impulse * nx;
                p.ballVy += impulse * ny;
              }

              p.lastTouchTeam = disc.team;
              p.awaitingSetPieceTouch = false;
              p.isCornerSetPiece = false;

              if (disc.uid === profile.uid) {
                localTouchedBall = true;
              }
            }
          }
        } else {
          p.controllingUid = '';
          p.controlStartedAtMs = 0;
          p.powershotMustExitRing = false;
        }

        // Sub-stepped Ball Movement + Goal Line Detection + Elastic Spring-Mesh Goal Net Physics
        const isAuthority =
          currentRoom.hostUid === profile.uid || localTouchedBall;
        const subSteps = 2;
        for (let step = 0; step < subSteps; step++) {
          p.ballX += (p.ballVx * dtScale) / subSteps;
          p.ballY += (p.ballVy * dtScale) / subSteps;

          // Goalpost Circle Collisions
          for (const post of GOALPOSTS) {
            const dx = p.ballX - post.x;
            const dy = p.ballY - post.y;
            const dist = Math.hypot(dx, dy);
            const minDist = BALL_RADIUS + POST_RADIUS;
            if (dist < minDist && dist > 0.001) {
              const nx = dx / dist;
              const ny = dy / dist;
              p.ballX = post.x + nx * minDist;
              p.ballY = post.y + ny * minDist;
              const dot = p.ballVx * nx + p.ballVy * ny;
              if (dot < 0) {
                p.ballVx = (p.ballVx - 2 * dot * nx) * 0.82;
                p.ballVy = (p.ballVy - 2 * dot * ny) * 0.82;
                if (soundEnabledRef.current) {
                  soundFX.playPostHit();
                }
              }
            }
          }

          // 3. Check for GOAL inside each sub-step BEFORE net rebound so goals are always counted!
          if (p.eventState === 'normal') {
            const inGoalY = p.ballY > GOAL_TOP && p.ballY < GOAL_BOTTOM;
            if (inGoalY && p.ballX + BALL_RADIUS * 0.6 < FIELD_LEFT) {
              // Blue scores in Red's left goal!
              const newBlueScore = roomRef.current.blueScore + 1;
              const pauseUntil = now + GOAL_PAUSE_MS;
              p.eventState = 'goal';
              p.eventTeam = 'blue';
              p.eventUntilMs = pauseUntil;
              lastHandledEventUntilRef.current = pauseUntil;
              p.awaitingSetPieceTouch = false;
              p.isCornerSetPiece = false;
              p.controllingUid = '';
              p.controlStartedAtMs = 0;
              p.powershotFlightUntilMs = 0;

              roomRef.current = {
                ...roomRef.current,
                blueScore: newBlueScore,
                eventState: 'goal',
                eventTeam: 'blue',
                eventUntilMs: pauseUntil,
              };

              if (soundEnabledRef.current) {
                soundFX.playGoalFanfare();
              }
              if (isAuthority) {
                registerGoalInNet(
                  roomRef.current,
                  'blue',
                  roomRef.current.redScore,
                  newBlueScore,
                  pauseUntil,
                  { x: p.ballX, y: p.ballY, vx: p.ballVx, vy: p.ballVy }
                ).catch(() => {});
              }
            } else if (inGoalY && p.ballX - BALL_RADIUS * 0.6 > FIELD_RIGHT) {
              // Red scores in Blue's right goal!
              const newRedScore = roomRef.current.redScore + 1;
              const pauseUntil = now + GOAL_PAUSE_MS;
              p.eventState = 'goal';
              p.eventTeam = 'red';
              p.eventUntilMs = pauseUntil;
              lastHandledEventUntilRef.current = pauseUntil;
              p.awaitingSetPieceTouch = false;
              p.isCornerSetPiece = false;
              p.controllingUid = '';
              p.controlStartedAtMs = 0;
              p.powershotFlightUntilMs = 0;

              roomRef.current = {
                ...roomRef.current,
                redScore: newRedScore,
                eventState: 'goal',
                eventTeam: 'red',
                eventUntilMs: pauseUntil,
              };

              if (soundEnabledRef.current) {
                soundFX.playGoalFanfare();
              }
              if (isAuthority) {
                registerGoalInNet(
                  roomRef.current,
                  'red',
                  newRedScore,
                  roomRef.current.blueScore,
                  pauseUntil,
                  { x: p.ballX, y: p.ballY, vx: p.ballVx, vy: p.ballVy }
                ).catch(() => {});
              }
            }
          }

          // Collide Ball with Left & Right Elastic Goal Nets
          collideBallWithGoalNet(p, 'left', now, soundEnabledRef.current);
          collideBallWithGoalNet(p, 'right', now, soundEnabledRef.current);

          // Step Spring-Mass Goal Net Nodes
          stepGoalNetSprings(p.leftNet);
          stepGoalNetSprings(p.rightNet);
        }

        // Apply natural turf/air damping (identical on pitch and inside goal mouth)
        const ballDamp = Math.pow(BALL_DAMPING, dtScale);
        p.ballVx *= ballDamp;
        p.ballVy *= ballDamp;

        const bSpeed = Math.hypot(p.ballVx, p.ballVy);
        if (bSpeed > BALL_MAX_SPEED) {
          p.ballVx = (p.ballVx / bSpeed) * BALL_MAX_SPEED;
          p.ballVy = (p.ballVy / bSpeed) * BALL_MAX_SPEED;
        }
        if (bSpeed < 0.03) {
          p.ballVx = 0;
          p.ballVy = 0;
        } else {
          p.ballAngle += bSpeed * 0.08 * dtScale * (p.ballVx >= 0 ? 1 : -1);
        }

        // During the 3-second post-goal window, the ball is free to rebound or be kicked out of the goal!
        // Keep it inside the outer stadium perimeter so it stays in the arena until the 3s reset.
        if (p.eventState === 'goal') {
          if (p.ballX - BALL_RADIUS < 3) {
            p.ballX = 3 + BALL_RADIUS;
            p.ballVx = Math.abs(p.ballVx) * 0.15;
          } else if (p.ballX + BALL_RADIUS > CANVAS_WIDTH - 3) {
            p.ballX = CANVAS_WIDTH - 3 - BALL_RADIUS;
            p.ballVx = -Math.abs(p.ballVx) * 0.15;
          }
          if (p.ballY - BALL_RADIUS < 12) {
            p.ballY = 12 + BALL_RADIUS;
            p.ballVy = Math.abs(p.ballVy) * 0.45;
          } else if (p.ballY + BALL_RADIUS > CANVAS_HEIGHT - 12) {
            p.ballY = CANVAS_HEIGHT - 12 - BALL_RADIUS;
            p.ballVy = -Math.abs(p.ballVy) * 0.45;
          }
        }

        if (p.eventState === 'normal') {
          const inGoalY = p.ballY > GOAL_TOP && p.ballY < GOAL_BOTTOM;

          // 4. Check for CORNER (Угловой: мяч пересекает лицевую линию у ворот мимо створа)
          const crossedLeftGoalLineOut =
            !inGoalY && p.ballX + BALL_RADIUS < FIELD_LEFT;
          const crossedRightGoalLineOut =
            !inGoalY && p.ballX - BALL_RADIUS > FIELD_RIGHT;

          if (
            p.eventState === 'normal' &&
            (crossedLeftGoalLineOut || crossedRightGoalLineOut)
          ) {
            const cornerX = crossedLeftGoalLineOut
              ? FIELD_LEFT + 6
              : FIELD_RIGHT - 6;
            const cornerY =
              p.ballY < FIELD_CENTER_Y ? FIELD_TOP + 6 : FIELD_BOTTOM - 6;
            const cornerKickingTeam: EventTeam =
              p.lastTouchTeam === 'red'
                ? 'blue'
                : p.lastTouchTeam === 'blue'
                  ? 'red'
                  : crossedLeftGoalLineOut
                    ? 'blue'
                    : 'red';
            const cornerPauseUntil = now + OUT_PAUSE_MS;

            p.eventState = 'corner';
            p.eventTeam = cornerKickingTeam;
            p.eventUntilMs = cornerPauseUntil;
            lastHandledEventUntilRef.current = cornerPauseUntil;
            p.ballX = cornerX;
            p.ballY = cornerY;
            p.ballVx = 0;
            p.ballVy = 0;
            p.awaitingSetPieceTouch = true;
            p.isCornerSetPiece = true;
            p.setPieceExpireMs = cornerPauseUntil + 5000;

            if (soundEnabledRef.current) {
              soundFX.playOutWhistle();
            }

            if (isAuthority) {
              syncRoomGameplayState(currentRoom.roomId, {
                redScore: currentRoom.redScore,
                blueScore: currentRoom.blueScore,
                ballX: cornerX,
                ballY: cornerY,
                ballVx: 0,
                ballVy: 0,
                eventState: 'corner',
                eventTeam: cornerKickingTeam,
                eventUntilMs: cornerPauseUntil,
                lastTouchTeam: p.lastTouchTeam,
              }).catch(() => {});
            }
          }

          // 5. Check for Side Touchline OUT (Боковой аут без всплывающего уведомления)
          const crossedTopLine = p.ballY + BALL_RADIUS < FIELD_TOP;
          const crossedBottomLine = p.ballY - BALL_RADIUS > FIELD_BOTTOM;

          if (p.eventState === 'normal' && (crossedTopLine || crossedBottomLine)) {
            const exitX = Math.max(
              FIELD_LEFT + 36,
              Math.min(FIELD_RIGHT - 36, p.ballX)
            );
            const returnY = crossedTopLine ? FIELD_TOP + 4 : FIELD_BOTTOM - 4;
            const throwInTeam: EventTeam =
              p.lastTouchTeam === 'red'
                ? 'blue'
                : p.lastTouchTeam === 'blue'
                  ? 'red'
                  : 'red';
            const outPauseUntil = now + OUT_PAUSE_MS;

            p.eventState = 'out';
            p.eventTeam = throwInTeam;
            p.eventUntilMs = outPauseUntil;
            lastHandledEventUntilRef.current = outPauseUntil;
            p.ballX = exitX;
            p.ballY = returnY;
            p.ballVx = 0;
            p.ballVy = 0;
            p.awaitingSetPieceTouch = true;
            p.isCornerSetPiece = false;
            p.setPieceExpireMs = outPauseUntil + 4500;

            if (soundEnabledRef.current) {
              soundFX.playOutWhistle();
            }

            if (isAuthority) {
              syncRoomGameplayState(currentRoom.roomId, {
                redScore: currentRoom.redScore,
                blueScore: currentRoom.blueScore,
                ballX: exitX,
                ballY: returnY,
                ballVx: 0,
                ballVy: 0,
                eventState: 'out',
                eventTeam: throwInTeam,
                eventUntilMs: outPauseUntil,
                lastTouchTeam: p.lastTouchTeam,
              }).catch(() => {});
            }
          }
        }
      }

      // 6. Real-Time Network Synchronization (WebSocket + Firestore + Express API)
      if (!isMatchFinished) {
        if (localTouchedBall) {
          lastLocalBallTouchMsRef.current = now;
        }

        if (localMovedOrChanged && now - lastPlayerSyncMsRef.current >= 50) {
          lastPlayerSyncMsRef.current = now;
          syncLocalPlayerDisc(
            currentRoom.roomId,
            profile.uid,
            {
              x: p.myX,
              y: p.myY,
              vx: p.myVx,
              vy: p.myVy,
              kicking: p.myKicking,
            },
            {
              nickname: profile.nickname,
              jerseyNumber: profile.jerseyNumber,
              team: localTeam,
            }
          ).catch(() => {});
        }

        const isHostAuthority =
          currentRoom.hostUid === profile.uid &&
          now >= remoteBallGraceUntilMsRef.current;
        const isBallAuthority = isHostAuthority || localTouchedBall;
        const ballMoving =
          Math.abs(p.ballVx) > 0.04 || Math.abs(p.ballVy) > 0.04 || localTouchedBall;

        if (
          isBallAuthority &&
          ballMoving &&
          p.eventState === 'normal' &&
          (localTouchedBall || now - lastBallSyncMsRef.current >= 55)
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
            actorUid: localTouchedBall ? profile.uid : undefined,
          }).catch(() => {});
        }
      }

      // 7. Render Arena on HTML5 Canvas
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          drawArena(ctx, currentRoom, allPlayers, p, profile);
        }
      }

      animationFrameId = window.requestAnimationFrame(stepPhysicsAndRender);
    };

    animationFrameId = window.requestAnimationFrame(stepPhysicsAndRender);
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [profile]);

  const isFinished =
    room.status === 'finished' || elapsedSeconds >= MATCH_DURATION_SEC;

  const getWinnerBannerText = (): {
    headline: string;
    subtext: string;
    accentClass: string;
  } => {
    if (room.redScore > room.blueScore) {
      return {
        headline: 'Матч окончен! Победила команда Красных',
        subtext: `Итоговый счёт — Красные ${room.redScore} : ${room.blueScore} Синие`,
        accentClass: 'text-red-400 border-red-500/40 bg-red-950/90',
      };
    }
    if (room.blueScore > room.redScore) {
      return {
        headline: 'Матч окончен! Победила команда Синих',
        subtext: `Итоговый счёт — Красные ${room.redScore} : ${room.blueScore} Синие`,
        accentClass: 'text-blue-400 border-blue-500/40 bg-blue-950/90',
      };
    }
    return {
      headline: 'Матч окончен! Боевая ничья',
      subtext: `Итоговый счёт — Красные ${room.redScore} : ${room.blueScore} Синие`,
      accentClass: 'text-emerald-300 border-emerald-500/40 bg-slate-900/95',
    };
  };

  return (
    <div className="relative flex flex-col items-center justify-between w-full h-screen overflow-hidden px-3 py-2 bg-slate-950 select-none">
      {/* Top-Center High-Contrast Match Scoreboard (HUD) */}
      <div className="w-full max-w-[min(98vw,calc((100vh-5.75rem)*1400/760))] flex items-center justify-between gap-4 mb-1.5 shrink-0">
        {/* Room title & player badge */}
        <div className="hidden md:flex items-center gap-3 min-w-[200px]">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center font-mono-tabular font-bold text-xs text-white border-2 ${
              myTeam === 'red'
                ? 'bg-red-600 border-red-300'
                : 'bg-blue-600 border-blue-300'
            }`}
          >
            {profile.jerseyNumber}
          </div>
          <div className="truncate">
            <div className="text-xs font-semibold text-slate-200 truncate">
              {profile.nickname}
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              {room.title}
            </div>
          </div>
        </div>

        {/* Contrast Scoreboard HUD (Красные 0 : 0 Синие + Таймер Минуты:Секунды) */}
        <div className="mx-auto flex items-center bg-slate-900 border border-slate-700/90 rounded-xl shadow-xl overflow-hidden">
          {/* Red Team Score Block */}
          <div className="flex items-center gap-3 px-4 py-1.5 bg-gradient-to-r from-red-950/90 to-slate-900 border-r border-slate-800">
            <span className="w-3 h-3 rounded-full bg-red-500 shrink-0" />
            <span className="font-display font-bold text-sm sm:text-base tracking-wide text-red-400 whitespace-nowrap">
              Красные
            </span>
            <span className="font-mono-tabular font-bold text-xl sm:text-2xl text-white pl-1">
              {room.redScore}
            </span>
          </div>

          {/* Center Match Timer (00:00 -> 05:00) */}
          <div className="flex flex-col items-center justify-center px-5 py-1 bg-slate-950">
            <span className="text-[10px] font-medium tracking-widest text-slate-400 uppercase">
              Время · 5 мин
            </span>
            <span
              className={`font-mono-tabular font-bold text-lg sm:text-xl tracking-wider ${
                elapsedSeconds >= 270 && !isFinished
                  ? 'text-amber-400'
                  : 'text-emerald-400'
              }`}
            >
              {formatTimerMMSS(elapsedSeconds)}
            </span>
          </div>

          {/* Blue Team Score Block */}
          <div className="flex items-center gap-3 px-4 py-1.5 bg-gradient-to-l from-blue-950/90 to-slate-900 border-l border-slate-800">
            <span className="font-mono-tabular font-bold text-xl sm:text-2xl text-white pr-1">
              {room.blueScore}
            </span>
            <span className="font-display font-bold text-sm sm:text-base tracking-wide text-blue-400 whitespace-nowrap">
              Синие
            </span>
            <span className="w-3 h-3 rounded-full bg-blue-500 shrink-0" />
          </div>
        </div>

        {/* Utility Controls (Sound + Leave Room) */}
        <div className="flex items-center justify-end gap-2 min-w-[140px] md:min-w-[200px]">
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

      {/* Main HTML5 Canvas Stadium Container (Scaled up to fill screen while preserving exact 1400x760 internal game proportions) */}
      <div className="relative w-full max-w-[min(98vw,calc((100vh-5.75rem)*1400/760))] aspect-[1400/760] rounded-2xl overflow-hidden border-2 border-slate-800 shadow-2xl bg-[#14532d] my-auto">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="w-full h-full block"
        />

        {/* 5-Minute Match Over Modal («Матч окончен! Победила команда [Цвет]») */}
        {isFinished && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
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

      {/* Bottom Controls Hint Bar */}
      <div className="w-full max-w-[min(98vw,calc((100vh-5.75rem)*1400/760))] mt-1.5 flex flex-wrap items-center justify-between gap-3 px-4 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800/80 text-xs text-slate-400 shrink-0">
        <div className="flex items-center gap-4">
          <span>
            Движение фишки:{' '}
            <strong className="text-slate-200 font-mono-tabular">WASD</strong> или{' '}
            <strong className="text-slate-200 font-mono-tabular">Стрелочки</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Удар / Подача углового:{' '}
            <strong className="text-slate-200 font-mono-tabular">Пробел</strong> /{' '}
            <strong className="text-slate-200 font-mono-tabular">X</strong>
          </span>
        </div>
        <div className="flex items-center gap-3 text-slate-400">
          <Shield className="w-3.5 h-3.5 text-emerald-400" />
          <span>
            Формат 4×4 · Красные ({room.redUids.length}/4) · Синие ({room.blueUids.length}/4)
          </span>
        </div>
      </div>
    </div>
  );
};

/**
 * Pure Canvas 2D Renderer for HaxArena Pitch, Corner Arcs, Goals, Players, and Soccer Ball Emoji
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

  // 3. Pitch Markings (Touchlines, Goal lines, Corner Arcs, Center Line, Center Circle, Penalty Areas)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 3;

  // Outer Pitch Rectangle
  ctx.strokeRect(FIELD_LEFT, FIELD_TOP, fieldWidth, fieldHeight);

  // 4 Corner Arcs (Угловые сектора для подачи корнеров)
  const cornerArcRadius = 22;
  // Top-Left Corner Arc
  ctx.beginPath();
  ctx.arc(FIELD_LEFT, FIELD_TOP, cornerArcRadius, 0, Math.PI * 0.5);
  ctx.stroke();
  // Bottom-Left Corner Arc
  ctx.beginPath();
  ctx.arc(FIELD_LEFT, FIELD_BOTTOM, cornerArcRadius, -Math.PI * 0.5, 0);
  ctx.stroke();
  // Top-Right Corner Arc
  ctx.beginPath();
  ctx.arc(FIELD_RIGHT, FIELD_TOP, cornerArcRadius, Math.PI * 0.5, Math.PI);
  ctx.stroke();
  // Bottom-Right Corner Arc
  ctx.beginPath();
  ctx.arc(FIELD_RIGHT, FIELD_BOTTOM, cornerArcRadius, Math.PI, Math.PI * 1.5);
  ctx.stroke();

  // Halfway Line
  ctx.beginPath();
  ctx.moveTo(FIELD_CENTER_X, FIELD_TOP);
  ctx.lineTo(FIELD_CENTER_X, FIELD_BOTTOM);
  ctx.stroke();

  // Center Circle
  ctx.beginPath();
  ctx.arc(FIELD_CENTER_X, FIELD_CENTER_Y, 82, 0, Math.PI * 2);
  ctx.stroke();

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

  // 5. Subtle Set-Piece Ring on Pitch for Throw-In or Corner Kick
  if (phys.awaitingSetPieceTouch && phys.eventTeam !== 'none') {
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([6, 6]);
    ctx.arc(phys.ballX, phys.ballY, 74, 0, Math.PI * 2);
    ctx.strokeStyle =
      phys.eventTeam === 'red'
        ? 'rgba(248, 113, 113, 0.65)'
        : 'rgba(96, 165, 250, 0.65)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // 6. Draw All Player Discs (Red & Blue)
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
    isMe: boolean;
  }> = [];

  // Add remote players
  Object.values(players).forEach((rp) => {
    if (rp.playerId === localProfile.uid) return;
    const pos = phys.remoteRenderPos[rp.playerId] || { x: rp.x, y: rp.y };
    renderList.push({
      uid: rp.playerId,
      nickname: rp.nickname,
      jerseyNumber: rp.jerseyNumber,
      team: rp.team,
      x: pos.x,
      y: pos.y,
      kicking: rp.kicking,
      isMe: false,
    });
  });

  // Add local player on top
  renderList.push({
    uid: localProfile.uid,
    nickname: players[localProfile.uid]?.nickname || localProfile.nickname,
    jerseyNumber:
      players[localProfile.uid]?.jerseyNumber || localProfile.jerseyNumber,
    team: localTeam,
    x: phys.myX,
    y: phys.myY,
    kicking: phys.myKicking,
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

    // Outer Disc Stroke (Turns bright white when kicking!)
    ctx.lineWidth = pl.kicking ? 4 : 2.5;
    ctx.strokeStyle = pl.kicking
      ? '#ffffff'
      : pl.team === 'red'
        ? '#7f1d1d'
        : '#1e3a8a';
    ctx.stroke();

    // Jersey Number (Игровой номер от 1 до 99 белым цветом прямо ВНУТРИ кружка)
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 14px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(pl.jerseyNumber), pl.x, pl.y + 0.5);

    // Player Nickname (Мелким белым текстом прямо НАД круглым персонажем игрока)
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

  // 7. Draw Smaller Soccer Ball (⚽ Emoji + Crisp Outer Layer that turns GREEN during the 2.5s Powershot window after 5s hold in gray circle)
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

  ctx.save();
  // Drop shadow under ball
  ctx.beginPath();
  ctx.arc(phys.ballX, phys.ballY + 2, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fill();

  // Translate & rotate ball around its center
  ctx.translate(phys.ballX, phys.ballY);
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

  // Outer layer / rim of the ball:
  // Normally black (#0f172a), turns bright green (#22c55e) when player controls ball >= 5s,
  // and immediately turns off as soon as the player kicks!
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

  // 8. When the ball is inside either goal mouth, render the top roof net cords over the ball
  // so the ball visually sits INSIDE the woven football net!
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

  // Helper to sample the deformed 2D net surface at (u in [0..1] depth, v in [0..1] height)
  const sampleNetSurface = (u: number, v: number): { x: number; y: number } => {
    // Top edge at depth u (nodes 0 .. NET_SIDE_SEGMENTS)
    const topF = u * NET_SIDE_SEGMENTS;
    const t0 = Math.floor(topF);
    const t1 = Math.min(NET_SIDE_SEGMENTS, t0 + 1);
    const tf = topF - t0;
    const topX = nodes[t0].x * (1 - tf) + nodes[t1].x * tf;
    const topY = nodes[t0].y * (1 - tf) + nodes[t1].y * tf;

    // Bottom edge at depth u (nodes 26 down to 20)
    const botF = NET_TOTAL_NODES - 1 - u * NET_SIDE_SEGMENTS;
    const b0 = Math.floor(botF);
    const b1 = Math.max(NET_SIDE_SEGMENTS + NET_BACK_SEGMENTS, Math.min(NET_TOTAL_NODES - 1, b0 + 1));
    const bf = botF - b0;
    const botX = nodes[b0].x * (1 - bf) + nodes[b1].x * bf;
    const botY = nodes[b0].y * (1 - bf) + nodes[b1].y * bf;

    // Back edge at height v (nodes 6 .. 20)
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

    // Coons-like blend: base interpolation between top & bottom edges + depth-weighted back bulge
    const depthWeight = Math.pow(u, 1.15);
    const x = topX * (1 - v) + botX * v + backDx * depthWeight;
    const y = topY * (1 - v) + botY * v + backDy * depthWeight * 0.65;
    return { x, y };
  };

  ctx.save();

  if (!overlayPass) {
    // 1. Rear Metal Stadium Support Stanchions & Tension Guy-Wires
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(lineX, GOAL_TOP);
    ctx.lineTo(stanchionBackX, GOAL_TOP - 4);
    ctx.moveTo(lineX, GOAL_BOTTOM);
    ctx.lineTo(stanchionBackX, GOAL_BOTTOM + 4);
    ctx.stroke();

    // Elastic guy-wires connecting rear stanchion brackets to the live net back corners
    ctx.strokeStyle =
      side === 'left' ? 'rgba(248, 113, 113, 0.65)' : 'rgba(96, 165, 250, 0.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(stanchionBackX, GOAL_TOP - 4);
    ctx.lineTo(topCornerNode.x, topCornerNode.y);
    ctx.moveTo(stanchionBackX, GOAL_BOTTOM + 4);
    ctx.lineTo(botCornerNode.x, botCornerNode.y);
    ctx.stroke();

    // 2. Deformed Net Interior Ground Shadow & Team Tint Fill
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

  // 3. Woven Deformable Net Mesh (Vertical & Horizontal Cords)
  const uSteps = NET_SIDE_SEGMENTS;
  const vSteps = NET_BACK_SEGMENTS;

  ctx.lineWidth = overlayPass ? 1.15 : 1.1;
  ctx.strokeStyle = overlayPass
    ? 'rgba(255, 255, 255, 0.34)'
    : side === 'left'
      ? 'rgba(254, 202, 202, 0.38)'
      : 'rgba(191, 219, 254, 0.38)';

  // Vertical-ish mesh cords running top-to-bottom across the depth of the goal
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
  // Horizontal-ish mesh cords running from goal line to the deformed back net
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

  // 4. Outer Perimeter Net Frame Cord (Curves smoothly when ball stretches the net)
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

