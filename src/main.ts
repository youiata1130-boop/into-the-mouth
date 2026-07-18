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
import { createShuffledDeck, drawCard, useFaceUpCard } from "./game/deck";
import { randomInt, shuffle } from "./game/random";
import {
  estimateFishCaptureValue as estimateBoardFishCaptureValue,
  getCardsInMouth as getBoardCardsInMouth,
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
type GameMode = "pvp" | "cpu" | "online";
type OnlineRole = "none" | "host" | "guest";
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
  isGameOver: boolean;
  logEntries: string[];
  poisonDeadlineAt: number | null;
  tryEndReason: TryEndReason | null;
  tryStartScores: Record<string, number>;
};

const appRoot = getAppRoot();

let hasStarted = false;
let gameMode: GameMode = "cpu";
let onlineLobbyOpen = false;
let onlineRole: OnlineRole = "none";
let onlinePeer: Peer | null = null;
let hostConnection: DataConnection | null = null;
let guestConnections: DataConnection[] = [];
let connectionPlayerIds = new Map<string, string>();
let onlineHumanPlayerIds = new Set<string>();
let localPlayerId = humanPlayerId;
let roomCode = "";
let draftRoomCode = "";
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

const simpleActions: Record<string, () => void> = {
  "start-pvp": () => startGame("pvp"),
  "start-cpu": () => startGame("cpu"),
  "back-to-title": returnToTitle,
  "open-online-lobby": openOnlineLobby,
  "create-room": createOnlineRoom,
  "join-room": joinOnlineRoom,
  "start-online-game": startOnlineGame,
  "apply-setup": applySetup,
  "open-mouth": openMouth,
  "close-mouth": closeMouth,
  "remove-poison": removeActivePoison,
  "next-try": prepareNextTry,
  "advance-parent": advanceParent,
  "reset-game": resetGameWithConfirmation
};

render();

appRoot.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) return;

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

appRoot.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.name !== "roomCode") return;
  draftRoomCode = target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  target.value = draftRoomCode;
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

function returnToTitle(): void {
  if (hasStarted && !confirmDiscardProgress()) return;
  clearNpcTimers();
  clearPoisonRemovalTimer();
  destroyOnlineSession();
  hasStarted = false;
  onlineLobbyOpen = false;
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
    hostConnection = onlinePeer?.connect(`into-mouth-${roomCode}`, { reliable: true }) ?? null;
    if (hostConnection) attachHostConnection(hostConnection);
  });
  onlinePeer.on("error", () => {
    onlineStatus = "部屋が見つからないか、接続できませんでした。コードを確認してください。";
    render();
  });
}

