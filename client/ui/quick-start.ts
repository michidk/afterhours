/**
 * `?play` skips the character screen and joins as soon as the city is ready, with the character
 * saved on this device. `?name=Tester` sets the name (up to 18 characters, as the screen allows).
 */
export function quickStart(search: string) {
  const params = new URLSearchParams(search);
  if (!params.has("play") || params.get("play") === "0") return undefined;
  const name = params.get("name")?.trim().slice(0, 18);
  return { name: name || undefined };
}
