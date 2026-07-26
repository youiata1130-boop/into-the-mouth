import { FISH_COUNTS } from "./config";
import type { FishCard, FishValue, Player, PlayerCard, PoisonCard, SchoolFishValue, SchoolSize } from "./model";
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
  if (source?.type !== "fish" || target?.type !== "fish") return false;

  const sourceBaseValue = getSchoolBaseValue(source);
  const targetBaseValue = getSchoolBaseValue(target);

  if (sourceBaseValue === null || sourceBaseValue !== targetBaseValue) return false;

  const schoolSize = getSchoolCardCount(source) + getSchoolCardCount(target);
  return schoolSize >= 2 && schoolSize <= 3;
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

  const schoolBaseValue = getSchoolBaseValue(target);
  if (schoolBaseValue === null) return null;

  const componentCardIds = [...getComponentCardIds(target), ...getComponentCardIds(source)];
  if (componentCardIds.length !== 2 && componentCardIds.length !== 3) return null;

  const schoolSize = componentCardIds.length as SchoolSize;
  const schoolValue = (schoolBaseValue * schoolSize) as FishValue;
  const schoolCard: FishCard = {
    ...target,
    value: schoolValue,
    schoolBaseValue,
    schoolSize,
    componentCardIds: schoolSize === 2
      ? [componentCardIds[0], componentCardIds[1]]
      : [componentCardIds[0], componentCardIds[1], componentCardIds[2]]
  };

  player.faceUp[targetSlotIndex] = schoolCard;
  player.faceUp[sourceSlotIndex] = drawCard(player);
  return schoolCard;
}

function getSchoolBaseValue(card: FishCard): SchoolFishValue | null {
  if (card.schoolBaseValue !== undefined) return card.schoolBaseValue;
  return card.value === 2 || card.value === 3 ? card.value : null;
}

function getSchoolCardCount(card: FishCard): number {
  return card.schoolSize ?? 1;
}

function getComponentCardIds(card: FishCard): number[] {
  return card.componentCardIds ? [...card.componentCardIds] : [card.id];
}

function createFishCard(id: number, value: FishCard["value"]): FishCard {
  return { id, type: "fish", value };
}

function createPoisonCard(id: number): PoisonCard {
  return { id, type: "poison" };
}
