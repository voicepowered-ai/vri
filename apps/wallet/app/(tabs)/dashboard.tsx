import { router } from "expo-router";
import { useMemo, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { cancelIdentitySession } from "../../lib/identity";
import { useSessionsStore, type SessionRecord } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";

const STATUS_COLORS: Record<SessionRecord["status"], string> = {
  AUTHORIZED: "#00C853",
  CONSUMED: "#4FC3F7",
  EXPIRED: "#FF5252",
  CANCELED: "#FFA726",
};

const STATUS_LABELS: Record<SessionRecord["status"], string> = {
  AUTHORIZED: "En curso",
  CONSUMED: "Consumida",
  EXPIRED: "Expirada",
  CANCELED: "Cancelada",
};

type DashboardNotice = {
  tone: "success" | "info" | "error";
  title: string;
  body: string;
};

function ActionButton({
  title,
  subtitle,
  onPress,
}: {
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.actionCard} onPress={onPress}>
      <Text style={styles.actionTitle}>{title}</Text>
      <Text style={styles.actionSubtitle}>{subtitle}</Text>
    </TouchableOpacity>
  );
}

export default function DashboardScreen() {
  const sessions = useSessionsStore((s) => s.sessions);
  const updateStatus = useSessionsStore((s) => s.updateStatus);
  const apiOverrideUrl = useSettingsStore((s) => s.apiOverrideUrl);
  const [endingSession, setEndingSession] = useState(false);
  const [notice, setNotice] = useState<DashboardNotice | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.status === "AUTHORIZED") ?? null,
    [sessions]
  );
  const recentSessions = useMemo(
    () => sessions.slice(0, 3),
    [sessions]
  );

  async function handleEndSession() {
    if (!activeSession || endingSession) {
      return;
    }

    setNotice(null);
    setEndingSession(true);
    const result = await cancelIdentitySession(
      activeSession.session_id,
      activeSession.verifier_origin,
      apiOverrideUrl ?? undefined
    );
    setEndingSession(false);

    if (!result.ok) {
      if (
        result.code === "identity_session_already_canceled"
        || result.code === "identity_session_not_found"
      ) {
        await updateStatus(activeSession.session_id, "CANCELED");
        setNotice({
          tone: "info",
          title: "La sesión ya estaba cerrada",
          body: "El wallet la ha marcado como terminada para que el panel quede sincronizado."
        });
        return;
      }

      setNotice({
        tone: "error",
        title: "No se pudo terminar la sesión",
        body: result.error
      });
      Alert.alert("No se pudo terminar la sesión", result.error);
      return;
    }

    await updateStatus(activeSession.session_id, "CANCELED");
    setNotice({
      tone: "success",
      title: "Sesión terminada",
      body: "La autorización activa se canceló correctamente y ya no queda ninguna sesión en curso."
    });
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>VRI Wallet</Text>
        <Text style={styles.title}>Panel de control</Text>
        <Text style={styles.copy}>
          Desde aquí puedes iniciar una autorización nueva, revisar el estado actual
          del wallet y gestionar la sesión que esté en curso.
        </Text>
      </View>

      {notice ? (
        <View style={[styles.noticeCard, styles[`${notice.tone}Notice`]]}>
          <Text style={styles.noticeTitle}>{notice.title}</Text>
          <Text style={styles.noticeBody}>{notice.body}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Acciones</Text>
        <View style={styles.actionsGrid}>
          <ActionButton
            title="Escanear QR"
            subtitle="Inicia una autorización nueva desde la cámara."
            onPress={() => router.push("/(tabs)/scan")}
          />
          <ActionButton
            title="Ver historial"
            subtitle="Consulta sesiones previas y su estado."
            onPress={() => router.push("/(tabs)/sessions")}
          />
          <ActionButton
            title="Ajustes"
            subtitle="Configura la API y los orígenes de confianza."
            onPress={() => router.push("/(tabs)/settings")}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>En curso</Text>
        {activeSession ? (
          <View style={styles.currentCard}>
            <View style={styles.currentHeader}>
              <View>
                <Text style={styles.currentHost}>{new URL(activeSession.verifier_origin).host}</Text>
                <Text style={styles.currentStatus}>
                  {STATUS_LABELS[activeSession.status]}
                </Text>
              </View>
              <Text style={[styles.statusPill, { color: STATUS_COLORS[activeSession.status] }]}>
                {activeSession.status}
              </Text>
            </View>
            <Text style={styles.currentMeta}>
              ID: {activeSession.session_id.slice(0, 8)}…{activeSession.session_id.slice(-4)}
            </Text>
            <Text style={styles.currentMeta}>
              Autorizada el {new Date(activeSession.redeemed_at * 1000).toLocaleString("es")}
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
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No hay sesiones activas</Text>
            <Text style={styles.emptyCopy}>
              Escanea un QR cuando quieras autorizar una sesión nueva.
            </Text>
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Actividad reciente</Text>
        {recentSessions.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Todavía no hay actividad</Text>
            <Text style={styles.emptyCopy}>
              Cuando autorices sesiones aparecerán aquí con su estado.
            </Text>
          </View>
        ) : (
          recentSessions.map((session) => (
            <View key={session.session_id} style={styles.recentItem}>
              <View>
                <Text style={styles.recentHost}>{new URL(session.verifier_origin).host}</Text>
                <Text style={styles.recentDate}>
                  {new Date(session.redeemed_at * 1000).toLocaleString("es")}
                </Text>
              </View>
              <Text style={[styles.recentStatus, { color: STATUS_COLORS[session.status] }]}>
                {STATUS_LABELS[session.status]}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A1F3D" },
  content: { padding: 16, paddingBottom: 48 },
  hero: {
    backgroundColor: "#112244",
    borderRadius: 18,
    padding: 18,
    marginBottom: 24,
  },
  eyebrow: {
    color: "#4FC3F7",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  },
  title: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 8,
  },
  copy: {
    color: "#A9B7C6",
    lineHeight: 22,
  },
  section: { marginBottom: 24 },
  noticeCard: {
    borderRadius: 14,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
  },
  successNotice: {
    backgroundColor: "#123629",
    borderColor: "#1F8F5F",
  },
  infoNotice: {
    backgroundColor: "#122B3A",
    borderColor: "#2D7BAA",
  },
  errorNotice: {
    backgroundColor: "#3A1F1F",
    borderColor: "#B64B4B",
  },
  noticeTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 4,
  },
  noticeBody: {
    color: "#D6E2EE",
    lineHeight: 20,
  },
  sectionTitle: {
    color: "#4FC3F7",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 10,
  },
  actionsGrid: {
    gap: 12,
  },
  actionCard: {
    backgroundColor: "#112244",
    borderRadius: 14,
    padding: 16,
  },
  actionTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 4,
  },
  actionSubtitle: {
    color: "#A9B7C6",
    lineHeight: 20,
  },
  currentCard: {
    backgroundColor: "#112244",
    borderRadius: 14,
    padding: 16,
  },
  currentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10,
  },
  currentHost: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
  currentStatus: {
    color: "#A9B7C6",
    marginTop: 2,
  },
  statusPill: {
    fontSize: 12,
    fontWeight: "700",
  },
  currentMeta: {
    color: "#A9B7C6",
    marginBottom: 6,
    fontFamily: "monospace",
    fontSize: 12,
  },
  endButton: {
    marginTop: 12,
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
  emptyCard: {
    backgroundColor: "#112244",
    borderRadius: 14,
    padding: 16,
  },
  emptyTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 4,
  },
  emptyCopy: {
    color: "#A9B7C6",
    lineHeight: 20,
  },
  recentItem: {
    backgroundColor: "#112244",
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  recentHost: {
    color: "#fff",
    fontWeight: "700",
    marginBottom: 2,
  },
  recentDate: {
    color: "#A9B7C6",
    fontSize: 12,
  },
  recentStatus: {
    fontWeight: "700",
  },
});
