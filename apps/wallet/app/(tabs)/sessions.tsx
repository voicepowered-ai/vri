/**
 * Sessions tab — historial de sesiones autorizadas
 */

import { useSessionsStore, type SessionRecord } from "../../store/sessions";
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const SCOPE_LABELS: Record<string, string> = {
  recording: "Grabación",
  generation: "Síntesis",
  export: "Exportación",
};

const STATUS_COLORS: Record<SessionRecord["status"], string> = {
  AUTHORIZED: "#00C853",
  CONSUMED: "#4FC3F7",
  EXPIRED: "#FF5252",
};

function SessionItem({ item }: { item: SessionRecord }) {
  const host = new URL(item.verifier_origin).host;
  const date = new Date(item.redeemed_at * 1000).toLocaleString("es");

  return (
    <View style={styles.item}>
      <View style={styles.itemHeader}>
        <Text style={styles.host}>{host}</Text>
        <Text style={[styles.status, { color: STATUS_COLORS[item.status] }]}>
          {item.status}
        </Text>
      </View>
      <Text style={styles.date}>{date}</Text>
      <View style={styles.scopes}>
        {item.session_scope.map((s) => (
          <Text key={s} style={styles.scope}>
            {SCOPE_LABELS[s] ?? s}
          </Text>
        ))}
      </View>
      <Text style={styles.sessionId}>
        {item.session_id.slice(0, 8)}…{item.session_id.slice(-4)}
      </Text>
    </View>
  );
}

export default function SessionsScreen() {
  const sessions = useSessionsStore((s) => s.sessions);
  const clearAll = useSessionsStore((s) => s.clear);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Sesiones autorizadas</Text>
        {sessions.length > 0 && (
          <TouchableOpacity onPress={clearAll}>
            <Text style={styles.clearBtn}>Borrar todo</Text>
          </TouchableOpacity>
        )}
      </View>

      {sessions.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            Aún no has autorizado ninguna sesión.{"\n"}
            Escanea un QR de VRI para comenzar.
          </Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(s) => s.session_id}
          renderItem={({ item }) => <SessionItem item={item} />}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A1F3D" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    paddingTop: 24,
  },
  title: { color: "#fff", fontSize: 18, fontWeight: "bold" },
  clearBtn: { color: "#FF5252", fontSize: 13 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyText: { color: "#8899aa", textAlign: "center", lineHeight: 22 },
  item: {
    backgroundColor: "#112244",
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
  },
  itemHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  host: { color: "#fff", fontWeight: "600", fontSize: 15 },
  status: { fontSize: 12, fontWeight: "bold" },
  date: { color: "#8899aa", fontSize: 12, marginBottom: 6 },
  scopes: { flexDirection: "row", gap: 6, marginBottom: 6 },
  scope: {
    color: "#00E5FF",
    fontSize: 11,
    backgroundColor: "#00E5FF22",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  sessionId: { color: "#556677", fontSize: 11, fontFamily: "monospace" },
});
