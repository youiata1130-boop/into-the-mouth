import "./styles/main.css";
import { Peer } from "peerjs";
import type { DataConnection } from "peerjs";
import { fishArtPaths, poisonFishArtPath, whaleArtPaths } from "./assets/paths";
import {
  CHILD_LABELS as childLabels,
  HUMAN_PLAYER_ID as humanPlayerId,
  MAX_TRIES_PER_PARENT as maxTriesPerParent,
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
type TryEndReason = "parent-close" | "poison-close" | "escape";
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
};
type GameMode = "cpu" | "online";
type OnlineRole = "none" | "host" | "guest";
type OnlineLobbyView = "choice" | "create" | "join";
type CpuDifficulty = "easy" | "normal" | "hard" | "advanced" | "expert";
type CpuDelayKind = "open" | "poison" | "close" | "secure" | "child";
type CpuTuning = {
  escapeMultiplier: number;
  mistakeChance: number;
  unproductiveFishChance: number;
  poisonTakeoverChance: number;
  ownPoisonFishAvoidChance: number;
  opponentPoisonFishAvoidChance: number;
  poisonAccuracy: number;
  randomPoisonChance: number;
  poisonRemovalChance: number;
  closeScore: number;
  delays: Record<CpuDelayKind, readonly [number, number]>;
};
type TutorialAction = "play-fish-2" | "play-fish-4" | "escape" | "continue-result" | "continue-parent" | "open-mouth" | "close-mouth" | "remove-poison";
type TutorialVisual =
  | "first-meal"
  | "first-feast"
  | "enemy-ambush"
  | "first-counterattack"
  | "first-victory"
  | "mouth-closed"
  | "escape-retry"
  | "escape-ready"
  | "escape-success"
  | "escape-result"
  | "parent-view"
  | "close-moment"
  | "poison-warning"
  | "poison-practice"
  | "poison-cleared"
  | "rule-cards"
  | "finale";
type TutorialStep = {
  chapter: string;
  title: string;
  dialogue: string;
  helper: string;
  visual: TutorialVisual;
  action?: TutorialAction;
  actionDelayMs?: number;
  autoAdvanceMs?: number;
  nextLabel?: string;
};
type NpcChildAction =
  | { type: "play" | "escape"; slotIndex: number }
  | { type: "stack"; sourceSlotIndex: number; targetSlotIndex: number };
type StackCardIdentity = {
  playerId: string;
  slotIndex: number;
  cardId: number;
  stackValue: "2" | "3";
};
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
  cpuDifficulty?: CpuDifficulty;
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
  actionWaitingPlayerIds?: string[];
  cardPlayWaitingPlayerIds?: string[];
  isGameOver: boolean;
  logEntries: string[];
  tryEndReason: TryEndReason | null;
  tryStartScores: Record<string, number>;
};
type TryResultView = {
  players: Player[];
  cards: BoxCard[];
  startScores: Record<string, number>;
  endReason: TryEndReason | null;
  actionsHtml: string;
  embedded?: boolean;
};

const cpuTuning = {
  easy: {
    escapeMultiplier: 0.62,
    mistakeChance: 0.44,
    unproductiveFishChance: 0.2,
    poisonTakeoverChance: 0.86,
    ownPoisonFishAvoidChance: 0.96,
    opponentPoisonFishAvoidChance: 0.9,
    poisonAccuracy: 0.58,
    randomPoisonChance: 0.12,
    poisonRemovalChance: 0.48,
    closeScore: 11,
    delays: { open: [1400, 2400], poison: [1050, 1750], close: [7200, 11200], secure: [1800, 3000], child: [1800, 3400] }
  },
  normal: {
    escapeMultiplier: 1,
    mistakeChance: 0.14,
    unproductiveFishChance: 0.06,
    poisonTakeoverChance: 0.86,
    ownPoisonFishAvoidChance: 0.96,
    opponentPoisonFishAvoidChance: 0.9,
    poisonAccuracy: 1,
    randomPoisonChance: 0.05,
    poisonRemovalChance: 0.78,
    closeScore: 8,
    delays: { open: [900, 1600], poison: [650, 1250], close: [5600, 9400], secure: [1100, 2100], child: [1100, 2600] }
  },
  hard: {
    escapeMultiplier: 1.15,
    mistakeChance: 0.03,
    unproductiveFishChance: 0.01,
    poisonTakeoverChance: 0.86,
    ownPoisonFishAvoidChance: 0.96,
    opponentPoisonFishAvoidChance: 0.9,
    poisonAccuracy: 1.08,
    randomPoisonChance: 0.02,
    poisonRemovalChance: 0.94,
    closeScore: 6,
    delays: { open: [550, 1000], poison: [380, 750], close: [4400, 7600], secure: [650, 1250], child: [650, 1500] }
  },
  advanced: {
    escapeMultiplier: 1.22,
    mistakeChance: 0.01,
    unproductiveFishChance: 0.003,
    poisonTakeoverChance: 0.95,
    ownPoisonFishAvoidChance: 0.99,
    opponentPoisonFishAvoidChance: 0.97,
    poisonAccuracy: 1.14,
    randomPoisonChance: 0.01,
    poisonRemovalChance: 0.98,
    closeScore: 6,
    delays: { open: [450, 800], poison: [260, 500], close: [3800, 6500], secure: [450, 850], child: [480, 1000] }
  },
  expert: {
    escapeMultiplier: 1.25,
    mistakeChance: 0,
    unproductiveFishChance: 0,
    poisonTakeoverChance: 1,
    ownPoisonFishAvoidChance: 1,
    opponentPoisonFishAvoidChance: 1,
    poisonAccuracy: 1.2,
    randomPoisonChance: 0,
    poisonRemovalChance: 1,
    closeScore: 5,
    delays: { open: [350, 650], poison: [180, 320], close: [3200, 5600], secure: [260, 480], child: [320, 700] }
  }
} as const satisfies Record<CpuDifficulty, CpuTuning>;

const appRoot = getAppRoot();
const gameImagePaths = [...new Set([
  ...Object.values(fishArtPaths),
  poisonFishArtPath,
  ...Object.values(whaleArtPaths)
])];
const biteAftermathDurationMs = 1500;
const mouthFishMotionDurationMs = 900;
const ownActionWaitExtensionMs = 300;
const ownActionWaitDurationMs = mouthFishMotionDurationMs + ownActionWaitExtensionMs;
const tutorialSteps: readonly TutorialStep[] = [
  {
    chapter: "子の冒険",
    title: "くじらの入り江へ",
    dialogue: "魚2を出して、ご飯を食べに行こう！",
    helper: "光っている魚2をタップしてください。",
    visual: "first-meal",
    action: "play-fish-2"
  },
  {
    chapter: "子の冒険",
    title: "ごちそうを食べました",
    dialogue: "おいしかったですね！",
    helper: "魚2は餌1を食べ、そのまま口の中を泳ぎます。",
    visual: "first-feast",
    autoAdvanceMs: 4000
  },
  {
    chapter: "子の冒険",
    title: "魚2が食べられた！",
    dialogue: "あっ、魚2が食べられた！",
    helper: "大きい魚は小さい魚と、その魚が捕まえた獲物を引き継ぎます。",
    visual: "enemy-ambush",
    autoAdvanceMs: 5000
  },
  {
    chapter: "子の冒険",
    title: "もっと大きな魚を！",
    dialogue: "魚4で食べ返そう！",
    helper: "光っている魚4をタップしてください。",
    visual: "first-counterattack",
    action: "play-fish-4"
  },
  {
    chapter: "子の冒険",
    title: "今度はこちらの番！",
    dialogue: "魚を食べることができました！",
    helper: "同じ数字か、それより大きい魚を出すと食べられます。さらに大きな魚には食べられます。",
    visual: "first-victory",
    autoAdvanceMs: 4500
  },
  {
    chapter: "子の冒険",
    title: "ここは大きな口の中！",
    dialogue: "うわ！ ここは大きな魚の口の中！",
    helper: "獲物を捕まえたら、食べられる前に逃げましょう。次のトライで練習します。",
    visual: "mouth-closed",
    nextLabel: "逃げる練習へ"
  },
  {
    chapter: "子の冒険",
    title: "もう一度、魚4を出そう",
    dialogue: "もう一度、魚4を出そう！",
    helper: "魚3が魚2と餌1を持っています。光っている魚4をタップしてください。",
    visual: "escape-retry",
    action: "play-fish-4"
  },
  {
    chapter: "子の冒険",
    title: "食べられる前に逃げよう",
    dialogue: "食べられる前に逃げよう！",
    helper: "獲物を捕まえた魚は、手札1枚を裏向きに使って逃げられます。「裏で逃げる 4点」をタップしてください。",
    visual: "escape-ready",
    action: "escape"
  },
  {
    chapter: "子の冒険",
    title: "ヒューん！ 逃げ切りました",
    dialogue: "逃げ切りました！",
    helper: "相手の魚3＋親の餌1＝4点です。自分の魚と逃走用カードは数えません。",
    visual: "escape-success",
    nextLabel: "リザルトを見る"
  },
  {
    chapter: "子の冒険",
    title: "4点を獲得！",
    dialogue: "4点獲得！",
    helper: "逃げると得点が確定します。獲得点・合計点・カードの順番はリザルトで確認できます。",
    visual: "escape-result",
    action: "continue-result"
  },
  {
    chapter: "親の冒険",
    title: "次はあなたが親！",
    dialogue: "次はあなたが親です！",
    helper: "大きな魚を操作して獲物を捕まえます。光っている「口を開く」をタップしてください。",
    visual: "parent-view",
    action: "open-mouth"
  },
  {
    chapter: "親の冒険",
    title: "魚が飛び込んできた！",
    dialogue: "そろそろ口を閉じよう！",
    helper: "魚2・3・4が順に入り、大きい魚が先にいた魚を食べます。魚4だけ残ったら「口を閉じる」をタップしてください。",
    visual: "close-moment",
    action: "close-mouth",
    actionDelayMs: 2100
  },
  {
    chapter: "親の冒険",
    title: "毒魚が飛び込んできた！",
    dialogue: "毒魚まで食べてしまった！",
    helper: "毒魚が入ったまま口を閉じると、親は0点です。失敗の流れを確認しましょう。",
    visual: "poison-warning",
    action: "continue-parent",
    actionDelayMs: 2800
  },
  {
    chapter: "親の冒険",
    title: "毒魚は吐き出そう",
    dialogue: "毒魚は吐き出そう！",
    helper: "食べる直前まで戻りました。光っている「毒魚を取り除く」をタップしてください。",
    visual: "poison-practice",
    action: "remove-poison"
  },
  {
    chapter: "親の冒険",
    title: "上手に吐き出せました",
    dialogue: "上手に吐き出せました！",
    helper: "毒魚を取り除く時間に制限はありません。魚だけになったら口を閉じましょう。",
    visual: "poison-cleared",
    nextLabel: "特別ルールへ"
  },
  {
    chapter: "海の手引き",
    title: "逃げる・毒魚・魚群",
    dialogue: "特別なルールを確認しよう！",
    helper: "逃げる成功で得点を確定。毒魚は早めに取り除き、同じ魚2・魚3は群れにできます。",
    visual: "rule-cards",
    nextLabel: "冒険のまとめへ"
  },
  {
    chapter: "冒険のはじまり",
    title: "親でも子でも得点しよう",
    dialogue: "最高得点をめざそう！",
    helper: "全員が1回ずつ親を担当します。親1人につき3トライで、合計得点が一番高い人の勝ちです。",
    visual: "finale",
    nextLabel: "チュートリアルを終える"
  }
] as const;

let hasStarted = false;
let gameMode: GameMode = "cpu";
let modeSetupOpen = false;
let pendingGameMode: GameMode = "cpu";
let cpuDifficulty: CpuDifficulty = "normal";
let onlineLobbyOpen = false;
let onlineRole: OnlineRole = "none";
let onlineLobbyView: OnlineLobbyView = "choice";
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
let onlineJoinRejected = false;
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
let mouthFishMotionStartedAt: number | null = null;
let actionWaitingPlayerIds = new Set<string>();
let actionWaitTimerIds = new Map<string, number>();
let isGameOver = false;
let logEntries: string[] = [];
let npcChildTimerId: number | null = null;
let npcChildActAt: number | null = null;
let npcParentTimerId: number | null = null;
let npcParentCloseAt: number | null = null;
let npcParentPoisonActAt: number | null = null;
let mouthOpenedAt: number | null = null;
let gameEffect: GameEffect | null = null;
let gameEffectTimerId: number | null = null;
let tryEndReason: TryEndReason | null = null;
let tryStartScores: Record<string, number> = {};
let stackDragState: StackDragState | null = null;
let suppressNextCardClick = false;
let suppressClickTimerId: number | null = null;
let tutorialStep: number | null = null;
let tutorialReturnToRules = false;
let tutorialAutoTimerId: number | null = null;
let tutorialActionUnlockTimerId: number | null = null;
let tutorialActionUnlockStep: number | null = null;
let tutorialActionUnlockAt: number | null = null;

