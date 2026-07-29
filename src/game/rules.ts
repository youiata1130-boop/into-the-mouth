import type { BoxCard, FishBoxCard, FishValue, NumericBoxCard } from "./model";

export function resolvePredation(boxCards: BoxCard[], newFish: FishBoxCard): number[] {
  const capturedIds = new Set<number>();
  const newFishIndex = boxCards.findIndex((card) => card.boxId === newFish.boxId);

  for (let index = newFishIndex - 1; index >= 0; index -= 1) {
    const target = boxCards[index];

    if (target.type === "poison") {
      if (target.status === "active") break;
      continue;
    }

    if (target.type === "escape") {
      if (!target.successful) continue;
      break;
    }

    if (!isNumericBoxCard(target) || target.consumedById !== null) continue;
    if (target.type === "fish" && target.invalidatedByOwnPoison) continue;
    if (target.type === "fish" && target.poisonScoredById) break;
    if (target.type === "fish" && target.value > newFish.value) {
      const swallowedIds = [newFish.boxId, ...capturedIds];

      for (const swallowedId of swallowedIds) {
        const swallowedCard = getNumericBoxCard(boxCards, swallowedId);
        if (swallowedCard) swallowedCard.consumedById = target.boxId;
      }

      target.capturedIds = [...new Set([...target.capturedIds, ...swallowedIds])];
      newFish.capturedIds = [];
      return [];
    }

    capturedIds.add(target.boxId);
    transferCapturedCard(boxCards, target, newFish, capturedIds);
  }

  return [...capturedIds];
}

export function getPlayerCandidates(boxCards: BoxCard[], playerId: string): FishBoxCard[] {
  return boxCards.filter(
    (card): card is FishBoxCard =>
      card.type === "fish" &&
      card.ownerId === playerId &&
      card.consumedById === null &&
      !card.poisonScoredById &&
      !card.invalidatedByOwnPoison &&
      card.capturedIds.length > 0
  );
}

export function getParentCloseTotal(boxCards: BoxCard[], scoringPlayerId: string): number {
  if (boxCards.some((card) => card.type === "fish" && card.escaped)) return 0;

  return boxCards.reduce((total, card) => {
    if (!isNumericBoxCard(card)) return total;
    if (card.ownerId === scoringPlayerId) return total;
    if (card.type === "fish" && (card.poisonScoredById || card.invalidatedByOwnPoison)) return total;
    return total + card.value;
  }, 0);
}

export function getCardsInMouth(boxCards: BoxCard[]): BoxCard[] {
  return boxCards.filter((card) => card.type !== "poison" || card.status !== "removed");
}

export function sumCapturedIds(boxCards: BoxCard[], cardIds: number[], scoringPlayerId: string): number {
  return cardIds.reduce((total, cardId) => {
    const card = getNumericBoxCard(boxCards, cardId);
    return total + (card && card.ownerId !== scoringPlayerId ? card.value : 0);
  }, 0);
}

export function estimateFishCaptureValue(boxCards: BoxCard[], value: FishValue, scoringPlayerId: string): number {
  let total = 0;

  for (let index = boxCards.length - 1; index >= 0; index -= 1) {
    const target = boxCards[index];

    if (target.type === "poison") {
      if (target.status === "active") break;
      continue;
    }
    if (target.type === "escape") {
      if (!target.successful) continue;
      break;
    }
    if (!isNumericBoxCard(target) || target.consumedById !== null) continue;
    if (target.type === "fish" && target.invalidatedByOwnPoison) continue;
    if (target.type === "fish" && target.poisonScoredById) break;
    if (target.value > value) return 0;
    if (target.ownerId !== scoringPlayerId) total += target.value;

    if (target.type === "fish") {
      total += sumCapturedIds(boxCards, target.capturedIds, scoringPlayerId);
    }
  }

  return total;
}

function transferCapturedCard(
  boxCards: BoxCard[],
  target: NumericBoxCard,
  newFish: FishBoxCard,
  capturedIds: Set<number>
): void {
  target.consumedById = newFish.boxId;

  if (target.type !== "fish") return;

  for (const inheritedId of target.capturedIds) {
    capturedIds.add(inheritedId);
    const inheritedCard = getNumericBoxCard(boxCards, inheritedId);

    if (inheritedCard) inheritedCard.consumedById = newFish.boxId;
  }

  target.capturedIds = [];
}

function getNumericBoxCard(boxCards: BoxCard[], boxId: number): NumericBoxCard | null {
  const card = boxCards.find((item) => item.boxId === boxId);
  return card && isNumericBoxCard(card) ? card : null;
}

function isNumericBoxCard(card: BoxCard): card is NumericBoxCard {
  return card.type === "bait" || card.type === "fish";
}
