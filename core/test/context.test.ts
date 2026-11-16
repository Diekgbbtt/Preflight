import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/context";

describe("estimateTokens", () => {
  it("is 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("is 1 for four characters", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("is 2 for five characters", () => {
    expect(estimateTokens("abcde")).toBe(2);
  });
});
