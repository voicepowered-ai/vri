/**
 * Mock for react-native-keychain — in-memory store for unit tests.
 */

const store: Record<string, string> = {};

export const ACCESS_CONTROL = {
  BIOMETRY_ANY_OR_DEVICE_PASSCODE: "BIOMETRY_ANY_OR_DEVICE_PASSCODE",
};

export const ACCESSIBLE = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
};

export async function setGenericPassword(
  username: string,
  password: string,
  options?: { service?: string }
): Promise<true> {
  const key = options?.service ?? "default";
  store[key] = password;
  return true;
}

export async function getGenericPassword(
  options?: { service?: string }
): Promise<{ username: string; password: string } | false> {
  const key = options?.service ?? "default";
  if (store[key] === undefined) return false;
  return { username: "vri", password: store[key] };
}

export async function resetGenericPassword(
  options?: { service?: string }
): Promise<boolean> {
  const key = options?.service ?? "default";
  delete store[key];
  return true;
}
