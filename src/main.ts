import "./styles.css";
import { Peer } from "peerjs";
import type { DataConnection } from "peerjs";
import {
  CHILD_LABELS as childLabels,
  HUMAN_PLAYER_ID as humanPlayerId,
  MAX_TRIES_PER_PARENT as maxTriesPerParent,
  POISON_REMOVAL_LIMIT_MS as poisonRemovalLimitMs,
  VISIBLE_CARD_COUNT as visibleCardCount
} from "./game/config";
import { canStackFishCards, createShuffledDeck, drawCard, stackFaceUpFishCards, useFaceUpCard } from "./game/deck";
import { randomInt, shuffle } from "./game/random";
import {
  estimateFishCaptureValue as estimateBoardFishCaptureValue,
  getParentCloseTotal as getBoardParentCloseTotal,
  getPlayerCandidates as getBoardPlayerCandidates,
  resolvePredation as resolveBoardPredation,
  sumCapturedIds as sumBoardCapturedIds
} from "./game/rules";
import { getAppRoot, getFocusedControlIdentity, restoreFocusedControl } from "./ui/dom";
import type {
  BaitBoxCard,
  BoxCard,
  EscapeBoxCard,
  FishBoxCard,
  FishCard,
  FishValue,
  Player,
  PlayerCard,
  PoisonBoxCard,
  PoisonCardStatus,
  PoisonState
} from "./game/model";

type GameEffect = {
  kind: "bite" | "escape";
  label: "パク！" | "ヒューん！";
};
type TryEndReason = "parent-close" | "escape" | "poison-timeout";
type BiteAftermath = "fed" | "poisoned";
type TryReplayEvent =
  | { kind: "play"; boxId: number }
  | { kind: "eat"; predatorId: number; preyId: number; bundleIds: number[]; points: number }
  | { kind: "poison"; poisonId: number; outcome: "triggered" | "removed" | "overridden" | "cancelled"; points: number }
  | { kind: "escape"; fishId: number; points: number }
  | { kind: "ineffective"; boxId: number; reason: "own-poison" | "escape-failed" };
type ScheduledTryReplayEvent = TryReplayEvent & { at: number };
type TryReplayNumericState = {
  card: BaitBoxCard | FishBoxCard;
  capturedIds: number[];
  consumedById: number | null;
};
type TryReplaySchedule = {
  events: ScheduledTryReplayEvent[];
  finalAt: number;
  duration: number;
};
type MouthFishMotion = {
  enteringId: number;
  predatorId: number | null;
  preyIds: number[];
  cameraFrom: number;
  cameraTo: number;
};
type GameMode = "pvp" | "cpu" | "online";
type OnlineRole = "none" | "host" | "guest";
type CpuDifficulty = "easy" | "normal" | "hard";
type NpcChildAction =
  | { type: "play" | "escape"; slotIndex: number }
  | { type: "stack"; sourceSlotIndex: number; targetSlotIndex: number };
type StackDragState = {
  pointerId: number;
  playerId: string;
  sourceSlotIndex: number;
  sourceCardId: number;
  stackValue: "2" | "3";
  startX: number;
  startY: number;
  started: boolean;
  sourceButton: HTMLButtonElement;
  targetButton: HTMLButtonElement | null;
};
type OnlineLobbyMember = { playerId: string; name: string; isHost: boolean };
type OnlineGameState = {
  playerCount: number;
  parentIndex: number;
  completedParentRounds: number;
  currentTry: number;
  players: Player[];
  boxCards: BoxCard[];
  activePoison: PoisonState | null;
  isMouthOpen: boolean;
  isTryEnded: boolean;
  biteAftermath: BiteAftermath | null;
  isTryReplayActive: boolean;
  mouthFishMotion: MouthFishMotion | null;
  isGameOver: boolean;
  logEntries: string[];
  poisonDeadlineAt: number | null;
  tryEndReason: TryEndReason | null;
  tryStartScores: Record<string, number>;
};

const appRoot = getAppRoot();
const biteAftermathDurationMs = 1500;
const mouthFishMotionDurationMs = 900;

const fishArtPaths: Record<FishValue, string> = {
  2: "./assets/cards/value-2-sardine.png",
  3: "./assets/cards/value-3-fish.png",
  4: "./assets/cards/value-4-octopus.png",
  5: "./assets/cards/value-5-shark.png",
  6: "./assets/cards/value-5-shark.png"
};

let hasStarted = false;
let gameMode: GameMode = "cpu";
let modeSetupOpen = false;
let pendingGameMode: GameMode = "cpu";
let cpuDifficulty: CpuDifficulty = "normal";
let onlineLobbyOpen = false;
let onlineRole: OnlineRole = "none";
let onlinePeer: Peer | null = null;
let hostConnection: DataConnection | null = null;
let guestConnections: DataConnection[] = [];
let connectionPlayerIds = new Map<string, string>();
let onlineHumanPlayerIds = new Set<string>();
let onlinePlayerNames = new Map<string, string>();
let onlineLobbyMembers: OnlineLobbyMember[] = [];
let localPlayerId = humanPlayerId;
let roomCode = "";
let draftRoomCode = "";
let draftPlayerName = "";
let onlineStatus = "";
let playerCount = 4;
let draftPlayerCount = 4;
let parentIndex = 0;
let draftParentIndex = 0;
let completedParentRounds = 0;
let currentTry = 1;
let nextCardId = 1;
let nextBoxCardId = 1;
let nextSequence = 1;
let players: Player[] = [];
let boxCards: BoxCard[] = [];
let activePoison: PoisonState | null = null;
let isMouthOpen = false;
let isTryEnded = false;
let biteAftermath: BiteAftermath | null = null;
let biteAftermathTimerId: number | null = null;
let isTryReplayActive = false;
let tryReplayTimerId: number | null = null;
let mouthFishMotion: MouthFishMotion | null = null;
let mouthFishMotionTimerId: number | null = null;
let isGameOver = false;
let logEntries: string[] = [];
let npcChildTimerId: number | null = null;
let npcParentTimerId: number | null = null;
let npcParentCloseAt: number | null = null;
let mouthOpenedAt: number | null = null;
let gameEffect: GameEffect | null = null;
let gameEffectTimerId: number | null = null;
let poisonDeadlineAt: number | null = null;
let poisonResolutionTimerId: number | null = null;
let poisonCountdownIntervalId: number | null = null;
let tryEndReason: TryEndReason | null = null;
let tryStartScores: Record<string, number> = {};
let stackDragState: StackDragState | null = null;
let suppressNextCardClick = false;
let suppressClickTimerId: number | null = null;

const simpleActions: Record<string, () => void> = {
  "start-pvp": () => openModeSetup("pvp"),
  "start-cpu": () => openModeSetup("cpu"),
  "back-to-title": returnToTitle,
  "open-online-lobby": () => openModeSetup("online"),
  "confirm-player-count": confirmPlayerCount,
  "create-room": createOnlineRoom,
  "join-room": joinOnlineRoom,
  "start-online-game": startOnlineGame,
  "apply-setup": applySetup,
  "open-mouth": openMouth,
  "close-mouth": closeMouth,
  "skip-try-replay": skipTryReplay,
  "remove-poison": removeActivePoison,
  "next-try": prepareNextTry,
  "advance-parent": advanceParent,
  "reset-game": resetGameWithConfirmation
};

render();

appRoot.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) return;

  if (suppressNextCardClick) {
    suppressNextCardClick = false;
    event.preventDefault();
    return;
  }

  const countButton = target.closest<HTMLButtonElement>("button[data-player-count]");
  if (countButton) {
    draftPlayerCount = Number(countButton.dataset.playerCount);
    if (draftParentIndex >= draftPlayerCount) draftParentIndex = 0;
    render();
    return;
  }

  const difficultyButton = target.closest<HTMLButtonElement>("button[data-cpu-difficulty]");
  if (difficultyButton) {
    cpuDifficulty = difficultyButton.dataset.cpuDifficulty as CpuDifficulty;
    render();
    return;
  }

  const button = target.closest<HTMLButtonElement>("button[data-action]");

  if (!button) return;

  const action = button.dataset.action ?? "";
  const simpleAction = simpleActions[action];

  if (onlineRole === "guest" && hasStarted && isRemoteGameAction(action)) {
    sendOnlineMessage({
      type: "action",
      action,
      playerId: button.dataset.playerId,
      slotIndex: Number(button.dataset.slotIndex)
    });
    return;
  }

  if (simpleAction) {
    simpleAction();
    return;
  }

  const cardTarget = getCardActionTarget(button);

  if (!cardTarget) return;

  if (action === "escape-card") {
    escapeWithCard(cardTarget.playerId, cardTarget.slotIndex);
  } else if (action === "play-card") {
    playCard(cardTarget.playerId, cardTarget.slotIndex);
  }
});

appRoot.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  const button = target.closest<HTMLButtonElement>("button[data-stack-value]");
  const cardTarget = button ? getStackCardIdentity(button) : null;

  if (!button || !cardTarget || button.disabled) return;

  cancelStackDrag();
  stackDragState = {
    pointerId: event.pointerId,
    playerId: cardTarget.playerId,
    sourceSlotIndex: cardTarget.slotIndex,
    sourceCardId: cardTarget.cardId,
    stackValue: cardTarget.stackValue,
    startX: event.clientX,
    startY: event.clientY,
    started: false,
    sourceButton: button,
    targetButton: null
  };
  button.setPointerCapture(event.pointerId);
});

appRoot.addEventListener("pointermove", (event) => {
  const drag = stackDragState;
  if (!drag || event.pointerId !== drag.pointerId) return;

  if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 8) return;

  drag.started = true;
  event.preventDefault();
  drag.sourceButton.classList.add("is-stack-dragging");
  setStackDropTarget(getStackDropTarget(event.clientX, event.clientY, drag));
});

appRoot.addEventListener("pointerup", (event) => {
  const drag = stackDragState;
  if (!drag || event.pointerId !== drag.pointerId) return;

  const targetButton = drag.started ? getStackDropTarget(event.clientX, event.clientY, drag) : null;

  if (!drag.started || !targetButton) {
    cancelStackDrag();
    return;
  }

  event.preventDefault();
  const targetIdentity = getStackCardIdentity(targetButton);
  suppressCardClickAfterDrag();
  cancelStackDrag();

  if (!targetIdentity) return;
  requestStackCards(
    drag.playerId,
    drag.sourceSlotIndex,
    targetIdentity.slotIndex,
    drag.sourceCardId,
    targetIdentity.cardId
  );
});

appRoot.addEventListener("pointercancel", (event) => {
  if (stackDragState?.pointerId === event.pointerId) cancelStackDrag();
});

appRoot.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "s") return;
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  const sourceIdentity = getStackCardIdentity(target);
  if (!sourceIdentity || target.disabled) return;

  const matchingTarget = [...appRoot.querySelectorAll<HTMLButtonElement>("button[data-stack-value]")]
    .find((button) => {
      const identity = getStackCardIdentity(button);
      return (
        identity !== null &&
        !button.disabled &&
        identity.playerId === sourceIdentity.playerId &&
        identity.slotIndex !== sourceIdentity.slotIndex &&
        identity.stackValue === sourceIdentity.stackValue
      );
    });

  const targetIdentity = matchingTarget ? getStackCardIdentity(matchingTarget) : null;
  if (!targetIdentity) return;

  event.preventDefault();
  requestStackCards(
    sourceIdentity.playerId,
    sourceIdentity.slotIndex,
    targetIdentity.slotIndex,
    sourceIdentity.cardId,
    targetIdentity.cardId
  );
});

appRoot.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.name === "roomCode") {
    draftRoomCode = target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    target.value = draftRoomCode;
  } else if (target.name === "playerName") {
    draftPlayerName = target.value.slice(0, 12);
  }
});

appRoot.addEventListener("change", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLSelectElement)) return;

  if (target.name === "playerCount") {
    draftPlayerCount = Number(target.value);

    if (draftParentIndex >= draftPlayerCount) {
      draftParentIndex = 0;
    }

    render();
    return;
  }

  if (target.name === "parentIndex") {
    draftParentIndex = Number(target.value);
    render();
  }
});

function getCardActionTarget(button: HTMLButtonElement): { playerId: string; slotIndex: number } | null {
  const playerId = button.dataset.playerId;
  const slotIndex = Number(button.dataset.slotIndex);

  return playerId && Number.isInteger(slotIndex) ? { playerId, slotIndex } : null;
}

function getStackCardIdentity(button: HTMLButtonElement): {
  playerId: string;
  slotIndex: number;
  cardId: number;
  stackValue: "2" | "3";
} | null {
  const playerId = button.dataset.playerId;
  const slotIndex = Number(button.dataset.slotIndex);
  const cardId = Number(button.dataset.cardId);
  const stackValue = button.dataset.stackValue;

  if (!playerId || !Number.isInteger(slotIndex) || !Number.isInteger(cardId)) return null;
  if (stackValue !== "2" && stackValue !== "3") return null;
  return { playerId, slotIndex, cardId, stackValue };
}

function getStackDropTarget(clientX: number, clientY: number, drag: StackDragState): HTMLButtonElement | null {
  const element = document.elementFromPoint(clientX, clientY);
  const button = element instanceof Element ? element.closest<HTMLButtonElement>("button[data-stack-value]") : null;
  const identity = button ? getStackCardIdentity(button) : null;

  if (!button || !identity || button.disabled) return null;
  if (identity.playerId !== drag.playerId || identity.slotIndex === drag.sourceSlotIndex) return null;
  if (identity.stackValue !== drag.stackValue) return null;
  return button;
}

function setStackDropTarget(button: HTMLButtonElement | null): void {
  const drag = stackDragState;
  if (!drag || drag.targetButton === button) return;
  drag.targetButton?.classList.remove("is-stack-target");
  drag.targetButton = button;
  drag.targetButton?.classList.add("is-stack-target");
}

function cancelStackDrag(): void {
  const drag = stackDragState;
  if (!drag) return;
  drag.sourceButton.classList.remove("is-stack-dragging");
  drag.targetButton?.classList.remove("is-stack-target");
  if (drag.sourceButton.hasPointerCapture(drag.pointerId)) {
    drag.sourceButton.releasePointerCapture(drag.pointerId);
  }
  stackDragState = null;
}

function suppressCardClickAfterDrag(): void {
  suppressNextCardClick = true;
  if (suppressClickTimerId !== null) window.clearTimeout(suppressClickTimerId);
  suppressClickTimerId = window.setTimeout(() => {
    suppressNextCardClick = false;
    suppressClickTimerId = null;
  }, 80);
}

