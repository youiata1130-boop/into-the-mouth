import { FISH_COUNTS } from "./config";
import type { FishCard, Player, PlayerCard, PoisonCard } from "./model";
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

function createFishCard(id: number, value: FishCard["value"]): FishCard {
  return { id, type: "fish", value };
}

function createPoisonCard(id: number): PoisonCard {
  return { id, type: "poison" };
}
