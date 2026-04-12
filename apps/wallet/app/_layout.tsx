import { Stack } from "expo-router";
import { useEffect } from "react";
import { useSessionsStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { ensureKeyPair } from "../lib/crypto";

export default function RootLayout() {
  const loadSessions = useSessionsStore((s) => s.load);
  const loadSettings = useSettingsStore((s) => s.load);
  const setPublicKey = useSettingsStore((s) => s.setPublicKey);

  useEffect(() => {
    async function init() {
      try {
        if (__DEV__) {
          console.log("[vri-wallet][boot] init start");
        }
        await loadSessions();
        await loadSettings();
        if (__DEV__) {
          console.log("[vri-wallet][boot] stores loaded");
        }
        // Ensure key pair exists on first launch
        const { publicKeyHex } = await ensureKeyPair();
        await setPublicKey(publicKeyHex);
        if (__DEV__) {
          console.log("[vri-wallet][boot] key pair ready", { publicKeyHex });
        }
      } catch (error) {
        if (__DEV__) {
          console.log("[vri-wallet][boot] init failed", {
            message: error instanceof Error ? error.message : String(error ?? "")
          });
        }
      }
    }
    init();
  }, []);

  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="confirm"
        options={{ title: "Confirmar sesión", presentation: "modal" }}
      />
      <Stack.Screen
        name="result"
        options={{ title: "Resultado", presentation: "modal" }}
      />
    </Stack>
  );
}