function requestStackCards(
  playerId: string,
  sourceSlotIndex: number,
  targetSlotIndex: number,
  expectedSourceCardId: number,
  expectedTargetCardId: number
): void {
  if (onlineRole === "guest") {
    sendOnlineMessage({
      type: "action",
      action: "stack-cards",
      playerId,
      slotIndex: sourceSlotIndex,
      targetSlotIndex,
      sourceCardId: expectedSourceCardId,
      targetCardId: expectedTargetCardId
    });
    return;
  }

  stackCardsIntoSchool(
    playerId,
    sourceSlotIndex,
    targetSlotIndex,
    expectedSourceCardId,
    expectedTargetCardId
  );
}

function stackCardsIntoSchool(
  playerId: string,
  sourceSlotIndex: number,
  targetSlotIndex: number,
  expectedSourceCardId?: number,
  expectedTargetCardId?: number
): void {
  if (mouthFishMotion) return;

  const player = getPlayer(playerId);
  if (player.role !== "child" || !isMouthOpen || isTryEnded || isGameOver) return;

  const school = stackFaceUpFishCards(
    player,
    sourceSlotIndex,
    targetSlotIndex,
    expectedSourceCardId,
    expectedTargetCardId
  );

  if (!school?.schoolBaseValue) return;
  const refillText = player.faceUp[sourceSlotIndex]
    ? "空いた場所には山札から1枚補充しました。"
    : "山札がないため、空いた場所はそのままです。";
  addLog(`${player.name} が ${school.schoolBaseValue} を2枚重ね、強さ ${school.value} の群れを作りました。${refillText}`);
  render();
}

function setupNewGame(): void {
  clearNpcTimers();
  clearGameEffect();
  playerCount = draftPlayerCount;
  parentIndex = draftParentIndex;
  completedParentRounds = 0;
  currentTry = 1;
  nextCardId = 1;
  nextBoxCardId = 1;
  nextSequence = 1;
  isGameOver = false;
  players = createPlayers();
  logEntries = [];
  startParentRound();
  addLog("ゲーム開始。全員が1回ずつ親を担当したら終了です。");
  render();
}

function startGame(mode: GameMode): void {
  gameMode = mode;
  localPlayerId = humanPlayerId;
  hasStarted = true;
  setupNewGame();
}

function openModeSetup(mode: GameMode): void {
  pendingGameMode = mode;
  modeSetupOpen = true;
  render();
}

function confirmPlayerCount(): void {
  modeSetupOpen = false;
  if (pendingGameMode === "online") {
    openOnlineLobby();
  } else {
    startGame(pendingGameMode);
  }
}

function returnToTitle(): void {
  if (hasStarted && !confirmDiscardProgress()) return;
  clearNpcTimers();
  clearPoisonRemovalTimer();
  clearBiteAftermath();
  clearTryReplay();
  clearMouthFishMotion();
  destroyOnlineSession();
  hasStarted = false;
  onlineLobbyOpen = false;
  modeSetupOpen = false;
  render();
}

function openOnlineLobby(): void {
  gameMode = "online";
  onlineLobbyOpen = true;
  onlineStatus = "部屋を作るか、参加コードを入力してください。";
  render();
}

function createOnlineRoom(): void {
  destroyOnlineSession();
  gameMode = "online";
  onlineRole = "host";
  localPlayerId = "player-1";
  roomCode = createRoomCode();
  onlineHumanPlayerIds = new Set([localPlayerId]);
  onlinePlayerNames = new Map([[localPlayerId, getEnteredPlayerName("ホスト")]]);
  updateOnlineLobbyMembers();
  onlineStatus = "部屋を作成しています…";
  render();

  onlinePeer = new Peer(`into-mouth-${roomCode}`);
  onlinePeer.on("open", () => {
    onlineStatus = "参加者を待っています。コードを友達に送ってください。";
    render();
  });
  onlinePeer.on("connection", attachGuestConnection);
  onlinePeer.on("error", (error) => {
    onlineStatus = error.type === "unavailable-id" ? "コードが重複しました。もう一度、部屋を作成してください。" : "接続できませんでした。通信環境を確認してください。";
    render();
  });
}

function joinOnlineRoom(): void {
  if (draftRoomCode.length !== 6) {
    onlineStatus = "6文字の参加コードを入力してください。";
    render();
    return;
  }

  destroyOnlineSession();
  gameMode = "online";
  onlineRole = "guest";
  roomCode = draftRoomCode;
  onlineStatus = "部屋に接続しています…";
  render();

  onlinePeer = new Peer();
  onlinePeer.on("open", () => {
    hostConnection = onlinePeer?.connect(`into-mouth-${roomCode}`, {
      reliable: true,
      metadata: { playerName: getEnteredPlayerName("ゲスト") }
    }) ?? null;
    if (hostConnection) attachHostConnection(hostConnection);
  });
  onlinePeer.on("error", () => {
    onlineStatus = "部屋が見つからないか、接続できませんでした。コードを確認してください。";
    render();
  });
}

function attachGuestConnection(connection: DataConnection): void {
  connection.on("open", () => {
    const availableId = Array.from({ length: draftPlayerCount - 1 }, (_, index) => `player-${index + 2}`).find((id) => !onlineHumanPlayerIds.has(id));
    if (!availableId) {
      connection.send({ type: "room-full" });
      connection.close();
      return;
    }

    guestConnections.push(connection);
    connectionPlayerIds.set(connection.peer, availableId);
    onlineHumanPlayerIds.add(availableId);
    const metadata = connection.metadata as { playerName?: string } | undefined;
    onlinePlayerNames.set(availableId, sanitizePlayerName(metadata?.playerName, `プレイヤー${onlineHumanPlayerIds.size}`));
    updateOnlineLobbyMembers();
    connection.send({ type: "welcome", playerId: availableId, roomCode });
    onlineStatus = `${onlineHumanPlayerIds.size}人が参加中です。ホストがゲームを開始できます。`;
    broadcastOnlineLobby();
    render();
  });
  connection.on("data", (data) => handleHostMessage(connection, data));
  connection.on("close", () => {
    const playerId = connectionPlayerIds.get(connection.peer);
    if (playerId) onlineHumanPlayerIds.delete(playerId);
    if (playerId) onlinePlayerNames.delete(playerId);
    connectionPlayerIds.delete(connection.peer);
    guestConnections = guestConnections.filter((item) => item !== connection);
    onlineStatus = "参加者が退出しました。";
    updateOnlineLobbyMembers();
    broadcastOnlineLobby();
    render();
  });
}

function attachHostConnection(connection: DataConnection): void {
  connection.on("open", () => {
    onlineStatus = "接続しました。ホストが開始するのを待っています。";
    render();
  });
  connection.on("data", (data) => handleGuestMessage(data));
  connection.on("close", () => {
    onlineStatus = "ホストとの接続が切れました。";
    hasStarted = false;
    onlineLobbyOpen = true;
    render();
  });
}

function handleHostMessage(connection: DataConnection, raw: unknown): void {
  const message = raw as {
    type?: string;
    action?: string;
    playerId?: string;
    slotIndex?: number;
    targetSlotIndex?: number;
    sourceCardId?: number;
    targetCardId?: number;
  };
  if (message.type !== "action" || !message.action) return;

  const assignedId = connectionPlayerIds.get(connection.peer);
  if (!assignedId) return;
  if (message.action === "stack-cards") {
    if (
      message.playerId !== assignedId ||
      !Number.isInteger(message.slotIndex) ||
      !Number.isInteger(message.targetSlotIndex) ||
      !Number.isInteger(message.sourceCardId) ||
      !Number.isInteger(message.targetCardId)
    ) return;
    stackCardsIntoSchool(
      assignedId,
      message.slotIndex!,
      message.targetSlotIndex!,
      message.sourceCardId!,
      message.targetCardId!
    );
    return;
  }
  if (message.action === "play-card" || message.action === "escape-card") {
    if (message.playerId !== assignedId || !Number.isInteger(message.slotIndex)) return;
    message.action === "play-card" ? playCard(assignedId, message.slotIndex!) : escapeWithCard(assignedId, message.slotIndex!);
    return;
  }

  if (message.action === "next-try") {
    prepareNextTry();
    return;
  }
  if (message.action === "advance-parent") {
    advanceParent();
    return;
  }

  if (getParent().id !== assignedId) return;
  if (message.action === "open-mouth") openMouth();
  if (message.action === "close-mouth") closeMouth();
  if (message.action === "remove-poison") removeActivePoison();
}

function handleGuestMessage(raw: unknown): void {
  const message = raw as { type?: string; playerId?: string; state?: OnlineGameState; members?: OnlineLobbyMember[]; playerCount?: number };
  if (message.type === "welcome" && message.playerId) {
    localPlayerId = message.playerId;
    onlineHumanPlayerIds.add(message.playerId);
    onlineStatus = "接続しました。ホストが開始するのを待っています。";
    render();
  } else if (message.type === "lobby" && message.members) {
    onlineLobbyMembers = message.members;
    if (message.playerCount) draftPlayerCount = message.playerCount;
    onlineStatus = `${message.members.length}人が参加中です。ホストが開始するのを待っています。`;
    render();
  } else if (message.type === "state" && message.state) {
    applyOnlineState(message.state);
  } else if (message.type === "room-full") {
    onlineStatus = "この部屋は満員です。";
    render();
  }
}

function startOnlineGame(): void {
  if (onlineRole !== "host" || onlineHumanPlayerIds.size < 2) return;
  playerCount = draftPlayerCount;
  parentIndex = 0;
  draftParentIndex = 0;
  hasStarted = true;
  onlineLobbyOpen = false;
  setupNewGame();
}

function createRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function getEnteredPlayerName(fallback: string): string {
  return sanitizePlayerName(draftPlayerName, fallback);
}

function sanitizePlayerName(value: string | undefined, fallback: string): string {
  const name = (value ?? "").trim().replace(/[<>]/g, "").slice(0, 12);
  return name || fallback;
}

function updateOnlineLobbyMembers(): void {
  onlineLobbyMembers = [...onlineHumanPlayerIds].map((playerId) => ({
    playerId,
    name: onlinePlayerNames.get(playerId) ?? playerId,
    isHost: playerId === "player-1"
  }));
}

function broadcastOnlineLobby(): void {
  const message = { type: "lobby", members: onlineLobbyMembers, playerCount: draftPlayerCount };
  guestConnections.filter((connection) => connection.open).forEach((connection) => connection.send(message));
}

function destroyOnlineSession(): void {
  hostConnection?.close();
  guestConnections.forEach((connection) => connection.close());
  onlinePeer?.destroy();
  hostConnection = null;
  guestConnections = [];
  connectionPlayerIds.clear();
  onlineHumanPlayerIds.clear();
  onlinePlayerNames.clear();
  onlineLobbyMembers = [];
  onlinePeer = null;
  onlineRole = "none";
  roomCode = "";
}

function isRemoteGameAction(action: string): boolean {
  return ["open-mouth", "close-mouth", "remove-poison", "play-card", "escape-card", "stack-cards", "next-try", "advance-parent"].includes(action);
}

function sendOnlineMessage(message: object): void {
  if (hostConnection?.open) hostConnection.send(message);
}

function applySetup(): void {
  if (!confirmDiscardProgress()) return;
  setupNewGame();
}

function resetGameWithConfirmation(): void {
  if (!confirmDiscardProgress()) return;
  setupNewGame();
}

function confirmDiscardProgress(): boolean {
  if (isGameOver) return true;

  const hasProgress = isMouthOpen || currentTry > 1 || completedParentRounds > 0 || boxCards.length > 1 || players.some((player) => player.score > 0);
  return !hasProgress || window.confirm("現在のゲームを終了して、得点と進行を初期化しますか？");
}

function startParentRound(): void {
  currentTry = 1;
  isGameOver = false;

  for (const [index, player] of players.entries()) {
    player.role = index === parentIndex ? "parent" : "child";

    if (player.role === "child") {
      resetChildDeck(player);
    } else {
      player.drawPile = [];
      player.faceUp = [];
      player.used = [];
    }
  }

  resetTryBox();
  addLog(`${getParent().name} の親ラウンド開始。子の山札を11枚に補給し、3枚を公開しました。必ず3トライ行います。`);
}

function resetTryBox(): void {
  clearNpcTimers();
  clearPoisonRemovalTimer();
  clearBiteAftermath();
  clearTryReplay();
  clearMouthFishMotion();
  nextSequence = 1;
  boxCards = [createBaitBoxCard()];
  tryStartScores = Object.fromEntries(players.map((player) => [player.id, player.score]));
  activePoison = null;
  isMouthOpen = false;
  mouthOpenedAt = null;
  isTryEnded = false;
  tryEndReason = null;
}

function createPlayers(): Player[] {
  return Array.from({ length: playerCount }, (_, index) => {
    const playerId = `player-${index + 1}`;
    const isCpu =
      (gameMode === "cpu" && playerId !== localPlayerId) ||
      (gameMode === "online" && !onlineHumanPlayerIds.has(playerId));
    return {
    id: playerId,
    name: isCpu ? `CPU ${index + 1}` : gameMode === "online" ? (onlinePlayerNames.get(playerId) ?? `プレイヤー${index + 1}`) : `プレイヤー${index + 1}`,
    role: index === parentIndex ? "parent" : "child",
    score: 0,
    drawPile: [],
    faceUp: [],
    used: []
  };
  });
}

function resetChildDeck(player: Player): void {
  player.drawPile = createShuffledDeck(() => nextCardId++);
  player.faceUp = Array.from({ length: visibleCardCount }, () => drawCard(player));
  player.used = [];
}

function createBaitBoxCard(): BaitBoxCard {
  const parent = getParent();

  return {
    boxId: nextBoxCardId++,
    type: "bait",
    value: 1,
    ownerId: parent.id,
    ownerName: parent.name,
    sequence: nextSequence++,
    consumedById: null
  };
}


function openMouth(): void {
  if (isGameOver || isMouthOpen || isTryEnded) return;

  isMouthOpen = true;
  npcParentCloseAt = null;
  mouthOpenedAt = Date.now();
  addLog(`${getParent().name} が口を開けました。カードは押した順に処理します。`);
  render();
}

