/**
 * Confirmation screen — shows challenge details before signing
 */

import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { type QRChallenge, redeemChallenge } from "../lib/identity";
import { getTrustDecision, setTrustDecision } from "../lib/trust";
import { useSessionsStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";

const SCOPE_LABELS: Record<string, string> = {
  recording: "Grabación",
  generation: "Síntesis / IA",
  export: "Exportación",
};

export default function ConfirmScreen() {
  const { challenge: challengeParam } = useLocalSearchParams<{ challenge: string }>();
  const challenge: QRChallenge = JSON.parse(challengeParam);

  const addSession = useSessionsStore((s) => s.add);
  const apiOverrideUrl = useSettingsStore((s) => s.apiOverrideUrl);

  const [loading, setLoading] = useState(false);
  const [trustStatus, setTrustStatus] = useState<string>("unknown");
  const [secondsLeft, setSecondsLeft] = useState(
    challenge.session_expires_at - Math.floor(Date.now() / 1000)
  );

  // Countdown timer
  useEffect(() => {
    const id = setInterval(() => {
      const left = challenge.session_expires_at - Math.floor(Date.now() / 1000);
      setSecondsLeft(left);
      if (left <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Check trust status on mount
  useEffect(() => {
    if (__DEV__) {
      console.log("[vri-wallet][confirm] mounted", {
        sessionId: challenge.session_id,
        verifierOrigin: challenge.verifier_origin,
        apiOverrideUrl: apiOverrideUrl ?? null
      });
    }
    getTrustDecision(challenge.verifier_origin).then(setTrustStatus);
  }, []);

  async function handleApprove() {
    if (secondsLeft <= 0) {
      Alert.alert("Expirado", "Este QR ya expiró. Pide uno nuevo.");
      return;
    }

    // If origin is unknown, ask user
    if (trustStatus === "unknown") {
      Alert.alert(
        "Origen nuevo",
        `¿Confiar en ${new URL(challenge.verifier_origin).host}?`,
        [
          {
            text: "Solo esta vez",
            onPress: () => doRedeem(),
          },
          {
            text: "Confiar siempre",
            onPress: async () => {
              await setTrustDecision(challenge.verifier_origin, "trusted");
              doRedeem();
            },
          },
          { text: "Cancelar", style: "cancel" },
        ]
      );
      return;
    }

    if (trustStatus === "blocked") {
      Alert.alert("Origen bloqueado", "Este origen está en tu lista de bloqueados.");
      return;
    }

    doRedeem();
  }

  async function doRedeem() {
    if (__DEV__) {
      console.log("[vri-wallet][confirm] doRedeem start", {
        sessionId: challenge.session_id,
        apiOverrideUrl: apiOverrideUrl ?? null,
        trustStatus
      });
    }
    setLoading(true);
    const result = await redeemChallenge(challenge, apiOverrideUrl ?? undefined);
    setLoading(false);
    if (__DEV__) {
      console.log("[vri-wallet][confirm] doRedeem result", {
        sessionId: challenge.session_id,
        ok: result.ok,
        error: result.ok ? null : result.error
      });
    }

    if (result.ok) {
      await addSession({
        session_id: result.sessionId,
        verifier_origin: challenge.verifier_origin,
        session_scope: challenge.session_scope,
        redeemed_at: result.redeemedAt,
        status: "AUTHORIZED",
      });

      router.replace({
        pathname: "/result",
        params: { success: "1", sessionId: result.sessionId },
      });
    } else {
      router.replace({
        pathname: "/result",
        params: { success: "0", error: result.error },
      });
    }
  }

  const host = new URL(challenge.verifier_origin).host;
  const trustedBadge =
    trustStatus === "trusted" ? "✓ Confiable" :
    trustStatus === "blocked" ? "✗ Bloqueado" : "Nuevo";
  const trustedColor =
    trustStatus === "trusted" ? "#00C853" :
    trustStatus === "blocked" ? "#FF5252" : "#FFA726";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Origin */}
      <View style={styles.card}>
        <Text style={styles.label}>Origen</Text>
        <Text style={styles.origin}>{host}</Text>
        <Text style={[styles.badge, { color: trustedColor }]}>{trustedBadge}</Text>
      </View>

      {/* Scope */}
      <View style={styles.card}>
        <Text style={styles.label}>Autoriza</Text>
        <View style={styles.scopes}>
          {challenge.session_scope.map((s) => (
            <View key={s} style={styles.scopeTag}>
              <Text style={styles.scopeText}>{SCOPE_LABELS[s] ?? s}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Expiry */}
      <View style={styles.card}>
        <Text style={styles.label}>Expira en</Text>
        <Text style={[styles.expiry, secondsLeft < 30 && styles.expirySoon]}>
          {secondsLeft > 0 ? `${secondsLeft}s` : "Expirado"}
        </Text>
      </View>

      {/* Session ID */}
      <View style={styles.card}>
        <Text style={styles.label}>ID de sesión</Text>
        <Text style={styles.sessionId}>
          {challenge.session_id.slice(0, 8)}…{challenge.session_id.slice(-4)}
        </Text>
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, styles.rejectButton]}
          onPress={() => router.back()}
          disabled={loading}
        >
          <Text style={styles.rejectText}>Rechazar</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.approveButton, loading && styles.buttonDisabled]}
          onPress={handleApprove}
          disabled={loading || secondsLeft <= 0}
        >
          {loading ? (
            <ActivityIndicator color="#0A1F3D" />
          ) : (
            <Text style={styles.approveText}>Autorizar</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    backgroundColor: "#0A1F3D",
    flexGrow: 1,
  },
  card: {
    backgroundColor: "#112244",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  label: {
    color: "#4FC3F7",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  },
  origin: { color: "#fff", fontSize: 18, fontWeight: "600" },
  badge: { fontSize: 12, marginTop: 4 },
  scopes: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  scopeTag: {
    backgroundColor: "#00E5FF22",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  scopeText: { color: "#00E5FF", fontSize: 13 },
  expiry: { color: "#fff", fontSize: 28, fontWeight: "bold" },
  expirySoon: { color: "#FF5252" },
  sessionId: { color: "#8899aa", fontFamily: "monospace", fontSize: 13 },
  actions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  rejectButton: { backgroundColor: "#1a2a3a" },
  approveButton: { backgroundColor: "#00E5FF" },
  buttonDisabled: { opacity: 0.5 },
  rejectText: { color: "#aaa", fontWeight: "600" },
  approveText: { color: "#0A1F3D", fontWeight: "bold", fontSize: 16 },
});
