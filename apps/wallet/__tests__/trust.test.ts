/**
 * Tests for lib/trust.ts
 */

import {
  getTrustDecision,
  setTrustDecision,
  removeTrustEntry,
  getAllTrustedOrigins,
} from "../lib/trust";
import { clear } from "../__mocks__/expo-secure-store";

beforeEach(() => {
  clear();
});

// ---------------------------------------------------------------------------
// getTrustDecision
// ---------------------------------------------------------------------------

describe("getTrustDecision", () => {
  it("returns 'unknown' for an origin that was never set", async () => {
    const result = await getTrustDecision("https://unknown.example");
    expect(result).toBe("unknown");
  });

  it("returns 'trusted' after setting trusted", async () => {
    await setTrustDecision("https://studio.vri.example", "trusted");
    expect(await getTrustDecision("https://studio.vri.example")).toBe("trusted");
  });

  it("returns 'blocked' after setting blocked", async () => {
    await setTrustDecision("https://bad.example", "blocked");
    expect(await getTrustDecision("https://bad.example")).toBe("blocked");
  });

  it("is keyed by host — ignores path and trailing slash differences", async () => {
    await setTrustDecision("https://studio.vri.example", "trusted");
    expect(await getTrustDecision("https://studio.vri.example/some/path")).toBe("trusted");
  });
});

// ---------------------------------------------------------------------------
// setTrustDecision
// ---------------------------------------------------------------------------

describe("setTrustDecision", () => {
  it("can update from trusted to blocked", async () => {
    await setTrustDecision("https://studio.vri.example", "trusted");
    await setTrustDecision("https://studio.vri.example", "blocked");
    expect(await getTrustDecision("https://studio.vri.example")).toBe("blocked");
  });

  it("persists multiple origins independently", async () => {
    await setTrustDecision("https://a.example", "trusted");
    await setTrustDecision("https://b.example", "blocked");
    expect(await getTrustDecision("https://a.example")).toBe("trusted");
    expect(await getTrustDecision("https://b.example")).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// removeTrustEntry
// ---------------------------------------------------------------------------

describe("removeTrustEntry", () => {
  it("removes an existing entry — returns unknown afterwards", async () => {
    await setTrustDecision("https://studio.vri.example", "trusted");
    await removeTrustEntry("https://studio.vri.example");
    expect(await getTrustDecision("https://studio.vri.example")).toBe("unknown");
  });

  it("is a no-op for an origin that was never set", async () => {
    await expect(removeTrustEntry("https://never.example")).resolves.not.toThrow();
  });

  it("does not affect other entries", async () => {
    await setTrustDecision("https://a.example", "trusted");
    await setTrustDecision("https://b.example", "trusted");
    await removeTrustEntry("https://a.example");
    expect(await getTrustDecision("https://b.example")).toBe("trusted");
  });
});

// ---------------------------------------------------------------------------
// getAllTrustedOrigins
// ---------------------------------------------------------------------------

describe("getAllTrustedOrigins", () => {
  it("returns empty array when nothing is stored", async () => {
    expect(await getAllTrustedOrigins()).toEqual([]);
  });

  it("returns all stored entries with host and decision", async () => {
    await setTrustDecision("https://a.example", "trusted");
    await setTrustDecision("https://b.example", "blocked");
    const entries = await getAllTrustedOrigins();
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        { host: "a.example", decision: "trusted" },
        { host: "b.example", decision: "blocked" },
      ])
    );
  });

  it("reflects removals", async () => {
    await setTrustDecision("https://a.example", "trusted");
    await removeTrustEntry("https://a.example");
    expect(await getAllTrustedOrigins()).toHaveLength(0);
  });
});
