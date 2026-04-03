export function verifyRfc3161TimestampAttestation(attestation, context = {}) {
  const expectedDigest = context.expectedDigest ?? null;
  const trustedAuthorities = Array.isArray(context.trustedAuthorities)
    ? context.trustedAuthorities
      .map((entry) => normalizeTrustedAuthorityEntry(entry))
      .filter((entry) => entry !== null)
    : [];

  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return { ok: false, reason: "timestamp attestation must be a JSON object" };
  }

  if (attestation.type !== "RFC3161") {
    return { ok: false, reason: "timestamp attestation type must be RFC3161" };
  }

  if (attestation.message_imprint_alg !== "sha256") {
    return { ok: false, reason: "RFC3161 message_imprint_alg must be sha256" };
  }

  if (typeof attestation.message_imprint !== "string" || attestation.message_imprint.length === 0) {
    return { ok: false, reason: "RFC3161 message_imprint is required" };
  }

  if (expectedDigest && attestation.message_imprint.toLowerCase() !== expectedDigest.toLowerCase()) {
    return {
      ok: false,
      reason: "RFC3161 message_imprint does not match the expected receipt digest"
    };
  }

  if (!Number.isInteger(attestation.attested_at) || attestation.attested_at < 0) {
    return { ok: false, reason: "RFC3161 attested_at must be a non-negative integer" };
  }

  if (!Number.isInteger(attestation.gen_time) || attestation.gen_time < 0) {
    return { ok: false, reason: "RFC3161 gen_time must be a non-negative integer" };
  }

  if (attestation.gen_time !== attestation.attested_at) {
    return { ok: false, reason: "RFC3161 gen_time must equal attested_at in the normalized profile" };
  }

  if (typeof attestation.tsa !== "string" || attestation.tsa.length === 0) {
    return { ok: false, reason: "RFC3161 tsa is required" };
  }

  const matchingAuthority = trustedAuthorities.find((entry) => entry.tsa === attestation.tsa);

  if (trustedAuthorities.length > 0 && !matchingAuthority) {
    return { ok: false, reason: "RFC3161 tsa is not trusted by verifier policy" };
  }

  if (typeof attestation.serial_number !== "string" || attestation.serial_number.length === 0) {
    return { ok: false, reason: "RFC3161 serial_number is required" };
  }

  if (typeof attestation.policy_oid !== "string" || attestation.policy_oid.length === 0) {
    return { ok: false, reason: "RFC3161 policy_oid is required" };
  }

  if (
    matchingAuthority
    && Array.isArray(matchingAuthority.policy_oids)
    && matchingAuthority.policy_oids.length > 0
    && !matchingAuthority.policy_oids.includes(attestation.policy_oid)
  ) {
    return { ok: false, reason: "RFC3161 policy_oid is not trusted for this TSA" };
  }

  if (typeof attestation.token !== "string" || attestation.token.length === 0) {
    return { ok: false, reason: "RFC3161 token is required in the normalized profile" };
  }

  return {
    ok: true,
    details: {
      tsa: attestation.tsa,
      serial_number: attestation.serial_number,
      policy_oid: attestation.policy_oid,
      attested_at: attestation.attested_at
    }
  };
}

function normalizeTrustedAuthorityEntry(entry) {
  if (typeof entry === "string" && entry.length > 0) {
    return { tsa: entry };
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  if (typeof entry.tsa !== "string" || entry.tsa.length === 0) {
    return null;
  }

  return {
    tsa: entry.tsa,
    policy_oids: Array.isArray(entry.policy_oids)
      ? entry.policy_oids.filter((oid) => typeof oid === "string" && oid.length > 0)
      : null
  };
}

export function normalizeTimestampTokenInput(input) {
  if (typeof input === "string" && input.length > 0) {
    return { ok: true, token: input };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "timestamp token input must be a non-empty string or an object with encoding and data" };
  }

  if (typeof input.data !== "string" || input.data.length === 0) {
    return { ok: false, reason: "timestamp token input data is required" };
  }

  const encoding = input.encoding ?? "base64";

  if (encoding !== "base64" && encoding !== "hex" && encoding !== "utf8") {
    return { ok: false, reason: "timestamp token encoding must be one of: base64, hex, utf8" };
  }

  if (encoding === "base64") {
    try {
      const normalized = Buffer.from(input.data, "base64").toString("base64");
      if (normalized.length === 0) {
        return { ok: false, reason: "timestamp token base64 data is invalid" };
      }
    } catch {
      return { ok: false, reason: "timestamp token base64 data is invalid" };
    }
  }

  if (encoding === "hex" && !/^(?:0x)?[0-9a-f]+$/i.test(input.data)) {
    return { ok: false, reason: "timestamp token hex data is invalid" };
  }

  return {
    ok: true,
    token: input.data,
    encoding
  };
}

export function normalizeParsedRfc3161TokenResult(result) {
  if (result && typeof result === "object" && !Array.isArray(result) && "ok" in result) {
    if (result.ok !== true) {
      return {
        ok: false,
        reason: typeof result.reason === "string" && result.reason.length > 0
          ? result.reason
          : "RFC3161 token parser returned a failure result"
      };
    }

    if (!result.attestation || typeof result.attestation !== "object" || Array.isArray(result.attestation)) {
      return {
        ok: false,
        reason: "RFC3161 token parser success results must include an attestation object"
      };
    }

    return {
      ok: true,
      attestation: result.attestation
    };
  }

  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ok: true,
      attestation: result
    };
  }

  return {
    ok: false,
    reason: "RFC3161 token parser must return an attestation object or { ok, attestation }"
  };
}

export function normalizeRfc3161TimestampAttestation(input, context = {}) {
  const parseRfc3161Token = typeof context.parseRfc3161Token === "function"
    ? context.parseRfc3161Token
    : null;

  let normalized;

  if (typeof input === "string" || (input && typeof input === "object" && !Array.isArray(input) && "data" in input)) {
    if (!parseRfc3161Token) {
      return { ok: false, reason: "an RFC3161 token parser is required to normalize raw tokens" };
    }

    const tokenInput = normalizeTimestampTokenInput(input);

    if (!tokenInput.ok) {
      return tokenInput;
    }

    const parsed = parseRfc3161Token(tokenInput.token, {
      ...context,
      tokenEncoding: tokenInput.encoding ?? null
    });
    const normalizedParsed = normalizeParsedRfc3161TokenResult(parsed);

    if (!normalizedParsed.ok) {
      return normalizedParsed;
    }

    normalized = normalizedParsed.attestation;
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    normalized = input;
  } else {
    return { ok: false, reason: "timestamp attestation input must be a normalized object or raw token string" };
  }

  const verification = verifyRfc3161TimestampAttestation(normalized, context);

  if (!verification.ok) {
    return verification;
  }

  return {
    ok: true,
    attestation: normalized,
    details: verification.details
  };
}
