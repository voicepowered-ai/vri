import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import "./App.css";
import {
  createIdentityChallenge,
  getIdentitySession,
  type IdentityChallengeResponse,
  type IdentitySession,
} from "./lib/api";

type RecorderState = "idle" | "ready" | "recording" | "finished";

const DEFAULT_API_BASE = "http://localhost:8787";
const DEFAULT_VERIFIER_ORIGIN = "https://studio.vri.example";
const POLL_INTERVAL_MS = 2000;

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return "0x" + Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getBestAudioMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "";
}

function getFileExtension(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function getAutoApiBaseUrl(): string {
  if (typeof window === "undefined") {
    return DEFAULT_API_BASE;
  }

  const hostname = window.location.hostname;

  if (!hostname) {
    return DEFAULT_API_BASE;
  }

  return `http://${hostname}:8787`;
}

function getAutoVerifierOrigin(): string {
  if (typeof window === "undefined") {
    return DEFAULT_VERIFIER_ORIGIN;
  }

  const hostname = window.location.hostname;

  if (!hostname) {
    return DEFAULT_VERIFIER_ORIGIN;
  }

  return `https://${hostname}`;
}

export default function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(getAutoApiBaseUrl);
  const [verifierOrigin, setVerifierOrigin] = useState(getAutoVerifierOrigin);
  const [ttlSeconds, setTtlSeconds] = useState("300");
  const [challengeState, setChallengeState] = useState<IdentityChallengeResponse | null>(null);
  const [sessionState, setSessionState] = useState<IdentitySession | null>(null);
  const [recorderState, setRecorderState] = useState<RecorderState>("idle");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioMimeType, setAudioMimeType] = useState("audio/webm");
  const [error, setError] = useState<string | null>(null);
  const [loadingChallenge, setLoadingChallenge] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const challenge = challengeState?.challenge ?? null;
  const sessionId = challenge?.session_id ?? null;

  const statusLabel = sessionState?.status ?? challengeState?.status ?? "IDLE";
  const downloadName = useMemo(() => {
    const suffix = sessionId ? sessionId.slice(0, 8) : "capture";
    return `vri-recording-${suffix}.${getFileExtension(audioMimeType)}`;
  }, [audioMimeType, sessionId]);

  useEffect(() => {
    if (recorderState !== "recording") return;
    const id = window.setInterval(() => {
      setRecordingSeconds((seconds) => seconds + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [recorderState]);

  useEffect(() => {
    if (!sessionId) return;
    if (sessionState?.status === "AUTHORIZED") return;
    if (
      sessionState?.status === "CONSUMED"
      || sessionState?.status === "EXPIRED"
      || sessionState?.status === "CANCELED"
    ) return;

    let active = true;
    const currentSessionId = sessionId;

    async function poll() {
      try {
        const session = await getIdentitySession(apiBaseUrl.trim(), currentSessionId);
        if (!active) return;
        setSessionState(session);

        if (session.status === "AUTHORIZED" && recorderState === "idle") {
          setRecorderState("ready");
        }

        if (session.status === "EXPIRED" && recorderState === "idle") {
          setError("La sesión QR expiró antes de autorizarse. Genera una nueva.");
        }

        if (session.status === "CANCELED" && recorderState === "idle") {
          setError("La sesión fue cancelada desde el wallet. Genera una nueva.");
        }
      } catch (pollError) {
        if (!active) return;
        setError(pollError instanceof Error ? pollError.message : "No se pudo consultar la sesión.");
      }
    }

    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [apiBaseUrl, recorderState, sessionId, sessionState?.status]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [audioUrl]);

  async function handleCreateChallenge() {
    setLoadingChallenge(true);
    setError(null);
    setSessionState(null);
    setRecorderState("idle");
    setRecordingSeconds(0);

    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }

    const ttl = Number(ttlSeconds);
    if (!Number.isFinite(ttl) || ttl <= 0) {
      setLoadingChallenge(false);
      setError("TTL inválido. Usa un número entero de segundos.");
      return;
    }

    try {
      const response = await createIdentityChallenge(apiBaseUrl.trim(), {
        verifierOrigin: verifierOrigin.trim(),
        sessionScope: ["recording"],
        sessionPublicKey: randomHex(32),
        ttlSeconds: ttl,
      });

      setChallengeState(response);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "No se pudo crear el challenge.");
    } finally {
      setLoadingChallenge(false);
    }
  }

  async function handleStartRecording() {
    setError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Este navegador no soporta acceso al micrófono.");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setError("Este navegador no soporta MediaRecorder.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getBestAudioMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      setAudioMimeType(recorder.mimeType || "audio/webm");

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const nextMimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: nextMimeType });
        const nextUrl = URL.createObjectURL(blob);

        setAudioMimeType(nextMimeType);
        setRecorderState("finished");
        setAudioUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return nextUrl;
        });

        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
      };

      setRecordingSeconds(0);
      setRecorderState("recording");
      recorder.start(1000);
    } catch (recordError) {
      setError(recordError instanceof Error ? recordError.message : "No se pudo iniciar la grabación.");
    }
  }

  function handleStopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  }

  function handleReset() {
    setChallengeState(null);
    setSessionState(null);
    setRecorderState("idle");
    setRecordingSeconds(0);
    setError(null);

    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }

    mediaRecorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    chunksRef.current = [];
  }

  return (
    <main className="shell">
      <section className="hero-card">
        <p className="eyebrow">VRI Recorder Driver</p>
        <h1>Autoriza por QR, graba en web y descarga el audio.</h1>
        <p className="hero-copy">
          Esta app web actúa como driver de sesión. Abre un challenge VRI, espera la
          autorización del wallet y solo entonces habilita la captura desde el navegador.
        </p>
      </section>

      <section className="grid">
        <div className="panel panel-form">
          <div className="panel-head">
            <h2>Sesión</h2>
            <span className={`status-pill status-${statusLabel.toLowerCase()}`}>{statusLabel}</span>
          </div>

          <label className="field">
            <span>API base URL</span>
            <input
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
              placeholder="http://localhost:8787"
            />
          </label>

          <label className="field">
            <span>Verifier origin</span>
            <input
              value={verifierOrigin}
              onChange={(event) => setVerifierOrigin(event.target.value)}
              placeholder="https://studio.vri.example"
            />
          </label>

          <label className="field field-small">
            <span>TTL</span>
            <input
              value={ttlSeconds}
              onChange={(event) => setTtlSeconds(event.target.value)}
              inputMode="numeric"
            />
          </label>

          <div className="actions">
            <button className="primary" onClick={handleCreateChallenge} disabled={loadingChallenge}>
              {loadingChallenge ? "Creando..." : "Crear sesión QR"}
            </button>
            <button className="ghost" onClick={handleReset}>
              Reiniciar
            </button>
          </div>

          <div className="session-meta">
            <div>
              <span className="meta-label">Scope</span>
              <strong>recording</strong>
            </div>
            <div>
              <span className="meta-label">Session ID</span>
              <strong>{sessionId ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : "pendiente"}</strong>
            </div>
          </div>

          <p className="hint">
            Esta pantalla detecta automáticamente el host actual y propone la API en
            `:8787`. El `verifierOrigin` usa ese mismo host sobre HTTPS para el flujo QR.
            En local, el wallet puede apuntar al backend real mediante su API override.
          </p>

          {error && <p className="error-box">{error}</p>}
        </div>

        <div className="panel panel-qr">
          <div className="panel-head">
            <h2>QR</h2>
            <span className="muted">Escanéalo con Wallet</span>
          </div>

          {challenge ? (
            <>
              <div className="qr-frame">
                <QRCodeSVG
                  value={JSON.stringify(challenge)}
                  size={280}
                  marginSize={2}
                  bgColor="#f7f1e8"
                  fgColor="#0f2d2a"
                />
              </div>
              <p className="qr-caption">
                Cuando el wallet cambie la sesión a <strong>AUTHORIZED</strong>, la grabación se
                habilita sola.
              </p>
            </>
          ) : (
            <div className="empty-state">
              <p>Genera una sesión para renderizar el challenge QR.</p>
            </div>
          )}
        </div>
      </section>

      <section className="panel panel-recorder">
        <div className="panel-head">
          <h2>Recorder</h2>
          <span className="timer">{formatClock(recordingSeconds)}</span>
        </div>

        <div className="recorder-stage">
          <div className={`stage stage-${recorderState}`}>
            {recorderState === "idle" && "Esperando autorización del wallet"}
            {recorderState === "ready" && "Sesión autorizada. Ya puedes grabar"}
            {recorderState === "recording" && "Grabando desde el micrófono del navegador"}
            {recorderState === "finished" && "Audio listo para escuchar o descargar"}
          </div>

          <div className="actions">
            <button
              className="primary"
              onClick={handleStartRecording}
              disabled={recorderState !== "ready"}
            >
              Empezar grabación
            </button>
            <button
              className="danger"
              onClick={handleStopRecording}
              disabled={recorderState !== "recording"}
            >
              Detener
            </button>
            <a
              className={`download ${audioUrl ? "download-active" : ""}`}
              href={audioUrl ?? "#"}
              download={downloadName}
              aria-disabled={!audioUrl}
              onClick={(event) => {
                if (!audioUrl) event.preventDefault();
              }}
            >
              Descargar audio
            </a>
          </div>

          {audioUrl && (
            <div className="playback">
              <audio controls src={audioUrl} />
              <p className="hint">
                Se guarda como <code>{downloadName}</code>.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
