import React, { useEffect, useRef, useState } from 'react';
import { LogOut, RotateCcw, Shield, Trophy, Volume2, VolumeX, Wifi } from 'lucide-react';
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
  applyWebRTCAuthoritativeSnapshot,
  finishMatchRoom,
  getHostAuthoritativePlayerState,
  getLiveMatchSnapshot,
  getLocalPingMs,
  registerGoalInNet,
  resetFormationAfterGoalDelay,
  sendRoomHeartbeat,
  sendWebRTCSignal,
  subscribeToWebRTCSignals,
  syncLocalPlayerDisc,
  syncRoomGameplayState,
} from '../services/roomService';
import {
  attemptKick,
  MAX_EXTRAPOLATION_MS,
  PING_INTERVAL_MS,
  PlayerInputKeys,
  round4,
  WebRTCLockstepSession,
} from '../services/webrtcLockstep';
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
  myOffsetX: number;
  myOffsetY: number;
  myVx: number;
  myVy: number;
  myKicking: boolean;
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
    }
  >;
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

  const isFreshKickoff =
    room.matchStartedAtMs > 0 && Date.now() - room.matchStartedAtMs < 6000;

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
    ballX: room.ballX ?? FIELD_CENTER_X,
    ballY: room.ballY ?? FIELD_CENTER_Y,
    ballVx: room.ballVx ?? 0,
    ballVy: room.ballVy ?? 0,
    ballOffsetX: 0,
    ballOffsetY: 0,
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
  }>({ x: -1, y: -1, vx: 0, vy: 0, keyMask: -1 });
  const lastAppliedBallSeqRef = useRef<number>(room.seq || 0);
  const lastHandledEventUntilRef = useRef<number>(0);
  const finishTriggeredRef = useRef<boolean>(false);
  const tickCounterRef = useRef<number>(0);
  const webrtcSessionRef = useRef<WebRTCLockstepSession | null>(null);
  const peerInputsRef = useRef<Record<string, PlayerInputKeys>>({});
  const [localPing, setLocalPing] = useState<number>(() => getLocalPingMs());
  const [peerPings, setPeerPings] = useState<Record<string, number>>({});
  const [tabOpen, setTabOpen] = useState<boolean>(false);
  const [extrapolationMs, setExtrapolationMs] = useState<number>(20);
  const extrapolationMsRef = useRef<number>(20);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  // Initialize P2P WebRTC DataChannel Lockstep Session + Firebase/WS Signaling
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
      onClientBall: (pkt) => {
        const nowMs = Date.now();
        // Smoothly absorb 100% of visual delta so client ball touch never causes a jump on Host
        const p = physRef.current;
        const prevVisX = p.ballX + p.ballOffsetX;
        const prevVisY = p.ballY + p.ballOffsetY;
        p.ballX = pkt.ballX;
        p.ballY = pkt.ballY;
        p.ballVx = pkt.ballVx;
        p.ballVy = pkt.ballVy;
        p.lastTouchTeam = pkt.lastTouchTeam;
        const errX = prevVisX - p.ballX;
        const errY = prevVisY - p.ballY;
        if (Math.hypot(errX, errY) < 120) {
          p.ballOffsetX = round4(errX);
          p.ballOffsetY = round4(errY);
        } else {
          p.ballOffsetX = 0;
          p.ballOffsetY = 0;
        }
        remoteBallGraceUntilMsRef.current = nowMs + 380;
        remoteBallActorUidRef.current = pkt.playerId;
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

  // Keep room alive & refresh ping strictly every 3000ms (3 seconds) to avoid network traffic
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
      const p = physRef.current;

      // Direct 60 FPS Zero-Lag Snapshot Pull (Bypasses React state re-renders!)
      const liveSnap = getLiveMatchSnapshot(roomRef.current.roomId);
      if (Object.keys(liveSnap.players).length > 0) {
        const nextPlayers = { ...playersRef.current };
        for (const [uid, pl] of Object.entries(liveSnap.players)) {
          if (uid === profile.uid) continue;
          nextPlayers[uid] = pl;
        }
        playersRef.current = nextPlayers;
      }

      // Check distances to ball to protect local dribble control from delayed network echoes
      const myDistToBallBefore = Math.hypot(p.ballX - p.myX, p.ballY - p.myY);
      let closestRemoteDistToBall = Infinity;
      for (const rp of Object.values(playersRef.current)) {
        if (rp.playerId === profile.uid) continue;
        const rPos = p.remoteRenderPos[rp.playerId] || rp;
        const d = Math.hypot(p.ballX - rPos.x, p.ballY - rPos.y);
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

        // Protect active 3-second post-goal window from stale packets
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

          // Handle new goal, out, or corner event from network
          if (
            netRoom.eventState !== 'normal' &&
            netRoom.eventUntilMs !== lastHandledEventUntilRef.current &&
            netRoom.eventUntilMs > now - 500
          ) {
            lastHandledEventUntilRef.current = netRoom.eventUntilMs;
            lastAppliedBallSeqRef.current = netRoom.seq || now;
            p.eventState = netRoom.eventState;
            p.eventTeam = netRoom.eventTeam;
            p.eventUntilMs = netRoom.eventUntilMs;
            p.ballX = netRoom.ballX;
            p.ballY = netRoom.ballY;
            p.ballVx = netRoom.ballVx;
            p.ballVy = netRoom.ballVy;
            p.ballOffsetX = 0;
            p.ballOffsetY = 0;

            if (netRoom.eventState === 'goal') {
              p.awaitingSetPieceTouch = false;
              p.isCornerSetPiece = false;
              if (soundEnabledRef.current && prevEventState !== 'goal') {
                soundFX.playGoalFanfare();
              }
            } else if (
              netRoom.eventState === 'out' ||
              netRoom.eventState === 'corner'
            ) {
              p.awaitingSetPieceTouch = true;
              p.isCornerSetPiece = netRoom.eventState === 'corner';
              p.setPieceExpireMs = netRoom.eventUntilMs + 4500;
              if (soundEnabledRef.current && prevEventState !== netRoom.eventState) {
                soundFX.playOutWhistle();
              }
            }
          } else if (
            (netRoom.seq || 0) !== lastAppliedBallSeqRef.current &&
            netRoom.eventState === 'normal'
          ) {
            // HaxBall Exact Physics Reconciliation + Visual Smoothing Offset
            lastAppliedBallSeqRef.current = netRoom.seq || 0;
            const isFromOtherPlayer = Boolean(
              netRoom.actorUid && netRoom.actorUid !== profile.uid
            );

            if (isFromOtherPlayer) {
              remoteBallGraceUntilMsRef.current = now + 380;
              remoteBallActorUidRef.current = netRoom.actorUid || '';
            }

            // Never overwrite the ball while the local player is sole dribbler / just kicked it,
            // UNLESS another player is physically contesting the ball right next to it!
            const shouldApplyRemoteBall =
              (isFromOtherPlayer && (!recentlyTouchedLocally || isRemoteContestingClose)) ||
              (!recentlyTouchedLocally && netRoom.hostUid !== profile.uid);

            if (shouldApplyRemoteBall) {
              const prevVisX = p.ballX + p.ballOffsetX;
              const prevVisY = p.ballY + p.ballOffsetY;

              p.ballX = round4(netRoom.ballX);
              p.ballY = round4(netRoom.ballY);
              p.ballVx = netRoom.ballVx;
              p.ballVy = netRoom.ballVy;
              p.lastTouchTeam = netRoom.lastTouchTeam;

              const errX = prevVisX - p.ballX;
              const errY = prevVisY - p.ballY;
              const errDist = Math.hypot(errX, errY);
              if (errDist < 120) {
                p.ballOffsetX = round4(errX);
                p.ballOffsetY = round4(errY);
              } else {
                p.ballOffsetX = 0;
                p.ballOffsetY = 0;
              }
            }
          }
        }
      }

      // Decay visual smoothing offsets smoothly on every 60Hz frame
      const ballDecay = Math.pow(0.76, dtScale);
      const discDecay = Math.pow(0.80, dtScale);
      p.ballOffsetX =
        Math.abs(p.ballOffsetX) > 0.15 ? round4(p.ballOffsetX * ballDecay) : 0;
      p.ballOffsetY =
        Math.abs(p.ballOffsetY) > 0.15 ? round4(p.ballOffsetY * ballDecay) : 0;
      p.myOffsetX =
        Math.abs(p.myOffsetX) > 0.15 ? round4(p.myOffsetX * discDecay) : 0;
      p.myOffsetY =
        Math.abs(p.myOffsetY) > 0.15 ? round4(p.myOffsetY * discDecay) : 0;

      const currentRoom = roomRef.current;
      const allPlayers = playersRef.current;
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
          p.myOffsetX = 0;
          p.myOffsetY = 0;
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

      // 1. Update Local Player Disc Movement + Pure Input WebRTC Transmission (60 Hz integer tick)
      tickCounterRef.current += 1;
      const currentTick = tickCounterRef.current;
      const rtcSession = webrtcSessionRef.current;
      if (rtcSession && !isMatchFinished && !rtcSession.isHost) {
        rtcSession.sendClientInput(currentTick, { ...keysRef.current });
      }

      let localMovedOrChanged = false;
      if (!isMatchFinished && !isPausedForOutOrCorner) {
        const k = keysRef.current;
        let dirX = 0;
        let dirY = 0;
        if (k.left) dirX -= 1;
        if (k.right) dirX += 1;
        if (k.up) dirY -= 1;
        if (k.down) dirY += 1;

        const accel = k.kick ? PLAYER_KICK_ACCEL : PLAYER_ACCEL;
        const playerDamp = Math.pow(PLAYER_DAMPING, dtScale);

        if (dirX !== 0 || dirY !== 0) {
          const moveAngle = Math.atan2(dirY, dirX);
          const ax = round4(Math.cos(moveAngle) * accel);
          const ay = round4(Math.sin(moveAngle) * accel);
          p.myVx = round4((p.myVx + ax * dtScale) * playerDamp);
          p.myVy = round4((p.myVy + ay * dtScale) * playerDamp);
        } else {
          p.myVx = round4(p.myVx * playerDamp);
          p.myVy = round4(p.myVy * playerDamp);
        }

        const speed = Math.hypot(p.myVx, p.myVy);
        if (speed > PLAYER_MAX_SPEED) {
          const sAngle = Math.atan2(p.myVy, p.myVx);
          p.myVx = round4(Math.cos(sAngle) * PLAYER_MAX_SPEED);
          p.myVy = round4(Math.sin(sAngle) * PLAYER_MAX_SPEED);
        }
        if (speed < 0.012 && dirX === 0 && dirY === 0) {
          p.myVx = 0;
          p.myVy = 0;
        }

        p.myX = round4(p.myX + p.myVx * dtScale);
        p.myY = round4(p.myY + p.myVy * dtScale);

        if (
           dirX !== 0 ||
          dirY !== 0 ||
          Math.abs(p.myVx) > 0.005 ||
          Math.abs(p.myVy) > 0.005 ||
          p.myKicking !== k.kick
        ) {
          localMovedOrChanged = true;
          lastLocalActiveMoveMsRef.current = now;
        }
        p.myKicking = k.kick;
      } else {
        p.myVx = 0;
        p.myVy = 0;
        p.myKicking = false;
      }

      const preCollisionMyVx = p.myVx;
      const preCollisionMyVy = p.myVy;

      // Continuous 60fps HaxBall Dead-Reckoning + Zero-Shudder Visual Offset Smoothing for Remote Players
      const remotePlayerDamp = Math.pow(PLAYER_DAMPING, dtScale);

      Object.values(allPlayers).forEach((rp) => {
        if (rp.playerId === profile.uid) return;
        const pktSeq =
          typeof rp.seq === 'number'
            ? rp.seq
            : typeof rp.updatedAt === 'number'
              ? rp.updatedAt
              : 0;
        let state = p.remoteRenderPos[rp.playerId];

        if (!state) {
          state = {
            x: rp.x,
            y: rp.y,
            offsetX: 0,
            offsetY: 0,
            simX: rp.x,
            simY: rp.y,
            vx: rp.vx || 0,
            vy: rp.vy || 0,
            lastSeq: pktSeq,
          };
          p.remoteRenderPos[rp.playerId] = state;
          return;
        }

        // STEP 1: Advance remote player physics at 60Hz FIRST (using lockstep input / keyMask + damping)
        if (!isMatchFinished && !isPausedForOutOrCorner) {
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
          if (peerKey) {
            let pdx = 0;
            let pdy = 0;
            if (peerKey.left) pdx -= 1;
            if (peerKey.right) pdx += 1;
            if (peerKey.up) pdy -= 1;
            if (peerKey.down) pdy += 1;
            if (pdx !== 0 || pdy !== 0) {
              const ang = Math.atan2(pdy, pdx);
              const acc = peerKey.kick ? PLAYER_KICK_ACCEL : PLAYER_ACCEL;
              state.vx = round4(
                (state.vx + Math.cos(ang) * acc * dtScale) * remotePlayerDamp
              );
              state.vy = round4(
                (state.vy + Math.sin(ang) * acc * dtScale) * remotePlayerDamp
              );
            } else {
              state.vx = round4(state.vx * remotePlayerDamp);
              state.vy = round4(state.vy * remotePlayerDamp);
            }
          } else {
            state.vx = round4(state.vx * remotePlayerDamp);
            state.vy = round4(state.vy * remotePlayerDamp);
          }

          const rSpeed = Math.hypot(state.vx, state.vy);
          if (rSpeed > PLAYER_MAX_SPEED) {
            const sAng = Math.atan2(state.vy, state.vx);
            state.vx = round4(Math.cos(sAng) * PLAYER_MAX_SPEED);
            state.vy = round4(Math.sin(sAng) * PLAYER_MAX_SPEED);
          } else if (rSpeed < 0.012) {
            state.vx = 0;
            state.vy = 0;
          }

          state.x = round4(
            Math.max(
              PLAYER_RADIUS + 12,
              Math.min(CANVAS_WIDTH - PLAYER_RADIUS - 12, state.x + state.vx * dtScale)
            )
          );
          state.y = round4(
            Math.max(
              PLAYER_RADIUS + 12,
              Math.min(CANVAS_HEIGHT - PLAYER_RADIUS - 12, state.y + state.vy * dtScale)
            )
          );

          for (const post of GOALPOSTS) {
            const dxPost = state.x - post.x;
            const dyPost = state.y - post.y;
            const distPost = Math.hypot(dxPost, dyPost);
            const minPostDist = PLAYER_RADIUS + POST_RADIUS;
            if (distPost < minPostDist && distPost > 0.001) {
              const pAngle = Math.atan2(dyPost, dxPost);
              const nx = round4(Math.cos(pAngle));
              const ny = round4(Math.sin(pAngle));
              state.x = round4(post.x + nx * minPostDist);
              state.y = round4(post.y + ny * minPostDist);
            }
          }
        }

        // STEP 2: Reconcile when a new network packet arrives AFTER stepping dead-reckoning!
        // Absorbing 100% (1.0) of (prevVisX - state.x) guarantees 0.000px instantaneous jump on packet arrival!
        if (pktSeq !== state.lastSeq) {
          const prevVisX = state.x + state.offsetX;
          const prevVisY = state.y + state.offsetY;
          state.lastSeq = pktSeq;
          state.x = rp.x;
          state.y = rp.y;
          state.vx = rp.vx || 0;
          state.vy = rp.vy || 0;

          const errX = prevVisX - state.x;
          const errY = prevVisY - state.y;
          const errDist = Math.hypot(errX, errY);
          if (errDist < 120) {
            state.offsetX = round4(errX);
            state.offsetY = round4(errY);
          } else {
            state.offsetX = 0;
            state.offsetY = 0;
          }
        }

        // STEP 3: Smoothly decay visual offset once per 60Hz frame
        state.offsetX =
          Math.abs(state.offsetX) > 0.15 ? round4(state.offsetX * discDecay) : 0;
        state.offsetY =
          Math.abs(state.offsetY) > 0.15 ? round4(state.offsetY * discDecay) : 0;

        state.simX = state.x;
        state.simY = state.y;
      });

      // 1b. Symmetric Player-to-Player Disc Collisions + Zero-Desync Coordinate Convergence
      if (!isMatchFinished && !isPausedForOutOrCorner) {
        const minPlayerDist = PLAYER_RADIUS * 2; // 38px
        Object.values(allPlayers).forEach((rp) => {
          if (rp.playerId === profile.uid) return;
          const rState = p.remoteRenderPos[rp.playerId];
          if (!rState) return;

          const dxP = p.myX - rState.x;
          const dyP = p.myY - rState.y;
          const distP = Math.hypot(dxP, dyP);

          if (distP < minPlayerDist && distP > 0.001) {
            const pAngle = Math.atan2(dyP, dxP);
            const nx = round4(Math.cos(pAngle));
            const ny = round4(Math.sin(pAngle));
            const overlap = minPlayerDist - distP;

            // Symmetric 50/50 equal-mass separation (identical to HaxBall stepDeterministicWorld!)
            const prevMyVisX = p.myX + p.myOffsetX;
            const prevMyVisY = p.myY + p.myOffsetY;
            const prevRemVisX = rState.x + rState.offsetX;
            const prevRemVisY = rState.y + rState.offsetY;

            p.myX = round4(p.myX + nx * overlap * 0.5);
            p.myY = round4(p.myY + ny * overlap * 0.5);
            rState.x = round4(rState.x - nx * overlap * 0.5);
            rState.y = round4(rState.y - ny * overlap * 0.5);

            // Smoothly absorb sub-frame collision nudge into visual offsets so discs never jitter on contact
            p.myOffsetX = round4((prevMyVisX - p.myX) * 0.45);
            p.myOffsetY = round4((prevMyVisY - p.myY) * 0.45);
            rState.offsetX = round4((prevRemVisX - rState.x) * 0.45);
            rState.offsetY = round4((prevRemVisY - rState.y) * 0.45);

            // Elastic 2D momentum transfer + contact repulsion so stationary discs always get pushed smoothly
            const relVx = p.myVx - rState.vx;
            const relVy = p.myVy - rState.vy;
            const normalVel = relVx * nx + relVy * ny;
            const contactPush = round4(overlap * 0.26);
            if (normalVel < 0) {
              const playerRestitution = 0.14;
              const impulse = Math.max(
                contactPush,
                -(1 + playerRestitution) * normalVel * 0.5
              );
              p.myVx = round4(p.myVx + impulse * nx);
              p.myVy = round4(p.myVy + impulse * ny);
              rState.vx = round4(rState.vx - impulse * nx);
              rState.vy = round4(rState.vy - impulse * ny);
            } else {
              p.myVx = round4(p.myVx + contactPush * nx);
              p.myVy = round4(p.myVy + contactPush * ny);
              rState.vx = round4(rState.vx - contactPush * nx);
              rState.vy = round4(rState.vy - contactPush * ny);
            }
            lastPlayerCollisionMsRef.current = now;
            lastLocalActiveMoveMsRef.current = now;
            localMovedOrChanged = true;
          }
        });

        // Smoothly reconcile Client coordinates with Host only if a major collision divergence (> 24px) occurred,
        // absorbing 100% of the shift into myOffsetX/myOffsetY so there is zero visible shudder!
        if (
          currentRoom.hostUid !== profile.uid &&
          now - lastPlayerCollisionMsRef.current < 240
        ) {
          const hostAuthMe = getHostAuthoritativePlayerState(
            currentRoom.roomId,
            profile.uid
          );
          if (hostAuthMe && now - hostAuthMe.ts < 140) {
            const diffX = hostAuthMe.x - p.myX;
            const diffY = hostAuthMe.y - p.myY;
            const diffDist = Math.hypot(diffX, diffY);
            if (diffDist > 24 && diffDist < 120) {
              const prevVisX = p.myX + p.myOffsetX;
              const prevVisY = p.myY + p.myOffsetY;
              p.myX = round4(p.myX + diffX * 0.25);
              p.myY = round4(p.myY + diffY * 0.25);
              p.myOffsetX = round4(prevVisX - p.myX);
              p.myOffsetY = round4(prevVisY - p.myY);
              lastLocalActiveMoveMsRef.current = now;
              localMovedOrChanged = true;
            }
          }
        }

        // Keep local player within outer arena walls & goalposts after player-to-player push
        p.myX = round4(
          Math.max(PLAYER_RADIUS + 12, Math.min(CANVAS_WIDTH - PLAYER_RADIUS - 12, p.myX))
        );
        p.myY = round4(
          Math.max(PLAYER_RADIUS + 12, Math.min(CANVAS_HEIGHT - PLAYER_RADIUS - 12, p.myY))
        );

        for (const post of GOALPOSTS) {
          const dxPost = p.myX - post.x;
          const dyPost = p.myY - post.y;
          const distPost = Math.hypot(dxPost, dyPost);
          const minPostDist = PLAYER_RADIUS + POST_RADIUS;
          if (distPost < minPostDist && distPost > 0.001) {
            const pAngle = Math.atan2(dyPost, dxPost);
            const nx = round4(Math.cos(pAngle));
            const ny = round4(Math.sin(pAngle));
            p.myX = round4(post.x + nx * minPostDist);
            p.myY = round4(post.y + ny * minPostDist);
            const dot = p.myVx * nx + p.myVy * ny;
            if (dot < 0) {
              p.myVx = round4(p.myVx - dot * nx * 1.15);
              p.myVy = round4(p.myVy - dot * ny * 1.15);
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
            const bAngle = Math.atan2(dyBall, dxBall);
            p.myX = round4(p.ballX + Math.cos(bAngle) * minThrowInDist);
            p.myY = round4(p.ballY + Math.sin(bAngle) * minThrowInDist);
          }
        }
      }

      // 2. Step Ball Movement FIRST, then resolve Disc-to-Ball Contact & Kick so the ball stays right on the player's circle when dribbling!
      let localTouchedBall = false;
      if (!isMatchFinished && !isPausedForOutOrCorner) {
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
          };
          activeDiscs.push({
            uid: rp.playerId,
            team: rp.team,
            x: interp.x,
            y: interp.y,
            vx: interp.vx,
            vy: interp.vy,
            kicking: rp.kicking || false,
          });
        });

        // Sub-stepped Ball Movement + Disc Contact + Goal Line Detection + Goal Net Physics
        const subSteps = 2;
        for (let step = 0; step < subSteps; step++) {
          p.ballX = round4(p.ballX + (p.ballVx * dtScale) / subSteps);
          p.ballY = round4(p.ballY + (p.ballVy * dtScale) / subSteps);

          // Resolve Disc-to-Ball Contact inside each sub-step AFTER stepping ball position:
          // This guarantees the ball sits flush against the player's disc circle (dist = PLAYER_RADIUS + BALL_RADIUS) instead of floating ahead!
          if (p.eventState === 'normal' || p.eventState === 'goal') {
            for (const disc of activeDiscs) {
              const dx = p.ballX - disc.x;
              const dy = p.ballY - disc.y;
              const dist = Math.hypot(dx, dy);
              const minDist = PLAYER_RADIUS + BALL_RADIUS;

              if (dist < minDist && dist > 0.001 && !disc.kicking) {
                const cAngle = Math.atan2(dy, dx);
                const nx = round4(Math.cos(cAngle));
                const ny = round4(Math.sin(cAngle));

                // Place ball flush on the outer perimeter of the player's disc
                p.ballX = round4(disc.x + nx * minDist);
                p.ballY = round4(disc.y + ny * minDist);

                const relVx = p.ballVx - disc.vx;
                const relVy = p.ballVy - disc.vy;
                const normalVel = relVx * nx + relVy * ny;

                if (normalVel < 0) {
                  // Zero restitution (0.0) during gentle dribbling so the ball rolls right on the player's disc without jumping ahead;
                  // small bounce (0.08) only on high-speed impact
                  const restitution = -normalVel > 1.85 ? 0.08 : 0.0;
                  const impulse = -(1 + restitution) * normalVel;
                  p.ballVx = round4(p.ballVx + impulse * nx);
                  p.ballVy = round4(p.ballVy + impulse * ny);
                }

                p.lastTouchTeam = disc.team;
                p.awaitingSetPieceTouch = false;
                p.isCornerSetPiece = false;

                if (disc.uid === profile.uid) {
                  localTouchedBall = true;
                }
              }
            }
          }

          // Goalpost Circle Collisions
          for (const post of GOALPOSTS) {
            const dx = p.ballX - post.x;
            const dy = p.ballY - post.y;
            const dist = Math.hypot(dx, dy);
            const minDist = BALL_RADIUS + POST_RADIUS;
            if (dist < minDist && dist > 0.001) {
              const nx = dx / dist;
              const ny = dy / dist;
              p.ballX = round4(post.x + nx * minDist);
              p.ballY = round4(post.y + ny * minDist);
              const dot = p.ballVx * nx + p.ballVy * ny;
              if (dot < 0) {
                p.ballVx = round4((p.ballVx - 2 * dot * nx) * 0.82);
                p.ballVy = round4((p.ballVy - 2 * dot * ny) * 0.82);
                if (soundEnabledRef.current) {
                  soundFX.playPostHit();
                }
              }
            }
          }

          const isAuthority =
            currentRoom.hostUid === profile.uid || localTouchedBall;

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

        // Check Powershot Hold & Deterministic Kick (`attemptKick`)
        if (p.eventState === 'normal' || p.eventState === 'goal') {
          const grayCircleHoldDist = KICK_RANGE;
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
            p.controllingUid = '';
            p.controlStartedAtMs = 0;
            p.powershotMustExitRing = false;
          } else if (p.controllingUid !== holderUid) {
            p.controllingUid = holderUid;
            p.controlStartedAtMs = now;
            p.powershotMustExitRing = false;
          } else if (!p.powershotMustExitRing && p.controlStartedAtMs > 0) {
            const heldMs = now - p.controlStartedAtMs;
            if (heldMs > POWERSHOT_CHARGE_MS + POWERSHOT_WINDOW_MS) {
              p.powershotMustExitRing = true;
              p.controlStartedAtMs = 0;
            }
          }

          for (const disc of activeDiscs) {
            const dx = p.ballX - disc.x;
            const dy = p.ballY - disc.y;
            const dist = Math.hypot(dx, dy);

            if (disc.kicking && dist < KICK_RANGE && dist > 0.001) {
              const heldMs =
                p.controllingUid === disc.uid &&
                !p.powershotMustExitRing &&
                p.controlStartedAtMs > 0
                  ? now - p.controlStartedAtMs
                  : 0;
              const hasChargedPowershot =
                heldMs >= POWERSHOT_CHARGE_MS &&
                heldMs <= POWERSHOT_CHARGE_MS + POWERSHOT_WINDOW_MS;

              const kickStrength = hasChargedPowershot
                ? POWERSHOT_IMPULSE
                : p.isCornerSetPiece
                  ? CORNER_KICK_IMPULSE
                  : KICK_IMPULSE;

              const ballObj = {
                x: p.ballX,
                y: p.ballY,
                vx: p.ballVx,
                vy: p.ballVy,
                radius: BALL_RADIUS,
              };
              const kickRes = attemptKick(
                {
                  x: disc.x,
                  y: disc.y,
                  vx: disc.vx,
                  vy: disc.vy,
                  radius: PLAYER_RADIUS,
                },
                ballObj,
                {
                  keys: {
                    up: false,
                    down: false,
                    left: false,
                    right: false,
                    kick: disc.kicking,
                  },
                },
                kickStrength,
                KICK_RANGE - PLAYER_RADIUS - BALL_RADIUS
              );

              if (kickRes) {
                p.ballVx = round4(kickRes.impulseX + disc.vx * 0.35);
                p.ballVy = round4(kickRes.impulseY + disc.vy * 0.35);
                p.lastTouchTeam = disc.team;
                p.awaitingSetPieceTouch = false;
                p.isCornerSetPiece = false;

                if (hasChargedPowershot) {
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
            }
          }
        } else {
          p.controllingUid = '';
          p.controlStartedAtMs = 0;
          p.powershotMustExitRing = false;
        }

        const isAuthority =
          currentRoom.hostUid === profile.uid || localTouchedBall;

        // Apply natural turf/air damping (identical on pitch and inside goal mouth)
        const ballDamp = Math.pow(BALL_DAMPING, dtScale);
        p.ballVx = round4(p.ballVx * ballDamp);
        p.ballVy = round4(p.ballVy * ballDamp);

        const bSpeed = Math.hypot(p.ballVx, p.ballVy);
        if (bSpeed > BALL_MAX_SPEED) {
          p.ballVx = round4((p.ballVx / bSpeed) * BALL_MAX_SPEED);
          p.ballVy = round4((p.ballVy / bSpeed) * BALL_MAX_SPEED);
        }
        if (bSpeed < 0.03) {
          p.ballVx = 0;
          p.ballVy = 0;
        } else {
          p.ballAngle += bSpeed * 0.08 * dtScale * (p.ballVx >= 0 ? 1 : -1);
        }

        // During the 3-second post-goal window, the ball is free to rebound or be kicked out of the goal!
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

      // 6. Real-Time Network Synchronization (60Hz WebRTC Lockstep + 60Hz /ws Direct Fast Channel)
      if (!isMatchFinished) {
        const myDistAfter = Math.hypot(p.ballX - p.myX, p.ballY - p.myY);
        const isDribblingNow =
          myDistAfter <= PLAYER_RADIUS + BALL_RADIUS + 16 &&
          myDistAfter < closestRemoteDistToBall - 4 &&
          now - lastLocalBallTouchMsRef.current < 900;

        if (localTouchedBall || isDribblingNow) {
          lastLocalBallTouchMsRef.current = now;
          remoteBallGraceUntilMsRef.current = 0;
          remoteBallActorUidRef.current = profile.uid;
        }

        const isClientActivelyControllingBall =
          currentRoom.hostUid !== profile.uid &&
          (localTouchedBall ||
            isDribblingNow ||
            now - lastLocalBallTouchMsRef.current < 340);

        if (
          rtcSession &&
          !rtcSession.isHost &&
          (localTouchedBall || isClientActivelyControllingBall)
        ) {
          rtcSession.sendClientBallTouch({
            ballX: p.ballX,
            ballY: p.ballY,
            ballVx: p.ballVx,
            ballVy: p.ballVy,
            lastTouchTeam: p.lastTouchTeam,
          });
        }

        // Broadcast 60Hz authoritative lockstep frame over WebRTC DataChannel when Host
        if (rtcSession && rtcSession.isHost) {
          const snapPlayers: Record<
            string,
            { x: number; y: number; vx: number; vy: number; kicking: boolean }
          > = {
            [profile.uid]: {
              x: p.myX,
              y: p.myY,
              vx: p.myVx,
              vy: p.myVy,
              kicking: p.myKicking,
            },
          };
          Object.values(allPlayers).forEach((rp) => {
            if (rp.playerId === profile.uid) return;
            const rState = p.remoteRenderPos[rp.playerId];
            snapPlayers[rp.playerId] = {
              x: rState ? rState.x : rp.x,
              y: rState ? rState.y : rp.y,
              vx: rState ? rState.vx : rp.vx || 0,
              vy: rState ? rState.vy : rp.vy || 0,
              kicking: rp.kicking || false,
            };
          });

          const activeBallActor =
            now < remoteBallGraceUntilMsRef.current
              ? remoteBallActorUidRef.current
              : now - lastLocalBallTouchMsRef.current < 360
                ? profile.uid
                : undefined;

          const resolved = rtcSession.resolveHostLockstepFrame(
            currentTick,
            { ...keysRef.current },
            {
              tick: currentTick,
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
              actorUid: activeBallActor,
              players: snapPlayers,
            }
          );
          if (resolved.ready) {
            peerInputsRef.current = resolved.frameInputs;
          }
        }

        const k = keysRef.current;
        const keyMask =
          (k.up ? 1 : 0) |
          (k.down ? 2 : 0) |
          (k.left ? 4 : 0) |
          (k.right ? 8 : 0) |
          (k.kick ? 16 : 0);

        const lastSent = lastSentPosRef.current;
        const posDelta = Math.hypot(p.myX - lastSent.x, p.myY - lastSent.y);
        const velDelta = Math.hypot(p.myVx - lastSent.vx, p.myVy - lastSent.vy);
        // Keep streaming 60Hz ticks for 400ms after stopping/colliding so resting coordinates never desync!
        const inPostMoveWindow = now - lastLocalActiveMoveMsRef.current < 400;
        const needFastSync =
          localMovedOrChanged ||
          inPostMoveWindow ||
          posDelta > 0.005 ||
          velDelta > 0.005 ||
          keyMask !== lastSent.keyMask;
        const needIdleBeacon = now - lastPlayerSyncMsRef.current >= 80;

        // Use >= 11ms instead of >= 16ms so 60Hz requestAnimationFrame (16.67ms) never skips every ~30th frame (0.5s beat)!
        if (
          (needFastSync && now - lastPlayerSyncMsRef.current >= 11) ||
          needIdleBeacon
        ) {
          lastPlayerSyncMsRef.current = now;
          const isCollidingNow = now - lastPlayerCollisionMsRef.current < 45;
          const txVx = isCollidingNow
            ? round4(p.myVx * 0.45 + preCollisionMyVx * 0.55)
            : p.myVx;
          const txVy = isCollidingNow
            ? round4(p.myVy * 0.45 + preCollisionMyVy * 0.55)
            : p.myVy;

          lastSentPosRef.current = {
            x: p.myX,
            y: p.myY,
            vx: txVx,
            vy: txVy,
            keyMask,
          };
          syncLocalPlayerDisc(
            currentRoom.roomId,
            profile.uid,
            {
              x: p.myX,
              y: p.myY,
              vx: txVx,
              vy: txVy,
              kicking: p.myKicking,
              keyMask,
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
        const isBallAuthority =
          isHostAuthority || localTouchedBall || isClientActivelyControllingBall;
        const ballMoving =
          Math.abs(p.ballVx) > 0.02 ||
          Math.abs(p.ballVy) > 0.02 ||
          localTouchedBall ||
          isClientActivelyControllingBall;

        if (
          isBallAuthority &&
          ballMoving &&
          p.eventState === 'normal' &&
          (localTouchedBall || now - lastBallSyncMsRef.current >= 11)
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
            actorUid:
              localTouchedBall || isClientActivelyControllingBall
                ? profile.uid
                : undefined,
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

  const handleExtrapolationChange = (nextVal: number) => {
    const clamped = Math.max(0, Math.min(MAX_EXTRAPOLATION_MS, Math.round(nextVal)));
    setExtrapolationMs(clamped);
    extrapolationMsRef.current = clamped;
    webrtcSessionRef.current?.setExtrapolation(clamped);
  };

  const redTeamRoster: RoomPlayerDoc[] = room.redUids.map((uid) => {
    return (
      players[uid] || {
        playerId: uid,
        roomId: room.roomId,
        nickname: uid === profile.uid ? profile.nickname : 'Игрок',
        jerseyNumber: uid === profile.uid ? profile.jerseyNumber : 10,
        team: 'red',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        kicking: false,
      }
    );
  });

  const blueTeamRoster: RoomPlayerDoc[] = room.blueUids.map((uid) => {
    return (
      players[uid] || {
        playerId: uid,
        roomId: room.roomId,
        nickname: uid === profile.uid ? profile.nickname : 'Игрок',
        jerseyNumber: uid === profile.uid ? profile.jerseyNumber : 10,
        team: 'blue',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        kicking: false,
      }
    );
  });

  return (
    <div className="relative flex flex-col items-center justify-center w-full h-screen overflow-hidden px-3 py-2 bg-slate-950 select-none">
      {/* Top-Center High-Contrast Match Scoreboard (HUD) — No Ping here (Ping is exclusively in Tab!) */}
      <div className="w-full max-w-[min(98vw,calc((100vh-3.75rem)*1400/760))] flex items-center justify-between gap-4 mb-1.5 shrink-0">
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

        {/* Utility Controls (Tab Scoreboard Button + Sound + Leave Room) */}
        <div className="flex items-center justify-end gap-2 min-w-[160px] md:min-w-[230px]">
          <button
            type="button"
            onClick={() => setTabOpen((prev) => !prev)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono-tabular transition-colors cursor-pointer ${
              tabOpen
                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-white'
            }`}
            title="Нажмите или удерживайте клавишу Tab для просмотра команд и пинга"
          >
            <span className="px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-[10px] font-bold text-white">
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

      {/* Main HTML5 Canvas Stadium Container (Maximized without bottom bar!) */}
      <div className="relative w-full max-w-[min(98vw,calc((100vh-3.75rem)*1400/760))] aspect-[1400/760] rounded-2xl overflow-hidden border-2 border-slate-800 shadow-2xl bg-[#14532d] my-auto">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="w-full h-full block"
        />

        {/* TAB Scoreboard Overlay: Teams, Nicknames, Ping (updated every 3s), and Extrapolation */}
        {tabOpen && !isFinished && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4">
            <div className="w-full max-w-3xl rounded-2xl bg-slate-900/95 border border-slate-700/90 shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="px-6 py-4 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-xs text-emerald-400 font-semibold">
                    <Shield className="w-3.5 h-3.5" />
                    <span>Таблица матча · WebRTC P2P Lockstep (60 Hz)</span>
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
    pingMs: number;
    isMe: boolean;
  }> = [];

  // Add remote players
  Object.values(players).forEach((rp) => {
    if (rp.playerId === localProfile.uid) return;
    const pos = phys.remoteRenderPos[rp.playerId] || {
      x: rp.x,
      y: rp.y,
      offsetX: 0,
      offsetY: 0,
    };
    renderList.push({
      uid: rp.playerId,
      nickname: rp.nickname,
      jerseyNumber: rp.jerseyNumber,
      team: rp.team,
      x: pos.x + (pos.offsetX || 0),
      y: pos.y + (pos.offsetY || 0),
      kicking: rp.kicking,
      pingMs: rp.pingMs ?? 24,
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
    x: phys.myX + (phys.myOffsetX || 0),
    y: phys.myY + (phys.myOffsetY || 0),
    kicking: phys.myKicking,
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

    // Player Nickname ONLY (Мелким белым текстом прямо НАД круглым персонажем игрока — без пинга!)
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

