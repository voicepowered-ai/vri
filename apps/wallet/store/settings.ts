/**
 * VRI Wallet — Settings store (Zustand)
 */

import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const STORE_KEY = "vri_settings_v1";

type Settings = {
  publicKeyHex: string | null;
  apiOverrideUrl: string | null; // override verifier_origin for dev/testing
};

type SettingsState = Settings & {
  loaded: boolean;
  load: () => Promise<void>;
  setPublicKey: (hex: string) => Promise<void>;
  setApiOverrideUrl: (url: string | null) => Promise<void>;
};

const defaults: Settings = {
  publicKeyHex: null,
  apiOverrideUrl: null,
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...defaults,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    const raw = await SecureStore.getItemAsync(STORE_KEY);
    const saved: Settings = raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
    set({ ...saved, loaded: true });
  },

  setPublicKey: async (hex) => {
    set({ publicKeyHex: hex });
    const current: Settings = { publicKeyHex: hex, apiOverrideUrl: get().apiOverrideUrl };
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(current));
  },

  setApiOverrideUrl: async (url) => {
    set({ apiOverrideUrl: url });
    const current: Settings = { publicKeyHex: get().publicKeyHex, apiOverrideUrl: url };
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(current));
  },
}));
