export function randomSlug(
  random: (array: Uint8Array) => Uint8Array = (array) => crypto.getRandomValues(array),
): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const characters: string[] = [];
  while (characters.length < 8) {
    const bytes = random(new Uint8Array(8 - characters.length));
    for (const byte of bytes) {
      if (byte >= 252) continue;
      characters.push(alphabet[byte % alphabet.length] ?? "");
      if (characters.length === 8) break;
    }
  }
  return characters.join("");
}
