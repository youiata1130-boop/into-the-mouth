export type FishValue = 2 | 3 | 4 | 5 | 6;
export type SchoolFishValue = 2 | 3;
export type Role = "parent" | "child";

export type FishCard = {
  id: number;
  type: "fish";
  value: FishValue;
  schoolBaseValue?: SchoolFishValue;
  schoolSize?: 2;
  componentCardIds?: [number, number];
};

export type PoisonCard = {
  id: number;
  type: "poison";
};

export type PlayerCard = FishCard | PoisonCard;

export type Player = {
  id: string;
  name: string;
  role: Role;
  score: number;
  drawPile: PlayerCard[];
  faceUp: Array<PlayerCard | null>;
  used: PlayerCard[];
};

export type BaitBoxCard = {
  boxId: number;
  type: "bait";
  value: 1;
  ownerId: string;
  ownerName: string;
  sequence: number;
  consumedById: number | null;
};

export type FishBoxCard = {
  boxId: number;
  sourceCardId: number;
  type: "fish";
  value: FishValue;
  schoolBaseValue?: SchoolFishValue;
  schoolSize?: 2;
  componentCardIds?: [number, number];
  ownerId: string;
  ownerName: string;
  sequence: number;
  consumedById: number | null;
  capturedIds: number[];
  poisonScoredById: string | null;
  poisonScoredByName: string | null;
  invalidatedByOwnPoison: boolean;
  escaped: boolean;
};

export type PoisonCardStatus = "active" | "triggered" | "removed" | "overridden" | "cancelled";

export type PoisonBoxCard = {
  boxId: number;
  sourceCardId: number;
  type: "poison";
  ownerId: string;
  ownerName: string;
  sequence: number;
  status: PoisonCardStatus;
};

export type EscapeBoxCard = {
  boxId: number;
  sourceCardId: number;
  type: "escape";
  ownerId: string;
  ownerName: string;
  sequence: number;
  successful: boolean;
};

export type BoxCard = BaitBoxCard | FishBoxCard | PoisonBoxCard | EscapeBoxCard;
export type NumericBoxCard = BaitBoxCard | FishBoxCard;

export type PoisonState = {
  boxId: number;
  ownerId: string;
  ownerName: string;
};
