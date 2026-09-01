import { describe, expect, test } from "bun:test";
import { placeVerbHint } from "./VerbHint";

describe("VerbHint collision placement", () => {
  test("flips below the top edge and shifts inside both horizontal edges", () => {
    expect(placeVerbHint(
      { top: 0, bottom: 20, left: 0, right: 40, width: 40 },
      { width: 180, height: 30 },
      { width: 320, height: 200 },
    )).toEqual({ top: 30, left: 8, arrowX: 12, placement: "below" });

    expect(placeVerbHint(
      { top: 100, bottom: 120, left: 300, right: 320, width: 20 },
      { width: 180, height: 30 },
      { width: 320, height: 200 },
    )).toEqual({ top: 60, left: 132, arrowX: 170, placement: "above" });
  });
});
