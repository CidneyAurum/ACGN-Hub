import { describe, expect, it } from "vitest";
import { canTransition } from "@/domain/state-machine";

describe("download state machine", () => {
  it("allows normal lifecycle transitions", () => {
    expect(canTransition("queued", "downloading")).toBe(true);
    expect(canTransition("downloading", "paused")).toBe(true);
    expect(canTransition("paused", "downloading")).toBe(true);
    expect(canTransition("downloading", "completed")).toBe(true);
  });

  it("rejects impossible transitions", () => {
    expect(canTransition("completed", "downloading")).toBe(false);
    expect(canTransition("cancelled", "completed")).toBe(false);
  });
});
