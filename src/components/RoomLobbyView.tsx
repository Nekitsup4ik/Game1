import React, { useEffect, useState } from 'react';
import { ArrowLeftRight, Copy, Check, LogOut, Play, Shield, Users, Wifi } from 'lucide-react';
import {
  MatchRoomDoc,
  MAX_TEAM_SIZE,
  PlayerProfile,
  RoomPlayerDoc,
} from '../types/game';
import {
  getLocalPingMs,
  sendRoomHeartbeat,
  startMatchByHost,
  switchPlayerTeam,
} from '../services/roomService';

interface RoomLobbyViewProps {
  room: MatchRoomDoc;
  players: Record<string, RoomPlayerDoc>;
  profile: PlayerProfile;
  onLeaveRoom: () => void;
}

export const RoomLobbyView: React.FC<RoomLobbyViewProps> = ({
  room,
  players,
  profile,
  onLeaveRoom,
}) => {
  const [busyAction, setBusyAction] = useState<'switch' | 'start' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<boolean>(false);
  const [localPing, setLocalPing] = useState<number>(() => getLocalPingMs());

  useEffect(() => {
    sendRoomHeartbeat(room.roomId, profile.uid).catch(() => {});
    const id = window.setInterval(() => {
      setLocalPing(getLocalPingMs());
      sendRoomHeartbeat(room.roomId, profile.uid).catch(() => {});
    }, 3000);
    return () => window.clearInterval(id);
  }, [room.roomId, profile.uid]);

  const isHost = room.hostUid === profile.uid;
  const myTeam = room.blueUids.includes(profile.uid) ? 'blue' : 'red';

  const redPlayers: RoomPlayerDoc[] = room.redUids.map((uid) => {
    return (
      players[uid] || {
        playerId: uid,
        roomId: room.roomId,
        nickname: uid === profile.uid ? profile.nickname : 'Игрок...',
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

  const bluePlayers: RoomPlayerDoc[] = room.blueUids.map((uid) => {
    return (
      players[uid] || {
        playerId: uid,
        roomId: room.roomId,
        nickname: uid === profile.uid ? profile.nickname : 'Игрок...',
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

  const handleSwitchTeam = async () => {
    setErrorMessage(null);
    setBusyAction('switch');
    try {
      const res = await switchPlayerTeam(room, profile);
      if (!res.switched && res.reason) {
        setErrorMessage(res.reason);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Не удалось сменить команду.'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleStartMatch = async () => {
    if (!isHost) return;
    setErrorMessage(null);
    setBusyAction('start');
    try {
      await startMatchByHost(room, players);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Ошибка при запуске матча.'
      );
      setBusyAction(null);
    }
  };

  const handleCopyRoomId = () => {
    navigator.clipboard.writeText(room.roomId).catch(() => {});
    setCopiedId(true);
    window.setTimeout(() => setCopiedId(false), 1800);
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-6 py-8">
      {/* Room Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span>Лобби комнаты</span>
            <span aria-hidden="true">·</span>
            <span>Организатор: {room.hostName}</span>
            <span aria-hidden="true">·</span>
            <span>Длительность матча: 5:00</span>
          </div>
          <h1 className="mt-1 font-display font-bold text-2xl sm:text-3xl text-white">
            {room.title}
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleCopyRoomId}
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-mono-tabular text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedId ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span>Код скопирован</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-slate-400" />
                <span>Код: {room.roomId.slice(0, 14)}...</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onLeaveRoom}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Покинуть комнату</span>
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="mt-4 px-4 py-3 rounded-xl bg-red-950/60 border border-red-500/40 text-xs text-red-200">
          {errorMessage}
        </div>
      )}

      {/* Two Columns: Red Team (up to 5) & Blue Team (up to 5) */}
      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
        {/* Column 1: Красная команда */}
        <div className="flex flex-col rounded-2xl bg-slate-900/90 border border-red-500/30 p-6">
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-3">
              <div className="w-4 h-4 rounded-full bg-red-600 border border-red-300" />
              <h2 className="font-display font-bold text-lg text-red-400">
                Красная команда
              </h2>
            </div>
            <span className="font-mono-tabular text-xs font-semibold text-slate-400">
              {redPlayers.length} / {MAX_TEAM_SIZE} игроков
            </span>
          </div>

          <div className="mt-4 space-y-2.5 flex-1">
            {Array.from({ length: MAX_TEAM_SIZE }).map((_, idx) => {
              const p = redPlayers[idx];
              if (!p) {
                return (
                  <div
                    key={`red-empty-${idx}`}
                    className="h-14 rounded-xl border border-dashed border-slate-800/90 px-4 flex items-center justify-between text-xs text-slate-500"
                  >
                    <span>Свободный слот #{idx + 1}</span>
                    <span className="font-mono-tabular">Ожидание</span>
                  </div>
                );
              }

              const isMe = p.playerId === profile.uid;
              const pPing = isMe ? localPing : p.pingMs ?? 24;
              const pingClass =
                pPing < 55
                  ? 'text-emerald-400 border-emerald-500/30 bg-emerald-950/40'
                  : pPing < 110
                    ? 'text-amber-400 border-amber-500/30 bg-amber-950/40'
                    : 'text-red-400 border-red-500/30 bg-red-950/40';
              return (
                <div
                  key={p.playerId}
                  className={`h-14 rounded-xl px-4 flex items-center justify-between gap-2 border ${
                    isMe
                      ? 'bg-red-950/45 border-red-500/60'
                      : 'bg-slate-950/70 border-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Circular Red Disc with White Jersey Number INSIDE */}
                    <div className="w-9 h-9 rounded-full bg-red-600 border-2 border-red-300 flex items-center justify-center font-mono-tabular font-bold text-xs text-white shrink-0 shadow">
                      {p.jerseyNumber}
                    </div>
                    <div className="truncate">
                      <div className="text-sm font-semibold text-white truncate">
                        {p.nickname}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Номер #{p.jerseyNumber}
                        {p.playerId === room.hostUid ? ' · Создатель комнаты' : ''}
                        {isMe ? ' · Вы' : ''}
                      </div>
                    </div>
                  </div>
                  <div
                    className={`flex items-center gap-1 px-2 py-1 rounded-md border font-mono-tabular text-[11px] font-semibold shrink-0 ${pingClass}`}
                    title="Сетевой пинг игрока"
                  >
                    <Wifi className="w-3 h-3" />
                    <span>{pPing} мс</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Column 2: Синяя команда */}
        <div className="flex flex-col rounded-2xl bg-slate-900/90 border border-blue-500/30 p-6">
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-3">
              <div className="w-4 h-4 rounded-full bg-blue-600 border border-blue-300" />
              <h2 className="font-display font-bold text-lg text-blue-400">
                Синяя команда
              </h2>
            </div>
            <span className="font-mono-tabular text-xs font-semibold text-slate-400">
              {bluePlayers.length} / {MAX_TEAM_SIZE} игроков
            </span>
          </div>

          <div className="mt-4 space-y-2.5 flex-1">
            {Array.from({ length: MAX_TEAM_SIZE }).map((_, idx) => {
              const p = bluePlayers[idx];
              if (!p) {
                return (
                  <div
                    key={`blue-empty-${idx}`}
                    className="h-14 rounded-xl border border-dashed border-slate-800/90 px-4 flex items-center justify-between text-xs text-slate-500"
                  >
                    <span>Свободный слот #{idx + 1}</span>
                    <span className="font-mono-tabular">Ожидание</span>
                  </div>
                );
              }

              const isMe = p.playerId === profile.uid;
              const pPing = isMe ? localPing : p.pingMs ?? 24;
              const pingClass =
                pPing < 55
                  ? 'text-emerald-400 border-emerald-500/30 bg-emerald-950/40'
                  : pPing < 110
                    ? 'text-amber-400 border-amber-500/30 bg-amber-950/40'
                    : 'text-red-400 border-red-500/30 bg-red-950/40';
              return (
                <div
                  key={p.playerId}
                  className={`h-14 rounded-xl px-4 flex items-center justify-between gap-2 border ${
                    isMe
                      ? 'bg-blue-950/45 border-blue-500/60'
                      : 'bg-slate-950/70 border-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Circular Blue Disc with White Jersey Number INSIDE */}
                    <div className="w-9 h-9 rounded-full bg-blue-600 border-2 border-blue-300 flex items-center justify-center font-mono-tabular font-bold text-xs text-white shrink-0 shadow">
                      {p.jerseyNumber}
                    </div>
                    <div className="truncate">
                      <div className="text-sm font-semibold text-white truncate">
                        {p.nickname}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Номер #{p.jerseyNumber}
                        {p.playerId === room.hostUid ? ' · Создатель комнаты' : ''}
                        {isMe ? ' · Вы' : ''}
                      </div>
                    </div>
                  </div>
                  <div
                    className={`flex items-center gap-1 px-2 py-1 rounded-md border font-mono-tabular text-[11px] font-semibold shrink-0 ${pingClass}`}
                    title="Сетевой пинг игрока"
                  >
                    <Wifi className="w-3 h-3" />
                    <span>{pPing} мс</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bottom Action Bar: «Сменить команду» & «СТАРТ» (for Host) */}
      <div className="mt-8 rounded-2xl bg-slate-900 border border-slate-800 p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={handleSwitchTeam}
            className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-sm font-semibold text-white border border-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ArrowLeftRight className="w-4 h-4 text-emerald-400" />
            <span>
              Сменить команду (в {myTeam === 'red' ? 'Синюю' : 'Красную'})
            </span>
          </button>

          <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400">
            <Users className="w-4 h-4 text-slate-500" />
            <span>Всего в комнате: {room.memberUids.length} / {MAX_TEAM_SIZE * 2}</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {isHost ? (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={handleStartMatch}
              className="flex items-center gap-2.5 px-8 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-display font-bold text-base tracking-wide shadow-lg shadow-emerald-500/20 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>СТАРТ</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <Shield className="w-4 h-4 text-emerald-400" />
              <span>Ожидание нажатия кнопки «СТАРТ» создателем комнаты ({room.hostName})</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