const simpleActions: Record<string, () => void> = {
  "start-game-loading": loadGameImages,
  "open-tutorial": openTutorial,
  "tutorial-previous": showPreviousTutorialStep,
  "tutorial-next": showNextTutorialStep,
  "tutorial-play-fish-2": playTutorialFish2,
  "tutorial-play-fish-4": playTutorialFish4,
  "tutorial-escape": escapeTutorialFish,
  "tutorial-continue-result": continueTutorialResult,
  "tutorial-continue-parent": continueTutorialParent,
  "tutorial-open-mouth": openTutorialMouth,
  "tutorial-close-mouth": closeTutorialMouth,
  "tutorial-remove-poison": removeTutorialPoison,
  "close-tutorial": closeTutorial,
  "start-cpu": () => openModeSetup("cpu"),
  "back-to-title": returnToTitle,
  "open-online-lobby": openOnlineLobby,
  "choose-create-room": () => showOnlineLobbyView("create"),
  "choose-join-room": () => showOnlineLobbyView("join"),
  "back-online-choice": () => showOnlineLobbyView("choice"),
  "retry-online-join": retryOnlineJoin,
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

renderGameLaunchScreen();

function renderGameLaunchScreen(): void {
  appRoot.innerHTML = `
    <main class="start-screen launch-screen">
      ${renderOceanBackdrop()}
      <section class="start-card launch-card" aria-labelledby="launch-title">
        <div class="ocean-whale launch-mark" aria-hidden="true"><span></span></div>
        <p class="start-eyebrow">WELCOME TO THE BLUE</p>
        <h1 id="launch-title">口に入る</h1>
        <p class="launch-catch">くじらの口へ、飛び込もう。</p>
        <p class="start-lead">魚を食べるか、毒を仕掛けるか。<br>大きなくじらの口を舞台に、最高得点を目指そう。</p>
        <button class="primary-button launch-start-button" type="button" data-action="start-game-loading">
          ゲームスタート
        </button>
        <p class="launch-note">ボタンを押すと、ゲーム画像を読み込みます</p>
      </section>
    </main>
  `;
}

function renderOceanBackdrop(): string {
  return `
    <div class="ocean-rays" aria-hidden="true"></div>
    <div class="ocean-bubbles" aria-hidden="true">
      <span></span><span></span><span></span><span></span><span></span><span></span>
    </div>
    <div class="ocean-seabed" aria-hidden="true"></div>
  `;
}

async function loadGameImages(): Promise<void> {
  renderLoadingScreen(0, gameImagePaths.length);

  let loadedCount = 0;
  await Promise.all(gameImagePaths.map(async (path) => {
    try {
      await preloadImage(path);
    } finally {
      loadedCount += 1;
      renderLoadingScreen(loadedCount, gameImagePaths.length);
    }
  }));

  render();
}

function preloadImage(path: string): Promise<void> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (): void => resolve();
    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", finish, { once: true });
    image.src = path;
  });
}

function renderLoadingScreen(loadedCount: number, totalCount: number): void {
  const progress = totalCount === 0 ? 100 : Math.round((loadedCount / totalCount) * 100);
  appRoot.innerHTML = `
    <main class="loading-screen" aria-labelledby="loading-title">
      ${renderOceanBackdrop()}
      <section class="loading-card">
        <div class="ocean-whale loading-whale" aria-hidden="true"><span></span></div>
        <p class="start-eyebrow">DIVING INTO THE GAME</p>
        <h1 id="loading-title">ゲームを準備中</h1>
        <p class="loading-message" role="status" aria-live="polite">海の仲間を呼んでいます… ${progress}%</p>
        <div class="loading-track" role="progressbar" aria-label="画像の読み込み状況" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
          <span style="width: ${progress}%"></span>
        </div>
        <p class="loading-count">${loadedCount} / ${totalCount}</p>
      </section>
    </main>
  `;
}

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
    const nextPlayerCount = Number(countButton.dataset.playerCount);
    if (!Number.isInteger(nextPlayerCount) || nextPlayerCount < 3 || nextPlayerCount > 6) return;
    if (onlineLobbyOpen && onlineRole !== "none") return;

    draftPlayerCount = nextPlayerCount;
    if (draftParentIndex >= draftPlayerCount) draftParentIndex = 0;
    render();
    return;
  }

  const difficultyButton = target.closest<HTMLButtonElement>("button[data-cpu-difficulty]");
  if (difficultyButton) {
    const nextDifficulty = difficultyButton.dataset.cpuDifficulty;
    if (!isCpuDifficulty(nextDifficulty)) return;
    if (onlineLobbyOpen && onlineRole !== "none") return;

    cpuDifficulty = nextDifficulty;
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
    const waitingPlayerId = action === "play-card"
      ? button.dataset.playerId
      : action === "open-mouth" || action === "remove-poison"
        ? localPlayerId
        : undefined;
    if (waitingPlayerId) {
      startOwnActionWait(waitingPlayerId, ownActionWaitDurationMs);
      render();
    }
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
  if (tutorialStep !== null) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      showPreviousTutorialStep();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      showNextTutorialStep();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeTutorial();
    }
    return;
  }

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
        identity.stackValue === sourceIdentity.stackValue &&
        canStackCardIdentities(sourceIdentity, identity)
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

function getStackCardIdentity(button: HTMLButtonElement): StackCardIdentity | null {
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
  const sourceIdentity: StackCardIdentity = {
    playerId: drag.playerId,
    slotIndex: drag.sourceSlotIndex,
    cardId: drag.sourceCardId,
    stackValue: drag.stackValue
  };
  if (!canStackCardIdentities(sourceIdentity, identity)) return null;
  return button;
}

function canStackCardIdentities(source: StackCardIdentity, target: StackCardIdentity): boolean {
  if (source.playerId !== target.playerId || source.slotIndex === target.slotIndex) return false;
  if (source.stackValue !== target.stackValue) return false;

  const player = getPlayer(source.playerId);
  const sourceCard = player.faceUp[source.slotIndex] ?? null;
  const targetCard = player.faceUp[target.slotIndex] ?? null;
  if (sourceCard?.id !== source.cardId || targetCard?.id !== target.cardId) return false;
  return canStackFishCards(sourceCard, targetCard);
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
  const player = getPlayer(playerId);
  if (player.role !== "child" || !isMouthOpen || isTryEnded || isGameOver) return;

  const school = stackFaceUpFishCards(
    player,
    sourceSlotIndex,
    targetSlotIndex,
    expectedSourceCardId,
    expectedTargetCardId
  );

  if (!school?.schoolBaseValue || !school.schoolSize) return;
  const refillText = player.faceUp[sourceSlotIndex]
    ? "空いた場所には山札から1枚補充しました。"
    : "山札がないため、空いた場所はそのままです。";
  addLog(`${player.name} が ${school.schoolBaseValue} を合計${school.schoolSize}枚重ね、${school.schoolSize}匹・強さ${school.value}の群れを作りました。${refillText}`);
  render();
}

function setupNewGame(): void {
  clearNpcTimers(true);
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
  startGame(pendingGameMode);
}

function returnToTitle(): void {
  if (hasStarted && !confirmDiscardProgress()) return;
  clearNpcTimers(true);
  clearBiteAftermath();
  clearTryReplay();
  clearMouthFishMotion();
  clearOwnActionWaits();
  destroyOnlineSession();
  hasStarted = false;
  onlineLobbyOpen = false;
  modeSetupOpen = false;
  render();
}

function openOnlineLobby(): void {
  gameMode = "online";
  modeSetupOpen = false;
  onlineLobbyOpen = true;
  onlineLobbyView = "choice";
  onlineStatus = "部屋を作るか、友達の部屋に参加するかを選んでください。";
  render();
}

function showOnlineLobbyView(view: OnlineLobbyView): void {
  if (onlineRole !== "none") return;
  onlineLobbyView = view;
  onlineStatus = view === "choice" ? "遊び方を選んでください。" : "";
  render();
}

function createOnlineRoom(): void {
  destroyOnlineSession();
  gameMode = "online";
  onlineRole = "host";
  onlineLobbyView = "create";
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
  onlineLobbyView = "join";
  onlineJoinRejected = false;
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
    onlineJoinRejected = true;
    onlineStatus = "部屋が見つからないか、接続できませんでした。コードを確認してください。";
    render();
  });
}

function retryOnlineJoin(): void {
  destroyOnlineSession();
  gameMode = "online";
  onlineLobbyOpen = true;
  onlineLobbyView = "join";
  onlineStatus = "参加コードを確認して、もう一度入力してください。";
  render();
}

function attachGuestConnection(connection: DataConnection): void {
  connection.on("open", () => {
    if (hasStarted) {
      connection.send({ type: "room-started" });
      window.setTimeout(() => connection.close(), 150);
      return;
    }

    const availableId = Array.from({ length: draftPlayerCount - 1 }, (_, index) => `player-${index + 2}`).find((id) => !onlineHumanPlayerIds.has(id));
    if (!availableId) {
      connection.send({ type: "room-full" });
      window.setTimeout(() => connection.close(), 150);
      return;
    }

    guestConnections.push(connection);
    connectionPlayerIds.set(connection.peer, availableId);
    onlineHumanPlayerIds.add(availableId);
    const metadata = connection.metadata as { playerName?: string } | undefined;
    onlinePlayerNames.set(availableId, sanitizePlayerName(metadata?.playerName, `プレイヤー${onlineHumanPlayerIds.size}`));
    updateOnlineLobbyMembers();
    connection.send({ type: "welcome", playerId: availableId, roomCode });
    onlineStatus = "友達が参加しました。ゲームを開始できます。";
    broadcastOnlineLobby();
    render();
  });
  connection.on("data", (data) => handleHostMessage(connection, data));
  connection.on("close", () => {
    const playerId = connectionPlayerIds.get(connection.peer);
    if (!playerId) return;
    onlineHumanPlayerIds.delete(playerId);
    onlinePlayerNames.delete(playerId);
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
    if (onlineRole !== "guest") return;
    if (onlineJoinRejected) {
      hasStarted = false;
      onlineLobbyOpen = true;
      render();
      return;
    }
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
  const message = raw as {
    type?: string;
    playerId?: string;
    state?: OnlineGameState;
    members?: OnlineLobbyMember[];
  };
  if (message.type === "welcome" && message.playerId) {
    onlineJoinRejected = false;
    localPlayerId = message.playerId;
    onlineHumanPlayerIds.add(message.playerId);
    onlineStatus = "接続しました。ホストが開始するのを待っています。";
    render();
  } else if (message.type === "lobby" && message.members) {
    onlineJoinRejected = false;
    onlineLobbyMembers = message.members;
    onlineStatus = "ホストがゲームを開始するのを待っています。";
    render();
  } else if (message.type === "state" && message.state) {
    applyOnlineState(message.state);
  } else if (message.type === "room-full") {
    onlineJoinRejected = true;
    onlineStatus = "この部屋は満員です。";
    render();
  } else if (message.type === "room-started") {
    onlineJoinRejected = true;
    onlineStatus = "この部屋はすでにゲームを開始しています。";
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[character] ?? character);
}

function isCpuDifficulty(value: unknown): value is CpuDifficulty {
  return value === "easy" || value === "normal" || value === "hard" || value === "advanced" || value === "expert";
}

function updateOnlineLobbyMembers(): void {
  onlineLobbyMembers = [...onlineHumanPlayerIds].map((playerId) => ({
    playerId,
    name: onlinePlayerNames.get(playerId) ?? playerId,
    isHost: playerId === "player-1"
  }));
}

function broadcastOnlineLobby(): void {
  const message = { type: "lobby", members: onlineLobbyMembers };
  guestConnections.filter((connection) => connection.open).forEach((connection) => connection.send(message));
}

function destroyOnlineSession(): void {
  const connectionToHost = hostConnection;
  const connectionsToGuests = guestConnections;
  const peerToDestroy = onlinePeer;

  clearOwnActionWaits();
  hostConnection = null;
  guestConnections = [];
  connectionPlayerIds.clear();
  onlineHumanPlayerIds.clear();
  onlinePlayerNames.clear();
  onlineLobbyMembers = [];
  onlinePeer = null;
  onlineRole = "none";
  onlineLobbyView = "choice";
  onlineJoinRejected = false;
  roomCode = "";

  connectionToHost?.close();
  connectionsToGuests.forEach((connection) => connection.close());
  peerToDestroy?.destroy();
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
  clearNpcTimers(true);
  clearBiteAftermath();
  clearTryReplay();
  clearMouthFishMotion();
  clearOwnActionWaits();
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
  const parent = getParent();
  if (isGameOver || isMouthOpen || isTryEnded || isPlayerWaitingAfterOwnAction(parent.id)) return;

  isMouthOpen = true;
  npcParentCloseAt = null;
  mouthOpenedAt = Date.now();
  startOwnActionWait(parent.id, ownActionWaitDurationMs);
  addLog(`${parent.name} が口を開けました。カードは押した順に処理します。`);
  render();
}

function closeMouth(): void {
  const parent = getParent();
  if (!isMouthOpen || isGameOver || isPlayerWaitingAfterOwnAction(parent.id)) return;

  tryEndReason = activePoison ? "poison-close" : "parent-close";
  showMouthCloseEffect();

  if (activePoison) {
    const poisonOwner = getPlayer(activePoison.ownerId);
    poisonOwner.score += 10;
    markPoisonResolved(activePoison.boxId, "triggered");
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
  clearNpcTimers(true);
  clearMouthFishMotion();
  clearOwnActionWaits();

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
  const parent = getParent();
  if (!isMouthOpen || !activePoison || isPlayerWaitingAfterOwnAction(parent.id)) return;

  const removedPoison = activePoison;
  markPoisonResolved(removedPoison.boxId, "removed");
  activePoison = null;
  clearMouthFishMotion();
  startOwnActionWait(parent.id, ownActionWaitDurationMs);
  addLog(`${parent.name} が ${removedPoison.ownerName} の毒魚を取り除きました。通常どおり続行します。`);
  render();
}

function playCard(playerId: string, slotIndex: number): void {
  if (isPlayerWaitingAfterOwnAction(playerId)) return;

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
    startFishEntryMotion(fishBoxCard, liveBeforeIds, player.id);
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
    addLog(`${player.name} が${getFishCardLabel(card)}を出しました。${activePoison.ownerName} の毒魚が発動し、${activePoison.ownerName} が ${card.value} 点を確定しました。`);
    activePoison = null;
    startFishEntryMotion(fishBoxCard, liveBeforeIds, player.id);
    render();
    return;
  }

  fishBoxCard.capturedIds = resolvePredation(fishBoxCard);

  startFishEntryMotion(fishBoxCard, liveBeforeIds, player.id);
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
  playerId: string
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

  startMouthFishMotion(
    {
      enteringId: fish.boxId,
      predatorId,
      preyIds: [...new Set(preyIds)]
    },
    playerId
  );
}

function getFishCardLabel(card: FishCard | FishBoxCard): string {
  return card.schoolBaseValue
    ? `${card.schoolBaseValue}の群れ（${getSchoolVisualFishCount(card)}匹・強さ${card.value}）`
    : `魚「${card.value}」`;
}

function getSchoolVisualFishCount(card: Pick<FishCard, "schoolSize">): number {
  return card.schoolSize ?? 1;
}

function getLiveMouthFishCount(): number {
  return getLiveMouthNumericCards().reduce(
    (total, card) => total + (card.type === "fish" ? getSchoolVisualFishCount(card) : 0),
    0
  );
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
  startMouthFishMotion(
    {
      enteringId: poisonBoxCard.boxId,
      predatorId: null,
      preyIds: []
    },
    player.id
  );
  const takeoverText = previousPoison ? `${previousPoison.ownerName} から得点の権利を奪いました。` : "";
  addLog(`${player.name} が毒魚を入れました。${takeoverText}親は毒魚が有効な間、時間制限なく取り除けます。`);
  render();
}

function escapeWithCard(playerId: string, slotIndex: number): void {
  if (isPlayerWaitingAfterOwnAction(playerId)) return;

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
      }, getCpuDelay("open"));
    }

    return;
  }

  scheduleNpcParentAction();
  scheduleNpcChildAction();
}

