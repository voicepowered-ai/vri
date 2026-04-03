import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync as defaultExecFileSync } from "node:child_process";

function decodeTimestampToken(token, encoding = "base64") {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("RFC3161 token must be a non-empty string.");
  }

  if (encoding === "base64") {
    return Buffer.from(token, "base64");
  }

  if (encoding === "hex") {
    return Buffer.from(token.startsWith("0x") ? token.slice(2) : token, "hex");
  }

  if (encoding === "utf8") {
    return Buffer.from(token, "utf8");
  }

  throw new TypeError("Unsupported RFC3161 token encoding.");
}

function normalizeSerialNumber(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    return `0x${trimmed.slice(2).toLowerCase()}`;
  }

  return `0x${trimmed.toLowerCase()}`;
}

function normalizeTsaName(value) {
  const trimmed = value.trim();
  const commonNameMatch = trimmed.match(/(?:^|\/)CN=([^/]+)/i);

  if (commonNameMatch) {
    return commonNameMatch[1];
  }

  return trimmed;
}

export function buildOpenSslTimestampVerifyArgs(options = {}) {
  const args = [];

  if (openSslBoolean(options.tokenIn)) {
    args.push("-token_in");
  }

  if (typeof options.caFile === "string" && options.caFile.length > 0) {
    args.push("-CAfile", options.caFile);
  }

  if (typeof options.caPath === "string" && options.caPath.length > 0) {
    args.push("-CApath", options.caPath);
  }

  if (typeof options.caStore === "string" && options.caStore.length > 0) {
    args.push("-CAstore", options.caStore);
  }

  if (typeof options.untrustedFile === "string" && options.untrustedFile.length > 0) {
    args.push("-untrusted", options.untrustedFile);
  }

  if (typeof options.purpose === "string" && options.purpose.length > 0) {
    args.push("-purpose", options.purpose);
  }

  if (typeof options.verifyName === "string" && options.verifyName.length > 0) {
    args.push("-verify_name", options.verifyName);
  }

  if (Number.isInteger(options.verifyDepth) && options.verifyDepth >= 0) {
    args.push("-verify_depth", String(options.verifyDepth));
  }

  if (Number.isInteger(options.authLevel) && options.authLevel >= 0) {
    args.push("-auth_level", String(options.authLevel));
  }

  if (Number.isInteger(options.attime) && options.attime >= 0) {
    args.push("-attime", String(options.attime));
  }

  if (typeof options.policy === "string" && options.policy.length > 0) {
    args.push("-policy", options.policy);
  }

  if (openSslBoolean(options.crlCheck)) {
    args.push("-crl_check");
  }

  if (openSslBoolean(options.crlCheckAll)) {
    args.push("-crl_check_all");
  }

  if (openSslBoolean(options.policyCheck)) {
    args.push("-policy_check");
  }

  if (openSslBoolean(options.explicitPolicy)) {
    args.push("-explicit_policy");
  }

  if (openSslBoolean(options.inhibitAny)) {
    args.push("-inhibit_any");
  }

  if (openSslBoolean(options.inhibitMap)) {
    args.push("-inhibit_map");
  }

  if (openSslBoolean(options.x509Strict)) {
    args.push("-x509_strict");
  }

  if (openSslBoolean(options.useDeltas)) {
    args.push("-use_deltas");
  }

  if (openSslBoolean(options.extendedCrl)) {
    args.push("-extended_crl");
  }

  if (openSslBoolean(options.checkSsSig)) {
    args.push("-check_ss_sig");
  }

  if (openSslBoolean(options.partialChain)) {
    args.push("-partial_chain");
  }

  if (openSslBoolean(options.noCheckTime)) {
    args.push("-no_check_time");
  }

  if (Array.isArray(options.verifyArgs)) {
    args.push(...options.verifyArgs);
  }

  return args;
}

function openSslBoolean(value) {
  return value === true;
}

