/**
 * Scan tab — QR scanner principal
 */

import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { parseQRChallenge } from "../../lib/identity";

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const processing = useRef(false);

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
