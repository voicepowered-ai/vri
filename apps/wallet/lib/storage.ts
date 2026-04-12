import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

export type StorageOptions = {
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
};

function getWebStorage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export async function getItemAsync(
  key: string,
  options?: StorageOptions
): Promise<string | null> {
  if (Platform.OS === "web") {
    return getWebStorage()?.getItem(key) ?? null;
  }

  return SecureStore.getItemAsync(key, options);
}

export async function setItemAsync(
  key: string,
  value: string,
  options?: StorageOptions
): Promise<void> {
  if (Platform.OS === "web") {
    getWebStorage()?.setItem(key, value);
    return;
  }

  await SecureStore.setItemAsync(key, value, options);
}

export async function deleteItemAsync(
  key: string,
  options?: StorageOptions
): Promise<void> {
  if (Platform.OS === "web") {
    getWebStorage()?.removeItem(key);
    return;
  }

  await SecureStore.deleteItemAsync(key, options);
}

export function canUseBiometricAuthentication(): boolean {
  if (Platform.OS === "web") return false;
  return SecureStore.canUseBiometricAuthentication();
}
