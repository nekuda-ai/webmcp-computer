export function screensaverHueAfterFrame(
  currentHue: number,
  wallHit: boolean,
  randomUnit: number,
): number {
  if (!wallHit) return currentHue;
  return (currentHue + 43 + Math.round(randomUnit * 58)) % 360;
}
