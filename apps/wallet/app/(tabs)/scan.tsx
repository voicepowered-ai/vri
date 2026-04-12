/**
 * Scan tab — QR scanner principal
 */

import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useMemo, useRef, useState } from "react";
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { cancelIdentitySession, parseQRChallenge } from "../../lib/identity";
import { useSessionsStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [endingSession, setEndingSession] = useState(false);
  const processing = useRef(false);
  const sessions = useSessionsStore((s) => s.sessions);
  const updateStatus = useSessionsStore((s) => s.updateStatus);
  const apiOverrideUrl = useSettingsStore((s) => s.apiOverrideUrl);

  const activeSession = useMemo(
    () => sessions.find((session) => session.status === "AUTHORIZED") ?? null,
    [sessions]
  );

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>
          Se necesita acceso a la cámara para escanear QR de VRI.
        </Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Permitir cámara</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function handleBarcode({ data }: { data: string }) {
    if (processing.current) return;
    processing.current = true;
    setError(null);

    const result = parseQRChallenge(data);

    if (!result.ok) {
      setError(result.error);
      processing.current = false;
      return;
    }

    // Navigate to confirmation screen passing the challenge as serialized param
    router.push({
      pathname: "/confirm",
      params: { challenge: JSON.stringify(result.challenge) },
    });

    // Allow re-scan after returning from confirm
    setTimeout(() => { processing.current = false; }, 2000);
  }

  async function handleEndSession() {
    if (!activeSession || endingSession) {
      return;
    }

    setEndingSession(true);
    const result = await cancelIdentitySession(
      activeSession.session_id,
      activeSession.verifier_origin,
      apiOverrideUrl ?? undefined
    );
    setEndingSession(false);

    if (!result.ok) {
      Alert.alert("No se pudo terminar la sesión", result.error);
      return;
    }

    await updateStatus(activeSession.session_id, "CANCELED");
    Alert.alert("Sesión terminada", "La sesión activa se canceló correctamente.");
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={handleBarcode}
      />

      {/* Viewfinder overlay */}
      <View style={styles.overlay}>
        <View style={styles.finder} />
        <Text style={styles.hint}>Apunta al QR del estudio</Text>
      </View>

      {activeSession && (
        <View style={styles.sessionCard}>
          <Text style={styles.sessionTitle}>Sesión activa</Text>
          <Text style={styles.sessionHost}>{new URL(activeSession.verifier_origin).host}</Text>
          <Text style={styles.sessionMeta}>
            {activeSession.session_id.slice(0, 8)}…{activeSession.session_id.slice(-4)}
          </Text>
          <TouchableOpacity
            style={[styles.endButton, endingSession && styles.endButtonDisabled]}
            onPress={handleEndSession}
            disabled={endingSession}
          >
            <Text style={styles.endButtonText}>
              {endingSession ? "Terminando..." : "Terminar sesión"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
  },
  message: {
    color: "#fff",
    textAlign: "center",
    marginHorizontal: 32,
    marginBottom: 16,
  },
  button: {
    backgroundColor: "#00E5FF",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: { color: "#0A1F3D", fontWeight: "bold" },
  overlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  finder: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: "#00E5FF",
    borderRadius: 12,
    backgroundColor: "transparent",
  },
  hint: {
    color: "#fff",
    marginTop: 16,
    fontSize: 14,
    opacity: 0.8,
  },
  sessionCard: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 120,
    backgroundColor: "#0A1F3DEE",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#00E5FF33",
  },
  sessionTitle: {
    color: "#4FC3F7",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  },
  sessionHost: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "700",
  },
  sessionMeta: {
    color: "#A9B7C6",
    marginTop: 4,
    marginBottom: 12,
    fontFamily: "monospace",
    fontSize: 12,
  },
  endButton: {
    backgroundColor: "#FF7043",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  endButtonDisabled: {
    opacity: 0.7,
  },
  endButtonText: {
    color: "#fff",
    fontWeight: "700",
  },
  errorBanner: {
    position: "absolute",
    bottom: 48,
    left: 24,
    right: 24,
    backgroundColor: "#FF5252",
    borderRadius: 8,
    padding: 12,
  },
  errorText: { color: "#fff", textAlign: "center" },
});
