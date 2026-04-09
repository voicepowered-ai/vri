/**
 * Result screen — shows success or error after redeem attempt
 */

import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

export default function ResultScreen() {
  const { success, sessionId, error } =
    useLocalSearchParams<{ success: string; sessionId?: string; error?: string }>();

  const isSuccess = success === "1";

  // Auto-dismiss after 3s on success
  useEffect(() => {
    if (isSuccess) {
      const id = setTimeout(() => router.replace("/(tabs)/scan"), 3000);
      return () => clearTimeout(id);
    }
  }, [isSuccess]);

  return (
    <View style={styles.container}>
      <Text style={styles.icon}>{isSuccess ? "✓" : "✗"}</Text>

      <Text style={styles.title}>
        {isSuccess ? "Sesión autorizada" : "Autorización fallida"}
      </Text>

      {isSuccess && sessionId && (
        <Text style={styles.subtitle}>
          {sessionId.slice(0, 8)}…{sessionId.slice(-4)}
        </Text>
      )}

      {!isSuccess && error && (
        <Text style={styles.errorText}>{error}</Text>
      )}

      {isSuccess ? (
        <Text style={styles.hint}>Cerrando automáticamente…</Text>
      ) : (
        <TouchableOpacity
          style={styles.button}
          onPress={() => router.replace("/(tabs)/scan")}
        >
          <Text style={styles.buttonText}>Escanear de nuevo</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0A1F3D",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  icon: {
    fontSize: 64,
    color: "#00E5FF",
    marginBottom: 16,
  },
  title: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "bold",
    textAlign: "center",
  },
  subtitle: {
    color: "#8899aa",
    fontFamily: "monospace",
    marginTop: 8,
  },
  errorText: {
    color: "#FF5252",
    textAlign: "center",
    marginTop: 12,
    lineHeight: 20,
  },
  hint: {
    color: "#4FC3F7",
    marginTop: 24,
    opacity: 0.7,
  },
  button: {
    marginTop: 24,
    backgroundColor: "#00E5FF",
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 10,
  },
  buttonText: { color: "#0A1F3D", fontWeight: "bold" },
});