function attachGuestConnection(connection: DataConnection): void {
  connection.on("open", () => {
    const availableId = ["player-2", "player-3", "player-4"].find((id) => !onlineHumanPlayerIds.has(id));
    if (!availableId) {
      connection.send({ type: "room-full" });
      connection.close();
      return;
    }

    guestConnections.push(connection);
    connectionPlayerIds.set(connection.peer, availableId);
    onlineHumanPlayerIds.add(availableId);
    connection.send({ type: "welcome", playerId: availableId, roomCode });
    onlineStatus = `${onlineHumanPlayerIds.size}人が参加中です。ホストがゲームを開始できます。`;
    render();
  });
  connection.on("data", (data) => handleHostMessage(connection, data));
  connection.on("close", () => {
    const playerId = connectionPlayerIds.get(connection.peer);
    if (playerId) onlineHumanPlayerIds.delete(playerId);
    connectionPlayerIds.delete(connection.peer);
    guestConnections = guestConnections.filter((item) => item !== connection);
    onlineStatus = "参加者が退出しました。";
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
  const message = raw as { type?: string; action?: string; playerId?: string; slotIndex?: number };
  if (message.type !== "action" || !message.action) return;

  const assignedId = connectionPlayerIds.get(connection.peer);
  if (!assignedId) return;
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
  const message = raw as { type?: string; playerId?: string; state?: OnlineGameState };
  if (message.type === "welcome" && message.playerId) {
    localPlayerId = message.playerId;
    onlineHumanPlayerIds.add(message.playerId);
    onlineStatus = "接続しました。ホストが開始するのを待っています。";
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
  playerCount = 4;
  draftPlayerCount = 4;
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

function destroyOnlineSession(): void {
  hostConnection?.close();
  guestConnections.forEach((connection) => connection.close());
  onlinePeer?.destroy();
  hostConnection = null;
  guestConnections = [];
  connectionPlayerIds.clear();
  onlineHumanPlayerIds.clear();
  onlinePeer = null;
  onlineRole = "none";
  roomCode = "";
}

function isRemoteGameAction(action: string): boolean {
  return ["open-mouth", "close-mouth", "remove-poison", "play-card", "escape-card", "next-try", "advance-parent"].includes(action);
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
  return Array.from({ length: playerCount }, (_, index) => ({
    id: `player-${index + 1}`,
    name:
      (gameMode === "cpu" && `player-${index + 1}` !== localPlayerId) ||
      (gameMode === "online" && !onlineHumanPlayerIds.has(`player-${index + 1}`))
        ? `CPU ${index + 1}`
        : `プレイヤー${index + 1}`,
    role: index === parentIndex ? "parent" : "child",
    score: 0,
    drawPile: [],
    faceUp: [],
    used: []
  }));
}

function resetChildDeck(player: Player): void {
  player.drawPile = createShuffledDeck(() => nextCardId++);
  player.faceUp = Array.from({ length: visibleCardCount }, () => drawCard(player));
  player.used = [];
}

function createBaitBoxCard(): BaitBoxCard {
  return {
    boxId: nextBoxCardId++,
    type: "bait",
    value: 1,
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
  if (!isMouthOpen || isGameOver) return;

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
    render();
    return;
  }

  const total = getParentCloseTotal();
  parent.score += total;
  addLog(`${parent.name} が口を閉じました。毒魚・逃げる・毒魚で得点化済みの魚を除き、親が ${total} 点を獲得しました。`);
  finishTry();
  render();
}

function finishTry(): void {
  clearNpcTimers();
  clearPoisonRemovalTimer();

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
  addLog(`${getParent().name} が ${removedPoison.ownerName} の毒魚を取り除きました。通常どおり続行します。`);
  render();
}

function playCard(playerId: string, slotIndex: number): void {
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

  const fishBoxCard: FishBoxCard = {
    boxId: nextBoxCardId++,
    sourceCardId: card.id,
    type: "fish",
    value: card.value,
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
    addLog(`${player.name} は自分の毒魚に続けて魚「${card.value}」を出したため、このカードは効果も得点価値も持ちません。`);
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
    addLog(`${player.name} が魚「${card.value}」を出しました。${activePoison.ownerName} の毒魚が発動し、${activePoison.ownerName} が ${card.value} 点を確定しました。`);
    activePoison = null;
    render();
    return;
  }

  fishBoxCard.capturedIds = resolvePredation(fishBoxCard);

  const capturedTotal = sumCapturedIds(fishBoxCard.capturedIds);
  const detail = fishBoxCard.capturedIds.length > 0 ? `得点候補 ${capturedTotal} 点を持ちました。` : "何も食べられず、得点候補はありません。";
  addLog(`${player.name} が魚「${card.value}」を出しました。${detail}`);
  render();
}

function playPoison(player: Player, slotIndex: number): void {
  const card = useFaceUpCard(player, slotIndex);

  if (!card || card.type !== "poison") return;

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
  startPoisonRemovalTimer();
  const takeoverText = previousPoison ? `${previousPoison.ownerName} から得点の権利を奪いました。` : "";
  addLog(`${player.name} が毒魚を入れました。${takeoverText}親は3秒以内に取り除く必要があります。`);
  render();
}

function escapeWithCard(playerId: string, slotIndex: number): void {
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

  const total = sumCapturedIds(target.capturedIds);
  target.escaped = true;
  player.score += total;
  tryEndReason = "escape";
  showEscapeSuccessEffect();
  addLog(`${player.name} が逃げに成功しました。最新の得点候補から ${total} 点を確定し、このトライは終了です。`);
  finishTry();
  render();
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
  return getBoardParentCloseTotal(boxCards);
}

function getCardsInMouth(): BoxCard[] {
  return getBoardCardsInMouth(boxCards);
}

function sumCapturedIds(cardIds: number[]): number {
  return sumBoardCapturedIds(boxCards, cardIds);
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

function getWinnerText(): string {
  const highestScore = Math.max(...players.map((player) => player.score));
  return players
    .filter((player) => player.score === highestScore)
    .map((player) => `${player.name} ${player.score}点`)
    .join(" / ");
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
  render();
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

  if (isGameOver || isTryEnded) return;

  if (!isMouthOpen) {
    npcParentCloseAt = null;

    if (isNpcParent()) {
      npcParentTimerId = window.setTimeout(() => {
        if (!isGameOver && !isTryEnded && !isMouthOpen && isNpcParent()) {
          openMouth();
        }
      }, randomInt(900, 1600));
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

      if (Math.random() < 0.78) {
        removeActivePoison();
      } else {
        closeMouth();
      }
    }, randomInt(650, 1250));
    return;
  }

  if (npcParentCloseAt === null) {
    npcParentCloseAt = Date.now() + randomInt(5600, 9400);
  }

  const availableScore = getParentCloseTotal();

  if (availableScore >= 8) {
    npcParentCloseAt = Math.min(npcParentCloseAt, Date.now() + randomInt(1100, 2100));
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

      if (action.type === "escape") {
        escapeWithCard(player.id, action.slotIndex);
      } else {
        playCard(player.id, action.slotIndex);
      }

      return;
    }

    scheduleNpcAutomation();
  }, randomInt(1100, 2600));
}

function chooseNpcChildAction(player: Player): { type: "play" | "escape"; slotIndex: number } | null {
  const candidate = getPlayerCandidates(player.id).at(-1);
  const candidateTotal = candidate ? sumCapturedIds(candidate.capturedIds) : 0;
  const escapeSlot = getNpcEscapeSlot(player);

  if (candidate && escapeSlot !== null) {
    const shouldSecureSix = candidate.value === 6 && candidateTotal > 0;
    const escapeChance = shouldSecureSix ? 0.94 : candidateTotal >= 6 ? 0.82 : candidateTotal >= 3 ? 0.58 : 0.28;

    if (Math.random() < escapeChance) {
      return { type: "escape", slotIndex: escapeSlot };
    }
  }

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
      .map((item) => ({ ...item, gain: estimateFishCaptureValue(item.card.value) }))
      .sort((left, right) => right.gain - left.gain || right.card.value - left.card.value);
    const usefulFish = rankedFish.filter((item) => item.gain > 0);

    if (usefulFish.length > 0) {
      // 少しだけ判断を揺らし、毎回完全な最善手を即座に選ぶCPUにはしない。
      const choice = usefulFish.length > 1 && Math.random() < 0.14 ? usefulFish[1] : usefulFish[0];
      return { type: "play", slotIndex: choice.slotIndex };
    }

    // 得点につながらない魚は温存する。まれな見落としだけを人間らしさとして残す。
    if (Math.random() < 0.06) {
      return { type: "play", slotIndex: rankedFish[0].slotIndex };
    }
  }

  if (candidate && escapeSlot !== null) {
    return { type: "escape", slotIndex: escapeSlot };
  }

  return null;
}

function estimateFishCaptureValue(value: FishValue): number {
  return estimateBoardFishCaptureValue(boxCards, value);
}

function shouldPlayPoisonNow(): boolean {
  const now = Date.now();
  const parentIsAboutToClose = npcParentCloseAt !== null && npcParentCloseAt - now <= 2400;
  const mouthHasBeenOpenLongEnough = mouthOpenedAt !== null && now - mouthOpenedAt >= 4800;
  const parentHasTemptingScore = getParentCloseTotal() >= 6;

  if (parentIsAboutToClose) return Math.random() < 0.88;
  if (mouthHasBeenOpenLongEnough && parentHasTemptingScore) return Math.random() < 0.68;
  return Math.random() < 0.05;
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
          <section class="mouth-panel" aria-label="大きな魚の口">
            <div class="mouth-title-row">
              <div>
                <p class="section-label">親</p>
                <h2>${getParent().name}</h2>
              </div>
              <span class="mouth-state ${isMouthOpen ? "is-open" : "is-closed"}">${isMouthOpen ? "OPEN" : "CLOSED"}</span>
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

        ${isTryEnded ? renderTryResultOverlay() : ""}
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
            ${renderStat("口内カード", `${getCardsInMouth().length}枚`)}
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

  const resultPanel = appRoot.querySelector<HTMLElement>(".try-result-panel");
  if (resultPanel && !resultWasVisible) {
    resultPanel.focus({ preventScroll: true });
  } else {
    restoreFocusedControl(appRoot, focusedControl);
  }

  broadcastOnlineState();
  scheduleNpcAutomation();
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
              <p class="online-status" role="status">${onlineStatus}</p>
              <button class="primary-button lobby-action" type="button" data-action="start-online-game" ${onlineHumanPlayerIds.size < 2 ? "disabled" : ""}>ゲームを開始</button>
            `
            : isGuest
              ? `<div class="waiting-spinner" aria-hidden="true"></div><p class="online-status" role="status">${onlineStatus}</p>`
              : `
                <p class="start-lead">1人が部屋を作り、表示された6文字のコードを友達に送ります。</p>
                <div class="lobby-actions">
                  <button class="primary-button lobby-action" type="button" data-action="create-room">部屋を作る</button>
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
          <li>箱のカードは先に出たものから並び、直前から逆順に捕食を判定します。</li>
          <li>箱のカードは表向きに重ね、一番上だけ内容が見える状態にします。終了後に全カードの順番と終了位置を公開します。</li>
          <li>魚は数字に関係なく出せます。</li>
          <li>逃げ成功時は、魚自身ではなく食べたカードだけを得点します。</li>
          <li>親が閉じたら、毒魚・逃げる・毒魚で得点化済みの魚を除いた数字カードを得点します。</li>
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
  return `
    <article class="child-panel is-self human-parent-seat">
      <header class="child-header">
        <div>
          <p class="section-label">あなたの番</p>
          <h3>${getParent().name}</h3>
        </div>
        <strong>${getParent().score}点</strong>
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
  return [4, 5, 6]
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
  const canClose = parentIsHuman && !isGameOver && isMouthOpen;
  const canRemovePoison = parentIsHuman && !isGameOver && isMouthOpen && activePoison;
  const parent = getParent();

  return `
    <section class="panel-block parent-controls">
      <p class="section-label">${parentIsHuman ? "あなたが親" : "NPC親"}</p>
      <h2>${parent.name}</h2>
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

function renderTryResultOverlay(): string {
  return `
    <section class="try-result-panel" role="dialog" aria-modal="true" aria-labelledby="try-result-title" tabindex="-1">
      <div class="try-result-header">
        <p class="section-label">1回終了</p>
        <h2 id="try-result-title">${isGameOver ? "ゲーム終了" : "この回の結果"}</h2>
      </div>
      ${isGameOver ? `<p class="notice is-hot">勝者: ${getWinnerText()}</p>` : ""}
      <div class="try-result-grid">
        <section>
          <p class="section-label">獲得点</p>
          <div class="try-score-list">
            ${players
              .map(
                (player) => {
                  const gained = getTryScoreGain(player);

                  return `
                    <div class="try-score-row ${player.role} ${gained > 0 ? "scored" : ""}">
                      <span>${player.name}<small>${player.role === "parent" ? "親" : "子"}</small></span>
                      <strong>+${gained}点</strong>
                      <em>合計 ${player.score}点</em>
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
  if (card.type === "bait") return "餌 1";
  if (card.type === "poison") return `${card.ownerName} 毒魚`;
  if (card.type === "escape") return `${card.ownerName} 逃げる`;
  return `${card.ownerName} 魚${card.value}`;
}

function getTryOrderDetail(card: BoxCard): string {
  if (card.type === "bait") {
    return card.consumedById ? `魚${getEatingFishValue(card.consumedById)}に食べられた` : "箱に残った";
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
    return `逃げ成功 ${sumCapturedIds(card.capturedIds)}点`;
  }

  if (card.consumedById) {
    return `魚${getEatingFishValue(card.consumedById)}に食べられた`;
  }

  const candidateTotal = sumCapturedIds(card.capturedIds);
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
  const cardsInMouth = getCardsInMouth();

  return `
    <div class="mouth ${isMouthOpen ? "is-open" : "is-closed"}">
      <div class="jaw jaw-top" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <div class="mouth-cavity">
        <div class="cavity-meta">
          <span>口の中 ${cardsInMouth.length}枚</span>
          <span>${activePoison ? `毒魚: ${activePoison.ownerName}` : "毒魚なし"}</span>
          ${activePoison ? `<small class="poison-countdown" data-poison-countdown>${getPoisonCountdownLabel()}</small>` : ""}
        </div>
        <div class="mouth-card-stack" aria-label="口の中にカードが${cardsInMouth.length}枚あります。一番上のカードを表示しています">
          ${cardsInMouth.map((card, index) => renderBoxCard(card, index < cardsInMouth.length - 1)).join("")}
        </div>
      </div>
      <div class="jaw jaw-bottom" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
    </div>
  `;
}

function renderBoxCard(card: BoxCard, concealed = false): string {
  const accessibility = concealed ? ' aria-hidden="true"' : "";

  if (card.type === "bait") {
    return `
      <article${accessibility} class="box-card bait-card ${card.consumedById ? "is-eaten" : ""}">
        <span class="card-sequence">${card.sequence}</span>
        <span class="card-value">1</span>
        <span class="card-name">餌</span>
        ${card.consumedById ? '<span class="card-tag">食べられた</span>' : ""}
      </article>
    `;
  }

  if (card.type === "poison") {
    const poisonLabel = getPoisonCardStatusLabel(card.status);
    return `
      <article${accessibility} class="box-card poison-card ${card.status === "active" ? "is-active" : "is-spent"} is-${card.status}">
        <span class="card-sequence">${card.sequence}</span>
        <span class="card-value">毒</span>
        <span class="card-name">${card.ownerName}</span>
        <span class="card-tag">${poisonLabel}</span>
      </article>
    `;
  }

  if (card.type === "escape") {
    return `
      <article${accessibility} class="box-card escape-card ${card.successful ? "" : "is-ineffective"}">
        <span class="card-sequence">${card.sequence}</span>
        <span class="card-value">逃</span>
        <span class="card-name">${card.ownerName}</span>
        <span class="card-tag">${card.successful ? "成功" : "効果なし"}</span>
      </article>
    `;
  }

  const candidateTotal = sumCapturedIds(card.capturedIds);
  const statusTag = getFishStatusTag(card, candidateTotal);

  return `
    <article${accessibility} class="box-card fish-card-in-box value-${card.value} ${card.consumedById ? "is-eaten" : ""} ${card.poisonScoredById ? "is-poison-scored" : ""} ${card.invalidatedByOwnPoison ? "is-ineffective" : ""} ${card.escaped ? "is-escaped" : ""}">
      <span class="card-sequence">${card.sequence}</span>
      <span class="card-value">${card.value}</span>
      <span class="card-name">${card.ownerName}</span>
      ${statusTag}
    </article>
  `;
}

function getFishStatusTag(card: FishBoxCard, candidateTotal: number): string {
  if (card.invalidatedByOwnPoison) return '<span class="card-tag">効果なし</span>';
  if (card.poisonScoredByName) return `<span class="card-tag">毒で${card.poisonScoredByName}へ</span>`;
  if (card.escaped) return `<span class="card-tag">逃げ成功</span>`;
  if (card.consumedById) return `<span class="card-tag">食べられた</span>`;
  if (candidateTotal > 0) return `<span class="card-tag">候補 ${candidateTotal}点</span>`;
  return "";
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
              <div class="score-row ${player.role}">
                <span>${player.name}<small>${player.role === "parent" ? "親" : "子"}</small></span>
                <strong>${player.score}</strong>
              </div>
            `
          )
          .join("")}
      </div>
      ${isGameOver ? `<p class="notice is-hot">勝者: ${getWinnerText()}</p>` : ""}
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
    ? `逃げ対象: 魚${latestCandidate.value} / ${sumCapturedIds(latestCandidate.capturedIds)}点`
    : "有効な得点候補なし";

  return `
    <article class="child-panel is-${variant}">
      <header class="child-header">
        <div>
          <p class="section-label">${label}</p>
          <h3>${player.name}</h3>
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
              <span>山札 ${player.drawPile.length} / 使用済み ${player.used.length}</span>
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

  const canUse = (gameMode === "pvp" || player.id === localPlayerId) && player.role === "child" && isMouthOpen && !isGameOver;
  const ownPoisonMakesFishIneffective = card.type === "fish" && activePoison?.ownerId === player.id;
  const playLabel = ownPoisonMakesFishIneffective
    ? `魚${card.value}を出す（自分の毒魚直後のため効果なし）`
    : card.type === "poison" && activePoison
      ? "毒魚を出して得点の権利を奪う"
      : card.type === "poison"
        ? "毒魚を出す"
        : `魚${card.value}を出す`;
  const cardClass = card.type === "poison" ? "poison-hand-card" : `fish-hand-card value-${card.value}`;
  const valueLabel = card.type === "poison" ? "毒" : String(card.value);
  const nameLabel = card.type === "poison" ? "毒魚" : "魚";
  const cardHint = getHandCardHint(player, card);
  const escapeCandidate = getPlayerCandidates(player.id).at(-1);
  const escapePoints = escapeCandidate ? sumCapturedIds(escapeCandidate.capturedIds) : 0;
  const escapeLabel = escapeCandidate ? `裏で逃げる ${escapePoints}点` : "裏で逃げる（効果なし）";

  return `
    <div class="hand-slot">
      <button
        class="play-card ${cardClass}"
        type="button"
        data-action="play-card"
        data-player-id="${player.id}"
        data-slot-index="${slotIndex}"
        ${canUse ? "" : " disabled"}
        title="${canUse ? playLabel : "口が開いている間だけ使用できます。"}"
      >
        <span class="card-value">${valueLabel}</span>
        <span class="card-name">${nameLabel}</span>
        <span class="card-preview">${cardHint}</span>
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

function getHandCardHint(player: Player, card: PlayerCard): string {
  if (card.type === "poison") {
    return activePoison ? "得点権を奪う" : "得点権を置く";
  }

  if (activePoison?.ownerId === player.id) return "効果なし";
  if (activePoison) return `${activePoison.ownerName}へ${card.value}点`;
  return "場に出す";
}

function getMouthStatusLabel(): string {
  if (isGameOver) return "ゲーム終了";
  if (isMouthOpen) return "開いている";
  if (isTryEnded) return "トライ終了";
  return "閉じている";
}
