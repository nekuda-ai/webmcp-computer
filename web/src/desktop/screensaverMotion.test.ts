import { describe, expect, test } from "bun:test";
import { screensaverHueAfterFrame } from "./screensaverMotion";

describe("screensaver motion", () => {
  test("keeps hue fixed between wall contacts and steps it on contact", () => {
    expect(screensaverHueAfterFrame(100, false, 1)).toBe(100);
    expect(screensaverHueAfterFrame(100, true, 0)).toBe(143);
    expect(screensaverHueAfterFrame(350, true, 1)).toBe(91);
  });
});