function closeMouth(): void {
  if (!isMouthOpen || isGameOver || mouthFishMotion) return;

  const parent = getParent();
  tryEndReason = "parent-close";
  showMouthCloseEffect();

  if (activePoison) {
    const poisonOwner = getPlayer(activePoison.ownerId);
    poisonOwner.score += 10;
    markPoisonResolved(activePoison.boxId, "triggered");
    clearPoisonRemovalTimer();
    addLog(`${parent.name} が毒魚を残したまま閉じました。${activePoison.ownerName} が10点、親は0点です。`);
    activePoison = null;
    finishTry();
    startBiteAftermath("poisoned");
    return;
  }

  const total = getParentCloseTotal();
  parent.score += total;
  addLog(`${parent.name} が口を閉じました。親自身の餌・毒魚・逃げる・毒魚で得点化済みの魚を除き、親が ${total} 点を獲得しました。`);
  finishTry();
  startBiteAftermath("fed");
}

function finishTry(): void {
  clearNpcTimers();
  clearPoisonRemovalTimer();
  clearMouthFishMotion();

  if (activePoison) {
    markPoisonResolved(activePoison.boxId, "cancelled");
    activePoison = null;
  }

  isMouthOpen = false;
  mouthOpenedAt = null;
  isTryEnded = true;

  if (currentTry >= maxTriesPerParent) {
    addLog(`${getParent().name} の${maxTriesPerParent}回目のトライが終了しました。親を交代できます。`);
  } else {
    addLog(`トライ${currentTry}終了。次のトライへ進めます。`);
  }
}

function prepareNextTry(): void {
  if (isGameOver || isMouthOpen || !isTryEnded || currentTry >= maxTriesPerParent) return;

  currentTry += 1;
  resetTryBox();
  addLog(`トライ${currentTry}を準備しました。餌カード「1」を箱に戻し、各子の山札と公開札は引き継ぎました。`);
  render();
}

function advanceParent(): void {
  if (isGameOver || isMouthOpen || !isTryEnded || currentTry < maxTriesPerParent) return;

  completedParentRounds += 1;

  if (completedParentRounds >= playerCount) {
    isGameOver = true;
    isMouthOpen = false;
    isTryEnded = true;
    addLog(`ゲーム終了。勝者: ${getWinnerText()}。`);
    render();
    return;
  }

  parentIndex = (parentIndex + 1) % playerCount;
  startParentRound();
  render();
}

function removeActivePoison(): void {
  if (!isMouthOpen || !activePoison) return;

  if (poisonDeadlineAt !== null && Date.now() >= poisonDeadlineAt) {
    resolveExpiredPoison(activePoison.boxId);
    return;
  }

  const removedPoison = activePoison;
  markPoisonResolved(removedPoison.boxId, "removed");
  activePoison = null;
  clearPoisonRemovalTimer();
  clearMouthFishMotion();
  addLog(`${getParent().name} が ${removedPoison.ownerName} の毒魚を取り除きました。通常どおり続行します。`);
  render();
}

function playCard(playerId: string, slotIndex: number): void {
  if (mouthFishMotion) return;

  const player = getPlayer(playerId);
  const card = player.faceUp[slotIndex];

  if (!card || player.role !== "child") return;

  if (!isMouthOpen || isGameOver) {
    addLog("口が開いている間だけカードを出せます。");
    render();
    return;
  }

  if (card.type === "poison") {
    playPoison(player, slotIndex);
    return;
  }

  playFish(player, slotIndex);
}

function playFish(player: Player, slotIndex: number): void {
  const card = useFaceUpCard(player, slotIndex);

  if (!card || card.type !== "fish") return;

  const cameraFrom = getMouthCameraZoom();
  const liveBeforeIds = new Set(getLiveMouthNumericCards().map((item) => item.boxId));
  const fishBoxCard: FishBoxCard = {
    boxId: nextBoxCardId++,
    sourceCardId: card.id,
    type: "fish",
    value: card.value,
    schoolBaseValue: card.schoolBaseValue,
    schoolSize: card.schoolSize,
    componentCardIds: card.componentCardIds,
    ownerId: player.id,
    ownerName: player.name,
    sequence: nextSequence++,
    consumedById: null,
    capturedIds: [],
    poisonScoredById: null,
    poisonScoredByName: null,
    invalidatedByOwnPoison: false,
    escaped: false
  };

  boxCards.push(fishBoxCard);

  if (activePoison?.ownerId === player.id) {
    fishBoxCard.invalidatedByOwnPoison = true;
    startFishEntryMotion(fishBoxCard, liveBeforeIds, cameraFrom);
    addLog(`${player.name} は自分の毒魚に続けて${getFishCardLabel(card)}を出したため、このカードは効果も得点価値も持ちません。`);
    render();
    return;
  }

  if (activePoison) {
    const poisonOwner = getPlayer(activePoison.ownerId);
    poisonOwner.score += card.value;
    fishBoxCard.poisonScoredById = activePoison.ownerId;
    fishBoxCard.poisonScoredByName = activePoison.ownerName;
    markPoisonResolved(activePoison.boxId, "triggered");
    clearPoisonRemovalTimer();
    addLog(`${player.name} が${getFishCardLabel(card)}を出しました。${activePoison.ownerName} の毒魚が発動し、${activePoison.ownerName} が ${card.value} 点を確定しました。`);
    activePoison = null;
    startFishEntryMotion(fishBoxCard, liveBeforeIds, cameraFrom);
    render();
    return;
  }

  fishBoxCard.capturedIds = resolvePredation(fishBoxCard);

  startFishEntryMotion(fishBoxCard, liveBeforeIds, cameraFrom);
  const capturedTotal = sumCapturedIds(fishBoxCard.capturedIds, fishBoxCard.ownerId);
  const predator = fishBoxCard.consumedById ? getBoxCard(fishBoxCard.consumedById) : null;
  const detail = predator?.type === "fish"
    ? `魚「${card.value}」は、先にいた魚「${predator.value}」に食べられました。`
    : fishBoxCard.capturedIds.length > 0
      ? capturedTotal > 0
        ? `自分のカードを除き、得点候補 ${capturedTotal} 点を持ちました。`
        : "魚を食べましたが、自分のカードだけなので得点候補は0点です。"
      : "何も食べられず、得点候補はありません。";
  addLog(`${player.name} が${getFishCardLabel(card)}を出しました。${detail}`);
  render();
}

function startFishEntryMotion(
  fish: FishBoxCard,
  liveBeforeIds: Set<number>,
  cameraFrom: number
): void {
  const predatorId = fish.consumedById ?? (fish.capturedIds.length > 0 ? fish.boxId : null);
  const newlyConsumedIds = predatorId === null
    ? []
    : [...liveBeforeIds].filter((boxId) => {
        const card = getBoxCard(boxId);
        return (card?.type === "bait" || card?.type === "fish") && card.consumedById === predatorId;
      });
  const preyIds = fish.consumedById
    ? [fish.boxId, ...newlyConsumedIds]
    : newlyConsumedIds;

  startMouthFishMotion({
    enteringId: fish.boxId,
    predatorId,
    preyIds: [...new Set(preyIds)],
    cameraFrom,
    cameraTo: getMouthCameraZoom()
  });
}

function getFishCardLabel(card: FishCard | FishBoxCard): string {
  return card.schoolBaseValue
    ? `${card.schoolBaseValue}の群れ（強さ${card.value}）`
    : `魚「${card.value}」`;
}

function playPoison(player: Player, slotIndex: number): void {
  const card = useFaceUpCard(player, slotIndex);

  if (!card || card.type !== "poison") return;

  const cameraZoom = getMouthCameraZoom();
  const previousPoison = activePoison;

  if (previousPoison) {
    markPoisonResolved(previousPoison.boxId, "overridden");
  }

  const poisonBoxCard: PoisonBoxCard = {
    boxId: nextBoxCardId++,
    sourceCardId: card.id,
    type: "poison",
    ownerId: player.id,
    ownerName: player.name,
    sequence: nextSequence++,
    status: "active"
  };

  boxCards.push(poisonBoxCard);
  activePoison = {
    boxId: poisonBoxCard.boxId,
    ownerId: player.id,
    ownerName: player.name
  };
  startMouthFishMotion({
    enteringId: poisonBoxCard.boxId,
    predatorId: null,
    preyIds: [],
    cameraFrom: cameraZoom,
    cameraTo: cameraZoom
  });
  startPoisonRemovalTimer();
  const takeoverText = previousPoison ? `${previousPoison.ownerName} から得点の権利を奪いました。` : "";
  addLog(`${player.name} が毒魚を入れました。${takeoverText}親は3秒以内に取り除く必要があります。`);
  render();
}

function escapeWithCard(playerId: string, slotIndex: number): void {
  if (mouthFishMotion) return;

  const player = getPlayer(playerId);

  if (player.role !== "child") return;

  if (!isMouthOpen || isGameOver) {
    addLog("口が開いている間だけ逃げるカードを出せます。");
    render();
    return;
  }

  const card = useFaceUpCard(player, slotIndex);

  if (!card) return;

  const target = findEscapeTarget(player.id);

  const escapeCard: EscapeBoxCard = {
    boxId: nextBoxCardId++,
    sourceCardId: card.id,
    type: "escape",
    ownerId: player.id,
    ownerName: player.name,
    sequence: nextSequence++,
    successful: target !== null
  };

  boxCards.push(escapeCard);

  if (!target) {
    addLog(`${player.name} は逃げる権利がない状態でカードを出しました。このカードは効果も得点価値も持たず、使用済みになります。`);
    render();
    return;
  }

  const total = sumCapturedIds(target.capturedIds, player.id);
  target.escaped = true;
  player.score += total;
  tryEndReason = "escape";
  showEscapeSuccessEffect();
  addLog(`${player.name} が逃げに成功しました。最新の得点候補から ${total} 点を確定し、このトライは終了です。`);
  finishTry();
  startTryReplay();
}

function resolvePredation(newFish: FishBoxCard): number[] {
  return resolveBoardPredation(boxCards, newFish);
}

function findEscapeTarget(playerId: string): FishBoxCard | null {
  const candidates = getPlayerCandidates(playerId);
  return candidates.at(-1) ?? null;
}

function getPlayerCandidates(playerId: string): FishBoxCard[] {
  return getBoardPlayerCandidates(boxCards, playerId);
}

function markPoisonResolved(boxId: number, status: Exclude<PoisonCardStatus, "active">): void {
  const poison = boxCards.find((card): card is PoisonBoxCard => card.type === "poison" && card.boxId === boxId);

  if (!poison) return;

  poison.status = status;
}

function getParentCloseTotal(): number {
  return getBoardParentCloseTotal(boxCards, getParent().id);
}

function getLiveMouthNumericCards(): Array<BaitBoxCard | FishBoxCard> {
  return boxCards.filter((card): card is BaitBoxCard | FishBoxCard => {
    if (card.type === "bait") return card.consumedById === null;
    if (card.type !== "fish") return false;
    return (
      card.consumedById === null &&
      !card.invalidatedByOwnPoison &&
      !card.poisonScoredById &&
      !card.escaped
    );
  });
}

function getLargestLiveMouthValue(): number {
  return getLiveMouthNumericCards().reduce(
    (largest, card) => Math.max(largest, card.value),
    1
  );
}

function getMouthCameraZoom(): number {
  const largestValue = getLargestLiveMouthValue();

  if (largestValue <= 2) return 3;
  if (largestValue === 3) return 2.25;
  if (largestValue === 4) return 1.68;
  if (largestValue === 5) return 1.28;
  return 1;
}

function sumCapturedIds(cardIds: number[], scoringPlayerId: string): number {
  return sumBoardCapturedIds(boxCards, cardIds, scoringPlayerId);
}

function getParent(): Player {
  return players[parentIndex];
}

function getChildren(): Player[] {
  return players.filter((player) => player.role === "child");
}

function getPlayer(playerId: string): Player {
  const player = players.find((item) => item.id === playerId);

  if (!player) {
    throw new Error(`Unknown player: ${playerId}`);
  }

  return player;
}

function getPlayerToneNumber(playerId: string): number {
  const numberedId = /^player-(\d+)$/.exec(playerId);
  if (numberedId) return ((Number(numberedId[1]) - 1) % 6) + 1;

  const hash = [...playerId].reduce((total, character) => total + character.charCodeAt(0), 0);
  return (hash % 6) + 1;
}

function getPlayerToneClass(playerId: string): string {
  return `player-tone player-tone-${getPlayerToneNumber(playerId)}`;
}

function renderPlayerIdentity(player: Player): string {
  const toneNumber = getPlayerToneNumber(player.id);

  return `
    <span class="player-identity">
      <span class="player-color-key" aria-label="プレイヤー${toneNumber}のカラー">P${toneNumber}</span>
      <span class="player-identity-name">${player.name}</span>
    </span>
  `;
}

function getWinningPlayers(): Player[] {
  const highestScore = Math.max(...players.map((player) => player.score));
  return players.filter((player) => player.score === highestScore);
}

function getWinnerText(): string {
  return getWinningPlayers()
    .map((player) => `${player.name} ${player.score}点`)
    .join(" / ");
}

