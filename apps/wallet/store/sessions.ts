/**
 * VRI Wallet — Session history store (Zustand)
 *
 * Keeps an in-memory list of redeemed sessions.
 * Persisted to expo-secure-store on every write.
 */

import { create } from "zustand";
import * as Storage from "../lib/storage";

const STORE_KEY = "vri_session_history_v1";
const MAX_SESSIONS = 50;

export type SessionRecord = {
  session_id: string;
  verifier_origin: string;
  session_scope: string[];
  redeemed_at: number; // Unix seconds
  status: "AUTHORIZED" | "CONSUMED" | "EXPIRED";
};

type SessionsState = {
  sessions: SessionRecord[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (record: SessionRecord) => Promise<void>;
  updateStatus: (sessionId: string, status: SessionRecord["status"]) => Promise<void>;
  clear: () => Promise<void>;
};

async function persist(sessions: SessionRecord[]): Promise<void> {
  await Storage.setItemAsync(STORE_KEY, JSON.stringify(sessions));
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    const raw = await Storage.getItemAsync(STORE_KEY);
    const sessions: SessionRecord[] = raw ? JSON.parse(raw) : [];
    set({ sessions, loaded: true });
  },

  add: async (record) => {
    const sessions = [record, ...get().sessions].slice(0, MAX_SESSIONS);
    set({ sessions });
    await persist(sessions);
  },

  updateStatus: async (sessionId, status) => {
    const sessions = get().sessions.map((s) =>
      s.session_id === sessionId ? { ...s, status } : s
    );
    set({ sessions });
    await persist(sessions);
  },

  clear: async () => {
    set({ sessions: [] });
    await Storage.deleteItemAsync(STORE_KEY);
  },
}));
