/**
 * Mock for expo-secure-store — in-memory store for unit tests.
 */

const store: Record<string, string> = {};

export async function getItemAsync(key: string): Promise<string | null> {
  return store[key] ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store[key] = value;
}

export async function deleteItemAsync(key: string): Promise<void> {
  delete store[key];
}

export function canUseBiometricAuthentication(): boolean {
  return true;
}

export function clear(): void {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
}
