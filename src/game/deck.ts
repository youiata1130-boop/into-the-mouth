import { FISH_COUNTS } from "./config";
import type { FishCard, FishValue, Player, PlayerCard, PoisonCard, SchoolFishValue } from "./model";
import { shuffle } from "./random";

export function createShuffledDeck(createCardId: () => number): PlayerCard[] {
  const deck: PlayerCard[] = [];

  for (const [value, count] of FISH_COUNTS) {
    for (let index = 0; index < count; index += 1) {
      deck.push(createFishCard(createCardId(), value));
    }
  }

  deck.push(createPoisonCard(createCardId()));
  return shuffle(deck);
}

export function drawCard(player: Player): PlayerCard | null {
  return player.drawPile.shift() ?? null;
}

export function useFaceUpCard(player: Player, slotIndex: number): PlayerCard | null {
  const card = player.faceUp[slotIndex];

  if (!card) return null;

  player.used.push(card);
  player.faceUp[slotIndex] = drawCard(player);
  return card;
}

export function canStackFishCards(source: PlayerCard | null, target: PlayerCard | null): source is FishCard {
  return (
    source?.type === "fish" &&
    target?.type === "fish" &&
    source.schoolSize === undefined &&
    target.schoolSize === undefined &&
    (source.value === 2 || source.value === 3) &&
    source.value === target.value
  );
}

export function stackFaceUpFishCards(
  player: Player,
  sourceSlotIndex: number,
  targetSlotIndex: number,
  expectedSourceCardId?: number,
  expectedTargetCardId?: number
): FishCard | null {
  if (sourceSlotIndex === targetSlotIndex) return null;

  const source = player.faceUp[sourceSlotIndex] ?? null;
  const target = player.faceUp[targetSlotIndex] ?? null;

  if (expectedSourceCardId !== undefined && source?.id !== expectedSourceCardId) return null;
  if (expectedTargetCardId !== undefined && target?.id !== expectedTargetCardId) return null;
  if (!canStackFishCards(source, target) || target?.type !== "fish") return null;

  const schoolBaseValue = target.value as SchoolFishValue;
  const schoolValue = (schoolBaseValue * 2) as FishValue;
  const schoolCard: FishCard = {
    ...target,
    value: schoolValue,
    schoolBaseValue,
    schoolSize: 2,
    componentCardIds: [target.id, source.id]
  };

  player.faceUp[targetSlotIndex] = schoolCard;
  player.faceUp[sourceSlotIndex] = drawCard(player);
  return schoolCard;
}

function createFishCard(id: number, value: FishCard["value"]): FishCard {
  return { id, type: "fish", value };
}

function createPoisonCard(id: number): PoisonCard {
  return { id, type: "poison" };
}