function clearNpcTimers(resetDeadlines = false): void {
  if (npcChildTimerId !== null) {
    window.clearTimeout(npcChildTimerId);
    npcChildTimerId = null;
  }

  if (npcParentTimerId !== null) {
    window.clearTimeout(npcParentTimerId);
    npcParentTimerId = null;
  }

  if (resetDeadlines) {
    npcChildActAt = null;
    npcParentCloseAt = null;
    npcParentPoisonActAt = null;
  }
}

function usesStableNpcDeadlines(): boolean {
  return cpuDifficulty === "advanced" || cpuDifficulty === "expert";
}

function scheduleNpcParentAction(): void {
  if (!isNpcParent() || !isMouthOpen || isTryEnded || isGameOver) return;
  if (isPlayerWaitingAfterOwnAction(getParent().id)) return;

  if (activePoison) {
    if (usesStableNpcDeadlines() && npcParentPoisonActAt === null) {
      npcParentPoisonActAt = Date.now() + getCpuDelay("poison");
    }
    const poisonActionDelay = usesStableNpcDeadlines() && npcParentPoisonActAt !== null
      ? Math.max(cpuDifficulty === "expert" ? 40 : 120, npcParentPoisonActAt - Date.now())
      : getCpuDelay("poison");

    npcParentTimerId = window.setTimeout(() => {
      npcParentPoisonActAt = null;
      if (!isMouthOpen || isTryEnded || isGameOver || !isNpcParent() || !activePoison) return;

      if (Math.random() < getCpuPoisonRemovalChance()) {
        removeActivePoison();
      } else {
        closeMouth();
      }
    }, poisonActionDelay);
    return;
  }

  npcParentPoisonActAt = null;

  if (npcParentCloseAt === null) {
    npcParentCloseAt = Date.now() + getCpuDelay("close");
  }

  const availableScore = getParentCloseTotal();

  if (availableScore >= getCpuCloseScore() || shouldStrategicParentSecure(availableScore)) {
    npcParentCloseAt = Math.min(npcParentCloseAt, Date.now() + getCpuDelay("secure"));
  }

  npcParentTimerId = window.setTimeout(() => {
    if (!isMouthOpen || isTryEnded || isGameOver || !isNpcParent()) return;

    if (activePoison) {
      scheduleNpcAutomation();
      return;
    }

    closeMouth();
  }, Math.max(cpuDifficulty === "expert" ? 40 : cpuDifficulty === "advanced" ? 120 : 260, npcParentCloseAt - Date.now()));
}

function shouldStrategicParentSecure(availableScore: number): boolean {
  if (!usesStableNpcDeadlines() || availableScore <= 0) return false;

  return getChildren().some((player) => {
    const canAct = player.faceUp.some(Boolean);
    if (!canAct) return false;

    const canEscapeWithPoints = getPlayerCandidates(player.id).some(
      (candidate) => sumCapturedIds(candidate.capturedIds, player.id) > 0
    );
    const canPlayPoison = player.faceUp.some((card) => card?.type === "poison");
    if (cpuDifficulty === "expert") return canEscapeWithPoints || canPlayPoison;
    return (canEscapeWithPoints && availableScore >= 3) || (canPlayPoison && availableScore >= 5);
  });
}

function scheduleNpcChildAction(): void {
  const npcChildren = getNpcChildren().filter(
    (player) => player.faceUp.some(Boolean) && !isPlayerWaitingAfterOwnAction(player.id)
  );

  if (npcChildren.length === 0) {
    if (usesStableNpcDeadlines()) npcChildActAt = null;
    return;
  }

  if (usesStableNpcDeadlines() && npcChildActAt === null) {
    npcChildActAt = Date.now() + getCpuDelay("child");
  }

  const actionDelay = usesStableNpcDeadlines() && npcChildActAt !== null
    ? Math.max(cpuDifficulty === "expert" ? 80 : 140, npcChildActAt - Date.now())
    : getCpuDelay("child");

  npcChildTimerId = window.setTimeout(() => {
    npcChildActAt = null;
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
  }, actionDelay);
}

function chooseNpcChildAction(player: Player): NpcChildAction | null {
  if (cpuDifficulty === "expert") return chooseExpertNpcChildAction(player);

  const tuning = cpuTuning[cpuDifficulty];
  const candidate = getPlayerCandidates(player.id).at(-1);
  const candidateTotal = candidate ? sumCapturedIds(candidate.capturedIds, player.id) : 0;
  const escapeSlot = getNpcEscapeSlot(player);

  if (candidate && escapeSlot !== null) {
    const shouldSecureLargeSchool = candidate.value >= 6 && candidateTotal > 0;
    const escapeChance = shouldSecureLargeSchool ? 0.94 : candidateTotal >= 6 ? 0.82 : candidateTotal >= 3 ? 0.58 : 0.28;

    if (Math.random() < Math.min(0.98, escapeChance * tuning.escapeMultiplier)) {
      return { type: "escape", slotIndex: escapeSlot };
    }
  }

  const stackPair = getNpcStackPair(player);
  if (stackPair) return { type: "stack", ...stackPair };

  const poisonSlot = player.faceUp.findIndex((card) => card?.type === "poison");

  if (poisonSlot >= 0) {
    const canTakePoisonRight = activePoison && activePoison.ownerId !== player.id;

    if ((canTakePoisonRight && Math.random() < tuning.poisonTakeoverChance) || (!activePoison && shouldPlayPoisonNow())) {
      return { type: "play", slotIndex: poisonSlot };
    }
  }

  const fishSlots = player.faceUp
    .map((card, slotIndex) => ({ card, slotIndex }))
    .filter((item): item is { card: FishCard; slotIndex: number } => item.card?.type === "fish");

  if (fishSlots.length > 0) {
    if (activePoison) {
      const avoidUselessOwnFish = activePoison.ownerId === player.id && Math.random() < tuning.ownPoisonFishAvoidChance;
      const avoidGivingPoisonPoints = activePoison.ownerId !== player.id && Math.random() < tuning.opponentPoisonFishAvoidChance;

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
      const choice = usefulFish.length > 1 && Math.random() < tuning.mistakeChance ? usefulFish[1] : usefulFish[0];
      return { type: "play", slotIndex: choice.slotIndex };
    }

    // 得点につながらない魚は温存する。まれな見落としだけを人間らしさとして残す。
    if (Math.random() < tuning.unproductiveFishChance) {
      return { type: "play", slotIndex: rankedFish[0].slotIndex };
    }
  }

  if (candidate && escapeSlot !== null) {
    return { type: "escape", slotIndex: escapeSlot };
  }

  return null;
}

function chooseExpertNpcChildAction(player: Player): NpcChildAction | null {
  const candidate = getPlayerCandidates(player.id).at(-1);
  const candidateTotal = candidate ? sumCapturedIds(candidate.capturedIds, player.id) : 0;
  const escapeSlot = getExpertNpcEscapeSlot(player);
  const poisonSlot = player.faceUp.findIndex((card) => card?.type === "poison");

  if (activePoison) {
    if (candidate && escapeSlot !== null && candidateTotal > 0) {
      return { type: "escape", slotIndex: escapeSlot };
    }

    if (activePoison.ownerId !== player.id && poisonSlot >= 0) {
      return { type: "play", slotIndex: poisonSlot };
    }

    const stackPair = getNpcStackPair(player);
    return stackPair ? { type: "stack", ...stackPair } : null;
  }

  const rankedFish = player.faceUp
    .map((card, slotIndex) => ({ card, slotIndex }))
    .filter((item): item is { card: FishCard; slotIndex: number } => item.card?.type === "fish")
    .map((item) => ({ ...item, gain: estimateFishCaptureValue(item.card.value, player.id) }))
    .sort((left, right) => right.gain - left.gain || left.card.value - right.card.value);
  const bestFish = rankedFish.find((item) => item.gain > 0);
  const parentIsLikelyToClose = (
    npcParentCloseAt !== null && npcParentCloseAt - Date.now() <= 1800
  ) || (
    mouthOpenedAt !== null && Date.now() - mouthOpenedAt >= 3200 && getParentCloseTotal() >= 4
  );
  const candidateIsAtRisk = candidate ? isExpertCandidateAtRisk(player, candidate) : false;

  if (
    candidate &&
    escapeSlot !== null &&
    candidateTotal > 0 &&
    (
      parentIsLikelyToClose ||
      !bestFish ||
      bestFish.gain <= candidateTotal ||
      (candidateIsAtRisk && bestFish.gain < candidateTotal + 3)
    )
  ) {
    return { type: "escape", slotIndex: escapeSlot };
  }

  if (poisonSlot >= 0 && shouldPlayPoisonNow()) {
    return { type: "play", slotIndex: poisonSlot };
  }

  if (bestFish) {
    return { type: "play", slotIndex: bestFish.slotIndex };
  }

  if (candidate && escapeSlot !== null && candidateTotal > 0) {
    return { type: "escape", slotIndex: escapeSlot };
  }

  const stackPair = getNpcStackPair(player);
  return stackPair ? { type: "stack", ...stackPair } : null;
}

function isExpertCandidateAtRisk(player: Player, candidate: FishBoxCard): boolean {
  return getChildren().some((opponent) =>
    opponent.id !== player.id && opponent.faceUp.some(
      (card) => card?.type === "fish" && card.value >= candidate.value && estimateFishCaptureValue(card.value, opponent.id) > 0
    )
  );
}

function getExpertNpcEscapeSlot(player: Player): number | null {
  const singleFish = player.faceUp
    .map((card, slotIndex) => ({ card, slotIndex }))
    .filter((item): item is { card: FishCard; slotIndex: number } => item.card?.type === "fish" && item.card.schoolSize === undefined)
    .sort((left, right) => left.card.value - right.card.value)[0];
  if (singleFish) return singleFish.slotIndex;

  const schoolFish = player.faceUp
    .map((card, slotIndex) => ({ card, slotIndex }))
    .filter((item): item is { card: FishCard; slotIndex: number } => item.card?.type === "fish")
    .sort((left, right) => left.card.value - right.card.value)[0];
  if (schoolFish) return schoolFish.slotIndex;

  const anySlot = player.faceUp.findIndex(Boolean);
  return anySlot >= 0 ? anySlot : null;
}

