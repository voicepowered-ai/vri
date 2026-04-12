export type SessionScope = "recording" | "generation" | "export";

export type IdentityChallenge = {
  auth_method: "QR_SECURE_ENCLAVE";
  verifier_origin: string;
  session_id: string;
  nonce: string;
  session_scope: SessionScope[];
  session_expires_at: number;
  session_public_key: string;
};

export type IdentityChallengeResponse = {
  challenge: IdentityChallenge;
  qr_payload: IdentityChallenge;
  status: "PENDING";
};

export type IdentitySession = {
  session_id: string;
  verifier_origin: string;
  session_public_key: string;
  session_scope: SessionScope[];
  status: "PENDING" | "AUTHORIZED" | "CONSUMED" | "EXPIRED" | "CANCELED";
  created_at: number;
  session_expires_at: number;
  redeemed_at: number | null;
  identity: unknown | null;
};

type CreateChallengeInput = {
  verifierOrigin: string;
  sessionScope: SessionScope[];
  sessionPublicKey: string;
  ttlSeconds: number;
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}

function normalizeBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, "");
}

export async function createIdentityChallenge(
  apiBaseUrl: string,
  input: CreateChallengeInput
): Promise<IdentityChallengeResponse> {
  const response = await fetch(`${normalizeBaseUrl(apiBaseUrl)}/identity/challenges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  return readJson<IdentityChallengeResponse>(response);
}

export async function getIdentitySession(
  apiBaseUrl: string,
  sessionId: string
): Promise<IdentitySession> {
  const response = await fetch(
    `${normalizeBaseUrl(apiBaseUrl)}/identity/sessions/${encodeURIComponent(sessionId)}`
  );
  return readJson<IdentitySession>(response);
}