export function parseOpenSslTsReplyText(text, { token } = {}) {
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError("OpenSSL TS reply text must be a non-empty string.");
  }

  const lines = text.split(/\r?\n/);
  let policyOid = null;
  let serialNumber = null;
  let messageImprintAlg = null;
  let attestedAt = null;
  let genTime = null;
  let tsa = null;
  const messageBytes = [];
  let collectingMessageData = false;

  for (const line of lines) {
    if (/^\s*Policy OID:/i.test(line)) {
      policyOid = line.split(":").slice(1).join(":").trim();
      collectingMessageData = false;
      continue;
    }

    if (/^\s*Hash Algorithm:/i.test(line)) {
      messageImprintAlg = line.split(":").slice(1).join(":").trim().toLowerCase();
      collectingMessageData = false;
      continue;
    }

    if (/^\s*Serial number:/i.test(line)) {
      serialNumber = normalizeSerialNumber(line.split(":").slice(1).join(":"));
      collectingMessageData = false;
      continue;
    }

    if (/^\s*Time stamp:/i.test(line)) {
      const value = line.split(":").slice(1).join(":").trim();
      const parsed = Date.parse(value);

      if (!Number.isNaN(parsed)) {
        attestedAt = Math.floor(parsed / 1000);
        genTime = attestedAt;
      }

      collectingMessageData = false;
      continue;
    }

    if (/^\s*TSA:/i.test(line)) {
      tsa = normalizeTsaName(line.split(":").slice(1).join(":"));
      collectingMessageData = false;
      continue;
    }

    if (/^\s*Message data:/i.test(line)) {
      collectingMessageData = true;
      continue;
    }

    if (collectingMessageData) {
      const bytePairs = line.match(/\b[0-9a-fA-F]{2}\b/g);

      if (bytePairs && bytePairs.length > 0) {
        messageBytes.push(...bytePairs.map((entry) => entry.toLowerCase()));
        continue;
      }

      if (line.trim().length === 0) {
        continue;
      }

      collectingMessageData = false;
    }
  }

  if (!policyOid || !serialNumber || !messageImprintAlg || !attestedAt || !tsa || messageBytes.length === 0) {
    throw new Error("OpenSSL TS reply output is missing required RFC3161 fields.");
  }

  return {
    type: "RFC3161",
    tsa,
    policy_oid: policyOid,
    serial_number: serialNumber,
    message_imprint_alg: messageImprintAlg,
    message_imprint: `0x${messageBytes.join("")}`,
    attested_at: attestedAt,
    gen_time: genTime,
    token
  };
}

export function parseRfc3161TokenWithOpenSsl(token, context = {}) {
  const encoding = context.tokenEncoding ?? "base64";
  const expectedDigest = typeof context.expectedDigest === "string" ? context.expectedDigest : null;
  const openSslOptions = context.openSslOptions ?? {};
  const execFileSync = openSslOptions.execFileSync ?? defaultExecFileSync;
  const openSslBinary = openSslOptions.binaryPath ?? "openssl";
  const requireVerification = openSslOptions.skipVerify !== true;
  const hasTrustStore = Boolean(openSslOptions.caFile || openSslOptions.caPath || openSslOptions.caStore);

  if (requireVerification && !hasTrustStore) {
    return {
      ok: false,
      reason: "OpenSSL RFC3161 parsing requires caFile, caPath, or caStore unless skipVerify=true"
    };
  }

  if (requireVerification && (!expectedDigest || !/^0x[0-9a-f]+$/i.test(expectedDigest))) {
    return {
      ok: false,
      reason: "OpenSSL RFC3161 verification requires an expectedDigest hex string"
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vri-rfc3161-"));
  const tokenPath = path.join(tempDir, "token.tsr");

  try {
    fs.writeFileSync(tokenPath, decodeTimestampToken(token, encoding));

    const parseArgs = ["ts", "-reply", "-in", tokenPath, "-text"];

    if (openSslOptions.tokenIn === true) {
      parseArgs.splice(3, 0, "-token_in");
    }

    const replyText = execFileSync(openSslBinary, parseArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (requireVerification) {
      const verifyArgs = ["ts", "-verify", "-in", tokenPath, "-digest", expectedDigest.slice(2)];
      verifyArgs.push(...buildOpenSslTimestampVerifyArgs(openSslOptions));

      execFileSync(openSslBinary, verifyArgs, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    }

    const attestation = parseOpenSslTsReplyText(replyText, { token });

    return {
      ok: true,
      attestation
    };
  } catch (error) {
    return {
      ok: false,
      reason: `OpenSSL RFC3161 parsing failed: ${error.message}`
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
