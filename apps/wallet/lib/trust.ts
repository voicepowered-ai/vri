/**
 * VRI Wallet — Trusted origin management
 *
 * Origins are stored in app storage as a JSON array.
 * An origin is trusted if the user explicitly approved it.
 */

import * as Storage from "./storage";

const STORE_KEY = "vri_trusted_origins_v1";

export type TrustDecision = "trusted" | "blocked" | "unknown";

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

async function loadOrigins(): Promise<Record<string, TrustDecision>> {
  const raw = await Storage.getItemAsync(STORE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveOrigins(map: Record<string, TrustDecision>): Promise<void> {
  await Storage.setItemAsync(STORE_KEY, JSON.stringify(map));
}

function extractHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getTrustDecision(origin: string): Promise<TrustDecision> {
  const map = await loadOrigins();
  return map[extractHost(origin)] ?? "unknown";
}

export async function setTrustDecision(
  origin: string,
  decision: TrustDecision
): Promise<void> {
  const map = await loadOrigins();
  map[extractHost(origin)] = decision;
  await saveOrigins(map);
}

export async function getAllTrustedOrigins(): Promise<
  Array<{ host: string; decision: TrustDecision }>
> {
  const map = await loadOrigins();
  return Object.entries(map).map(([host, decision]) => ({ host, decision }));
}

export async function removeTrustEntry(origin: string): Promise<void> {
  const map = await loadOrigins();
  delete map[extractHost(origin)];
  await saveOrigins(map);
}
