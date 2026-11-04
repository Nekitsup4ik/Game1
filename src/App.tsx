import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Gamepad2,
  LogOut,
  Plus,
  Trophy,
  Trash2,
  UserCheck,
} from 'lucide-react';
import {
  MatchRoomDoc,
  PlayerProfile,
  RoomPlayerDoc,
} from './types/game';
import {
  createMatchRoom,
  deleteOrLeaveMatchRoom,
  joinMatchRoom,
  subscribeToActiveRoom,
  subscribeToLobbyRooms,
} from './services/roomService';
import { RoomLobbyView } from './components/RoomLobbyView';
import { MatchArena } from './components/MatchArena';

const STORAGE_NICKNAME_KEY = 'haxarena_nickname';
const STORAGE_NUMBER_KEY = 'haxarena_jersey_number';
const STORAGE_PLAYER_UID_KEY = 'haxarena_player_uid';

type NavTab = 'lobby' | 'profile' | 'rules' | 'controls';

function getOrCreatePlayerUid(): string {
  let uid = localStorage.getItem(STORAGE_PLAYER_UID_KEY);
  if (!uid) {
    uid = `player_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(STORAGE_PLAYER_UID_KEY, uid);
  }
  return uid;
}

export default function App() {
  const [playerUid] = useState<string>(() => getOrCreatePlayerUid());

  // Start Screen Form State (Никнейм + Игровой номер 1..99)
  const [nicknameInput, setNicknameInput] = useState<string>(() => {
    return localStorage.getItem(STORAGE_NICKNAME_KEY) || '';
  });
  const [jerseyInput, setJerseyInput] = useState<string>(() => {
    return localStorage.getItem(STORAGE_NUMBER_KEY) || '10';
  });
  const [previewTeam, setPreviewTeam] = useState<'red' | 'blue'>('red');
  const [profileConfirmed, setProfileConfirmed] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_NICKNAME_KEY);
    return Boolean(saved && saved.trim().length > 0);
  });
  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const saved = localStorage.getItem(STORAGE_NICKNAME_KEY);
    return saved && saved.trim().length > 0 ? 'lobby' : 'profile';
  });
  const [formError, setFormError] = useState<string | null>(null);

  // Lobby State
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [lobbyRooms, setLobbyRooms] = useState<Record<string, MatchRoomDoc>>({});
  const [newRoomTitle, setNewRoomTitle] = useState<string>('');
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');
  const [lobbyBusy, setLobbyBusy] = useState<boolean>(false);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  // Active Room & Match State
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<MatchRoomDoc | null>(null);
  const [activePlayers, setActivePlayers] = useState<Record<string, RoomPlayerDoc>>({});

  // 1. Subscribe to Active Lobby Rooms in Real Time once nickname is confirmed
  useEffect(() => {
    if (!profileConfirmed) {
      setRoomIds([]);
      setLobbyRooms({});
      return;
    }

    const unsub = subscribeToLobbyRooms((rooms) => {
      const nextMap: Record<string, MatchRoomDoc> = {};
      const nextIds: string[] = [];
      rooms.forEach((r) => {
        if (r.status !== 'finished' && r.memberUids.length > 0) {
          nextMap[r.roomId] = r;
          nextIds.push(r.roomId);
        }
      });
      setLobbyRooms(nextMap);
      setRoomIds(nextIds);
    });

    return () => unsub();
  }, [profileConfirmed]);

  // 2. Subscribe to Active Room Document & Players in Real Time (20Hz)
  useEffect(() => {
    if (!profileConfirmed || !activeRoomId) {
      setActiveRoom(null);
      setActivePlayers({});
      return;
    }

    const unsub = subscribeToActiveRoom(activeRoomId, (roomData, playersData) => {
      if (roomData) {
        setActiveRoom(roomData);
        setActivePlayers(playersData);
      } else {
        setActiveRoom(null);
        setActivePlayers({});
        setActiveRoomId(null);
      }
    });

    return () => unsub();
  }, [profileConfirmed, activeRoomId]);

  const handleSignOut = async () => {
    if (activeRoomId) {
      await handleLeaveCurrentRoom();
    }
    localStorage.removeItem(STORAGE_NICKNAME_KEY);
    setActiveRoomId(null);
    setProfileConfirmed(false);
    setActiveTab('profile');
  };

  const handleConfirmProfileForm = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedNick = nicknameInput.trim();
    if (trimmedNick.length < 1 || trimmedNick.length > 24) {
      setFormError('Пожалуйста, введите никнейм (от 1 до 24 символов).');
      return;
    }

    const parsedNum = Number(jerseyInput);
    if (!Number.isInteger(parsedNum) || parsedNum < 1 || parsedNum > 99) {
      setFormError('Игровой номер должен быть целым числом от 1 до 99.');
      return;
    }

    localStorage.setItem(STORAGE_NICKNAME_KEY, trimmedNick);
    localStorage.setItem(STORAGE_NUMBER_KEY, String(parsedNum));
    setNicknameInput(trimmedNick);
    setJerseyInput(String(parsedNum));
    setProfileConfirmed(true);
    setActiveTab('lobby');
  };

  const handleOpenLobbyTab = () => {
    if (!profileConfirmed) return;
    if (activeRoomId) {
      handleLeaveCurrentRoom();
    }
    setActiveTab('lobby');
  };

  const handleOpenProfileTab = () => {
    if (activeRoomId) {
      handleLeaveCurrentRoom();
    }
    setActiveTab('profile');
  };

  const handleOpenRulesTab = () => {
    if (activeRoomId) {
      handleLeaveCurrentRoom();
    }
    setActiveTab('rules');
  };

  const handleOpenControlsTab = () => {
    if (activeRoomId) {
      handleLeaveCurrentRoom();
    }
    setActiveTab('controls');
  };

  const currentProfile: PlayerProfile | null = profileConfirmed
    ? {
        uid: playerUid,
        nickname: nicknameInput.trim() || 'Игрок',
        jerseyNumber: Math.max(1, Math.min(99, parseInt(jerseyInput, 10) || 10)),
      }
    : null;

  const handleCreateRoom = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!currentProfile) return;
    setLobbyError(null);
    setLobbyBusy(true);
    try {
      const roomId = await createMatchRoom(currentProfile, newRoomTitle);
      setNewRoomTitle('');
      setActiveRoomId(roomId);
      setActiveTab('lobby');
    } catch (err) {
      setLobbyError(
        err instanceof Error ? err.message : 'Не удалось создать комнату.'
      );
    } finally {
      setLobbyBusy(false);
    }
  };

  const handleJoinRoom = async (roomIdToJoin: string) => {
    if (!currentProfile) return;
    const cleanId = roomIdToJoin.trim();
    if (!cleanId) return;
    setLobbyError(null);
    setLobbyBusy(true);
    try {
      const res = await joinMatchRoom(cleanId, currentProfile);
      if (!res.joined) {
        setLobbyError(res.reason || 'Не удалось войти в комнату.');
      } else {
        setActiveRoomId(cleanId);
        setJoinCodeInput('');
        setActiveTab('lobby');
      }
    } catch (err) {
      setLobbyError(
        err instanceof Error ? err.message : 'Ошибка подключения к комнате.'
      );
    } finally {
      setLobbyBusy(false);
    }
  };

  const handleLeaveCurrentRoom = async () => {
    const roomToLeave = activeRoom;
    setActiveRoomId(null);
    setActiveRoom(null);
    setActivePlayers({});
    if (roomToLeave) {
      await deleteOrLeaveMatchRoom(roomToLeave, playerUid).catch(() => {});
    }
  };

  const handleDeleteLobbyRoom = async (roomToDelete: MatchRoomDoc) => {
    setLobbyBusy(true);
    try {
      await deleteOrLeaveMatchRoom(roomToDelete, playerUid);
    } catch {
      // ignore if already deleted
    } finally {
      setLobbyBusy(false);
    }
  };

  // Only show active waiting or in-progress rooms (never finished rooms)
  const sortedRooms = roomIds
    .map((id) => lobbyRooms[id])
    .filter(
      (r): r is MatchRoomDoc =>
        Boolean(r) && r.status !== 'finished' && r.memberUids.length > 0
    );

  const previewNumber = Math.max(1, Math.min(99, parseInt(jerseyInput, 10) || 1));
  const previewNick = nicknameInput.trim() || 'Игрок';
  const isInActiveMatch = Boolean(
    profileConfirmed &&
      currentProfile &&
      activeRoom &&
      activeRoom.status !== 'waiting'
  );

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Top Bar Contract: Hidden during active match so the game window gets maximum screen space */}
      {!isInActiveMatch && (
        <header className="flex flex-wrap items-center justify-between gap-6 px-6 py-3.5 border-b border-slate-800/90 bg-slate-950">
          {/* Zone 1: Brand Title (Single Element) */}
          <button
            type="button"
            onClick={() => {
              if (profileConfirmed) {
                handleOpenLobbyTab();
              } else {
                handleOpenProfileTab();
              }
            }}
            className="font-display text-lg font-extrabold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            HaxArena 2D
          </button>

          {/* Zone 2: Concise Single-Line Navigation Links ("Лобби матчей" shown once player entered nickname) */}
          <nav className="flex flex-wrap items-center gap-5 sm:gap-6 text-sm font-medium">
            {profileConfirmed && (
              <button
                type="button"
                onClick={handleOpenLobbyTab}
                className={`transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === 'lobby'
                    ? 'text-emerald-400 font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Лобби матчей
              </button>
            )}
            <button
              type="button"
              onClick={handleOpenProfileTab}
              className={`transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'profile'
                  ? 'text-emerald-400 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Профиль и номер
            </button>
            <button
              type="button"
              onClick={handleOpenRulesTab}
              className={`transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'rules'
                  ? 'text-emerald-400 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Правила 4×4
            </button>
            <button
              type="button"
              onClick={handleOpenControlsTab}
              className={`transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'controls'
                  ? 'text-emerald-400 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Управление
            </button>
          </nav>

          {/* Zone 3: 1 Primary Action */}
          <div className="flex items-center shrink-0">
            {profileConfirmed ? (
              <button
                type="button"
                onClick={handleSignOut}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-200 bg-slate-900 border border-slate-800 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Сменить ник</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleOpenProfileTab}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-500 rounded-lg hover:bg-emerald-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <UserCheck className="w-3.5 h-3.5" />
                <span>Ввести ник</span>
              </button>
            )}
          </div>
        </header>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col">
        {activeRoomId && activeRoom && currentProfile ? (
          /* АКТИВНАЯ КОМНАТА ИЛИ МАТЧ */
          activeRoom.status === 'waiting' ? (
            <RoomLobbyView
              room={activeRoom}
              players={activePlayers}
              profile={currentProfile}
              onLeaveRoom={handleLeaveCurrentRoom}
            />
          ) : (
            <MatchArena
              room={activeRoom}
              players={activePlayers}
              profile={currentProfile}
              onExitToLobby={handleLeaveCurrentRoom}
              onCreateRematch={async () => {
                await handleLeaveCurrentRoom();
                await handleCreateRoom();
              }}
            />
          )
        ) : activeTab === 'rules' ? (
          /* ВКЛАДКА «ПРАВИЛА 4×4» */
          <div className="w-full max-w-5xl mx-auto px-6 py-10 space-y-8">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
              <div>
                <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
                  Регламент HaxArena 2D
                </div>
                <h1 className="mt-1 font-display font-extrabold text-2xl sm:text-3xl text-white">
                  Правила командных матчей 4×4
                </h1>
                <p className="mt-2 text-sm text-slate-400 max-w-2xl">
                  Полное описание правил игры, стартовых позиций, физики ворот, повершота, угловых и боковых аутов.
                </p>
              </div>
              {profileConfirmed ? (
                <button
                  type="button"
                  onClick={handleOpenLobbyTab}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-sm transition-colors cursor-pointer"
                >
                  <span>Перейти в лобби матчей</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleOpenProfileTab}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-sm transition-colors cursor-pointer"
                >
                  <span>Ввести ник и играть</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-3">
                <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  1. Формат матча и время
                </div>
                <h2 className="font-display font-bold text-lg text-white">
                  Команды 4×4 · Тайм 05:00
                </h2>
                <p className="text-xs text-slate-300 leading-relaxed">
                  В каждом матче соревнуются две команды — <strong className="text-red-400">Красные</strong> и <strong className="text-blue-400">Синие</strong> (до 4 игроков в каждой команде). В комнате ожидания перед стартом любой игрок может свободно переключаться между командами.
                </p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Длительность матча составляет ровно <strong className="text-white">5 минут (05:00)</strong>. Побеждает команда, забившая больше голов к моменту финального свистка.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-3">
                <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  2. Стартовая расстановка
                </div>
                <h2 className="font-display font-bold text-lg text-white">
                  Позиции игроков на своей половине
                </h2>
                <ul className="space-y-2 text-xs text-slate-300">
                  <li>
                    <strong className="text-white">1-й слот (У мяча):</strong> центральный нападающий прямо перед точкой развода в центре поля.
                  </li>
                  <li>
                    <strong className="text-white">2-й слот (Вратарь):</strong> защитник/голкипер непосредственно перед линией своих ворот.
                  </li>
                  <li>
                    <strong className="text-white">3-й слот (Центр верх):</strong> верхний центральный полузащитник на своей половине.
                  </li>
                  <li>
                    <strong className="text-white">4-й слот (Центр низ):</strong> нижний центральный полузащитник на своей половине.
                  </li>
                </ul>
              </div>

              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-3">
                <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  3. Голы, штанги и физика сетки
                </div>
                <h2 className="font-display font-bold text-lg text-white">
                  Мягкая сетка и 3 секунды после гола
                </h2>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Штанги ворот имеют твёрдый физический хитбокс — ни мяч, ни кружок игрока не могут пройти сквозь штангу. Когда мяч пересекает линию ворот в створе, мгновенно засчитывается гол и звучат фанфары.
                </p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Сетка ворот плавно тянется за мячом и мягко возвращает форму. После гола действует пауза <strong className="text-white">3 секунды</strong>, в течение которой мяч сохраняет физику (его можно выбить из ворот), а затем игроки и мяч возвращаются на расстановку в центр.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-3">
                <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  4. Стандарты: Ауты и Угловые
                </div>
                <h2 className="font-display font-bold text-lg text-white">
                  Ввод мяча с боковой и подача корнера
                </h2>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Если мяч уходит за боковую линию, назначается <strong className="text-white">боковой аут</strong> в пользу команды, не касавшейся мяча последней. Если мяч уходит за лицевую линию мимо ворот — назначается <strong className="text-white">угловой удар (корнер)</strong> с угловой дуги.
                </p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  При розыгрыше аута или углового вокруг мяча появляется пунктирный круг радиусом <strong className="text-white">74px</strong>, внутрь которого соперники не могут войти до первого касания.
                </p>
              </div>
            </div>

            <div className="rounded-2xl bg-emerald-950/30 border border-emerald-500/30 p-6 space-y-2">
              <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                5. Правило Повершота (Суперудара)
              </div>
              <h2 className="font-display font-bold text-lg text-white">
                4 секунды удержания в сером кружке → 2.5 секунды на мощный удар
              </h2>
              <p className="text-xs text-slate-300 leading-relaxed">
                Если игрок удерживает мяч в сером кружке вокруг своей фишки непрерывно <strong className="text-emerald-300">4 секунды</strong>, обводка мяча загорается ярко-зелёным цветом (<code className="text-emerald-400">#22c55e</code>). С этого момента у игрока есть ровно <strong className="text-emerald-300">2.5 секунды</strong>, чтобы нажать удар (<strong className="text-white">Пробел / X</strong>) и выполнить мощный Повершот. Если не ударить за 2.5 секунды — заряд пропадает, и чтобы зарядить его снова, нужно вывести мяч за пределы серого кружка и вновь удерживать его 4 секунды.
              </p>
            </div>
          </div>
        ) : activeTab === 'controls' ? (
          /* ВКЛАДКА «УПРАВЛЕНИЕ» */
          <div className="w-full max-w-5xl mx-auto px-6 py-10 space-y-8">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
              <div>
                <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
                  Клавиши и механики
                </div>
                <h1 className="mt-1 font-display font-extrabold text-2xl sm:text-3xl text-white">
                  Управление фишкой и мячом
                </h1>
                <p className="mt-2 text-sm text-slate-400 max-w-2xl">
                  Как двигаться по газону, мягко вести мяч кружком, пробивать по воротам, подавать угловые и заряжать Повершот.
                </p>
              </div>
              {profileConfirmed ? (
                <button
                  type="button"
                  onClick={handleOpenLobbyTab}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-sm transition-colors cursor-pointer"
                >
                  <span>Перейти в лобби матчей</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleOpenProfileTab}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-sm transition-colors cursor-pointer"
                >
                  <span>Ввести ник и играть</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                    Движение игрока
                  </span>
                  <span className="px-3 py-1 rounded-lg bg-slate-950 border border-slate-800 font-mono-tabular text-xs font-bold text-white">
                    WASD / Стрелочки
                  </span>
                </div>
                <h2 className="font-display font-bold text-lg text-white">
                  Перемещение и скольжение по полю
                </h2>
                <ul className="space-y-2 text-xs text-slate-300">
                  <li>
                    <strong className="text-white font-mono-tabular">W / ↑</strong> — движение вверх к верхней бровке.
                  </li>
                  <li>
                    <strong className="text-white font-mono-tabular">S / ↓</strong> — движение вниз к нижней бровке.
                  </li>
                  <li>
                    <strong className="text-white font-mono-tabular">A / ←</strong> — движение влево к левым воротам.
                  </li>
                  <li>
                    <strong className="text-white font-mono-tabular">D / →</strong> — движение вправо к правым воротам.
                  </li>
                </ul>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Кружок игрока имеет плавный разгон и естественное скольжение по траве. При зажатой клавише удара скорость движения слегка снижается для точного прицеливания.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                    Удар и Подача
                  </span>
                  <span className="px-3 py-1 rounded-lg bg-slate-950 border border-slate-800 font-mono-tabular text-xs font-bold text-white">
                    Пробел / X / Shift
                  </span>
                </div>
                <h2 className="font-display font-bold text-lg text-white">
                  Удар по мячу, пас и подача углового
                </h2>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Нажмите <strong className="text-white font-mono-tabular">Пробел (Space)</strong>, <strong className="text-white font-mono-tabular">X</strong> или <strong className="text-white font-mono-tabular">Shift</strong>, когда мяч находится внутри серого контура вокруг вашей фишки. Ободок вашей фишки загорится белым цветом и произойдёт удар вдоль линии от центра игрока к центру мяча.
                </p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  При подаче углового (корнера) удар автоматически получает навесной импульс для удобного прострела в штрафную площадь.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-3">
                <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  Техника дриблинга
                </div>
                <h2 className="font-display font-bold text-lg text-white">
                  Нежное ведение мяча кружком
                </h2>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Если подбежать к мячу <strong className="text-white">без нажатия кнопки удара</strong>, кружок игрока не отбивает мяч далеко и не издаёт звук удара. Мяч мягко катится от касания по честной 2D-нормали и не прилипает при поворотах влево-вправо, позволяя тонко обводить соперников.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-3">
                <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  Техника суперудара
                </div>
                <h2 className="font-display font-bold text-lg text-white">
                  Зарядка Повершота за 4 секунды
                </h2>
                <p className="text-xs text-slate-300 leading-relaxed">
                  1. Ведите или удерживайте мяч на сером кружке вокруг своей фишки <strong className="text-white">4 секунды</strong>.<br />
                  2. Контур мяча станет <strong className="text-emerald-400">зелёным</strong> — у вас есть <strong className="text-white">2.5 секунды</strong> на удар.<br />
                  3. Нажмите <strong className="text-white font-mono-tabular">Пробел / X</strong> для мощного выстрела (зелёная обводка сразу гаснет). Если не ударить за 2.5 секунды — отпустите мяч из серого кружка и зарядите снова.
                </p>
              </div>
            </div>
          </div>
        ) : !profileConfirmed || !currentProfile || activeTab === 'profile' ? (
          /* ВКЛАДКА «ПРОФИЛЬ И НОМЕР» (Вход сразу по Никнейму и Игровому номеру 1..99 без Google) */
          <div className="flex-1 flex items-center justify-center px-6 py-10">
            <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
              {/* Left Column: Direct Nickname & Jersey Registration Form */}
              <div className="lg:col-span-7 rounded-2xl bg-slate-900 border border-slate-800 p-6 sm:p-8 flex flex-col justify-between shadow-2xl">
                <div>
                  <div className="text-xs font-medium text-emerald-400">
                    Командный 2D-мультиплеер · 4 на 4 · Матч 5 минут
                  </div>
                  <h1 className="mt-2 font-display font-extrabold text-2xl sm:text-3xl text-white text-balance">
                    Вход в игру по никнейму
                  </h1>
                  <p className="mt-2 text-sm text-slate-400">
                    Введите свой игровой никнейм и выберите номер на футболке от 1 до 99. Никнейм отображается над вашей фишкой, а номер — внутри кружка.
                  </p>

                  {formError && (
                    <div className="mt-4 px-4 py-3 rounded-xl bg-red-950/60 border border-red-500/40 text-xs text-red-200">
                      {formError}
                    </div>
                  )}

                  <form onSubmit={handleConfirmProfileForm} className="mt-6 space-y-5">
                    <div>
                      <label
                        htmlFor="nickname-input"
                        className="block text-xs font-semibold text-slate-300 mb-2"
                      >
                        Никнейм игрока (отображается над фишкой) *
                      </label>
                      <input
                        id="nickname-input"
                        type="text"
                        required
                        maxLength={24}
                        value={nicknameInput}
                        onChange={(e) => setNicknameInput(e.target.value)}
                        placeholder="Например: Striker_RU"
                        className="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 focus:border-emerald-500 focus:outline-none text-sm text-white placeholder:text-slate-600"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="jersey-input"
                        className="block text-xs font-semibold text-slate-300 mb-2"
                      >
                        Игровой номер от 1 до 99 (белым цветом внутри фишки) *
                      </label>
                      <div className="flex items-center gap-3">
                        <input
                          id="jersey-input"
                          type="number"
                          required
                          min={1}
                          max={99}
                          value={jerseyInput}
                          onChange={(e) => setJerseyInput(e.target.value)}
                          className="w-32 px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 focus:border-emerald-500 focus:outline-none font-mono-tabular font-bold text-lg text-white text-center"
                        />
                        <div className="flex flex-wrap gap-1.5">
                          {[7, 9, 10, 11, 23, 77, 99].map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => setJerseyInput(String(preset))}
                              className={`px-2.5 py-1.5 rounded-lg font-mono-tabular text-xs font-semibold border transition-colors cursor-pointer ${
                                Number(jerseyInput) === preset
                                  ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                              }`}
                            >
                              #{preset}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <button
                      type="submit"
                      className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-base shadow-lg shadow-emerald-500/20 transition-colors cursor-pointer"
                    >
                      <UserCheck className="w-5 h-5" />
                      <span>Войти в лобби матчей</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </form>
                </div>

                <div className="mt-6 pt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-500">
                  <span>WASD / Стрелочки — движение</span>
                  <span>·</span>
                  <span>Пробел / X — удар</span>
                  <span>·</span>
                  <span>Повершот — 4с контроля</span>
                </div>
              </div>

              {/* Right Column: Live Interactive Preview of Player Disc on Turf */}
              <div className="lg:col-span-5 rounded-2xl bg-slate-900 border border-slate-800 p-6 sm:p-8 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">
                      Предпросмотр фишки на поле
                    </span>
                    <div className="flex items-center gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800">
                      <button
                        type="button"
                        onClick={() => setPreviewTeam('red')}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                          previewTeam === 'red'
                            ? 'bg-red-600 text-white'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        Красные
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewTeam('blue')}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                          previewTeam === 'blue'
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        Синие
                      </button>
                    </div>
                  </div>

                  {/* Mini Stadium Turf Preview Box */}
                  <div className="mt-4 h-56 rounded-xl bg-[#15803d] border-2 border-white/80 relative flex flex-col items-center justify-center overflow-hidden shadow-inner">
                    {/* Center line & circle decoration */}
                    <div className="absolute inset-y-0 left-1/2 w-0.5 bg-white/40 -translate-x-1/2" />
                    <div className="w-28 h-28 rounded-full border-2 border-white/40 absolute" />

                    {/* Nickname rendered directly ABOVE the circular disc in white */}
                    <div className="relative z-10 mb-1.5 px-2 py-0.5 rounded bg-slate-950/75 text-[12px] font-semibold text-white tracking-tight shadow">
                      {previewNick}
                    </div>

                    {/* Circular Player Disc with White Jersey Number INSIDE */}
                    <div
                      className={`relative z-10 w-14 h-14 rounded-full flex items-center justify-center font-mono-tabular font-bold text-xl text-white border-[3px] shadow-xl ${
                        previewTeam === 'red'
                          ? 'bg-red-600 border-white'
                          : 'bg-blue-600 border-white'
                      }`}
                    >
                      {previewNumber}
                    </div>
                  </div>
                </div>

                <div className="mt-6 space-y-2.5 text-xs text-slate-400">
                  <div className="font-semibold text-slate-200">
                    Краткая памятка HaxArena:
                  </div>
                  <p>
                    1. Команды до 4 человек (формат 4×4: Красные против Синих). Таймер матча — 05:00.
                  </p>
                  <p>
                    2. Удержание мяча 4 сек в сером кружке включает зелёный Повершот (окно 2.5 сек на удар).
                  </p>
                  <div className="pt-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleOpenRulesTab}
                      className="text-emerald-400 hover:underline font-medium cursor-pointer"
                    >
                      Все правила 4×4 →
                    </button>
                    <button
                      type="button"
                      onClick={handleOpenControlsTab}
                      className="text-emerald-400 hover:underline font-medium cursor-pointer"
                    >
                      Управление →
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ВКЛАДКА «ЛОББИ МАТЧЕЙ» (Доступна после входа через Google) */
          <div className="w-full max-w-6xl mx-auto px-6 py-8">
            {/* Player Profile Banner & Quick Create Match */}
            <div className="flex flex-wrap items-center justify-between gap-6 pb-8 border-b border-slate-800">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-red-600 border-2 border-white flex items-center justify-center font-mono-tabular font-bold text-lg text-white shadow-md shrink-0">
                  {currentProfile.jerseyNumber}
                </div>
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>Игрок авторизован</span>
                    <span aria-hidden="true">·</span>
                    <span>Номер #{currentProfile.jerseyNumber}</span>
                    <span aria-hidden="true">·</span>
                    <button
                      type="button"
                      onClick={handleOpenProfileTab}
                      className="text-emerald-400 hover:underline cursor-pointer"
                    >
                      Изменить ник / номер
                    </button>
                  </div>
                  <h1 className="font-display font-extrabold text-2xl sm:text-3xl text-white">
                    {currentProfile.nickname}
                  </h1>
                </div>
              </div>

              {/* Create Match Form («Создать матч») */}
              <form
                onSubmit={handleCreateRoom}
                className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto"
              >
                <input
                  type="text"
                  maxLength={60}
                  value={newRoomTitle}
                  onChange={(e) => setNewRoomTitle(e.target.value)}
                  placeholder="Название комнаты (необязательно)"
                  className="flex-1 sm:w-64 px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 focus:border-emerald-500 focus:outline-none text-xs text-white placeholder:text-slate-500"
                />
                <button
                  type="submit"
                  disabled={lobbyBusy}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-display font-bold text-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Создать матч</span>
                </button>
              </form>
            </div>

            {lobbyError && (
              <div className="mt-6 px-4 py-3 rounded-xl bg-red-950/60 border border-red-500/40 text-xs text-red-200">
                {lobbyError}
              </div>
            )}

            {/* Room List + Join by Code */}
            <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
              {/* Left 8 Columns: Active Match Rooms */}
              <div className="lg:col-span-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-display font-bold text-lg text-white">
                    Доступные комнаты ({sortedRooms.length})
                  </h2>
                  <span className="text-xs text-slate-400">
                    Обновление списка комнат в реальном времени
                  </span>
                </div>

                {sortedRooms.length === 0 ? (
                  <div className="rounded-2xl bg-slate-900/70 border border-slate-800 p-10 text-center">
                    <Gamepad2 className="w-10 h-10 text-slate-500 mx-auto mb-3" />
                    <h3 className="font-display font-bold text-base text-white">
                      Пока нет активных комнат
                    </h3>
                    <p className="mt-1 text-xs text-slate-400 max-w-md mx-auto">
                      Нажмите кнопку «Создать матч», чтобы открыть новую комнату 4×4 и пригласить игроков.
                    </p>
                    <button
                      type="button"
                      disabled={lobbyBusy}
                      onClick={() => handleCreateRoom()}
                      className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-xs transition-colors cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Создать первый матч</span>
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {sortedRooms.map((r) => {
                      const isWaiting = r.status === 'waiting';
                      const isPlaying = r.status === 'playing';
                      const isMember = r.memberUids.includes(currentProfile.uid);

                      return (
                        <div
                          key={r.roomId}
                          className="rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 p-5 flex flex-wrap items-center justify-between gap-4 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-xs text-slate-400">
                              <span
                                className={
                                  isWaiting
                                    ? 'text-emerald-400 font-semibold'
                                    : isPlaying
                                      ? 'text-amber-400 font-semibold'
                                      : 'text-slate-500'
                                }
                              >
                                {isWaiting
                                  ? 'Ожидание игроков'
                                  : isPlaying
                                    ? `Идёт матч (${r.redScore} : ${r.blueScore})`
                                    : `Завершён (${r.redScore} : ${r.blueScore})`}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>Хост: {r.hostName}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono-tabular">
                                Красные {r.redUids.length}/4 · Синие {r.blueUids.length}/4
                              </span>
                            </div>
                            <h3 className="mt-1 font-display font-bold text-lg text-white truncate">
                              {r.title}
                            </h3>
                          </div>

                          <div className="flex items-center gap-2.5 shrink-0">
                            {(r.hostUid === currentProfile.uid || isMember) && (
                              <button
                                type="button"
                                disabled={lobbyBusy}
                                onClick={() => handleDeleteLobbyRoom(r)}
                                title="Удалить комнату"
                                className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-red-500/50 text-slate-400 hover:text-red-400 transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={lobbyBusy || (!isWaiting && !isMember)}
                              onClick={() => handleJoinRoom(r.roomId)}
                              className={`px-4 py-2.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                isWaiting || isMember
                                  ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold'
                                  : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                              }`}
                            >
                              {isMember
                                ? 'Вернуться в матч'
                                : isWaiting
                                  ? 'Войти в комнату'
                                  : 'Матч уже идёт'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right 4 Columns: Join by Code & Controls Info */}
              <div className="lg:col-span-4 space-y-6">
                <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6">
                  <h3 className="font-display font-bold text-base text-white">
                    Вход по коду комнаты
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    Если друг поделился кодом комнаты, вставьте его ниже для прямого входа:
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      type="text"
                      value={joinCodeInput}
                      onChange={(e) => setJoinCodeInput(e.target.value)}
                      placeholder="room_..."
                      className="flex-1 px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 focus:border-emerald-500 focus:outline-none font-mono-tabular text-xs text-white"
                    />
                    <button
                      type="button"
                      disabled={lobbyBusy || !joinCodeInput.trim()}
                      onClick={() => handleJoinRoom(joinCodeInput)}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Войти
                    </button>
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-3 text-xs text-slate-400">
                  <div className="flex items-center gap-2 font-display font-bold text-sm text-white">
                    <Trophy className="w-4 h-4 text-amber-400" />
                    <span>Памятка игрока</span>
                  </div>
                  <div className="flex items-center justify-between py-1.5 border-b border-slate-800/80">
                    <span>Перемещение фишки</span>
                    <span className="font-mono-tabular text-slate-200">WASD / Стрелки</span>
                  </div>
                  <div className="flex items-center justify-between py-1.5 border-b border-slate-800/80">
                    <span>Удар по мячу</span>
                    <span className="font-mono-tabular text-slate-200">Пробел / X</span>
                  </div>
                  <div className="flex items-center justify-between py-1.5 border-b border-slate-800/80">
                    <span>Повершот (зелёный мяч)</span>
                    <span className="font-mono-tabular text-emerald-400">4с удержания → 2.5с окно</span>
                  </div>
                  <div className="flex items-center justify-between py-1.5">
                    <span>Длительность тайма</span>
                    <span className="font-mono-tabular text-slate-200">05:00</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
