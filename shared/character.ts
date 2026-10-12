import { z } from "zod";

export const PHYSIQUES = {
  runner: {
    name: "Runner",
    health: 80,
    speed: 1.2,
    width: 0.82,
    description: "Light on your feet. Less room for mistakes.",
  },
  regular: {
    name: "Regular",
    health: 100,
    speed: 1,
    width: 1,
    description: "A little speed. A little staying power.",
  },
  tank: {
    name: "Tank",
    health: 150,
    speed: 0.8,
    width: 1.28,
    description: "Built to take a hit. Takes the slower route.",
  },
} as const;
export const characterSchema = z.object({
  physique: z.enum(["runner", "regular", "tank"]),
  skin: z.enum(["#edc5a5", "#c99773", "#986747", "#654432"]),
  hair: z.enum(["crop", "curls", "cap", "shaved"]),
  top: z.enum(["tee", "jacket", "vest"]),
  legs: z.enum(["trousers", "shorts", "cargo"]),
});
export type Character = z.infer<typeof characterSchema>;
export const DEFAULT_CHARACTER: Character = {
  physique: "regular",
  skin: "#c99773",
  hair: "crop",
  top: "jacket",
  legs: "trousers",
};
export const SHIRT_COLORS = [
  "#e8b63f",
  "#c4664e",
  "#588f91",
  "#8d829e",
  "#7b8960",
  "#e4dfca",
] as const;
export function randomCharacter(): Character {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(Math.random() * items.length)];
  return {
    physique: pick(characterSchema.shape.physique.options),
    skin: pick(characterSchema.shape.skin.options),
    hair: pick(characterSchema.shape.hair.options),
    top: pick(characterSchema.shape.top.options),
    legs: pick(characterSchema.shape.legs.options),
  };
}
