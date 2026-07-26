import type { FishValue } from "../game/model";

const creatureAssetRoot = "./assets/creatures";
const whaleAssetRoot = "./assets/whale";

export const fishArtPaths: Record<FishValue, string> = {
  2: `${creatureAssetRoot}/fish-2-sardine.png`,
  3: `${creatureAssetRoot}/fish-3.png`,
  4: `${creatureAssetRoot}/creature-4-octopus.png`,
  5: `${creatureAssetRoot}/fish-5-shark.png`,
  6: `${creatureAssetRoot}/fish-5-shark.png`,
  9: `${creatureAssetRoot}/fish-3.png`
};

export const poisonFishArtPath = `${creatureAssetRoot}/fish-poison.png`;

export const whaleArtPaths = {
  closed: `${whaleAssetRoot}/closed.png`,
  open: `${whaleAssetRoot}/open.png`,
  fed: `${whaleAssetRoot}/fed.png`,
  poisoned: `${whaleAssetRoot}/poisoned.png`
} as const;
