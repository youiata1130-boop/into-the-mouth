import type { FishValue } from "../game/model";

const creatureAssetRoot = "./assets/creatures";
const whaleAssetRoot = "./assets/whale";

export const fishArtPaths: Record<FishValue, string> = {
  2: `${creatureAssetRoot}/fish-2-sardine.webp`,
  3: `${creatureAssetRoot}/fish-3.webp`,
  4: `${creatureAssetRoot}/creature-4-octopus.webp`,
  5: `${creatureAssetRoot}/fish-5-shark.webp`,
  6: `${creatureAssetRoot}/fish-5-shark.webp`,
  9: `${creatureAssetRoot}/fish-3.webp`
};

export const poisonFishArtPath = `${creatureAssetRoot}/fish-poison.webp`;

export const whaleArtPaths = {
  closed: `${whaleAssetRoot}/closed.webp`,
  open: `${whaleAssetRoot}/open.webp`,
  launchOpen: `${whaleAssetRoot}/open-wide.webp`,
  fed: `${whaleAssetRoot}/fed.webp`,
  poisoned: `${whaleAssetRoot}/poisoned.webp`
} as const;