function renderWinnerNotice(): string {
  return `
    <div class="winner-notice" role="status">
      <span class="winner-label">勝者</span>
      <div class="winner-list">
        ${getWinningPlayers()
          .map(
            (player) => `
              <span class="winner-chip ${getPlayerToneClass(player.id)}">
                ${renderPlayerIdentity(player)}
                <strong>${player.score}点</strong>
              </span>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function addLog(message: string): void {
  logEntries = [message, ...logEntries].slice(0, 14);
}

function startPoisonRemovalTimer(): void {
  clearPoisonRemovalTimer();

  if (!activePoison) return;

  const poisonBoxId = activePoison.boxId;
  poisonDeadlineAt = Date.now() + poisonRemovalLimitMs;
  poisonResolutionTimerId = window.setTimeout(() => resolveExpiredPoison(poisonBoxId), poisonRemovalLimitMs);
  poisonCountdownIntervalId = window.setInterval(updatePoisonCountdownDisplay, 100);
}

function clearPoisonRemovalTimer(): void {
  if (poisonResolutionTimerId !== null) {
    window.clearTimeout(poisonResolutionTimerId);
    poisonResolutionTimerId = null;
  }

  if (poisonCountdownIntervalId !== null) {
    window.clearInterval(poisonCountdownIntervalId);
    poisonCountdownIntervalId = null;
  }

  poisonDeadlineAt = null;
}

function resolveExpiredPoison(poisonBoxId: number): void {
  if (activePoison?.boxId !== poisonBoxId) return;

  if (!isMouthOpen || isTryEnded || isGameOver) {
    clearPoisonRemovalTimer();
    return;
  }

  const remainingMs = (poisonDeadlineAt ?? 0) - Date.now();

  if (remainingMs > 0) {
    poisonResolutionTimerId = window.setTimeout(() => resolveExpiredPoison(poisonBoxId), remainingMs);
    return;
  }

  const expiredPoison = activePoison;
  getPlayer(expiredPoison.ownerId).score += 10;
  markPoisonResolved(expiredPoison.boxId, "triggered");
  activePoison = null;
  tryEndReason = "poison-timeout";
  clearPoisonRemovalTimer();
  addLog(`毒魚を時間内に取り除けませんでした。${expiredPoison.ownerName} が10点を獲得し、親は0点です。`);
  finishTry();
  startTryReplay();
}

function updatePoisonCountdownDisplay(): void {
  const label = getPoisonCountdownLabel();
  document.querySelectorAll<HTMLElement>("[data-poison-countdown]").forEach((element) => {
    element.textContent = label;
  });
}

function getPoisonCountdownLabel(): string {
  if (poisonDeadlineAt === null) return "";

  const remainingSeconds = Math.max(0, poisonDeadlineAt - Date.now()) / 1000;
  return `除去まで ${remainingSeconds.toFixed(1)}秒`;
}

function scheduleNpcAutomation(): void {
  clearNpcTimers();

  if (gameMode === "online" && onlineRole !== "host") return;

  if (isGameOver || isTryEnded || mouthFishMotion) return;

  if (!isMouthOpen) {
    npcParentCloseAt = null;

    if (isNpcParent()) {
      npcParentTimerId = window.setTimeout(() => {
        if (!isGameOver && !isTryEnded && !isMouthOpen && isNpcParent()) {
          openMouth();
        }
      }, getCpuDelay("open"));
    }

    return;
  }

  scheduleNpcParentAction();
  scheduleNpcChildAction();
}

function clearNpcTimers(): void {
  if (npcChildTimerId !== null) {
    window.clearTimeout(npcChildTimerId);
    npcChildTimerId = null;
  }

  if (npcParentTimerId !== null) {
    window.clearTimeout(npcParentTimerId);
    npcParentTimerId = null;
  }
}

function scheduleNpcParentAction(): void {
  if (!isNpcParent() || !isMouthOpen || isTryEnded || isGameOver) return;

  if (activePoison) {
    npcParentTimerId = window.setTimeout(() => {
      if (!isMouthOpen || isTryEnded || isGameOver || !isNpcParent() || !activePoison) return;

      if (Math.random() < getCpuPoisonRemovalChance()) {
        removeActivePoison();
      } else {
        closeMouth();
      }
    }, getCpuDelay("poison"));
    return;
  }

  if (npcParentCloseAt === null) {
    npcParentCloseAt = Date.now() + getCpuDelay("close");
  }

  const availableScore = getParentCloseTotal();

  if (availableScore >= getCpuCloseScore()) {
    npcParentCloseAt = Math.min(npcParentCloseAt, Date.now() + getCpuDelay("secure"));
  }

  npcParentTimerId = window.setTimeout(() => {
    if (!isMouthOpen || isTryEnded || isGameOver || !isNpcParent()) return;

    if (activePoison) {
      scheduleNpcAutomation();
      return;
    }

    closeMouth();
  }, Math.max(260, npcParentCloseAt - Date.now()));
}

function scheduleNpcChildAction(): void {
  const npcChildren = getNpcChildren().filter((player) => player.faceUp.some(Boolean));

  if (npcChildren.length === 0) return;

  npcChildTimerId = window.setTimeout(() => {
    if (!isMouthOpen || isTryEnded || isGameOver) return;

    for (const player of shuffle(npcChildren)) {
      const action = chooseNpcChildAction(player);

      if (!action) continue;

      if (action.type === "stack") {
        stackCardsIntoSchool(player.id, action.sourceSlotIndex, action.targetSlotIndex);
      } else if (action.type === "escape") {
        escapeWithCard(player.id, action.slotIndex);
      } else {
        playCard(player.id, action.slotIndex);
      }

      return;
    }

    scheduleNpcAutomation();
  }, getCpuDelay("child"));
}

function chooseNpcChildAction(player: Player): NpcChildAction | null {
  const candidate = getPlayerCandidates(player.id).at(-1);
  const candidateTotal = candidate ? sumCapturedIds(candidate.capturedIds, player.id) : 0;
  const escapeSlot = getNpcEscapeSlot(player);

  if (candidate && escapeSlot !== null) {
    const shouldSecureSix = candidate.value === 6 && candidateTotal > 0;
    const escapeChance = shouldSecureSix ? 0.94 : candidateTotal >= 6 ? 0.82 : candidateTotal >= 3 ? 0.58 : 0.28;

    const difficultyMultiplier = cpuDifficulty === "easy" ? 0.62 : cpuDifficulty === "hard" ? 1.15 : 1;
    if (Math.random() < Math.min(0.98, escapeChance * difficultyMultiplier)) {
      return { type: "escape", slotIndex: escapeSlot };
    }
  }

  const stackPair = getNpcStackPair(player);
  if (stackPair) return { type: "stack", ...stackPair };

  const poisonSlot = player.faceUp.findIndex((card) => card?.type === "poison");

  if (poisonSlot >= 0) {
    const canTakePoisonRight = activePoison && activePoison.ownerId !== player.id;

    if ((canTakePoisonRight && Math.random() < 0.86) || (!activePoison && shouldPlayPoisonNow())) {
      return { type: "play", slotIndex: poisonSlot };
    }
  }

  const fishSlots = player.faceUp
    .map((card, slotIndex) => ({ card, slotIndex }))
    .filter((item): item is { card: FishCard; slotIndex: number } => item.card?.type === "fish");

  if (fishSlots.length > 0) {
    if (activePoison) {
      const avoidUselessOwnFish = activePoison.ownerId === player.id && Math.random() < 0.96;
      const avoidGivingPoisonPoints = activePoison.ownerId !== player.id && Math.random() < 0.9;

      if (avoidUselessOwnFish || avoidGivingPoisonPoints) return null;

      const smallestFish = [...fishSlots].sort((left, right) => left.card.value - right.card.value)[0];
      return { type: "play", slotIndex: smallestFish.slotIndex };
    }

    const rankedFish = fishSlots
      .map((item) => ({ ...item, gain: estimateFishCaptureValue(item.card.value, player.id) }))
      .sort((left, right) => right.gain - left.gain || right.card.value - left.card.value);
    const usefulFish = rankedFish.filter((item) => item.gain > 0);

    if (usefulFish.length > 0) {
      // 少しだけ判断を揺らし、毎回完全な最善手を即座に選ぶCPUにはしない。
      const mistakeChance = cpuDifficulty === "easy" ? 0.44 : cpuDifficulty === "hard" ? 0.03 : 0.14;
      const choice = usefulFish.length > 1 && Math.random() < mistakeChance ? usefulFish[1] : usefulFish[0];
      return { type: "play", slotIndex: choice.slotIndex };
    }

    // 得点につながらない魚は温存する。まれな見落としだけを人間らしさとして残す。
    if (Math.random() < (cpuDifficulty === "easy" ? 0.2 : cpuDifficulty === "hard" ? 0.01 : 0.06)) {
      return { type: "play", slotIndex: rankedFish[0].slotIndex };
    }
  }

  if (candidate && escapeSlot !== null) {
    return { type: "escape", slotIndex: escapeSlot };
  }

  return null;
}

function getNpcStackPair(player: Player): { sourceSlotIndex: number; targetSlotIndex: number } | null {
  for (const value of [3, 2] as const) {
    const matchingSlots = player.faceUp
      .map((card, slotIndex) => ({ card, slotIndex }))
      .filter(({ card }) => card?.type === "fish" && card.value === value && card.schoolSize === undefined);

    for (let sourceIndex = 0; sourceIndex < matchingSlots.length; sourceIndex += 1) {
      for (let targetIndex = sourceIndex + 1; targetIndex < matchingSlots.length; targetIndex += 1) {
        const source = matchingSlots[sourceIndex];
        const target = matchingSlots[targetIndex];
        if (canStackFishCards(source.card, target.card)) {
          return { sourceSlotIndex: source.slotIndex, targetSlotIndex: target.slotIndex };
        }
      }
    }
  }

  return null;
}

function estimateFishCaptureValue(value: FishValue, scoringPlayerId: string): number {
  return estimateBoardFishCaptureValue(boxCards, value, scoringPlayerId);
}

function shouldPlayPoisonNow(): boolean {
  const now = Date.now();
  const parentIsAboutToClose = npcParentCloseAt !== null && npcParentCloseAt - now <= 2400;
  const mouthHasBeenOpenLongEnough = mouthOpenedAt !== null && now - mouthOpenedAt >= 4800;
  const parentHasTemptingScore = getParentCloseTotal() >= 6;

  const accuracy = cpuDifficulty === "easy" ? 0.58 : cpuDifficulty === "hard" ? 1.08 : 1;
  if (parentIsAboutToClose) return Math.random() < Math.min(0.97, 0.88 * accuracy);
  if (mouthHasBeenOpenLongEnough && parentHasTemptingScore) return Math.random() < Math.min(0.92, 0.68 * accuracy);
  return Math.random() < (cpuDifficulty === "easy" ? 0.12 : cpuDifficulty === "hard" ? 0.02 : 0.05);
}

function getCpuDelay(kind: "open" | "poison" | "close" | "secure" | "child"): number {
  const ranges = {
    easy: { open: [1400, 2400], poison: [1050, 1750], close: [7200, 11200], secure: [1800, 3000], child: [1800, 3400] },
    normal: { open: [900, 1600], poison: [650, 1250], close: [5600, 9400], secure: [1100, 2100], child: [1100, 2600] },
    hard: { open: [550, 1000], poison: [380, 750], close: [4400, 7600], secure: [650, 1250], child: [650, 1500] }
  } as const;
  const [min, max] = ranges[cpuDifficulty][kind];
  return randomInt(min, max);
}

function getCpuPoisonRemovalChance(): number {
  return cpuDifficulty === "easy" ? 0.48 : cpuDifficulty === "hard" ? 0.94 : 0.78;
}

function getCpuCloseScore(): number {
  return cpuDifficulty === "easy" ? 11 : cpuDifficulty === "hard" ? 6 : 8;
}

function getNpcEscapeSlot(player: Player): number | null {
  const fishSlot = player.faceUp.findIndex((card) => card?.type === "fish");

  if (fishSlot >= 0) return fishSlot;

  const anySlot = player.faceUp.findIndex(Boolean);
  return anySlot >= 0 ? anySlot : null;
}

function getNpcChildren(): Player[] {
  if (gameMode === "pvp") return [];
  if (gameMode === "online") return getChildren().filter((player) => !onlineHumanPlayerIds.has(player.id));
  return getChildren().filter((player) => player.id !== localPlayerId);
}

function isHumanParent(): boolean {
  return gameMode === "pvp" || getParent().id === localPlayerId;
}

function isNpcParent(): boolean {
  if (gameMode === "pvp") return false;
  if (gameMode === "online") return !onlineHumanPlayerIds.has(getParent().id);
  return getParent().id !== localPlayerId;
}

function showMouthCloseEffect(): void {
  showGameEffect({ kind: "bite", label: "パク！" });
}

function startBiteAftermath(kind: BiteAftermath): void {
  clearBiteAftermath();
  biteAftermath = kind;
  render();

  biteAftermathTimerId = window.setTimeout(() => {
    biteAftermath = null;
    biteAftermathTimerId = null;
    startTryReplay();
  }, biteAftermathDurationMs);
}

function clearBiteAftermath(): void {
  if (biteAftermathTimerId !== null) {
    window.clearTimeout(biteAftermathTimerId);
    biteAftermathTimerId = null;
  }

  biteAftermath = null;
}

function startMouthFishMotion(motion: MouthFishMotion): void {
  clearMouthFishMotion();

  if (prefersReducedMotion() && gameMode !== "online") return;

  mouthFishMotion = motion;
  mouthFishMotionTimerId = window.setTimeout(() => {
    mouthFishMotion = null;
    mouthFishMotionTimerId = null;
    render();
  }, mouthFishMotionDurationMs + Math.max(0, motion.preyIds.length - 1) * 70);
}

function clearMouthFishMotion(): void {
  if (mouthFishMotionTimerId !== null) {
    window.clearTimeout(mouthFishMotionTimerId);
    mouthFishMotionTimerId = null;
  }

  mouthFishMotion = null;
}

function startTryReplay(): void {
  clearTryReplay();

  if (prefersReducedMotion()) {
    render();
    return;
  }

  isTryReplayActive = true;
  const { duration } = getTryReplaySchedule();
  render();

  tryReplayTimerId = window.setTimeout(() => {
    isTryReplayActive = false;
    tryReplayTimerId = null;
    render();
  }, duration);
}

function skipTryReplay(): void {
  if (!isTryReplayActive) return;
  clearTryReplay();
  render();
}

function clearTryReplay(): void {
  if (tryReplayTimerId !== null) {
    window.clearTimeout(tryReplayTimerId);
    tryReplayTimerId = null;
  }

  isTryReplayActive = false;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function showEscapeSuccessEffect(): void {
  showGameEffect({ kind: "escape", label: "ヒューん！" });
}

function showGameEffect(effect: GameEffect): void {
  gameEffect = effect;

  if (gameEffectTimerId !== null) {
    window.clearTimeout(gameEffectTimerId);
  }

  gameEffectTimerId = window.setTimeout(() => {
    gameEffect = null;
    gameEffectTimerId = null;
    document.querySelector(".game-effect")?.remove();
  }, 1100);
}

function clearGameEffect(): void {
  if (gameEffectTimerId !== null) {
    window.clearTimeout(gameEffectTimerId);
    gameEffectTimerId = null;
  }

  gameEffect = null;
}

function renderGameEffect(): string {
  if (!gameEffect) return "";

  return `<div class="game-effect is-${gameEffect.kind}" role="status" aria-live="assertive">${gameEffect.label}</div>`;
}

function getOnlineState(): OnlineGameState {
  return {
    playerCount,
    parentIndex,
    completedParentRounds,
    currentTry,
    players,
    boxCards,
    activePoison,
    isMouthOpen,
    isTryEnded,
    biteAftermath,
    isTryReplayActive,
    mouthFishMotion,
    isGameOver,
    logEntries,
    poisonDeadlineAt,
    tryEndReason,
    tryStartScores
  };
}

function broadcastOnlineState(): void {
  if (gameMode !== "online" || onlineRole !== "host" || !hasStarted) return;
  const message = { type: "state", state: getOnlineState() };
  guestConnections.filter((connection) => connection.open).forEach((connection) => connection.send(message));
}

function applyOnlineState(state: OnlineGameState): void {
  playerCount = state.playerCount;
  parentIndex = state.parentIndex;
  completedParentRounds = state.completedParentRounds;
  currentTry = state.currentTry;
  players = state.players;
  boxCards = state.boxCards;
  activePoison = state.activePoison;
  isMouthOpen = state.isMouthOpen;
  isTryEnded = state.isTryEnded;
  biteAftermath = state.biteAftermath ?? null;
  isTryReplayActive = Boolean(state.isTryReplayActive && !prefersReducedMotion());
  clearMouthFishMotion();
  mouthFishMotion = state.mouthFishMotion ?? null;
  isGameOver = state.isGameOver;
  logEntries = state.logEntries;
  poisonDeadlineAt = state.poisonDeadlineAt;
  tryEndReason = state.tryEndReason;
  tryStartScores = state.tryStartScores;
  hasStarted = true;
  onlineLobbyOpen = false;
  render();
}

function render(): void {
  cancelStackDrag();

  if (modeSetupOpen) {
    appRoot.innerHTML = renderPlayerCountScreen();
    return;
  }

  if (onlineLobbyOpen) {
    appRoot.innerHTML = renderOnlineLobby();
    return;
  }

  if (!hasStarted) {
    appRoot.innerHTML = renderStartScreen();
    return;
  }

  const rulesWereOpen = appRoot.querySelector<HTMLDetailsElement>(".rules-panel")?.open ?? false;
  const resultWasVisible = appRoot.querySelector(".try-result-panel") !== null;
  const replayWasVisible = appRoot.querySelector(".try-replay-panel") !== null;
  const focusedControl = getFocusedControlIdentity();
  const focusedChild = getFocusedChild();
  const opponentChildren = getOpponentChildren(focusedChild?.id ?? null);

  appRoot.innerHTML = `
    <main class="app-shell">
      <section class="board-screen" aria-label="ゲーム盤面">
        ${renderGameEffect()}
        <section class="top-seats" aria-label="他の子プレイヤー"${isTryEnded ? " inert" : ""}>
          <div class="opponent-grid">
            ${opponentChildren.map((player) => renderChildPanel(player, getChildIndex(player), "opponent")).join("")}
          </div>
        </section>

        <section class="center-stage${isHumanParent() ? "" : " no-parent-controls"}"${isTryEnded ? " inert" : ""}>
          <section class="mouth-panel ${getPlayerToneClass(getParent().id)}" aria-label="大きな魚の口">
            <div class="mouth-title-row">
              <div>
                <p class="section-label">親</p>
                <h2>${renderPlayerIdentity(getParent())}</h2>
              </div>
              <span class="mouth-state ${biteAftermath ? "is-after-bite" : isMouthOpen ? "is-open" : "is-closed"}">
                ${biteAftermath ? "MUNCH!" : isMouthOpen ? "OPEN" : "CLOSED"}
              </span>
            </div>
            ${renderMouth()}
          </section>

          ${
            isHumanParent()
              ? `<aside class="parent-side" aria-label="親の操作">${renderParentControls(false)}</aside>`
              : ""
          }
        </section>

        <section class="self-seat" aria-label="自分の子プレイヤー"${isTryEnded ? " inert" : ""}>
          ${focusedChild ? renderChildPanel(focusedChild, getChildIndex(focusedChild), "self") : renderHumanParentSeat()}
        </section>

        ${
          isTryReplayActive
            ? renderTryReplayOverlay()
            : isTryEnded && !biteAftermath
              ? renderTryResultOverlay()
              : ""
        }
      </section>

      <section class="detail-screen" id="details" aria-label="詳細情報"${isTryEnded ? " inert" : ""}>
        <header class="app-header">
          <div>
            <p class="eyebrow">リアルタイム捕食ゲーム</p>
            <h1>口に入る</h1>
          </div>
          <div class="status-strip" aria-label="現在の状態">
            ${renderStat("人数", `${playerCount}人`)}
            ${renderStat("親", getParent().name)}
            ${renderStat("親ラウンド", `${Math.min(completedParentRounds + 1, playerCount)}/${playerCount}`)}
            ${renderStat("トライ", `${currentTry}/${maxTriesPerParent}`)}
            ${renderStat("口", getMouthStatusLabel())}
            ${renderStat("泳ぐ魚", `${getLiveMouthNumericCards().filter((card) => card.type === "fish").length}匹`)}
          </div>
        </header>

        <section class="setup-bar compact-setup" aria-label="ゲーム設定">
          <label>
            <span>人数</span>
            <select name="playerCount" ${isMouthOpen ? " disabled" : ""}>
              ${renderNumberOptions()}
            </select>
          </label>
          <label>
            <span>最初の親</span>
            <select name="parentIndex" ${isMouthOpen ? " disabled" : ""}>
              ${renderParentOptions()}
            </select>
          </label>
          <button class="secondary-button" type="button" data-action="apply-setup" ${isMouthOpen ? " disabled" : ""}>この設定で新しく開始</button>
          <button class="text-button" type="button" data-action="reset-game">全体を初期化</button>
          <button class="text-button" type="button" data-action="back-to-title">タイトルへ戻る</button>
        </section>

        <section class="bottom-info" aria-label="ログと細かい情報">
          ${renderRoundControls()}
          ${renderScoreboard()}
          ${renderPoisonStatus()}
          ${renderLog()}
          ${renderRulesSummary()}
        </section>
      </section>
    </main>
  `;

  const rulesPanel = appRoot.querySelector<HTMLDetailsElement>(".rules-panel");
  if (rulesPanel) rulesPanel.open = rulesWereOpen;

  const replayPanel = appRoot.querySelector<HTMLElement>(".try-replay-panel");
  const resultPanel = appRoot.querySelector<HTMLElement>(".try-result-panel");
  if (replayPanel && !replayWasVisible) {
    replayPanel.focus({ preventScroll: true });
  } else if (resultPanel && !resultWasVisible) {
    resultPanel.focus({ preventScroll: true });
  } else {
    restoreFocusedControl(appRoot, focusedControl);
  }

  broadcastOnlineState();
  scheduleNpcAutomation();
}

function renderPlayerCountScreen(): string {
  const modeLabels: Record<GameMode, string> = {
    pvp: "プレイヤーと対戦",
    cpu: "CPUと対戦",
    online: "友達とオンライン対戦"
  };
  return `
    <main class="start-screen">
      <section class="start-card count-screen" aria-labelledby="count-title">
        <p class="start-eyebrow">${modeLabels[pendingGameMode]}</p>
        <h1 id="count-title">人数を選択</h1>
        <p class="start-lead">3〜6人から、今回のゲームに参加する人数を選んでください。</p>
        <div class="count-options" role="group" aria-label="参加人数">
          ${[3, 4, 5, 6].map((count) => `<button class="count-option${draftPlayerCount === count ? " selected" : ""}" type="button" data-player-count="${count}"><strong>${count}</strong><span>人</span></button>`).join("")}
        </div>
        ${pendingGameMode === "pvp" ? "" : renderCpuDifficultyOptions()}
        <button class="primary-button count-confirm" type="button" data-action="confirm-player-count">${draftPlayerCount}人で進む</button>
        <button class="text-button back-title" type="button" data-action="back-to-title">モード選択へ戻る</button>
      </section>
    </main>
  `;
}

function renderCpuDifficultyOptions(): string {
  const options: Array<{ id: CpuDifficulty; label: string; detail: string }> = [
    { id: "easy", label: "弱い", detail: "ゆっくり・ミス多め" },
    { id: "normal", label: "ふつう", detail: "標準的な判断" },
    { id: "hard", label: "強い", detail: "素早く正確" }
  ];
  return `
    <section class="difficulty-section" aria-labelledby="difficulty-title">
      <h2 id="difficulty-title">CPUの強さ</h2>
      <div class="difficulty-options" role="group" aria-label="CPUの強さ">
        ${options.map((option) => `<button class="difficulty-option${cpuDifficulty === option.id ? " selected" : ""}" type="button" data-cpu-difficulty="${option.id}"><strong>${option.label}</strong><small>${option.detail}</small></button>`).join("")}
      </div>
    </section>
  `;
}

function renderStartScreen(): string {
  return `
    <main class="start-screen">
      <section class="start-card" aria-labelledby="game-title">
        <p class="start-eyebrow">REAL-TIME CARD GAME</p>
        <h1 id="game-title">口に入る</h1>
        <p class="start-lead">魚を食べるか、毒を仕掛けるか。相手の動きを読んで最高得点を目指そう。</p>
        <div class="mode-grid" aria-label="対戦モードを選択">
          <button class="mode-card mode-card-player" type="button" data-action="start-pvp">
            <span class="mode-icon" aria-hidden="true">対</span>
            <strong>プレイヤーと対戦</strong>
            <small>1台の端末を囲んで、みんなで遊ぶ</small>
          </button>
          <button class="mode-card mode-card-cpu" type="button" data-action="start-cpu">
            <span class="mode-icon" aria-hidden="true">CPU</span>
            <strong>CPUと対戦</strong>
            <small>ひとりですぐに対戦を始める</small>
          </button>
          <button class="mode-card mode-card-online" type="button" data-action="open-online-lobby">
            <span class="mode-icon" aria-hidden="true">NET</span>
            <strong>友達とオンライン対戦</strong>
            <small>部屋を作り、参加コードで別の端末と遊ぶ</small>
          </button>
        </div>
      </section>
    </main>
  `;
}

function renderOnlineLobby(): string {
  const isHost = onlineRole === "host";
  const isGuest = onlineRole === "guest";
  return `
    <main class="start-screen">
      <section class="start-card online-lobby" aria-labelledby="online-title">
        <p class="start-eyebrow">ONLINE ROOM</p>
        <h1 id="online-title">友達と対戦</h1>
        ${
          isHost
            ? `
              <p class="room-label">参加コード</p>
              <div class="room-code" aria-label="参加コード ${roomCode}">${roomCode || "------"}</div>
              ${renderOnlineParticipants()}
              <p class="online-status" role="status">${onlineStatus}</p>
              <button class="primary-button lobby-action" type="button" data-action="start-online-game" ${onlineHumanPlayerIds.size < 2 ? "disabled" : ""}>ゲームを開始</button>
            `
            : isGuest
              ? `<div class="waiting-spinner" aria-hidden="true"></div>${renderOnlineParticipants()}<p class="online-status" role="status">${onlineStatus}</p>`
              : `
                <p class="start-lead">1人が部屋を作り、表示された6文字のコードを友達に送ります。</p>
                <div class="lobby-actions">
                  <div class="create-box">
                    <label for="player-name-input">表示名（部屋作成・参加共通）</label>
                    <input id="player-name-input" name="playerName" value="${draftPlayerName}" maxlength="12" autocomplete="nickname" placeholder="あなたの名前">
                    <button class="primary-button lobby-action" type="button" data-action="create-room">部屋を作る</button>
                  </div>
                  <div class="join-box">
                    <label for="room-code-input">参加コード</label>
                    <input id="room-code-input" name="roomCode" value="${draftRoomCode}" maxlength="6" autocomplete="off" placeholder="ABC234">
                    <button class="secondary-button" type="button" data-action="join-room">部屋に参加</button>
                  </div>
                </div>
                <p class="online-status" role="status">${onlineStatus}</p>
              `
        }
        <button class="text-button back-title" type="button" data-action="back-to-title">タイトルへ戻る</button>
      </section>
    </main>
  `;
}

function renderOnlineParticipants(): string {
  if (onlineLobbyMembers.length === 0) return "";
  return `
    <section class="participant-panel" aria-label="参加者一覧">
      <div class="participant-summary">
        <strong>参加者 ${onlineLobbyMembers.length}/${draftPlayerCount}人</strong>
        <span>最初の親：${onlineLobbyMembers[0]?.name ?? "未定"}</span>
      </div>
      <ul class="participant-list">
        ${onlineLobbyMembers.map((member, index) => `<li><span>${member.name}</span>${index === 0 ? "<strong>最初の親</strong>" : member.isHost ? "<small>ホスト</small>" : "<small>参加</small>"}</li>`).join("")}
      </ul>
    </section>
  `;
}

function getFocusedChild(): Player | null {
  return getChildren().find((player) => player.id === localPlayerId) ?? null;
}

function getOpponentChildren(focusedChildId: string | null): Player[] {
  return getChildren().filter((player) => player.id !== focusedChildId);
}

function getChildIndex(player: Player): number {
  return getChildren().findIndex((child) => child.id === player.id);
}

function renderRulesSummary(): string {
  return `
    <details class="rules-panel compact-rules">
      <summary>ルール</summary>
      <div>
        <p class="section-label">進行と捕食</p>
        <ul>
          <li>親1人につき必ず3トライ行い、その後に親を交代します。</li>
          <li>山札と公開札はトライ間で引き継ぎ、親交代時に補給します。</li>
          <li>魚を出すと直前から逆順に比べ、大きい魚が小さい魚を食べます。先に大きい魚がいた場合は、後から出した小さい魚が食べられます。</li>
          <li>同じ数字では捕食が止まります。食べられた魚が抱えていた魚も、まとめて大きい魚へ引き継がれます。</li>
          <li>口の中ではカードの代わりに魚が泳ぎ、小さい魚だけの時はカメラが寄り、大きい魚が出るほどズームアウトします。</li>
          <li>魚は数字に関係なく出せます。</li>
          <li>口が開いている間、同じ2同士または3同士をドラッグして重ねると群れになります。2の群れは強さ4、3の群れは強さ6です。</li>
          <li>群れを作って空いた公開枠には、山札があれば即座に1枚補充します。群れは1枚の魚として出し、再び重ねたり分けたりはできません。</li>
          <li>得点時は、得点する人自身が出したカードを除き、食べた数字カードを得点します。</li>
          <li>逃げ成功時は、逃げる魚自身と同じ子が以前に出した魚を除いて得点します。</li>
          <li>最初の餌「1」は親自身のカードです。ほかに魚がいないまま親が閉じても0点です。</li>
          <li>親が閉じたら、自身の餌・毒魚・逃げる・毒魚で得点化済みの魚を除いた数字カードを得点します。</li>
        </ul>
      </div>
      <div>
        <p class="section-label">効果なしと毒魚</p>
        <ul>
          <li>逃げる権利がない子の裏向きカードは、効果も得点価値も持ちません。</li>
          <li>自分の毒魚に続けて出した魚も、効果も得点価値も持ちません。</li>
          <li>毒魚の後に毒魚が出ると、得点の権利は後の子へ移ります。</li>
          <li>毒魚があっても、権利を持つ子は逃げられます。</li>
          <li>毒魚を3秒以内に除去できない場合、毒魚の子が10点を得てトライ終了です。</li>
          <li>山札と公開札を使い切った子は行動できません。</li>
        </ul>
      </div>
    </details>
  `;
}

function renderHumanParentSeat(): string {
  const parent = getParent();

  return `
    <article class="child-panel is-self human-parent-seat ${getPlayerToneClass(parent.id)}">
      <header class="child-header">
        <div>
          <p class="section-label">あなたの番</p>
          <h3>${renderPlayerIdentity(parent)}</h3>
        </div>
        <strong>${parent.score}点</strong>
      </header>
      <p class="notice">あなたは親です。中央の口を操作してください。</p>
    </article>
  `;
}

function renderStat(label: string, value: string): string {
  return `
    <div class="status-pill">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderNumberOptions(): string {
  return [3, 4, 5, 6]
    .map((count) => `<option value="${count}"${count === draftPlayerCount ? " selected" : ""}>${count}人</option>`)
    .join("");
}

function renderParentOptions(): string {
  return Array.from({ length: draftPlayerCount }, (_, index) => {
    const selected = index === draftParentIndex ? " selected" : "";
    return `<option value="${index}"${selected}>プレイヤー${index + 1}</option>`;
  }).join("");
}

function renderParentControls(showRoundActions = true): string {
  const parentIsHuman = isHumanParent();
  const canOpen = parentIsHuman && !isGameOver && !isMouthOpen && !isTryEnded;
  const canClose = parentIsHuman && !isGameOver && isMouthOpen && !mouthFishMotion;
  const canRemovePoison = parentIsHuman && !isGameOver && isMouthOpen && activePoison;
  const parent = getParent();

  return `
    <section class="panel-block parent-controls ${getPlayerToneClass(parent.id)}">
      <p class="section-label">${parentIsHuman ? "あなたが親" : "NPC親"}</p>
      <h2>${renderPlayerIdentity(parent)}</h2>
      <div class="parent-actions">
        <button class="primary-button" type="button" data-action="open-mouth"${canOpen ? "" : " disabled"}>
          口を開ける
        </button>
        <button class="danger-button" type="button" data-action="close-mouth"${canClose ? "" : " disabled"}>
          口を閉じる
        </button>
      </div>
      <button class="secondary-button wide" type="button" data-action="remove-poison"${canRemovePoison ? "" : " disabled"}>
        毒魚を取り除く
      </button>
      ${showRoundActions ? renderRoundActionButtons() : ""}
    </section>
  `;
}

function renderRoundControls(): string {
  return `
    <section class="panel-block">
      <p class="section-label">進行</p>
      <div class="round-actions">
        ${renderRoundActionButtons()}
      </div>
    </section>
  `;
}

function renderTryReplayOverlay(): string {
  const orderedCards = [...boxCards].sort((left, right) => left.sequence - right.sequence);
  const schedule = getTryReplaySchedule();
  const cardIndexById = new Map(orderedCards.map((card, index) => [card.boxId, index]));
  const playTimes = new Map<number, number>();
  const eatenEvents = new Map<number, Extract<ScheduledTryReplayEvent, { kind: "eat" }>>();
  const escapeEvents = new Map<number, Extract<ScheduledTryReplayEvent, { kind: "escape" }>>();
  const poisonEvents = new Map<number, Extract<ScheduledTryReplayEvent, { kind: "poison" }>>();
  const predatorEvents = new Map<number, Array<Extract<ScheduledTryReplayEvent, { kind: "eat" }>>>();

  for (const event of schedule.events) {
    if (event.kind === "play") {
      playTimes.set(event.boxId, event.at);
    } else if (event.kind === "eat") {
      eatenEvents.set(event.preyId, event);
      const events = predatorEvents.get(event.predatorId) ?? [];
      events.push(event);
      predatorEvents.set(event.predatorId, events);
    } else if (event.kind === "escape") {
      escapeEvents.set(event.fishId, event);
    } else if (event.kind === "poison") {
      poisonEvents.set(event.poisonId, event);
    }
  }

  const parentGain = getTryScoreGain(getParent());
  const showWhale = tryEndReason === "parent-close";
  const scoreTargetIndex = orderedCards.length;
  const slotCount = orderedCards.length + (showWhale ? 1 : 0);

  return `
    <section
      class="try-replay-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="try-replay-title"
      aria-describedby="try-replay-description"
      tabindex="-1"
    >
      <div class="try-replay-header">
        <div>
          <p class="section-label">得点確定</p>
          <h2 id="try-replay-title">この回の捕食リプレイ</h2>
        </div>
        <button class="text-button try-replay-skip" type="button" data-action="skip-try-replay">スキップ</button>
      </div>
      <p id="try-replay-description" class="try-replay-description">
        魚が泳いで現れ、大きな魚が小さな魚を食べた流れを再生します。
      </p>
      <div class="try-replay-stage">
        <div class="try-replay-callout-layer" aria-hidden="true">
          ${schedule.events
            .filter((event) => event.kind !== "play")
            .map(
              (event) => `
                <div
                  class="try-replay-callout is-${event.kind}"
                  style="--event-delay: ${event.at}ms"
                >${getTryReplayEventLabel(event)}</div>
              `
            )
            .join("")}
        </div>
        <div
          class="try-replay-track"
          style="--replay-slots: ${Math.max(slotCount, 1)}"
          aria-label="魚の登場と捕食の順番"
        >
          ${orderedCards
            .map((card, index) => {
              const eatenEvent = eatenEvents.get(card.boxId);
              const escapeEvent = escapeEvents.get(card.boxId);
              const poisonEvent = poisonEvents.get(card.boxId);
              const isParentScoreBundle =
                showWhale &&
                parentGain > 0 &&
                isParentScoringBundle(card);
              const motionClass = eatenEvent
                ? "is-devoured"
                : escapeEvent
                  ? "is-escaping"
                  : isParentScoreBundle
                    ? "is-parent-scored"
                    : poisonEvent
                      ? "is-poison-resolved"
                      : "";
              const motionStyle = eatenEvent
                ? `--motion-delay: ${eatenEvent.at}ms; --motion-x: ${(cardIndexById.get(eatenEvent.predatorId)! - index) * 100}%`
                : escapeEvent
                  ? `--motion-delay: ${escapeEvent.at}ms`
                  : isParentScoreBundle
                    ? `--motion-delay: ${schedule.finalAt}ms; --motion-x: ${(scoreTargetIndex - index) * 100}%`
                    : poisonEvent
                      ? `--motion-delay: ${poisonEvent.at}ms`
                      : "";
              const chompEvents = predatorEvents.get(card.boxId) ?? [];

              return `
                <div
                  class="try-replay-slot"
                  style="--enter-delay: ${playTimes.get(card.boxId) ?? 0}ms"
                >
                  <div class="try-replay-card-motion ${motionClass}" style="${motionStyle}">
                    <div class="try-replay-card-visual">
                      ${renderTryReplayCard(card)}
                    </div>
                    ${chompEvents
                      .map(
                        (event) => `
                          <span
                            class="try-replay-chomp-ring"
                            style="--event-delay: ${event.at}ms"
                            aria-hidden="true"
                          ></span>
                        `
                      )
                      .join("")}
                  </div>
                  <small title="${getTryOrderLabel(card)}">${getTryReplayOwnerLabel(card)}</small>
                </div>
              `;
            })
            .join("")}
          ${
            showWhale
              ? `
                <div class="try-replay-whale" style="--motion-delay: ${schedule.finalAt}ms" aria-hidden="true">
                  <img class="try-replay-whale-open" src="./assets/mouth/whale-open.png" alt="">
                  <img class="try-replay-whale-fed" src="./assets/mouth/whale-fed.png" alt="">
                  <strong>パク！</strong>
                </div>
              `
              : ""
          }
        </div>
        <div class="try-replay-final" style="--final-delay: ${schedule.finalAt + 520}ms" aria-live="polite">
          <span>得点確定</span>
          <strong>${getTryReplayScoreSummary()}</strong>
        </div>
      </div>
    </section>
  `;
}

function getTryReplaySchedule(): TryReplaySchedule {
  const replayEvents = buildTryReplayEvents();
  const tempo = replayEvents.length > 18 ? 0.68 : replayEvents.length > 12 ? 0.82 : 1;
  const events: ScheduledTryReplayEvent[] = [];
  let cursor = gameEffect ? 1080 : 220;

  for (const event of replayEvents) {
    events.push({ ...event, at: Math.round(cursor) } as ScheduledTryReplayEvent);

    const baseDuration =
      event.kind === "play"
        ? 300
        : event.kind === "eat"
          ? 440
          : event.kind === "escape"
            ? 520
            : 340;
    cursor += baseDuration * tempo;
  }

  const finalAt = Math.round(cursor + 180);
  return {
    events,
    finalAt,
    duration: finalAt + 1450
  };
}

function buildTryReplayEvents(): TryReplayEvent[] {
  // Final capture fields collapse a whole chain into the latest predator, so replay the rules in sequence.
  const orderedCards = [...boxCards].sort((left, right) => left.sequence - right.sequence);
  const processedCards: BoxCard[] = [];
  const numericStates = new Map<number, TryReplayNumericState>();
  const poisonEventsRecorded = new Set<number>();
  const events: TryReplayEvent[] = [];

  for (const card of orderedCards) {
    events.push({ kind: "play", boxId: card.boxId });
    processedCards.push(card);

    if (card.type === "bait") {
      numericStates.set(card.boxId, {
        card,
        capturedIds: [],
        consumedById: null
      });
      continue;
    }

    if (card.type === "poison") continue;

    if (card.type === "escape") {
      if (!card.successful) {
        events.push({ kind: "ineffective", boxId: card.boxId, reason: "escape-failed" });
        continue;
      }

      const escapeTarget = [...processedCards]
        .reverse()
        .find((item): item is FishBoxCard => {
          if (item.type !== "fish" || item.ownerId !== card.ownerId) return false;
          const state = numericStates.get(item.boxId);
          return Boolean(
            state &&
            state.consumedById === null &&
            !item.poisonScoredById &&
            !item.invalidatedByOwnPoison &&
            state.capturedIds.length > 0
          );
        });

      if (escapeTarget) {
        const targetState = numericStates.get(escapeTarget.boxId)!;
        events.push({
          kind: "escape",
          fishId: escapeTarget.boxId,
          points: sumTryReplayValues(targetState.capturedIds, numericStates, escapeTarget.ownerId)
        });
      }
      continue;
    }

    const newFishState: TryReplayNumericState = {
      card,
      capturedIds: [],
      consumedById: null
    };
    numericStates.set(card.boxId, newFishState);

    if (card.invalidatedByOwnPoison) {
      events.push({ kind: "ineffective", boxId: card.boxId, reason: "own-poison" });
      continue;
    }

    if (card.poisonScoredById) {
      const poison = [...processedCards]
        .reverse()
        .find(
          (item): item is PoisonBoxCard =>
            item.type === "poison" &&
            item.ownerId === card.poisonScoredById &&
            item.status === "triggered"
        );

      if (poison) {
        events.push({
          kind: "poison",
          poisonId: poison.boxId,
          outcome: "triggered",
          points: card.value
        });
        poisonEventsRecorded.add(poison.boxId);
      }
      continue;
    }

    for (let index = processedCards.length - 2; index >= 0; index -= 1) {
      const target = processedCards[index];

      if (target.type === "poison") continue;
      if (target.type === "escape") {
        if (target.successful) break;
        continue;
      }

      const targetState = numericStates.get(target.boxId);
      if (!targetState || targetState.consumedById !== null) continue;
      if (target.type === "fish" && target.invalidatedByOwnPoison) continue;
      if (target.type === "fish" && target.poisonScoredById) break;
      if (target.value === card.value) break;

      if (target.value > card.value) {
        const bundleIds = [card.boxId, ...newFishState.capturedIds];
        events.push({
          kind: "eat",
          predatorId: target.boxId,
          preyId: card.boxId,
          bundleIds,
          points: sumTryReplayValues(bundleIds, numericStates, targetState.card.ownerId)
        });

        for (const capturedId of bundleIds) {
          const capturedState = numericStates.get(capturedId);
          if (capturedState) capturedState.consumedById = target.boxId;
        }

        targetState.capturedIds = [...new Set([...targetState.capturedIds, ...bundleIds])];
        newFishState.capturedIds = [];
        break;
      }

      const bundleIds = [target.boxId, ...targetState.capturedIds];
      events.push({
        kind: "eat",
        predatorId: card.boxId,
        preyId: target.boxId,
        bundleIds,
        points: sumTryReplayValues(bundleIds, numericStates, card.ownerId)
      });

      for (const capturedId of bundleIds) {
        const capturedState = numericStates.get(capturedId);
        if (capturedState) capturedState.consumedById = card.boxId;
      }

      newFishState.capturedIds.push(...bundleIds);
      targetState.capturedIds = [];
    }
  }

  for (const poison of orderedCards.filter((card): card is PoisonBoxCard => card.type === "poison")) {
    if (poisonEventsRecorded.has(poison.boxId) || poison.status === "active") continue;

    const outcome = poison.status === "triggered"
      ? "triggered"
      : poison.status === "removed"
        ? "removed"
        : poison.status === "overridden"
          ? "overridden"
          : "cancelled";
    events.push({
      kind: "poison",
      poisonId: poison.boxId,
      outcome,
      points: outcome === "triggered" ? 10 : 0
    });
  }

  return events;
}

function sumTryReplayValues(
  cardIds: number[],
  numericStates: Map<number, TryReplayNumericState>,
  scoringPlayerId: string
): number {
  return cardIds.reduce((total, cardId) => {
    const card = numericStates.get(cardId)?.card;
    return total + (card && card.ownerId !== scoringPlayerId ? card.value : 0);
  }, 0);
}

function renderTryReplayCard(card: BoxCard): string {
  if (card.type === "escape") {
    return `
      <div class="try-replay-fish is-escape-effect ${getPlayerToneClass(card.ownerId)}" aria-label="${card.ownerName}の逃げる">
        <span aria-hidden="true">≋</span>
        <strong>逃げる</strong>
      </div>
    `;
  }

  const typeClass = card.type === "bait"
    ? "is-bait"
    : card.type === "poison"
      ? "is-poison"
      : `value-${card.value}${card.schoolSize === 2 ? " is-school" : ""}`;

  return `
    <div class="try-replay-fish ${typeClass} ${getPlayerToneClass(card.ownerId)}" aria-label="${getMouthFishActorLabel(card)}">
      ${renderMouthFishVisual(card)}
    </div>
  `;
}

function getTryReplayEventLabel(event: ScheduledTryReplayEvent): string {
  if (event.kind === "play") {
    return `${getTryReplayCardLabel(getBoxCard(event.boxId))}を出した`;
  }

  if (event.kind === "eat") {
    const predator = getBoxCard(event.predatorId);
    const prey = getBoxCard(event.preyId);
    const carriedText = event.bundleIds.length > 1 ? "ごと" : "";
    return `${getTryReplayCardLabel(predator)}が${getTryReplayCardLabel(prey)}${carriedText} ${event.points}点分を食べた！`;
  }

  if (event.kind === "escape") {
    const fish = getBoxCard(event.fishId);
    return `${getTryReplayCardOwner(fish)}がヒューん！ ${event.points}点を確定`;
  }

  if (event.kind === "ineffective") {
    return event.reason === "own-poison" ? "自分の毒魚の直後で効果なし" : "逃げる権利がなく不発";
  }

  const poison = getBoxCard(event.poisonId);
  const owner = getTryReplayCardOwner(poison);
  if (event.outcome === "triggered") return `${owner}の毒魚が発動！ +${event.points}点`;
  if (event.outcome === "removed") return `${owner}の毒魚を親が除去`;
  if (event.outcome === "overridden") return `${owner}の毒魚は後の毒魚に上書き`;
  return `${owner}の毒魚はトライ終了で無効`;
}

function getBoxCard(boxId: number): BoxCard | null {
  return boxCards.find((card) => card.boxId === boxId) ?? null;
}

function getTryReplayCardLabel(card: BoxCard | null): string {
  if (!card) return "カード";
  if (card.type === "bait") return "親の餌1";
  if (card.type === "fish") return card.schoolBaseValue ? `${card.schoolBaseValue}の群れ` : `魚${card.value}`;
  if (card.type === "poison") return "毒魚";
  return "逃げるカード";
}

function getTryReplayCardOwner(card: BoxCard | null): string {
  if (!card) return "親";
  return card.ownerName;
}

function getTryReplayOwnerLabel(card: BoxCard): string {
  if (card.type === "bait") return `${card.ownerName}の餌`;
  return card.ownerName;
}

function isParentScoringBundle(card: BoxCard): boolean {
  if (card.type !== "fish" || card.ownerId === getParent().id) return false;
  return (
    card.consumedById === null &&
    !card.poisonScoredById &&
    !card.invalidatedByOwnPoison &&
    !card.escaped
  );
}

function getTryReplayScoreSummary(): string {
  const gains = players
    .map((player) => ({ player, gained: getTryScoreGain(player) }))
    .filter(({ gained }) => gained > 0);

  if (gains.length === 0) return '<span class="try-replay-no-score">今回は得点なし</span>';
  return `
    <span class="try-replay-score-chips">
      ${gains
        .map(
          ({ player, gained }) => `
            <span class="try-replay-score-chip ${getPlayerToneClass(player.id)}">
              <span>P${getPlayerToneNumber(player.id)} ${player.name}</span>
              <b>+${gained}点</b>
            </span>
          `
        )
        .join("")}
    </span>
  `;
}

function renderTryResultOverlay(): string {
  return `
    <section class="try-result-panel" role="dialog" aria-modal="true" aria-labelledby="try-result-title" tabindex="-1">
      <div class="try-result-header">
        <p class="section-label">1回終了</p>
        <h2 id="try-result-title">${isGameOver ? "ゲーム終了" : "この回の結果"}</h2>
      </div>
      ${isGameOver ? renderWinnerNotice() : ""}
      <div class="try-result-grid">
        <section class="try-score-section">
          <p class="section-label">獲得点</p>
          <div class="try-score-list">
            ${players
              .map(
                (player) => {
                  const gained = getTryScoreGain(player);

                  return `
                    <div
                      class="try-score-row ${player.role} ${gained > 0 ? "scored" : ""} ${getPlayerToneClass(player.id)}"
                      aria-label="${player.name}、今回の獲得 ${gained}点、合計 ${player.score}点"
                    >
                      <div class="try-score-player">
                        ${renderPlayerIdentity(player)}
                        <small>${player.role === "parent" ? "親" : "子"}</small>
                      </div>
                      <div class="try-score-gain">
                        <span>今回獲得</span>
                        <strong>+${gained}</strong>
                        <b>点</b>
                      </div>
                      <em>合計 <b>${player.score}点</b></em>
                    </div>
                  `;
                }
              )
              .join("")}
          </div>
        </section>
        <section>
          <p class="section-label">カード順</p>
          <p class="try-order-caption">左から、箱に入った順です。</p>
          <div class="try-card-track" aria-label="このトライのカード順">
            ${boxCards.map(renderTryTimelineCard).join("")}
            ${renderTryEndMarker()}
          </div>
        </section>
      </div>
      <div class="round-actions">
        ${renderRoundActionButtons()}
      </div>
    </section>
  `;
}

function getTryScoreGain(player: Player): number {
  return player.score - (tryStartScores[player.id] ?? player.score);
}

function renderTryTimelineCard(card: BoxCard): string {
  const escapedHere = card.type === "escape" && card.successful;
  const label = getTryOrderLabel(card);
  const detail = getTryOrderDetail(card);

  return `
    <div class="try-card-step" aria-label="${label}。${detail}">
      ${escapedHere ? '<span class="try-event-badge is-escape">ヒューん！<small>ここで逃げた</small></span>' : ""}
      ${renderBoxCard(card)}
    </div>
  `;
}

function renderTryEndMarker(): string {
  if (tryEndReason === "parent-close") {
    return '<div class="try-end-marker is-close" role="note"><strong>パク！</strong><span>ここで口を閉じた</span></div>';
  }

  if (tryEndReason === "poison-timeout") {
    return '<div class="try-end-marker is-poison" role="note"><strong>毒発動</strong><span>除去時間切れ</span></div>';
  }

  return "";
}

function getTryOrderLabel(card: BoxCard): string {
  if (card.type === "bait") return `${card.ownerName}の餌 1`;
  if (card.type === "poison") return `${card.ownerName} 毒魚`;
  if (card.type === "escape") return `${card.ownerName} 逃げる`;
  return `${card.ownerName} ${getFishCardLabel(card)}`;
}

function getTryOrderDetail(card: BoxCard): string {
  if (card.type === "bait") {
    return card.consumedById
      ? `魚${getEatingFishValue(card.consumedById)}に食べられた`
      : `${card.ownerName}自身の餌・0点`;
  }

  if (card.type === "poison") {
    if (card.status === "active") return "得点の権利を保持";
    if (card.status === "triggered") return "得点に発動済み";
    if (card.status === "removed") return "親が除去";
    if (card.status === "overridden") return "後の毒魚に権利を奪われた";
    return "トライ終了により無効";
  }

  if (card.type === "escape") {
    return card.successful ? "逃げ成功" : "権利なし・効果なし";
  }

  if (card.invalidatedByOwnPoison) return "自分の毒魚直後・効果なし";

  if (card.poisonScoredByName) {
    return `毒魚で${card.poisonScoredByName}が${card.value}点`;
  }

  if (card.escaped) {
    return `逃げ成功 ${sumCapturedIds(card.capturedIds, card.ownerId)}点`;
  }

  if (card.consumedById) {
    return `魚${getEatingFishValue(card.consumedById)}に食べられた`;
  }

  const candidateTotal = sumCapturedIds(card.capturedIds, card.ownerId);
  return candidateTotal > 0 ? `未確定候補 ${candidateTotal}点` : "得点候補なし";
}

function getEatingFishValue(boxId: number): string {
  const card = boxCards.find((item): item is FishBoxCard => item.type === "fish" && item.boxId === boxId);
  return card ? String(card.value) : "?";
}

function renderRoundActionButtons(): string {
  if (isGameOver) {
    return '<button class="primary-button" type="button" data-action="reset-game">もう一度遊ぶ</button>';
  }

  const canNextTry = !isGameOver && isTryEnded && currentTry < maxTriesPerParent;
  const canAdvanceParent = !isGameOver && isTryEnded && currentTry >= maxTriesPerParent;

  return `
    <button class="secondary-button" type="button" data-action="next-try"${canNextTry ? "" : " disabled"}>次のトライ</button>
    <button class="secondary-button" type="button" data-action="advance-parent"${canAdvanceParent ? "" : " disabled"}>
      ${completedParentRounds + 1 >= playerCount ? "ゲーム終了" : "親を交代"}
    </button>
  `;
}

function renderMouth(): string {
  const liveFishCount = getLiveMouthNumericCards().filter((card) => card.type === "fish").length;
  const largestLiveValue = getLargestLiveMouthValue();
  const cameraFrom = mouthFishMotion?.cameraFrom ?? getMouthCameraZoom();
  const cameraTo = mouthFishMotion?.cameraTo ?? getMouthCameraZoom();
  const mouthClass = isMouthOpen
    ? "is-open"
    : biteAftermath
      ? `is-closed is-after-bite is-${biteAftermath}`
      : "is-closed";
  const aftermathMessage = biteAftermath === "poisoned"
    ? "ごっくん…毒魚まで食べちゃった！"
    : "もぐもぐ…ごっくん！";

  return `
    <div class="mouth ${mouthClass} camera-value-${largestLiveValue}">
      <img class="whale-face whale-face-closed" src="./assets/mouth/whale-front.png" alt="" aria-hidden="true">
      <img class="whale-face whale-face-fed" src="./assets/mouth/whale-fed.png" alt="" aria-hidden="true">
      <div class="jaw jaw-top" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <div
        class="mouth-camera-layer ${mouthFishMotion ? "is-camera-moving" : ""}"
        style="--camera-from:${cameraFrom}; --camera-to:${cameraTo}; --mouth-camera-zoom:${cameraTo}"
      >
        <img class="whale-face whale-face-open" src="./assets/mouth/whale-open.png" alt="" aria-hidden="true">
        <div class="mouth-cavity">
          ${renderMouthFishScene()}
        </div>
      </div>
      <div class="cavity-meta">
        <span>泳いでいる魚 ${liveFishCount}匹</span>
        <span>${activePoison ? `毒魚: ${activePoison.ownerName}` : "毒魚なし"}</span>
        ${activePoison ? `<small class="poison-countdown" data-poison-countdown>${getPoisonCountdownLabel()}</small>` : ""}
      </div>
      <div class="jaw jaw-bottom" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      ${biteAftermath ? `<div class="bite-aftermath-badge" role="status" aria-live="polite">${aftermathMessage}</div>` : ""}
    </div>
  `;
}

function renderMouthFishScene(): string {
  const liveIds = new Set(getLiveMouthNumericCards().map((card) => card.boxId));
  const motionIds = new Set(
    mouthFishMotion
      ? [mouthFishMotion.enteringId, mouthFishMotion.predatorId, ...mouthFishMotion.preyIds].filter(
          (boxId): boxId is number => boxId !== null
        )
      : []
  );
  const actors = boxCards
    .filter((card) => {
      if (card.type === "bait" || card.type === "fish") {
        return liveIds.has(card.boxId) || motionIds.has(card.boxId);
      }
      return card.type === "poison" && (card.status === "active" || motionIds.has(card.boxId));
    })
    .sort((left, right) => left.sequence - right.sequence);
  const cameraTo = mouthFishMotion?.cameraTo ?? getMouthCameraZoom();
  const cameraLabel = cameraTo >= 2.5
    ? "口の奥へ大ズーム"
    : cameraTo >= 1.5
      ? "口の中を追跡中"
      : cameraTo > 1
        ? "親の顔へズームアウト"
        : "最大魚を口いっぱいに表示";
  const predator = mouthFishMotion?.predatorId ? getBoxCard(mouthFishMotion.predatorId) : null;
  const predatorPosition = predator ? getMouthFishPosition(predator) : null;

  return `
    <div class="mouth-fish-stage" role="group" aria-label="口の中を泳ぐ魚">
      <div
        class="mouth-fish-world"
        style="--mouth-zoom:1"
      >
        <span class="water-bubble bubble-one" aria-hidden="true"></span>
        <span class="water-bubble bubble-two" aria-hidden="true"></span>
        <span class="water-bubble bubble-three" aria-hidden="true"></span>
        ${actors.map(renderMouthFishActor).join("")}
        ${
          predatorPosition && mouthFishMotion?.preyIds.length
            ? `<span class="mouth-chomp-burst" style="--burst-x:${predatorPosition.x}%; --burst-y:${predatorPosition.y}%" aria-hidden="true">パクッ!</span>`
            : ""
        }
      </div>
      <span class="mouth-camera-readout" aria-hidden="true">${cameraLabel} · ×${cameraTo.toFixed(2)}</span>
      ${
        mouthFishMotion
          ? `<span class="visually-hidden" role="status" aria-live="polite">${getMouthFishMotionAnnouncement()}</span>`
          : ""
      }
    </div>
  `;
}

function renderMouthFishActor(card: BoxCard): string {
  if (card.type === "escape") return "";

  const position = getMouthFishPosition(card);
  const predator = mouthFishMotion?.predatorId ? getBoxCard(mouthFishMotion.predatorId) : null;
  const targetPosition = predator ? getMouthFishPosition(predator) : position;
  const preyIndex = mouthFishMotion?.preyIds.indexOf(card.boxId) ?? -1;
  const isEntering = mouthFishMotion?.enteringId === card.boxId;
  const isPredator = mouthFishMotion?.predatorId === card.boxId && preyIndex < 0;
  const motionClass = [
    isEntering ? "is-entering" : "",
    preyIndex >= 0 ? "is-prey" : "",
    isEntering && preyIndex >= 0 ? "is-entering-prey" : "",
    isPredator ? "is-predator" : ""
  ].filter(Boolean).join(" ");
  const delay = Math.max(0, preyIndex) * 70;
  const style = [
    `--actor-x:${position.x}%`,
    `--actor-y:${position.y}%`,
    `--target-x:${targetPosition.x}%`,
    `--target-y:${targetPosition.y}%`,
    `--fish-size:${getMouthFishSize(card)}%`,
    `--motion-delay:${delay}ms`
  ].join("; ");
  const statusClass = card.type === "fish"
    ? [
        card.invalidatedByOwnPoison ? "is-ineffective" : "",
        card.poisonScoredById ? "is-poison-scored" : "",
        card.schoolSize === 2 ? "is-school" : ""
      ].filter(Boolean).join(" ")
    : card.type === "poison"
      ? "is-poison"
      : "is-bait";

  return `
    <article
      class="mouth-fish-actor ${statusClass} ${card.type === "fish" ? `value-${card.value}` : ""} ${motionClass} ${getPlayerToneClass(card.ownerId)}"
      style="${style}"
      aria-label="${getMouthFishActorLabel(card)}"
    >
      <div class="mouth-fish-body">
        ${renderMouthFishVisual(card)}
      </div>
    </article>
  `;
}

function renderMouthFishVisual(card: BaitBoxCard | FishBoxCard | PoisonBoxCard): string {
  if (card.type === "bait") {
    return `
      <span class="bait-sprite" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="mouth-fish-value">1</span>
    `;
  }

  const artPath = card.type === "poison"
    ? "./assets/cards/poison-fish.png"
    : fishArtPaths[card.schoolBaseValue ?? card.value];
  const valueBadge = card.type === "fish"
    ? `<span class="mouth-fish-value">${card.value}</span>`
    : '<span class="mouth-fish-value is-poison-mark">&#9760;</span>';
  const schoolMate = card.type === "fish" && card.schoolSize === 2
    ? `<span class="mouth-fish-cutout is-school-mate" aria-hidden="true"><img src="${artPath}" alt=""></span>`
    : "";

  return `
    ${schoolMate}
    <span class="mouth-fish-cutout" aria-hidden="true"><img src="${artPath}" alt=""></span>
    ${valueBadge}
    <span class="mouth-fish-owner">${card.ownerName}</span>
  `;
}

function getMouthFishPosition(card: BoxCard): { x: number; y: number } {
  if (card.type === "bait") return { x: 46, y: 55 };
  if (card.type === "poison") return { x: 50, y: 52 };

  const positions = card.type === "fish" && card.value >= 6
    ? [{ x: 50, y: 52 }]
    : card.type === "fish" && card.value === 5
      ? [{ x: 47, y: 50 }, { x: 53, y: 54 }]
      : card.type === "fish" && card.value === 4
        ? [{ x: 44, y: 48 }, { x: 56, y: 56 }, { x: 50, y: 52 }]
        : card.type === "fish" && card.value === 3
          ? [{ x: 42, y: 47 }, { x: 58, y: 57 }, { x: 50, y: 52 }]
          : [
              { x: 39, y: 44 },
              { x: 54, y: 48 },
              { x: 45, y: 59 },
              { x: 61, y: 57 },
              { x: 50, y: 52 }
            ];
  return positions[Math.abs(card.sequence - 2) % positions.length];
}

function getMouthFishSize(card: BoxCard): number {
  if (card.type === "bait") return 8;
  if (card.type === "poison") return 30;
  if (card.type !== "fish") return 12;
  if (card.value === 2) return 36;
  if (card.value === 3) return 36;
  if (card.value === 4) return 27;
  if (card.value === 5) return 37;
  return 38;
}

function getMouthFishActorLabel(card: BoxCard): string {
  if (card.type === "bait") return `${card.ownerName}の餌、1`;
  if (card.type === "poison") return `${card.ownerName}の毒魚`;
  if (card.type === "escape") return `${card.ownerName}の逃げる`;
  const schoolText = card.schoolSize === 2 ? "の群れ" : "";
  return `${card.ownerName}の魚${schoolText}、強さ${card.value}`;
}

function getMouthFishMotionAnnouncement(): string {
  if (!mouthFishMotion) return "";

  const entering = getBoxCard(mouthFishMotion.enteringId);
  const predator = mouthFishMotion.predatorId ? getBoxCard(mouthFishMotion.predatorId) : null;
  const prey = mouthFishMotion.preyIds.map(getBoxCard).filter((card): card is BoxCard => card !== null);

  if (predator && prey.length > 0) {
    return `${getMouthFishActorLabel(predator)}が、${prey.map(getMouthFishActorLabel).join("と")}を食べました。`;
  }

  return entering ? `${getMouthFishActorLabel(entering)}が泳いできました。` : "";
}

function renderBoxCard(card: BoxCard, concealed = false): string {
  const accessibility = concealed ? ' aria-hidden="true"' : "";

  if (card.type === "bait") {
    return `
      <article${accessibility} class="box-card bait-card ${card.consumedById ? "is-eaten" : ""} ${getPlayerToneClass(card.ownerId)}">
        <span class="card-sequence">${card.sequence}</span>
        <span class="card-value">1</span>
        <span class="card-name">餌</span>
        ${card.consumedById ? '<span class="card-tag">食べられた</span>' : ""}
      </article>
    `;
  }

  if (card.type === "poison") {
    const poisonLabel = getPoisonCardStatusLabel(card.status);
    const poisonAccessibility = concealed ? accessibility : ` aria-label="毒魚。${poisonLabel}"`;
    return `
      <article${poisonAccessibility} class="box-card poison-card ${card.status === "active" ? "is-active" : "is-spent"} is-${card.status} ${getPlayerToneClass(card.ownerId)}">
        <span class="card-sequence">${card.sequence}</span>
        <img class="card-fish-art" src="./assets/cards/poison-fish.png" alt="" aria-hidden="true">
        <span class="card-symbol poison-symbol" aria-hidden="true">&#9760;</span>
      </article>
    `;
  }

  if (card.type === "escape") {
    return `
      <article${accessibility} class="box-card escape-card ${card.successful ? "" : "is-ineffective"} ${getPlayerToneClass(card.ownerId)}">
        <span class="card-sequence">${card.sequence}</span>
        <span class="card-value">逃</span>
        <span class="card-name">${card.ownerName}</span>
        <span class="card-tag">${card.successful ? "成功" : "効果なし"}</span>
      </article>
    `;
  }

  const fishArtValue = card.schoolBaseValue ?? card.value;
  return `
    <article${accessibility} class="box-card fish-card-in-box value-${card.value} ${card.schoolSize === 2 ? "is-school" : ""} ${card.consumedById ? "is-eaten" : ""} ${card.poisonScoredById ? "is-poison-scored" : ""} ${card.invalidatedByOwnPoison ? "is-ineffective" : ""} ${card.escaped ? "is-escaped" : ""} ${getPlayerToneClass(card.ownerId)}">
      <span class="card-sequence">${card.sequence}</span>
      ${card.schoolSize === 2 ? '<span class="school-card-layer" aria-hidden="true"></span>' : ""}
      <img class="card-fish-art" src="${fishArtPaths[fishArtValue]}" alt="" aria-hidden="true">
      <span class="card-value">${card.value}</span>
    </article>
  `;
}

function getPoisonCardStatusLabel(status: PoisonCardStatus): string {
  if (status === "active") return "権利あり";
  if (status === "triggered") return "発動済み";
  if (status === "removed") return "除去済み";
  if (status === "overridden") return "権利移動";
  return "終了で無効";
}

function renderPoisonStatus(): string {
  const content = activePoison
    ? `
      <p class="poison-live">${activePoison.ownerName} の毒魚が有効です。</p>
      <p>親は3秒以内に取り除く必要があります。間に合わない場合、${activePoison.ownerName} に10点が入ります。</p>
    `
    : "<p>有効な毒魚はありません。発動済みの毒魚は無効として箱に残ります。</p>";

  return `
    <section class="panel-block">
      <p class="section-label">毒魚</p>
      ${content}
    </section>
  `;
}

function renderScoreboard(): string {
  return `
    <section class="panel-block">
      <p class="section-label">得点</p>
      <div class="score-list">
        ${players
          .map(
            (player) => `
              <div class="score-row ${player.role} ${getPlayerToneClass(player.id)}">
                <div class="score-player">
                  ${renderPlayerIdentity(player)}
                  <small>${player.role === "parent" ? "親" : "子"}</small>
                </div>
                <strong>${player.score}<b>点</b></strong>
              </div>
            `
          )
          .join("")}
      </div>
      ${isGameOver ? renderWinnerNotice() : ""}
    </section>
  `;
}

function renderLog(): string {
  const content = isMouthOpen
    ? '<p class="concealed-log">一番上以外のカード履歴は、トライ終了後に公開されます。</p>'
    : `<ol class="log-list">${logEntries.map((entry) => `<li>${entry}</li>`).join("")}</ol>`;

  return `
    <section class="panel-block">
      <p class="section-label">ログ</p>
      ${content}
    </section>
  `;
}

function renderChildPanel(player: Player, index: number, variant: "opponent" | "self" = "self"): string {
  const isSelf = variant === "self";
  const label = isSelf ? "あなたの子プレイヤー" : (childLabels[index] ?? `子${index + 1}`);
  const candidates = getPlayerCandidates(player.id);
  const latestCandidate = candidates.at(-1);
  const hasNoCards = player.faceUp.every((card) => card === null) && player.drawPile.length === 0;
  const candidateText = hasNoCards
    ? "山札切れ・この親ラウンドでは行動終了"
    : latestCandidate
    ? `逃げ対象: ${getFishCardLabel(latestCandidate)} / ${sumCapturedIds(latestCandidate.capturedIds, player.id)}点`
    : "有効な得点候補なし";

  return `
    <article class="child-panel is-${variant} ${getPlayerToneClass(player.id)}">
      <header class="child-header">
        <div>
          <p class="section-label">${label}</p>
          <h3>${renderPlayerIdentity(player)}</h3>
        </div>
        <strong>${player.score}点</strong>
      </header>
      <div class="hand-row">
        ${player.faceUp.map((card, slotIndex) => renderHandSlot(player, card, slotIndex)).join("")}
      </div>
      ${
        isSelf
          ? `
            <div class="child-meta">
              <span>${candidateText}</span>
              <span>山札 ${player.drawPile.length} / 使用済み ${getUsedPhysicalCardCount(player)}</span>
              <span>同じ2または3をドラッグで重ねると群れになります</span>
            </div>
          `
          : `<p class="microcopy">${candidateText}</p>`
      }
    </article>
  `;
}

function renderHandSlot(player: Player, card: PlayerCard | null, slotIndex: number): string {
  if (!card) {
    return '<div class="hand-slot"><div class="play-card empty-card"><span>空</span></div></div>';
  }

  const canUse =
    (gameMode === "pvp" || player.id === localPlayerId) &&
    player.role === "child" &&
    isMouthOpen &&
    !isGameOver &&
    !mouthFishMotion;
  const ownPoisonMakesFishIneffective = card.type === "fish" && activePoison?.ownerId === player.id;
  const fishLabel = card.type === "fish" ? getFishCardLabel(card) : "";
  const playLabel = ownPoisonMakesFishIneffective
    ? `${fishLabel}を出す（自分の毒魚直後のため効果なし）`
    : card.type === "poison" && activePoison
      ? "毒魚を出して得点の権利を奪う"
      : card.type === "poison"
        ? "毒魚を出す"
        : `${fishLabel}を出す`;
  const isSchool = card.type === "fish" && card.schoolSize === 2;
  const canStack =
    canUse &&
    card.type === "fish" &&
    card.schoolSize === undefined &&
    (card.value === 2 || card.value === 3);
  const cardClass = card.type === "poison"
    ? "poison-hand-card"
    : `fish-hand-card value-${card.value}${isSchool ? " is-school" : ""}`;
  const valueLabel = card.type === "poison" ? "" : String(card.value);
  const artValue = card.type === "fish" ? (card.schoolBaseValue ?? card.value) : null;
  const escapeCandidate = getPlayerCandidates(player.id).at(-1);
  const escapePoints = escapeCandidate ? sumCapturedIds(escapeCandidate.capturedIds, player.id) : 0;
  const escapeLabel = escapeCandidate ? `裏で逃げる ${escapePoints}点` : "裏で逃げる（効果なし）";

  return `
    <div class="hand-slot">
      <button
        class="play-card ${cardClass}"
        type="button"
        data-action="play-card"
        data-player-id="${player.id}"
        data-slot-index="${slotIndex}"
        data-card-id="${card.id}"
        ${canStack ? `data-stack-value="${card.value}"` : ""}
        ${canStack ? 'aria-keyshortcuts="S"' : ""}
        ${canUse ? "" : " disabled"}
        title="${canUse ? `${playLabel}${canStack ? "。同じ数字のカードへドラッグするか、Sキーで群れにできます。" : ""}` : "口が開いている間だけ使用できます。"}"
      >
        ${isSchool ? '<span class="school-card-layer" aria-hidden="true"></span>' : ""}
        <img class="card-fish-art" src="${artValue ? fishArtPaths[artValue] : "./assets/cards/poison-fish.png"}" alt="" aria-hidden="true">
        ${card.type === "poison" ? '<span class="card-symbol poison-symbol" aria-hidden="true">&#9760;</span>' : `<span class="card-value">${valueLabel}</span>`}
      </button>
      <button
        class="escape-chip"
        type="button"
        data-action="escape-card"
        data-player-id="${player.id}"
        data-slot-index="${slotIndex}"
        ${canUse ? "" : " disabled"}
        title="${getPlayerCandidates(player.id).length > 0 ? "このカードを裏向きで使って逃げます。" : "逃げる権利がないため、出しても効果はなく使用済みになります。"}"
      >
        ${escapeLabel}
      </button>
    </div>
  `;
}

function getUsedPhysicalCardCount(player: Player): number {
  return player.used.reduce(
    (total, card) => total + (card.type === "fish" && card.schoolSize === 2 ? 2 : 1),
    0
  );
}

function getMouthStatusLabel(): string {
  if (isGameOver) return "ゲーム終了";
  if (isMouthOpen) return "開いている";
  if (biteAftermath) return "食べている";
  if (isTryEnded) return "トライ終了";
  return "閉じている";
}
