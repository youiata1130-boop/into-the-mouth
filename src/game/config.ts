import type { FishValue } from "./model";

export const FISH_COUNTS: ReadonlyArray<readonly [FishValue, number]> = [
  [2, 3],
  [3, 3],
  [4, 2],
  [5, 1],
  [6, 1]
];

export const CHILD_LABELS = ["子A", "子B", "子C", "子D", "子E"] as const;
export const MAX_TRIES_PER_PARENT = 3;
export const VISIBLE_CARD_COUNT = 3;
export const POISON_REMOVAL_LIMIT_MS = 3000;
export const HUMAN_PLAYER_ID = "player-2";