function getNpcStackPair(player: Player): { sourceSlotIndex: number; targetSlotIndex: number } | null {
  for (const value of [3, 2] as const) {
    const matchingSlots = player.faceUp
      .map((card, slotIndex) => ({ card, slotIndex }))
      .filter((item): item is { card: FishCard; slotIndex: number } =>
        item.card?.type === "fish" &&
        (item.card.schoolBaseValue ?? item.card.value) === value &&
        (item.card.schoolSize === undefined || item.card.schoolSize === 2)
      )
      .sort((left, right) => (right.card.schoolSize ?? 1) - (left.card.schoolSize ?? 1));

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
  const tuning = cpuTuning[cpuDifficulty];
  const closeLookaheadMs = cpuDifficulty === "expert" ? 3200 : cpuDifficulty === "advanced" ? 2800 : 2400;
  const minimumMouthOpenMs = cpuDifficulty === "expert" ? 2600 : cpuDifficulty === "advanced" ? 3600 : 4800;
  const temptingScore = cpuDifficulty === "expert" ? 4 : cpuDifficulty === "advanced" ? 5 : 6;
  const parentIsAboutToClose = npcParentCloseAt !== null && npcParentCloseAt - now <= closeLookaheadMs;
  const mouthHasBeenOpenLongEnough = mouthOpenedAt !== null && now - mouthOpenedAt >= minimumMouthOpenMs;
  const parentHasTemptingScore = getParentCloseTotal() >= temptingScore;

  if (cpuDifficulty === "expert") {
    return parentIsAboutToClose || parentHasTemptingScore;
  }

  if (parentIsAboutToClose) return Math.random() < Math.min(0.97, 0.88 * tuning.poisonAccuracy);
  if (mouthHasBeenOpenLongEnough && parentHasTemptingScore) return Math.random() < Math.min(0.92, 0.68 * tuning.poisonAccuracy);
  return Math.random() < tuning.randomPoisonChance;
}

function getCpuDelay(kind: CpuDelayKind): number {
  const [min, max] = cpuTuning[cpuDifficulty].delays[kind];
  return randomInt(min, max);
}

function getCpuPoisonRemovalChance(): number {
  return cpuTuning[cpuDifficulty].poisonRemovalChance;
}

function getCpuCloseScore(): number {
  return cpuTuning[cpuDifficulty].closeScore;
}

function getNpcEscapeSlot(player: Player): number | null {
  const fishSlot = player.faceUp.findIndex((card) => card?.type === "fish");

  if (fishSlot >= 0) return fishSlot;

  const anySlot = player.faceUp.findIndex(Boolean);
  return anySlot >= 0 ? anySlot : null;
}

function getNpcChildren(): Player[] {
  if (gameMode === "online") return getChildren().filter((player) => !onlineHumanPlayerIds.has(player.id));
  return getChildren().filter((player) => player.id !== localPlayerId);
}

function isHumanParent(): boolean {
  return getParent().id === localPlayerId;
}

function isNpcParent(): boolean {
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

function startMouthFishMotion(motion: MouthFishMotion, playerId: string): void {
  clearMouthFishMotion();

  const duration = mouthFishMotionDurationMs + Math.max(0, motion.preyIds.length - 1) * 70;
  if (prefersReducedMotion() && gameMode !== "online") {
    startOwnActionWait(playerId, duration + ownActionWaitExtensionMs);
    return;
  }

  mouthFishMotion = motion;
  mouthFishMotionStartedAt = window.performance.now();
  mouthFishMotionTimerId = window.setTimeout(() => {
    mouthFishMotion = null;
    mouthFishMotionTimerId = null;
    mouthFishMotionStartedAt = null;
    render();
  }, duration);
  startOwnActionWait(playerId, duration + ownActionWaitExtensionMs);
}

function clearMouthFishMotion(): void {
  if (mouthFishMotionTimerId !== null) {
    window.clearTimeout(mouthFishMotionTimerId);
    mouthFishMotionTimerId = null;
  }

  mouthFishMotion = null;
  mouthFishMotionStartedAt = null;
}

function getMouthFishMotionElapsedMs(): number {
  if (!mouthFishMotion || mouthFishMotionStartedAt === null) return 0;
  // Full-board renders rebuild the actors, so resume their CSS motion instead of replaying it.
  return Math.max(0, Math.round(window.performance.now() - mouthFishMotionStartedAt));
}

function isPlayerWaitingAfterOwnAction(playerId: string): boolean {
  return actionWaitingPlayerIds.has(playerId);
}

function startOwnActionWait(playerId: string, durationMs: number): void {
  const existingTimerId = actionWaitTimerIds.get(playerId);
  if (existingTimerId !== undefined) window.clearTimeout(existingTimerId);

  actionWaitingPlayerIds.add(playerId);
  const timerId = window.setTimeout(() => {
    actionWaitTimerIds.delete(playerId);
    actionWaitingPlayerIds.delete(playerId);
    render();
  }, durationMs);
  actionWaitTimerIds.set(playerId, timerId);
}

function clearOwnActionWaits(): void {
  actionWaitTimerIds.forEach((timerId) => window.clearTimeout(timerId));
  actionWaitTimerIds.clear();
  actionWaitingPlayerIds.clear();
}

function applyOwnActionWaitingPlayers(playerIds: string[]): void {
  const synchronizedPlayerIds = new Set(playerIds);

  actionWaitTimerIds.forEach((timerId, playerId) => {
    if (synchronizedPlayerIds.has(playerId)) {
      window.clearTimeout(timerId);
      actionWaitTimerIds.delete(playerId);
    } else {
      // Keep a guest's just-sent action locked until the host acknowledges it
      // or the short optimistic wait expires.
      synchronizedPlayerIds.add(playerId);
    }
  });

  actionWaitingPlayerIds = synchronizedPlayerIds;
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
    cpuDifficulty,
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
    actionWaitingPlayerIds: [...actionWaitingPlayerIds],
    cardPlayWaitingPlayerIds: [...actionWaitingPlayerIds],
    isGameOver,
    logEntries,
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
  const previousMouthFishMotionId = mouthFishMotion?.enteringId ?? null;
  const previousMouthFishMotionStartedAt = mouthFishMotionStartedAt;
  playerCount = state.playerCount;
  if (isCpuDifficulty(state.cpuDifficulty)) cpuDifficulty = state.cpuDifficulty;
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
  if (mouthFishMotion) {
    mouthFishMotionStartedAt = previousMouthFishMotionId === mouthFishMotion.enteringId
      && previousMouthFishMotionStartedAt !== null
      ? previousMouthFishMotionStartedAt
      : window.performance.now();
  }
  applyOwnActionWaitingPlayers(state.actionWaitingPlayerIds ?? state.cardPlayWaitingPlayerIds ?? []);
  isGameOver = state.isGameOver;
  logEntries = state.logEntries;
  tryEndReason = state.tryEndReason;
  tryStartScores = state.tryStartScores;
  hasStarted = true;
  onlineLobbyOpen = false;
  render();
}

function render(): void {
  cancelStackDrag();
  const focusedControl = getFocusedControlIdentity();

  if (tutorialStep !== null) {
    appRoot.innerHTML = renderTutorialScreen();
    const tutorialFocusTarget = appRoot.querySelector<HTMLElement>(".story-tutorial-result-stage .try-result-panel")
      ?? appRoot.querySelector<HTMLElement>(".story-tutorial-action-target:not(:disabled)")
      ?? appRoot.querySelector<HTMLElement>(".story-tutorial-shell");
    tutorialFocusTarget?.focus({ preventScroll: true });
    scheduleTutorialAutoAdvance();
    scheduleTutorialActionUnlock();
    return;
  }

  if (modeSetupOpen) {
    appRoot.innerHTML = renderPlayerCountScreen();
    restoreFocusedControl(appRoot, focusedControl);
    return;
  }

  if (onlineLobbyOpen) {
    appRoot.innerHTML = renderOnlineLobby();
    restoreFocusedControl(appRoot, focusedControl);
    return;
  }

  if (!hasStarted) {
    appRoot.innerHTML = renderStartScreen();
    return;
  }

  const rulesWereOpen = appRoot.querySelector<HTMLDetailsElement>(".rules-panel")?.open ?? false;
  const resultWasVisible = appRoot.querySelector(".try-result-panel") !== null;
  const replayWasVisible = appRoot.querySelector(".try-replay-panel") !== null;
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
              <span class="mouth-state ${isMouthOpen ? "is-open" : "is-closed"}">
                ${isMouthOpen ? "OPEN" : "CLOSED"}
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
            ${renderStat("泳ぐ魚", `${getLiveMouthFishCount()}匹`)}
          </div>
        </header>

        ${
          gameMode === "online"
            ? `
              <section class="setup-bar compact-setup online-game-settings" aria-label="オンラインゲーム設定">
                <p><strong>オンライン対戦中</strong><span>部屋の設定はゲーム開始時に固定されています</span></p>
                <button class="text-button" type="button" data-action="back-to-title">タイトルへ戻る</button>
              </section>
            `
            : `
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
            `
        }

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
    cpu: "CPUと対戦",
    online: "友達とオンライン対戦"
  };
  return `
    <main class="start-screen">
      <section class="start-card count-screen" aria-labelledby="count-title">
        <p class="start-eyebrow">${modeLabels[pendingGameMode]}</p>
        <h1 id="count-title">人数を選択</h1>
        <p class="start-lead">3〜6人から、今回のゲームに参加する人数を選んでください。</p>
        ${renderPlayerCountOptions()}
        ${renderCpuDifficultyOptions()}
        <button class="primary-button count-confirm" type="button" data-action="confirm-player-count">${draftPlayerCount}人で進む</button>
        <button class="text-button back-title" type="button" data-action="back-to-title">モード選択へ戻る</button>
      </section>
    </main>
  `;
}

function renderPlayerCountOptions(minimumPlayerCount = 3): string {
  return `
    <div class="count-options" role="group" aria-label="合計プレイ人数">
      ${[3, 4, 5, 6].map((count) => {
        const isDisabled = count < minimumPlayerCount;
        return `<button class="count-option${draftPlayerCount === count ? " selected" : ""}" type="button" data-player-count="${count}" aria-pressed="${draftPlayerCount === count}" ${isDisabled ? "disabled title=\"現在の参加者を収容できない人数です\"" : ""}><strong>${count}</strong><span>人</span></button>`;
      }).join("")}
    </div>
  `;
}

function renderCpuDifficultyOptions(title = "CPUの強さ"): string {
  const options: Array<{ id: CpuDifficulty; label: string; detail: string }> = [
    { id: "easy", label: "弱い", detail: "ゆっくり・ミス多め" },
    { id: "normal", label: "ふつう", detail: "標準的な判断" },
    { id: "hard", label: "強い", detail: "素早く正確" },
    { id: "advanced", label: "達人", detail: "先読み・わずかに隙あり" },
    { id: "expert", label: "最強", detail: "先読み・ミスなし" }
  ];
  return `
    <section class="difficulty-section" aria-labelledby="difficulty-title">
      <h2 id="difficulty-title">${title}</h2>
      <div class="difficulty-options" role="group" aria-label="CPUの強さ">
        ${options.map((option) => `<button class="difficulty-option${cpuDifficulty === option.id ? " selected" : ""}" type="button" data-cpu-difficulty="${option.id}" aria-pressed="${cpuDifficulty === option.id}"><strong>${option.label}</strong><small>${option.detail}</small></button>`).join("")}
      </div>
    </section>
  `;
}

function renderStartScreen(): string {
  return `
    <main class="start-screen mode-screen">
      ${renderOceanBackdrop()}
      <section class="start-card mode-select-card" aria-labelledby="game-title">
        <div class="ocean-whale mode-whale" aria-hidden="true"><span></span></div>
        <p class="start-eyebrow">CHOOSE YOUR CURRENT</p>
        <h1 id="game-title">口に入る</h1>
        <p class="mode-heading">どの海へ飛び込みますか？</p>
        <p class="start-lead">魚を食べるか、毒を仕掛けるか。相手の動きを読んで最高得点を目指そう。</p>
        <div class="mode-grid" aria-label="対戦モードを選択">
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
        <button class="tutorial-entry" type="button" data-action="open-tutorial">
          <span class="tutorial-entry-icon" aria-hidden="true">?</span>
          <span>
            <strong>遊び方を見る</strong>
            <small>魚をタップしながら、子と親の役割を物語で体験します</small>
          </span>
        </button>
      </section>
    </main>
  `;
}

function openTutorial(): void {
  tutorialReturnToRules = appRoot.querySelector<HTMLDetailsElement>(".rules-panel")?.open ?? false;
  clearNpcTimers();
  clearTutorialAutoAdvance();
  resetTutorialActionUnlock();
  tutorialStep = 0;
  render();
}

function closeTutorial(): void {
  const shouldRestoreRules = tutorialReturnToRules;
  clearTutorialAutoAdvance();
  resetTutorialActionUnlock();
  tutorialReturnToRules = false;
  tutorialStep = null;
  render();

  const rulesPanel = appRoot.querySelector<HTMLDetailsElement>(".rules-panel");
  if (shouldRestoreRules && rulesPanel) rulesPanel.open = true;

  const tutorialButton = shouldRestoreRules
    ? rulesPanel?.querySelector<HTMLButtonElement>('button[data-action="open-tutorial"]')
    : appRoot.querySelector<HTMLButtonElement>('button[data-action="open-tutorial"]');
  tutorialButton?.focus({ preventScroll: true });
}

function showPreviousTutorialStep(): void {
  if (tutorialStep === null) return;
  setTutorialStep(Math.max(0, tutorialStep - 1));
}

function showNextTutorialStep(): void {
  if (tutorialStep === null) return;
  const step = tutorialSteps[tutorialStep];

  if (step.action) return;

  if (tutorialStep >= tutorialSteps.length - 1) {
    closeTutorial();
    return;
  }

  setTutorialStep(tutorialStep + 1);
}

function playTutorialFish2(): void {
  if (tutorialStep === null || tutorialSteps[tutorialStep].action !== "play-fish-2") return;
  setTutorialStep(tutorialStep + 1);
}

function playTutorialFish4(): void {
  if (tutorialStep === null || tutorialSteps[tutorialStep].action !== "play-fish-4") return;
  setTutorialStep(tutorialStep + 1);
}

function escapeTutorialFish(): void {
  if (tutorialStep === null || tutorialSteps[tutorialStep].action !== "escape") return;
  setTutorialStep(tutorialStep + 1);
}

function continueTutorialResult(): void {
  if (tutorialStep === null || tutorialSteps[tutorialStep].action !== "continue-result") return;
  setTutorialStep(tutorialStep + 1);
}

function continueTutorialParent(): void {
  if (tutorialStep === null || tutorialSteps[tutorialStep].action !== "continue-parent") return;
  setTutorialStep(tutorialStep + 1);
}

function openTutorialMouth(): void {
  if (tutorialStep === null || tutorialSteps[tutorialStep].action !== "open-mouth") return;
  setTutorialStep(tutorialStep + 1);
}

function closeTutorialMouth(): void {
  if (tutorialStep === null || tutorialSteps[tutorialStep].action !== "close-mouth") return;
  setTutorialStep(tutorialStep + 1);
}

function removeTutorialPoison(): void {
  if (tutorialStep === null || tutorialSteps[tutorialStep].action !== "remove-poison") return;
  setTutorialStep(tutorialStep + 1);
}

function setTutorialStep(nextStep: number): void {
  clearTutorialAutoAdvance();
  resetTutorialActionUnlock();
  tutorialStep = Math.max(0, Math.min(tutorialSteps.length - 1, nextStep));
  render();
}

function scheduleTutorialAutoAdvance(): void {
  clearTutorialAutoAdvance();
  if (tutorialStep === null) return;

  const scheduledStep = tutorialStep;
  const delay = tutorialSteps[scheduledStep].autoAdvanceMs;
  if (delay === undefined) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  tutorialAutoTimerId = window.setTimeout(() => {
    tutorialAutoTimerId = null;
    if (tutorialStep !== scheduledStep) return;
    setTutorialStep(scheduledStep + 1);
  }, delay);
}

function clearTutorialAutoAdvance(): void {
  if (tutorialAutoTimerId === null) return;
  window.clearTimeout(tutorialAutoTimerId);
  tutorialAutoTimerId = null;
}

function scheduleTutorialActionUnlock(): void {
  clearTutorialActionUnlockTimer();
  if (tutorialStep === null) return;

  const scheduledStep = tutorialStep;
  const step = tutorialSteps[scheduledStep];
  if (step.actionDelayMs === undefined) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (tutorialActionUnlockStep !== scheduledStep || tutorialActionUnlockAt === null) {
    tutorialActionUnlockStep = scheduledStep;
    tutorialActionUnlockAt = Date.now() + (reduceMotion ? 0 : step.actionDelayMs);
  }

  const unlock = (): void => {
    tutorialActionUnlockTimerId = null;
    if (tutorialStep !== scheduledStep) return;
    const shellHadFocus = document.activeElement?.classList.contains("story-tutorial-shell") ?? false;
    const actionTarget = appRoot.querySelector<HTMLButtonElement>("button[data-tutorial-delayed-action]");
    if (!actionTarget) return;
    actionTarget.disabled = false;
    actionTarget.removeAttribute("data-tutorial-delayed-action");
    const actionHint = appRoot.querySelector<HTMLElement>(".story-action-hint");
    if (actionHint) actionHint.textContent = "光っているところをタップ";
    if (shellHadFocus) actionTarget.focus({ preventScroll: true });
  };
  const remaining = Math.max(0, tutorialActionUnlockAt - Date.now());

  if (remaining === 0) {
    unlock();
    return;
  }

  tutorialActionUnlockTimerId = window.setTimeout(unlock, remaining);
}

function clearTutorialActionUnlockTimer(): void {
  if (tutorialActionUnlockTimerId === null) return;
  window.clearTimeout(tutorialActionUnlockTimerId);
  tutorialActionUnlockTimerId = null;
}

function resetTutorialActionUnlock(): void {
  clearTutorialActionUnlockTimer();
  tutorialActionUnlockStep = null;
  tutorialActionUnlockAt = null;
}

function renderTutorialScreen(): string {
  const stepIndex = tutorialStep ?? 0;
  const step = tutorialSteps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === tutorialSteps.length - 1;
  const waitsForAction = step.action !== undefined;
  const advancesAutomatically = step.autoAdvanceMs !== undefined;
  const waitsForDelayedAction = step.actionDelayMs !== undefined;
  const isResultStep = step.visual === "escape-result";

  return `
    <main class="story-tutorial-screen">
      <section
        class="story-tutorial-shell scene-${step.visual}"
        role="dialog"
        aria-modal="true"
        aria-label="遊び方チュートリアル"
        aria-describedby="tutorial-dialogue tutorial-helper"
        tabindex="-1"
      >
        <header class="story-tutorial-header">
          <div class="story-tutorial-brand">
            <span class="story-compass" aria-hidden="true">✦</span>
            <div>
              <p>THE WHALE'S COVE</p>
              <strong>${step.chapter}</strong>
            </div>
          </div>
          <p class="story-progress-label">SCENE ${stepIndex + 1} / ${tutorialSteps.length}</p>
          <button class="story-tutorial-close" type="button" data-action="close-tutorial" aria-label="チュートリアルを閉じる">×</button>
        </header>

        <div class="story-tutorial-progress" aria-hidden="true">
          ${tutorialSteps.map((_, index) => `<span class="${index <= stepIndex ? "is-complete" : ""}${index === stepIndex ? " is-current" : ""}"></span>`).join("")}
        </div>

        <div class="story-tutorial-body${isResultStep ? " is-result-step" : ""}">
          <section class="story-tutorial-world" aria-label="${step.title}の物語場面">
            ${renderTutorialVisual(step.visual, waitsForDelayedAction)}
          </section>
          <aside class="story-tutorial-popup" id="tutorial-dialogue" aria-live="polite">
            <p>${renderTutorialDialogue(step.dialogue)}</p>
          </aside>
        </div>

        <footer class="story-tutorial-actions">
          <p class="story-tutorial-note" id="tutorial-helper">${escapeHtml(step.helper)}</p>
          <button class="secondary-button" type="button" data-action="tutorial-previous" ${isFirst ? "disabled" : ""}>前へ</button>
          <span class="story-action-hint">
            ${waitsForDelayedAction ? "アニメーションのあとに操作できます" : waitsForAction ? "光っているところをタップ" : advancesAutomatically ? "物語が進んでいます…" : "← → キーでも移動できます"}
          </span>
          ${waitsForAction
            ? '<span class="story-action-spacer" aria-hidden="true"></span>'
            : `<button class="primary-button" type="button" data-action="tutorial-next">${isLast ? "完了" : step.nextLabel ?? "次へ"}</button>`}
        </footer>
      </section>
    </main>
  `;
}

function renderTutorialDialogue(dialogue: string): string {
  return escapeHtml(dialogue).replace(/\n/g, "<br>");
}

function renderTutorialVisual(visual: TutorialVisual, actionDelayed = false): string {
  if (visual === "first-meal") {
    return renderStoryWhaleScene(
      "open",
      "is-first-meal",
      renderStoryBait("is-center"),
      renderStoryHandCard(2, "tutorial-play-fish-2", "魚2を出して餌1を食べる"),
      "口を開けたくじらの中に、餌1があります。"
    );
  }

  if (visual === "first-feast") {
    return renderStoryWhaleScene(
      "open",
      "is-feast",
      renderStoryFishToken(2, "is-center is-feasting", "餌1を食べた"),
      '<span class="story-sparkle sparkle-one" aria-hidden="true">✦</span><span class="story-sparkle sparkle-two" aria-hidden="true">✦</span>',
      "魚2が餌1を食べました。"
    );
  }

  if (visual === "enemy-ambush") {
    return renderStoryWhaleScene(
      "open",
      "is-ambush",
      `${renderStoryFishToken(2, "is-left is-swallowed", "食べられた")}${renderStoryFishToken(3, "is-center is-attacking", "魚2＋餌1")}`,
      '<span class="story-chomp" aria-hidden="true">パクッ！</span>',
      "敵の魚3が、魚2を獲物ごと食べました。"
    );
  }

  if (visual === "first-counterattack") {
    return renderStoryWhaleScene(
      "open",
      "is-counterattack",
      renderStoryFishToken(3, "is-center is-enemy", "魚2＋餌1"),
      renderStoryHandCard(4, "tutorial-play-fish-4", "魚4を出して魚3を食べる"),
      "敵の魚3が口の中を泳いでいます。"
    );
  }

  if (visual === "first-victory") {
    return renderStoryWhaleScene(
      "open",
      "is-victory",
      `${renderStoryFishToken(3, "is-left is-swallowed", "食べられた")}${renderStoryFishToken(4, "is-center is-feasting", "魚3＋魚2＋餌1")}`,
      '<span class="story-chomp is-coral" aria-hidden="true">パクッ！</span>',
      "魚4が魚3を食べ、獲物も引き継ぎました。"
    );
  }

  if (visual === "mouth-closed") {
    return renderStoryWhaleScene(
      "fed",
      "is-mouth-closed",
      "",
      '<div class="story-sound-wave" aria-hidden="true"><span></span><strong>パクン！</strong><span></span></div>',
      "親のくじらが口を閉じ、トライが終わりました。"
    );
  }

  if (visual === "escape-retry") {
    return renderStoryWhaleScene(
      "open",
      "is-escape-retry",
      renderStoryFishToken(3, "is-center is-enemy", "魚2＋餌1"),
      renderStoryHandCard(4, "tutorial-play-fish-4", "もう一度、魚4を出して魚3を食べる"),
      "もう一度、敵の魚3が魚2と餌1を持って泳いでいます。"
    );
  }

  if (visual === "escape-ready") {
    return renderStoryWhaleScene(
      "open",
      "is-escape-ready",
      `${renderStoryFishToken(3, "is-left is-swallowed", "食べられた")}${renderStoryFishToken(4, "is-center is-feasting", "魚3＋魚2＋餌1")}`,
      renderStoryEscapeControl(4),
      "魚4が獲物を捕まえ、手札の魚2を裏向きで使って逃げられる状態です。"
    );
  }

  if (visual === "escape-success") {
    return renderStoryWhaleScene(
      "open",
      "is-escape-success",
      "",
      `${renderStoryFishToken(4, "is-escaping", "4点確定")}<div class="story-escape-success"><span>ヒューん！</span><strong>+4点</strong><small>逃げる成功</small></div>`,
      "魚4が口の外へ逃げ、4点を確定しました。"
    );
  }

  if (visual === "escape-result") return renderTutorialTryResult();

  if (visual === "parent-view") {
    return renderStoryWhaleScene(
      "closed",
      "is-parent-view",
      "",
      `
        <span class="story-parent-badge">あなたは親</span>
        <button class="story-open-mouth-button story-tutorial-action-target" type="button" data-action="tutorial-open-mouth">
          <span>最初の行動</span>
          <strong>口を開く</strong>
        </button>
      `,
      "親が交代し、あなたが閉じた口の大きな魚を操作します。"
    );
  }

  if (visual === "close-moment") {
    return renderStoryWhaleScene(
      "open",
      "is-close-moment",
      `
        ${renderStoryBait("is-center is-parent-prey")}
        ${renderStoryFishToken(2, "is-upper-left is-parent-arriving is-parent-prey arrival-1", "餌1を食べる")}
        ${renderStoryFishToken(3, "is-upper-right is-parent-arriving is-parent-prey arrival-2", "魚2と餌1を食べる")}
        ${renderStoryFishToken(4, "is-lower-left is-parent-arriving arrival-3", "魚3＋魚2＋餌1")}
        <span class="story-parent-chomp chomp-1" aria-hidden="true">パクッ！</span>
        <span class="story-parent-chomp chomp-2" aria-hidden="true">パクッ！</span>
        <span class="story-parent-chomp chomp-3" aria-hidden="true">パクッ！</span>
      `,
      `
        <button class="story-close-mouth-button story-tutorial-action-target" type="button" data-action="tutorial-close-mouth"${actionDelayed ? ' disabled data-tutorial-delayed-action="true"' : ""}>
          <span>そろそろ！</span>
          <strong>口を閉じる</strong>
        </button>
      `,
      "魚2が餌1を食べ、魚3が魚2を、魚4が魚3を獲物ごと食べたため、最後は魚4だけが残りました。"
    );
  }

  if (visual === "poison-warning") return renderStoryPoisonBiteFailure(actionDelayed);

  if (visual === "poison-practice") {
    return renderStoryWhaleScene(
      "open",
      "is-poison-practice",
      `${renderStoryFishToken(4, "is-lower-left", "魚3＋魚2＋餌1")}${renderStoryPoisonToken("is-in-mouth is-training-poison")}`,
      `
        <button class="story-remove-poison-button story-tutorial-action-target" type="button" data-action="tutorial-remove-poison">
          <span aria-hidden="true">!</span>
          <strong>毒魚を取り除く</strong>
        </button>
      `,
      "口を閉じる直前まで戻り、魚3、魚2、餌1を獲物として持つ魚4の横から毒魚を取り除く練習です。"
    );
  }

  if (visual === "poison-cleared") {
    return renderStoryWhaleScene(
      "open",
      "is-poison-cleared",
      renderStoryFishToken(4, "is-lower-left", "魚3＋魚2＋餌1"),
      `${renderStoryPoisonToken("is-spit-out")}<div class="story-poison-cleared"><span aria-hidden="true">✓</span><strong>毒魚を吐き出しました</strong></div>`,
      "毒魚を口の外へ吐き出し、口の中には魚3、魚2、餌1を獲物として持つ魚4だけが残りました。"
    );
  }

  if (visual === "rule-cards") return renderTutorialRuleCards();

  return renderStoryWhaleScene(
    "open",
    "is-finale",
    `${renderStoryFishToken(2, "is-upper-left")}${renderStoryFishToken(3, "is-upper-right")}${renderStoryFishToken(4, "is-lower-left")}`,
    '<div class="story-final-emblem"><span aria-hidden="true">★</span><strong>最高得点をめざそう！</strong></div>',
    "親と子の両方で得点し、入り江の勝者を目指します。"
  );
}

function renderStoryPoisonBiteFailure(actionDelayed: boolean): string {
  return `
    <div class="story-ocean-scene is-poison-bite-cinematic">
      <div class="story-light-rays" aria-hidden="true"></div>
      <span class="story-bubble bubble-a" aria-hidden="true"></span>
      <span class="story-bubble bubble-b" aria-hidden="true"></span>
      <span class="story-bubble bubble-c" aria-hidden="true"></span>
      <div class="story-whale is-open story-poison-bite-open">
        <img src="${whaleArtPaths.open}" alt="" aria-hidden="true">
        <div class="story-mouth-layer">
          ${renderStoryFishToken(4, "is-lower-left", "魚3＋魚2＋餌1")}
        </div>
      </div>
      <div class="story-whale is-poisoned story-poison-bite-closed">
        <img src="${whaleArtPaths.poisoned}" alt="" aria-hidden="true">
      </div>
      ${renderStoryPoisonToken("is-diving-in")}
      <div class="story-poison-bite-caption" aria-hidden="true">
        <strong>パクン！</strong>
        <span>毒魚まで食べてしまった！</span>
      </div>
      <button class="story-cinematic-continue-button story-tutorial-action-target" type="button" data-action="tutorial-continue-parent"${actionDelayed ? ' disabled data-tutorial-delayed-action="true"' : ""}>取り除く練習へ</button>
      <p class="visually-hidden">口を閉じる瞬間に毒魚が飛び込み、大きな魚が毒魚まで食べて苦しんでいます。</p>
    </div>
  `;
}

function renderStoryWhaleScene(
  state: "closed" | "open" | "fed" | "poisoned",
  sceneClass: string,
  mouthContent: string,
  foregroundContent: string,
  description: string
): string {
  const whaleArtPath = state === "open"
    ? whaleArtPaths.open
    : state === "poisoned"
      ? whaleArtPaths.poisoned
      : state === "closed"
        ? whaleArtPaths.closed
        : whaleArtPaths.fed;

  return `
    <div class="story-ocean-scene ${sceneClass}">
      <div class="story-light-rays" aria-hidden="true"></div>
      <span class="story-bubble bubble-a" aria-hidden="true"></span>
      <span class="story-bubble bubble-b" aria-hidden="true"></span>
      <span class="story-bubble bubble-c" aria-hidden="true"></span>
      <div class="story-whale is-${state}">
        <img src="${whaleArtPath}" alt="" aria-hidden="true">
        ${state === "open" ? `<div class="story-mouth-layer">${mouthContent}</div>` : ""}
      </div>
      ${foregroundContent}
      <p class="visually-hidden">${description}</p>
    </div>
  `;
}

function renderStoryFishToken(value: FishValue, className = "", annotation = ""): string {
  return `
    <span class="story-fish-token value-${value} ${className}" aria-label="魚${value}${annotation ? `、${annotation}` : ""}">
      <img src="${fishArtPaths[value]}" alt="">
      <b>${value}</b>
      ${annotation ? `<small>${annotation}</small>` : ""}
    </span>
  `;
}

function renderStoryBait(className = ""): string {
  return `<span class="story-bait-token ${className}" aria-label="餌1"><i></i><b>1</b></span>`;
}

function renderStoryHandCard(
  value: 2 | 4,
  action: "tutorial-play-fish-2" | "tutorial-play-fish-4",
  label: string
): string {
  return `
    <div class="story-hand-dock">
      <span class="story-hand-label">あなたの山札</span>
      <button class="story-hand-card value-${value} story-tutorial-action-target" type="button" data-action="${action}" aria-label="${label}">
        <img src="${fishArtPaths[value]}" alt="">
        <b>${value}</b>
        <small>タップ！</small>
      </button>
    </div>
  `;
}

function renderStoryEscapeControl(points: number): string {
  return `
    <div class="story-hand-dock is-escape-dock">
      <span class="story-hand-label">あなたの手札</span>
      <span class="story-hand-card value-2 is-escape-source" aria-hidden="true">
        <img src="${fishArtPaths[2]}" alt="">
        <b>2</b>
        <small>手札のカード</small>
      </span>
      <button
        class="escape-chip story-tutorial-escape-chip story-tutorial-action-target"
        type="button"
        data-action="tutorial-escape"
        aria-label="手札の魚2を裏向きで使い、魚4で${points}点を確定して逃げる"
      >
        裏で逃げる ${points}点
      </button>
    </div>
  `;
}

function renderTutorialTryResult(): string {
  const resultPlayers: Player[] = [
    { id: "player-1", name: "親CPU", role: "parent", score: 0, drawPile: [], faceUp: [], used: [] },
    { id: "player-2", name: "あなた", role: "child", score: 4, drawPile: [], faceUp: [], used: [] },
    { id: "player-3", name: "ライバルCPU", role: "child", score: 0, drawPile: [], faceUp: [], used: [] }
  ];
  const resultCards: BoxCard[] = [
    {
      boxId: 1,
      type: "bait",
      value: 1,
      ownerId: "player-1",
      ownerName: "親CPU",
      sequence: 1,
      consumedById: 4
    },
    {
      boxId: 2,
      sourceCardId: 101,
      type: "fish",
      value: 2,
      ownerId: "player-2",
      ownerName: "あなた",
      sequence: 2,
      consumedById: 4,
      capturedIds: [],
      poisonScoredById: null,
      poisonScoredByName: null,
      invalidatedByOwnPoison: false,
      escaped: false
    },
    {
      boxId: 3,
      sourceCardId: 102,
      type: "fish",
      value: 3,
      ownerId: "player-3",
      ownerName: "ライバルCPU",
      sequence: 3,
      consumedById: 4,
      capturedIds: [],
      poisonScoredById: null,
      poisonScoredByName: null,
      invalidatedByOwnPoison: false,
      escaped: false
    },
    {
      boxId: 4,
      sourceCardId: 103,
      type: "fish",
      value: 4,
      ownerId: "player-2",
      ownerName: "あなた",
      sequence: 4,
      consumedById: null,
      capturedIds: [1, 2, 3],
      poisonScoredById: null,
      poisonScoredByName: null,
      invalidatedByOwnPoison: false,
      escaped: true
    },
    {
      boxId: 5,
      sourceCardId: 104,
      type: "escape",
      ownerId: "player-2",
      ownerName: "あなた",
      sequence: 5,
      successful: true
    }
  ];

  return `
    <div class="story-tutorial-result-stage">
      ${renderTryResultOverlay({
        players: resultPlayers,
        cards: resultCards,
        startScores: { "player-1": 0, "player-2": 0, "player-3": 0 },
        endReason: "escape",
        embedded: true,
        actionsHtml: `
          <button class="secondary-button story-tutorial-action-target" type="button" data-action="tutorial-continue-result">次のトライ</button>
        `
      })}
    </div>
  `;
}

function renderStoryPoisonToken(className = ""): string {
  return `
    <span class="story-poison-token ${className}" aria-label="毒魚">
      <img src="${poisonFishArtPath}" alt="">
      <b>毒</b>
    </span>
  `;
}

function renderTutorialRuleCards(): string {
  return `
    <div class="story-rulebook" aria-label="特別ルールのまとめ">
      <article class="story-rule-card is-escape">
        <div class="story-rule-visual">
          ${renderStoryFishToken(4)}
          <span class="story-escape-token" aria-hidden="true">逃</span>
        </div>
        <div><span>逃げる</span><strong>成功したら得点確定</strong><p>食べた他人の数字だけを合計。自分のカードと逃げる魚自身は含めません。</p></div>
      </article>
      <article class="story-rule-card is-poison">
        <div class="story-rule-visual">${renderStoryPoisonToken()}<span class="story-remove-token" aria-hidden="true">×</span></div>
        <div><span>毒魚</span><strong>親は取り除きましょう</strong><p>次の別の子の魚を得点に。残して閉じると毒魚の持ち主が10点、親は0点です。</p></div>
      </article>
      <article class="story-rule-card is-school">
        <div class="story-rule-visual">${renderStoryFishToken(2)}${renderStoryFishToken(2)}<span class="story-equals" aria-hidden="true">＝4</span></div>
        <div><span>魚群</span><strong>同じ2・3を重ねる</strong><p>2匹・3匹の群れは、合計した強さの1匹として扱います。</p></div>
      </article>
      <article class="story-rule-card is-score">
        <div class="story-rule-visual"><span class="story-score-crown" aria-hidden="true">♛</span><strong>3 TRY</strong></div>
        <div><span>ゲームの流れ</span><strong>親1人につき3トライ</strong><p>全員が親を1回終えたら、合計得点で勝者を決めます。</p></div>
      </article>
    </div>
  `;
}

function renderOnlineLobby(): string {
  const isHost = onlineRole === "host";
  const isGuest = onlineRole === "guest";
  const humanCount = onlineLobbyMembers.length;
  const canStart = isHost && humanCount >= 2;
  const isWaitingRoom = isHost || isGuest;
  const pageTitle = isGuest && onlineJoinRejected ? "参加できませんでした" : isWaitingRoom ? "参加を待っています" : "友達と対戦";
  return `
    <main class="start-screen">
      <section class="start-card online-lobby${isWaitingRoom ? " is-waiting-room" : ""}" aria-labelledby="online-title">
        <p class="start-eyebrow">${isWaitingRoom ? "WAITING ROOM" : "ONLINE ROOM"}</p>
        <h1 id="online-title">${pageTitle}</h1>
        ${
          isHost
            ? `
              <p class="waiting-room-copy">友達に参加コードを送り、この画面で参加を待ちます。</p>
              <p class="room-label">参加コード</p>
              <div class="room-code" aria-label="参加コード ${roomCode}">${roomCode || "------"}</div>
              ${renderOnlineWaitingCount()}
              <p class="online-status" role="status" aria-live="polite">${onlineStatus}</p>
              <button class="primary-button lobby-action" type="button" data-action="start-online-game" ${canStart ? "" : "disabled"}>${canStart ? "ゲームを開始" : "友達の参加を待っています"}</button>
              ${canStart ? "" : `<p class="lobby-hint">友達が1人以上参加すると開始できます。</p>`}
            `
            : isGuest
              ? onlineJoinRejected
                ? `
                  <div class="online-error-mark" aria-hidden="true">!</div>
                  <p class="start-lead">このコードでは参加できませんでした。</p>
                  <p class="online-status" role="status" aria-live="polite">${onlineStatus}</p>
                  <button class="secondary-button lobby-action" type="button" data-action="retry-online-join">参加コードを入力し直す</button>
                `
                : `
                  <div class="waiting-spinner" aria-hidden="true"></div>
                  ${renderOnlineWaitingCount()}
                  <p class="online-status" role="status" aria-live="polite">${onlineStatus}</p>
                `
              : renderOnlineEntry()
        }
        <button class="text-button back-title" type="button" data-action="back-to-title">タイトルへ戻る</button>
      </section>
    </main>
  `;
}

function renderOnlineEntry(): string {
  if (onlineLobbyView === "choice") {
    return `
      <p class="start-lead">オンライン対戦の始め方を選んでください。</p>
      <div class="online-entry-options" aria-label="部屋を作るか参加するかを選択">
        <button class="online-entry-card is-create" type="button" data-action="choose-create-room">
          <span class="online-entry-icon" aria-hidden="true">作</span>
          <strong>部屋を作る</strong>
          <small>人数と、空き枠に入るCPUの強さを決める</small>
        </button>
        <button class="online-entry-card is-join" type="button" data-action="choose-join-room">
          <span class="online-entry-icon" aria-hidden="true">入</span>
          <strong>部屋に参加する</strong>
          <small>友達から届いた6文字のコードで参加する</small>
        </button>
      </div>
      <p class="online-status" role="status" aria-live="polite">${onlineStatus}</p>
    `;
  }

  if (onlineLobbyView === "join") {
    return `
      <section class="online-setup-panel" aria-labelledby="join-room-title">
        <h2 id="join-room-title">部屋に参加する</h2>
        <p class="online-setup-copy">表示名と、友達から届いた参加コードを入力してください。</p>
        <div class="online-form">
          <label for="join-player-name-input">あなたの表示名</label>
          <input id="join-player-name-input" name="playerName" value="${escapeHtml(draftPlayerName)}" maxlength="12" autocomplete="nickname" placeholder="あなたの名前">
          <label for="room-code-input">6文字の参加コード</label>
          <input class="room-code-input" id="room-code-input" name="roomCode" value="${draftRoomCode}" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC234">
          <button class="primary-button lobby-action" type="button" data-action="join-room">この部屋に参加する</button>
        </div>
        <p class="online-status" role="status" aria-live="polite">${onlineStatus}</p>
        <button class="text-button" type="button" data-action="back-online-choice">選択に戻る</button>
      </section>
    `;
  }

  return `
    <section class="online-setup-panel" aria-labelledby="create-room-title">
      <h2 id="create-room-title">部屋を作る</h2>
      <p class="online-setup-copy">あなたがホストです。全体の人数と、友達が入らなかった席のCPUレベルを設定します。</p>
      <div class="online-form online-host-name">
        <label for="host-player-name-input">あなたの表示名</label>
        <input id="host-player-name-input" name="playerName" value="${escapeHtml(draftPlayerName)}" maxlength="12" autocomplete="nickname" placeholder="あなたの名前">
      </div>
      <fieldset class="online-setting-group">
        <legend>合計プレイ人数</legend>
        <p>ホスト・参加する友達・CPUを合わせた人数です。</p>
        ${renderPlayerCountOptions()}
      </fieldset>
      ${renderCpuDifficultyOptions("残りのCPUの強さ")}
      <p class="online-cpu-note">友達が1人以上参加すると開始できます。合計${draftPlayerCount}人になるように、残りの空き席へCPUが入ります。</p>
      <button class="primary-button lobby-action" type="button" data-action="create-room">この設定で部屋を作る</button>
      <p class="online-status" role="status" aria-live="polite">${onlineStatus}</p>
      <button class="text-button" type="button" data-action="back-online-choice">選択に戻る</button>
    </section>
  `;
}

function renderOnlineWaitingCount(): string {
  const participantCount = onlineLobbyMembers.length;
  const countLabel = participantCount > 0 ? `${participantCount}人が参加中` : "参加人数を確認中";
  const note = participantCount === 0
    ? "部屋に接続しています"
    : participantCount === 1
      ? "ホストを含む現在の人数です"
      : "ホストを含む現在の参加人数です";
  return `
    <section class="online-waiting-count" role="status" aria-live="polite" aria-atomic="true" aria-label="${countLabel}">
      <span>現在の参加人数</span>
      ${participantCount > 0 ? `<strong><b>${participantCount}</b>人</strong>` : '<strong class="is-connecting">確認中</strong>'}
      <small>${note}</small>
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
      <button class="tutorial-inline-button" type="button" data-action="open-tutorial">物語チュートリアルを見る</button>
      <div>
        <p class="section-label">進行と捕食</p>
        <ul>
          <li>親1人につき必ず3トライ行い、その後に親を交代します。</li>
          <li>山札と公開札はトライ間で引き継ぎ、親交代時に補給します。</li>
          <li>魚を出すと直前から逆順に比べ、大きい魚が小さい魚を食べます。先に大きい魚がいた場合は、後から出した小さい魚が食べられます。</li>
          <li>同じ強さでは後から出した魚が先の魚を食べます。食べられた魚が抱えていた魚も、まとめて捕食した魚へ引き継がれます。</li>
          <li>口の中は固定画面で、数字が小さい魚ほど小さく、大きい魚ほど大きく表示されます。</li>
          <li>魚は数字に関係なく出せます。</li>
          <li>魚を出した子、口を開けた親、毒魚を取り除いた親だけ約1.2秒待ちます。ほかのプレイヤーはすぐ行動できます。</li>
          <li>口が開いている間、同じ2同士または3同士を2枚重ねると、2匹の群れになります。強さはカードの合計です。</li>
          <li>2匹の群れには、さらに同じ種類を1枚追加でき、3匹の群れになります。強さは2の群れなら6、3の群れなら9です。完成した群れは1枚の魚として出し、分けることはできません。</li>
          <li>群れを作って空いた公開枠には、山札があれば即座に1枚補充します。</li>
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
          <li>親は口が開いていて毒魚が有効な間、時間制限なく除去できます。</li>
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
  const parent = getParent();
  const parentIsWaitingAfterOwnAction = isPlayerWaitingAfterOwnAction(parent.id);
  const canOpen = parentIsHuman && !isGameOver && !isMouthOpen && !isTryEnded && !parentIsWaitingAfterOwnAction;
  const canClose = parentIsHuman && !isGameOver && isMouthOpen && !parentIsWaitingAfterOwnAction;
  const canRemovePoison = parentIsHuman && !isGameOver && isMouthOpen && activePoison && !parentIsWaitingAfterOwnAction;
  const waitTitle = "自分が行動した後の待ち時間です。少し待つと、また操作できます。";

  return `
    <section class="panel-block parent-controls${parentIsWaitingAfterOwnAction ? " is-action-waiting" : ""} ${getPlayerToneClass(parent.id)}"${parentIsWaitingAfterOwnAction ? ' aria-busy="true"' : ""}>
      <p class="section-label">${parentIsHuman ? "あなたが親" : "NPC親"}</p>
      <h2>${renderPlayerIdentity(parent)}</h2>
      <div class="parent-actions">
        <button class="primary-button" type="button" data-action="open-mouth"${canOpen ? "" : " disabled"}${parentIsWaitingAfterOwnAction ? ` title="${waitTitle}"` : ""}>
          口を開ける
        </button>
        <button class="danger-button" type="button" data-action="close-mouth"${canClose ? "" : " disabled"}${parentIsWaitingAfterOwnAction ? ` title="${waitTitle}"` : ""}>
          口を閉じる
        </button>
      </div>
      <button class="secondary-button wide" type="button" data-action="remove-poison"${canRemovePoison ? "" : " disabled"}${parentIsWaitingAfterOwnAction ? ` title="${waitTitle}"` : ""}>
        毒魚を取り除く
      </button>
      ${parentIsWaitingAfterOwnAction ? '<p class="microcopy action-wait-notice" role="status">行動後の待ち時間です。ほかのプレイヤーは操作できます。</p>' : ""}
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
  const whaleIsPoisoned = tryEndReason === "poison-close";
  const showWhale = tryEndReason === "parent-close" || whaleIsPoisoned;
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
                <div class="try-replay-whale${whaleIsPoisoned ? " is-poisoned" : ""}" style="--motion-delay: ${schedule.finalAt}ms" aria-hidden="true">
                  <img class="try-replay-whale-open" src="${whaleArtPaths.open}" alt="">
                  <img class="try-replay-whale-fed" src="${whaleIsPoisoned ? whaleArtPaths.poisoned : whaleArtPaths.fed}" alt="">
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
      <div class="try-replay-fish is-escape-effect ${getPlayerToneClass(card.ownerId)}" role="img" aria-label="${card.ownerName}の逃げる">
        <span aria-hidden="true">≋</span>
        <strong>逃げる</strong>
      </div>
    `;
  }

  const typeClass = card.type === "bait"
    ? "is-bait"
    : card.type === "poison"
      ? "is-poison"
      : `value-${card.value} size-value-${card.schoolBaseValue ?? card.value} art-value-${card.schoolBaseValue ?? card.value}${card.schoolSize !== undefined ? " is-school" : ""}`;

  return `
    <div class="try-replay-fish ${typeClass} ${getPlayerToneClass(card.ownerId)}" role="img" aria-label="${getMouthFishActorLabel(card)}">
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
  if (card.type === "fish") return card.schoolBaseValue ? `${card.schoolBaseValue}の群れ${getSchoolVisualFishCount(card)}匹` : `魚${card.value}`;
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

function renderTryResultOverlay(view?: TryResultView): string {
  const resultPlayers = view?.players ?? players;
  const resultCards = view?.cards ?? boxCards;
  const resultStartScores = view?.startScores ?? tryStartScores;
  const resultEndReason = view ? view.endReason : tryEndReason;
  const resultIsGameOver = view ? false : isGameOver;
  const resultActions = view?.actionsHtml ?? renderRoundActionButtons();
  const accessibility = view?.embedded
    ? 'role="region" aria-labelledby="try-result-title" tabindex="-1"'
    : 'role="dialog" aria-modal="true" aria-labelledby="try-result-title" tabindex="-1"';

  return `
    <section class="try-result-panel${view?.embedded ? " is-embedded" : ""}" ${accessibility}>
      <div class="try-result-header">
        <p class="section-label">1回終了</p>
        <h2 id="try-result-title">${resultIsGameOver ? "ゲーム終了" : "この回の結果"}</h2>
      </div>
      ${resultIsGameOver ? renderWinnerNotice() : ""}
      <div class="try-result-grid">
        <section class="try-score-section">
          <p class="section-label">獲得点</p>
          <div class="try-score-list">
            ${resultPlayers
              .map(
                (player) => {
                  const gained = player.score - (resultStartScores[player.id] ?? player.score);

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
            ${resultCards.map((card) => renderTryTimelineCard(card, resultCards)).join("")}
            ${renderTryEndMarker(resultEndReason)}
          </div>
        </section>
      </div>
      <div class="round-actions">
        ${resultActions}
      </div>
    </section>
  `;
}

function getTryScoreGain(player: Player): number {
  return player.score - (tryStartScores[player.id] ?? player.score);
}

function renderTryTimelineCard(card: BoxCard, sourceCards: BoxCard[] = boxCards): string {
  const escapedHere = card.type === "escape" && card.successful;
  const label = getTryOrderLabel(card);
  const detail = getTryOrderDetail(card, sourceCards);

  return `
    <div class="try-card-step" aria-label="${label}。${detail}">
      ${escapedHere ? '<span class="try-event-badge is-escape">ヒューん！<small>ここで逃げた</small></span>' : ""}
      ${renderBoxCard(card)}
    </div>
  `;
}

function renderTryEndMarker(endReason: TryEndReason | null = tryEndReason): string {
  if (endReason === "parent-close") {
    return '<div class="try-end-marker is-close" role="note"><strong>パク！</strong><span>ここで口を閉じた</span></div>';
  }

  if (endReason === "poison-close") {
    return '<div class="try-end-marker is-poison" role="note"><strong>毒発動</strong><span>毒魚を食べてしまった</span></div>';
  }

  return "";
}

function getTryOrderLabel(card: BoxCard): string {
  if (card.type === "bait") return `${card.ownerName}の餌 1`;
  if (card.type === "poison") return `${card.ownerName} 毒魚`;
  if (card.type === "escape") return `${card.ownerName} 逃げる`;
  return `${card.ownerName} ${getFishCardLabel(card)}`;
}

function getTryOrderDetail(card: BoxCard, sourceCards: BoxCard[] = boxCards): string {
  if (card.type === "bait") {
    return card.consumedById
      ? `魚${getEatingFishValue(card.consumedById, sourceCards)}に食べられた`
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
    return `逃げ成功 ${sumBoardCapturedIds(sourceCards, card.capturedIds, card.ownerId)}点`;
  }

  if (card.consumedById) {
    return `魚${getEatingFishValue(card.consumedById, sourceCards)}に食べられた`;
  }

  const candidateTotal = sumBoardCapturedIds(sourceCards, card.capturedIds, card.ownerId);
  return candidateTotal > 0 ? `未確定候補 ${candidateTotal}点` : "得点候補なし";
}

function getEatingFishValue(boxId: number, sourceCards: BoxCard[] = boxCards): string {
  const card = sourceCards.find((item): item is FishBoxCard => item.type === "fish" && item.boxId === boxId);
  return card ? String(card.value) : "?";
}

function renderRoundActionButtons(): string {
  if (isGameOver) {
    return '<button class="primary-button" type="button" data-action="reset-game">もう一度遊ぶ</button>';
  }

  const shouldAdvanceParent = currentTry >= maxTriesPerParent;
  const action = shouldAdvanceParent ? "advance-parent" : "next-try";
  const label = shouldAdvanceParent ? "次のトライ（親の交代）" : "次のトライ";

  return `<button class="secondary-button" type="button" data-action="${action}"${isTryEnded ? "" : " disabled"}>${label}</button>`;
}

function renderMouth(): string {
  const liveFishCount = getLiveMouthFishCount();
  const mouthClass = isMouthOpen
    ? "is-open"
    : biteAftermath
      ? `is-closed is-after-bite is-${biteAftermath}`
      : "is-closed";
  return `
    <div class="mouth ${mouthClass}">
      <img class="whale-face whale-face-closed" src="${whaleArtPaths.closed}" alt="" aria-hidden="true">
      <img class="whale-face whale-face-fed" src="${whaleArtPaths.fed}" alt="" aria-hidden="true">
      <img class="whale-face whale-face-poisoned" src="${whaleArtPaths.poisoned}" alt="" aria-hidden="true">
      <div class="jaw jaw-top" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <div class="mouth-camera-layer">
        <img class="whale-face whale-face-open" src="${whaleArtPaths.open}" alt="" aria-hidden="true">
        <div class="mouth-cavity">
          ${renderMouthFishScene()}
        </div>
      </div>
      <div class="cavity-meta">
        <span>泳いでいる魚 ${liveFishCount}匹</span>
        <span>${activePoison ? `毒魚: ${activePoison.ownerName}` : "毒魚なし"}</span>
      </div>
      <div class="jaw jaw-bottom" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      ${biteAftermath === "poisoned" ? '<span class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">親が毒魚を食べて苦しんでいます。</span>' : ""}
    </div>
  `;
}

function renderMouthFishScene(): string {
  const motionElapsedMs = getMouthFishMotionElapsedMs();
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
  const predator = mouthFishMotion?.predatorId ? getBoxCard(mouthFishMotion.predatorId) : null;
  const predatorPosition = predator ? getMouthFishPosition(predator) : null;

  return `
    <div class="mouth-fish-stage" role="group" aria-label="口の中を泳ぐ魚">
      <div class="mouth-fish-world">
        <span class="water-bubble bubble-one" aria-hidden="true"></span>
        <span class="water-bubble bubble-two" aria-hidden="true"></span>
        <span class="water-bubble bubble-three" aria-hidden="true"></span>
        ${actors.map((card) => renderMouthFishActor(card, motionElapsedMs)).join("")}
        ${
          predatorPosition && mouthFishMotion?.preyIds.length
            ? `<span class="mouth-chomp-burst" style="--burst-x:${predatorPosition.x}%; --burst-y:${predatorPosition.y}%; --motion-elapsed:${motionElapsedMs}ms" aria-hidden="true">パクッ!</span>`
            : ""
        }
      </div>
      ${
        mouthFishMotion
          ? `<span class="visually-hidden" role="status" aria-live="polite">${getMouthFishMotionAnnouncement()}</span>`
          : ""
      }
    </div>
  `;
}

function renderMouthFishActor(card: BoxCard, motionElapsedMs: number): string {
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
    `--motion-delay:${delay}ms`,
    `--motion-elapsed:${motionElapsedMs}ms`
  ].join("; ");
  const statusClass = card.type === "fish"
    ? [
        card.invalidatedByOwnPoison ? "is-ineffective" : "",
        card.poisonScoredById ? "is-poison-scored" : "",
        card.schoolSize !== undefined ? "is-school" : ""
      ].filter(Boolean).join(" ")
    : card.type === "poison"
      ? "is-poison"
      : "is-bait";
  const visualClass = card.type === "fish"
    ? `size-value-${card.schoolBaseValue ?? card.value} art-value-${card.schoolBaseValue ?? card.value}`
    : "";

  return `
    <article
      class="mouth-fish-actor ${statusClass} ${card.type === "fish" ? `value-${card.value}` : ""} ${visualClass} ${motionClass} ${getPlayerToneClass(card.ownerId)}"
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
      <span class="bait-sprite" aria-hidden="true"><i></i></span>
      <span class="mouth-fish-value">1</span>
    `;
  }

  const artPath = card.type === "poison"
    ? poisonFishArtPath
    : fishArtPaths[card.schoolBaseValue ?? card.value];
  const valueBadge = card.type === "fish"
    ? `<span class="mouth-fish-value">${card.value}</span>`
    : '<span class="mouth-fish-value is-poison-mark">&#9760;</span>';
  const schoolFishCount = card.type === "fish" ? getSchoolVisualFishCount(card) : 1;
  const artworkClass = card.type === "poison"
    ? "is-poison-art"
    : `art-value-${card.schoolBaseValue ?? card.value}`;
  const fishArtwork = schoolFishCount > 1
    ? `
      <span class="mouth-fish-school school-count-${schoolFishCount}" aria-hidden="true">
        ${Array.from({ length: schoolFishCount }, (_, index) => `<span class="mouth-fish-cutout school-fish-member member-${index + 1}"><img class="${artworkClass}" src="${artPath}" alt=""></span>`).join("")}
      </span>
    `
    : `<span class="mouth-fish-cutout" aria-hidden="true"><img class="${artworkClass}" src="${artPath}" alt=""></span>`;
  const schoolCountBadge = schoolFishCount > 1
    ? `<span class="mouth-school-count" aria-hidden="true">${schoolFishCount}匹</span>`
    : "";

  return `
    ${fishArtwork}
    ${valueBadge}
    ${schoolCountBadge}
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
  if (card.type === "bait") return 6;
  if (card.type === "poison") return 28;
  if (card.type !== "fish") return 12;
  if (card.schoolBaseValue === 2) return 27;
  if (card.schoolBaseValue === 3) return 39;
  const visualValue = card.schoolBaseValue ?? card.value;
  if (visualValue === 2) return 18;
  if (visualValue === 3) return 26;
  if (visualValue === 4) return 34;
  if (visualValue === 5) return 43;
  return 50;
}

function getMouthFishActorLabel(card: BoxCard): string {
  if (card.type === "bait") return `${card.ownerName}の餌、1`;
  if (card.type === "poison") return `${card.ownerName}の毒魚`;
  if (card.type === "escape") return `${card.ownerName}の逃げる`;
  if (card.schoolBaseValue) {
    return `${card.ownerName}の${card.schoolBaseValue}の群れ、${getSchoolVisualFishCount(card)}匹、強さ${card.value}`;
  }
  return `${card.ownerName}の魚、強さ${card.value}`;
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

function renderCardFishArtwork(artValue: FishValue, schoolSize?: FishCard["schoolSize"]): string {
  const artPath = fishArtPaths[artValue];
  const fishCount = schoolSize ?? 1;

  if (fishCount === 1) {
    return `<img class="card-fish-art art-value-${artValue}" src="${artPath}" alt="" aria-hidden="true">`;
  }

  return `
    <span class="card-school-art art-value-${artValue} school-count-${fishCount}" aria-hidden="true">
      ${Array.from({ length: fishCount }, (_, index) => `<span class="card-school-fish member-${index + 1}"><img src="${artPath}" alt=""></span>`).join("")}
    </span>
  `;
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
        <img class="card-fish-art is-poison-art" src="${poisonFishArtPath}" alt="" aria-hidden="true">
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
    <article${accessibility} class="box-card fish-card-in-box value-${card.value} ${card.schoolSize !== undefined ? "is-school" : ""} ${card.consumedById ? "is-eaten" : ""} ${card.poisonScoredById ? "is-poison-scored" : ""} ${card.invalidatedByOwnPoison ? "is-ineffective" : ""} ${card.escaped ? "is-escaped" : ""} ${getPlayerToneClass(card.ownerId)}">
      <span class="card-sequence">${card.sequence}</span>
      ${card.schoolSize !== undefined ? '<span class="school-card-layer" aria-hidden="true"></span>' : ""}
      ${renderCardFishArtwork(fishArtValue, card.schoolSize)}
      <span class="card-value">${card.value}</span>
      ${card.schoolBaseValue ? `<span class="school-fish-count-badge" aria-hidden="true">${getSchoolVisualFishCount(card)}匹</span>` : ""}
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
      <p>親は毒魚が有効な間、時間制限なく取り除けます。残したまま口を閉じると、${activePoison.ownerName} に10点が入ります。</p>
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
  const isWaitingAfterOwnAction = isPlayerWaitingAfterOwnAction(player.id);
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
    <article class="child-panel is-${variant}${isWaitingAfterOwnAction ? " is-card-waiting" : ""} ${getPlayerToneClass(player.id)}">
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
              <span>群れ作りには待ち時間がありません。同じ2・3を重ね、2匹の群れには同じ種類をもう1枚追加できます</span>
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

  const isWaitingAfterOwnAction = isPlayerWaitingAfterOwnAction(player.id);
  const canInteract =
    player.id === localPlayerId &&
    player.role === "child" &&
    isMouthOpen &&
    !isGameOver;
  const canUse = canInteract && !isWaitingAfterOwnAction;
  const unavailableTitle = isWaitingAfterOwnAction
    ? "自分がカードを出した後の待ち時間です。少し待つと、また出せます。"
    : "口が開いている間だけ使用できます。";
  const ownPoisonMakesFishIneffective = card.type === "fish" && activePoison?.ownerId === player.id;
  const fishLabel = card.type === "fish" ? getFishCardLabel(card) : "";
  const playLabel = ownPoisonMakesFishIneffective
    ? `${fishLabel}を出す（自分の毒魚直後のため効果なし）`
    : card.type === "poison" && activePoison
      ? "毒魚を出して得点の権利を奪う"
      : card.type === "poison"
        ? "毒魚を出す"
        : `${fishLabel}を出す`;
  const isSchool = card.type === "fish" && card.schoolSize !== undefined;
  const stackBaseValue = card.type === "fish"
    ? card.schoolBaseValue ?? (card.value === 2 || card.value === 3 ? card.value : null)
    : null;
  const canStack =
    canInteract &&
    card.type === "fish" &&
    stackBaseValue !== null &&
    (card.schoolSize === undefined || card.schoolSize === 2) &&
    player.faceUp.some((targetCard, targetSlotIndex) =>
      targetSlotIndex !== slotIndex && targetCard !== null && canStackFishCards(card, targetCard)
    );
  const stackHint = card.type === "fish" && card.schoolSize === 2 && stackBaseValue !== null
    ? `同じ${stackBaseValue}を追加すると、3匹・強さ${stackBaseValue * 3}の群れになります。`
    : "同じ数字のカードへドラッグするか、Sキーで2匹の群れにできます。";
  const cardAction = canUse ? "play-card" : canStack ? "stack-only" : "play-card";
  const cardActionLabel = canUse ? playLabel : canStack ? `群れを作る。${stackHint}` : playLabel;
  const cardClass = card.type === "poison"
    ? "poison-hand-card"
    : `fish-hand-card value-${card.value}${isSchool ? " is-school" : ""}`;
  const valueLabel = card.type === "poison" ? "" : String(card.value);
  const cardArtwork = card.type === "fish"
    ? renderCardFishArtwork(card.schoolBaseValue ?? card.value, card.schoolSize)
    : `<img class="card-fish-art is-poison-art" src="${poisonFishArtPath}" alt="" aria-hidden="true">`;
  const escapeCandidate = getPlayerCandidates(player.id).at(-1);
  const escapePoints = escapeCandidate ? sumCapturedIds(escapeCandidate.capturedIds, player.id) : 0;
  const escapeLabel = escapeCandidate ? `裏で逃げる ${escapePoints}点` : "裏で逃げる（効果なし）";

  return `
    <div class="hand-slot">
      <button
        class="play-card ${cardClass}"
        type="button"
        data-action="${cardAction}"
        data-player-id="${player.id}"
        data-slot-index="${slotIndex}"
        data-card-id="${card.id}"
        aria-label="${cardActionLabel}"
        ${canStack ? `data-stack-value="${stackBaseValue}"` : ""}
        ${canStack ? 'aria-keyshortcuts="S"' : ""}
        ${canUse || canStack ? "" : " disabled"}
        title="${canUse ? `${playLabel}${canStack ? `。${stackHint}` : ""}` : canStack ? `待ち時間中でも群れを作れます。${stackHint}` : unavailableTitle}"
      >
        ${isSchool ? '<span class="school-card-layer" aria-hidden="true"></span>' : ""}
        ${cardArtwork}
        ${card.type === "poison" ? '<span class="card-symbol poison-symbol" aria-hidden="true">&#9760;</span>' : `<span class="card-value">${valueLabel}</span>`}
        ${isSchool ? `<span class="school-fish-count-badge" aria-hidden="true">${getSchoolVisualFishCount(card)}匹</span>` : ""}
      </button>
      <button
        class="escape-chip"
        type="button"
        data-action="escape-card"
        data-player-id="${player.id}"
        data-slot-index="${slotIndex}"
        ${canUse ? "" : " disabled"}
        title="${canUse ? (getPlayerCandidates(player.id).length > 0 ? "このカードを裏向きで使って逃げます。" : "逃げる権利がないため、出しても効果はなく使用済みになります。") : unavailableTitle}"
      >
        ${escapeLabel}
      </button>
    </div>
  `;
}

function getUsedPhysicalCardCount(player: Player): number {
  return player.used.reduce(
    (total, card) => total + (card.type === "fish" ? card.schoolSize ?? 1 : 1),
    0
  );
}

function getMouthStatusLabel(): string {
  if (isGameOver) return "ゲーム終了";
  if (isMouthOpen) return "開いている";
  if (biteAftermath === "poisoned") return "毒魚を食べて苦しんでいる";
  if (biteAftermath === "fed") return "閉じている";
  if (isTryEnded) return "トライ終了";
  return "閉じている";
}
