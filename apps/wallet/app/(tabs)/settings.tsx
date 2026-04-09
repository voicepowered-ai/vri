/**
 * Settings tab — public key display, trusted origins, API override
 */

import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { getAllTrustedOrigins, removeTrustEntry, setTrustDecision, type TrustDecision } from "../../lib/trust";
import { useSettingsStore } from "../../store/settings";

function TrustRow({
  host,
  decision,
  onRemove,
  onToggleBlock,
}: {
  host: string;
  decision: TrustDecision;
  onRemove: () => void;
  onToggleBlock: () => void;
}) {
  const color = decision === "trusted" ? "#00C853" : "#FF5252";
  const label = decision === "trusted" ? "Confiable" : "Bloqueado";

  return (
    <View style={styles.trustRow}>
      <View style={styles.trustInfo}>
        <Text style={styles.trustHost}>{host}</Text>
        <Text style={[styles.trustStatus, { color }]}>{label}</Text>
      </View>
      <View style={styles.trustActions}>
        <TouchableOpacity style={styles.iconBtn} onPress={onToggleBlock}>
          <Text style={styles.iconBtnText}>
            {decision === "trusted" ? "Bloquear" : "Confiar"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.iconBtn, styles.removeBtn]} onPress={onRemove}>
          <Text style={[styles.iconBtnText, { color: "#FF5252" }]}>Borrar</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const publicKeyHex = useSettingsStore((s) => s.publicKeyHex);
  const apiOverrideUrl = useSettingsStore((s) => s.apiOverrideUrl);
  const setApiOverrideUrl = useSettingsStore((s) => s.setApiOverrideUrl);

  const [origins, setOrigins] = useState<Array<{ host: string; decision: TrustDecision }>>([]);
  const [urlDraft, setUrlDraft] = useState(apiOverrideUrl ?? "");

  // Reload trust list every time the tab gains focus
  useFocusEffect(
    useCallback(() => {
      getAllTrustedOrigins().then(setOrigins);
    }, [])
  );

  async function handleRemove(host: string) {
    await removeTrustEntry(host);
    setOrigins((prev) => prev.filter((o) => o.host !== host));
  }

  async function handleToggleBlock(host: string, current: TrustDecision) {
    const next: TrustDecision = current === "trusted" ? "blocked" : "trusted";
    await setTrustDecision(host, next);
    setOrigins((prev) =>
      prev.map((o) => (o.host === host ? { ...o, decision: next } : o))
    );
  }

  function handleSaveUrl() {
    const trimmed = urlDraft.trim();
    if (trimmed && !trimmed.startsWith("http")) {
      Alert.alert("URL inválida", "Debe comenzar con http:// o https://");
      return;
    }
    setApiOverrideUrl(trimmed || null);
    Alert.alert("Guardado", trimmed ? `URL API: ${trimmed}` : "URL API restaurada por defecto");
  }

  const shortKey = publicKeyHex
    ? `${publicKeyHex.slice(0, 12)}…${publicKeyHex.slice(-8)}`
    : "No disponible";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Public key */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Clave pública</Text>
        <View style={styles.keyCard}>
          <Text style={styles.keyText} selectable>{shortKey}</Text>
          {publicKeyHex && (
            <Text style={styles.keyFull} selectable numberOfLines={2}>
              {publicKeyHex}
            </Text>
          )}
        </View>
      </View>

      {/* Trusted origins */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Orígenes de confianza</Text>
        {origins.length === 0 ? (
          <Text style={styles.emptyText}>Ninguno guardado aún.</Text>
        ) : (
          origins.map(({ host, decision }) => (
            <TrustRow
              key={host}
              host={host}
              decision={decision}
              onRemove={() => handleRemove(host)}
              onToggleBlock={() => handleToggleBlock(host, decision)}
            />
          ))
        )}
      </View>

      {/* API override (dev only) */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>URL API (desarrollo)</Text>
        <Text style={styles.sectionHint}>
          Anula la URL base del verificador para pruebas locales.
        </Text>
        <TextInput
          style={styles.input}
          value={urlDraft}
          onChangeText={setUrlDraft}
          placeholder="http://localhost:8787"
          placeholderTextColor="#445566"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TouchableOpacity style={styles.saveBtn} onPress={handleSaveUrl}>
          <Text style={styles.saveBtnText}>Guardar URL</Text>
        </TouchableOpacity>
        {apiOverrideUrl && (
          <TouchableOpacity
            style={[styles.saveBtn, styles.clearBtn]}
            onPress={() => {
              setUrlDraft("");
              setApiOverrideUrl(null);
            }}
          >
            <Text style={[styles.saveBtnText, { color: "#FF5252" }]}>
              Restablecer por defecto
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A1F3D" },
  content: { padding: 16, paddingBottom: 48 },
  section: { marginBottom: 28 },
  sectionTitle: {
    color: "#4FC3F7",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 10,
  },
  sectionHint: { color: "#556677", fontSize: 12, marginBottom: 8 },
  keyCard: {
    backgroundColor: "#112244",
    borderRadius: 12,
    padding: 14,
  },
  keyText: {
    color: "#00E5FF",
    fontFamily: "monospace",
    fontSize: 14,
    marginBottom: 6,
  },
  keyFull: {
    color: "#445566",
    fontFamily: "monospace",
    fontSize: 10,
    lineHeight: 15,
  },
  emptyText: { color: "#556677", fontSize: 13, fontStyle: "italic" },
  trustRow: {
    backgroundColor: "#112244",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  trustInfo: { flex: 1 },
  trustHost: { color: "#fff", fontSize: 14, fontWeight: "500" },
  trustStatus: { fontSize: 11, marginTop: 2 },
  trustActions: { flexDirection: "row", gap: 8 },
  iconBtn: {
    backgroundColor: "#1a2a3a",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  removeBtn: { borderWidth: 1, borderColor: "#FF525230" },
  iconBtnText: { color: "#aaa", fontSize: 12 },
  input: {
    backgroundColor: "#112244",
    borderRadius: 10,
    padding: 12,
    color: "#fff",
    fontFamily: "monospace",
    fontSize: 13,
    marginBottom: 10,
  },
  saveBtn: {
    backgroundColor: "#00E5FF",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: 8,
  },
  clearBtn: { backgroundColor: "#1a2a3a" },
  saveBtnText: { color: "#0A1F3D", fontWeight: "bold" },
});
