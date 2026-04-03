import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  buildTimestampAttestationReceipt,
  canonicalizeWavTo24BitLE,
  createIdentityAssertion,
  createSessionChallenge,
  createNonceReplayTracker,
  getCanonicalMetadataString,
  getTimestampAttestationReceiptDigest,
  sha256Hex,
  registerVoice,
  verifyIdentityAssertion,
  verifyProofPackage
} from "../src/index.js";
import { canonicalizeWavTo24BitLEAsync } from "../src/index.js";
import { createDspPool } from "../src/dsp-pool.js";
import {
  KeyManager,
  createKeyManager,
  createKmsKeyManager
} from "../src/key-manager.js";
import { createRevocationRegistry } from "../src/revocation-registry.js";
import {
  normalizeParsedRfc3161TokenResult,
  normalizeTimestampTokenInput,
  normalizeRfc3161TimestampAttestation,
  verifyRfc3161TimestampAttestation
} from "../src/timestamp-attestation.js";
import {
  buildOpenSslTimestampVerifyArgs,
  parseOpenSslTsReplyText,
  parseRfc3161TokenWithOpenSsl
} from "../src/openssl-rfc3161.js";

function createPcmWav({ sampleRate = 48000, channels = 1, audioFormat = 1, bitsPerSample = 16, samples }) {
  const effectiveBitsPerSample = audioFormat === 3 ? 32 : bitsPerSample;
  const bytesPerSample = effectiveBitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const data = Buffer.alloc(samples.length * bytesPerSample);

  for (let index = 0; index < samples.length; index += 1) {
    const offset = index * bytesPerSample;
    const sample = samples[index];

    if (bitsPerSample === 16) {
      data.writeInt16LE(sample, offset);
    } else if (bitsPerSample === 24) {
      const normalized = sample < 0 ? sample + 0x1000000 : sample;
      data[offset] = normalized & 0xff;
      data[offset + 1] = (normalized >> 8) & 0xff;
      data[offset + 2] = (normalized >> 16) & 0xff;
    } else if (audioFormat === 3 && effectiveBitsPerSample === 32) {
      data.writeFloatLE(sample, offset);
    } else {
      throw new Error("Unsupported test audio format.");
    }
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(effectiveBitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

async function createRealOpenSslTimestampFixture(expectedDigestHex) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-openssl-tsa-"));
  const configPath = path.join(tempDir, "openssl.cnf");
  const keyPath = path.join(tempDir, "tsa-key.pem");
  const certPath = path.join(tempDir, "tsa-cert.pem");
  const serialPath = path.join(tempDir, "tsaserial");
  const queryPath = path.join(tempDir, "request.tsq");
  const responsePath = path.join(tempDir, "response.tsr");
  const config = `[ req ]
distinguished_name = dn
x509_extensions = v3_tsa
prompt = no
[ dn ]
CN = Test TSA
[ v3_tsa ]
basicConstraints = critical,CA:FALSE
keyUsage = critical, digitalSignature, nonRepudiation
extendedKeyUsage = critical, timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
[ tsa ]
default_tsa = tsa_config
[ tsa_config ]
serial = ${serialPath}
crypto_device = builtin
signer_cert = ${certPath}
certs = ${certPath}
signer_key = ${keyPath}
signer_digest = sha256
default_policy = 1.2.3.4.5
other_policies = 1.2.3.4.5
digests = sha256
accuracy = secs:1
ordering = yes
tsa_name = yes
ess_cert_id_chain = no
`;

  await writeFile(configPath, config, "utf8");
  await writeFile(serialPath, "01\n", "utf8");

  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey", "rsa:2048",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "1",
    "-nodes",
    "-config", configPath,
    "-extensions", "v3_tsa"
  ], { stdio: "ignore" });

  execFileSync("openssl", [
    "ts",
    "-query",
    "-digest", expectedDigestHex.slice(2),
    "-sha256",
    "-cert",
    "-out", queryPath
  ], { stdio: "ignore" });

  execFileSync("openssl", [
    "ts",
    "-reply",
    "-section", "tsa_config",
    "-queryfile", queryPath,
    "-out", responsePath
  ], {
    stdio: "ignore",
    env: {
      ...process.env,
      OPENSSL_CONF: configPath
    }
  });

  const tokenBuffer = await readFile(responsePath);

  return {
    tempDir,
    certPath,
    tokenBase64: tokenBuffer.toString("base64")
  };
}

test("canonical metadata is sorted and compact", () => {
  const metadata = {
    tenant_id: "org_test",
    request_id: "req_123",
    operation: "voice_synthesis",
    model_id: "tts-v3"
  };

  assert.equal(
    getCanonicalMetadataString(metadata),
    "{\"model_id\":\"tts-v3\",\"operation\":\"voice_synthesis\",\"request_id\":\"req_123\",\"tenant_id\":\"org_test\"}"
  );
});

test("canonical audio converts 16-bit PCM WAV to 24-bit little-endian bytes", () => {
  const wav = createPcmWav({
    bitsPerSample: 16,
    samples: [0x1234, -0x1234]
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 6);
  assert.deepEqual([...canonical], [0x00, 0x34, 0x12, 0x00, 0xcc, 0xed]);
});

test("canonical audio preserves 24-bit PCM WAV sample bytes", () => {
  const wav = createPcmWav({
    bitsPerSample: 24,
    samples: [0x123456, -0x123456]
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 6);
  assert.deepEqual([...canonical], [0x56, 0x34, 0x12, 0xaa, 0xcb, 0xed]);
});

test("canonical audio deterministically resamples 44.1 kHz input to 48 kHz", () => {
  const samples = Array.from({ length: 441 }, (_, index) => (index - 220) * 100);
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 44100,
    samples
  });

  const canonicalA = canonicalizeWavTo24BitLE(wav);
  const canonicalB = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonicalA.length, 480 * 3);
  assert.deepEqual(canonicalA, canonicalB);
  assert.equal(sha256Hex(canonicalA), "c6c5c6748dafde42922ded40374f6f155ca22fd55b204f29e7624b44791c5ff1");
});

test("canonical audio resamples 96 kHz input to 48 kHz without frame drift", () => {
  const samples = [
    1000,
    2000,
    3000,
    4000,
    5000,
    6000,
    7000,
    8000
  ];
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 96000,
    samples
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 4 * 3);
  assert.deepEqual([...canonical], [0x00, 0xe8, 0x03, 0x00, 0xb8, 0x0b, 0x00, 0x88, 0x13, 0x00, 0x58, 0x1b]);
});

test("canonical audio supports float32 PCM WAV at 48 kHz", () => {
  const samples = [0.5, -0.5, 0.25, -0.25];
  const wav = createPcmWav({
    audioFormat: 3,
    sampleRate: 48000,
    samples
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 4 * 3);
  assert.ok(canonical.length > 0, "canonical float32 audio should be non-empty");
});

test("canonical audio deterministically resamples float32 PCM 44.1 kHz to 48 kHz", () => {
  const samples = Array.from({ length: 441 }, (_, index) => {
    const normalized = (index - 220) / 32768;
    return Math.max(-1.0, Math.min(1.0, normalized));
  });
  const wav = createPcmWav({
    audioFormat: 3,
    sampleRate: 44100,
    samples
  });

  const canonicalA = canonicalizeWavTo24BitLE(wav);
  const canonicalB = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonicalA.length, 480 * 3);
  assert.deepEqual(canonicalA, canonicalB);
  const hash = sha256Hex(canonicalA);
  assert.ok(/^[0-9a-f]{64}$/.test(hash), "float32 resampling should produce stable hash");
});

test("canonical audio deterministically resamples float32 PCM 96 kHz to 48 kHz", () => {
  const samples = [
    0.1,
    0.2,
    0.3,
    0.4,
    0.5,
    0.6,
    0.7,
    0.8
  ];
  const wav = createPcmWav({
    audioFormat: 3,
    sampleRate: 96000,
    samples
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 4 * 3);
  assert.ok(canonical.length > 0, "float32 96kHz→48kHz should have 4 output frames");
});

test("registerVoice emits a proof package that verifyProofPackage accepts", async () => {
  const privateKeyPem = crypto.generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8"
  });
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [1000, -1000, 2000, -2000, 3000, -3000]
  });

  const registration = await registerVoice(wav, {
    privateKeyPem,
    timestamp: 1711892400,
    nonce: 0x73,
    metadata: {
      model_id: "tts-v3",
      operation: "voice_synthesis",
      request_id: "req_test_0001",
      tenant_id: "org_test"
    }
  });

  const verification = verifyProofPackage(wav, registration.proofPackage);

  assert.equal(verification.ok, true);
  assert.equal(verification.reason, "VALID");
});

test("Level 1 proofs omit watermark fields and verify as PARTIAL", async () => {
  const privateKeyPem = crypto.generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8"
  });
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [500, -500, 1000, -1000]
  });

  const registration = await registerVoice(wav, {
    privateKeyPem,
    proofType: "RECORDED",
    complianceLevel: 1,
    metadata: {
      operation: "studio_recording"
    }
  });

  assert.equal(registration.proofPackage.protocol_version, "2.0");
  assert.equal(registration.proofPackage.proof_type, "RECORDED");
  assert.equal(registration.proofPackage.compliance_level, 1);
  assert.equal("watermark_payload" in registration.proofPackage, false);
  assert.equal("ledger_anchor" in registration.proofPackage, false);

  const verification = verifyProofPackage(wav, registration.proofPackage);
  assert.equal(verification.ok, true);
  assert.equal(verification.trust_level, "PARTIAL");
});

test("tampering proof_type breaks signature verification", async () => {
  const privateKeyPem = crypto.generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8"
  });
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [100, -100, 200, -200]
  });

  const registration = await registerVoice(wav, {
    privateKeyPem,
    proofType: "GENERATED",
    complianceLevel: 2,
    metadata: {
      operation: "voice_synthesis"
    }
  });
  const tampered = {
    ...registration.proofPackage,
    proof_type: "RECORDED"
  };

  const verification = verifyProofPackage(wav, tampered, {
    watermarkStatus: "present",
    requireWatermarkCheck: true
  });

  assert.equal(verification.ok, false);
  assert.equal(verification.reason, "INVALID_SIGNATURE");
});

test("verifyProofPackage reports current key status and conservative historical validity", async () => {
  const keyManager = createKeyManager();
  const revocationRegistry = createRevocationRegistry();
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [120, -120, 240, -240]
  });

  const registration = await registerVoice(wav, {
    keyManager,
    proofType: "GENERATED",
    complianceLevel: 2,
    metadata: {
      operation: "voice_synthesis"
    }
  });

  revocationRegistry.revoke({
    keyId: registration.proofPackage.key_id,
    creatorId: registration.proofPackage.creator_id,
    publicKey: registration.proofPackage.public_key,
    effectiveAt: registration.proofPackage.timestamp + 60,
    reason: "key_compromise"
  });

  const verification = verifyProofPackage(wav, registration.proofPackage, {
    watermarkStatus: "present",
    requireWatermarkCheck: true,
    nowTimestamp: registration.proofPackage.timestamp + 120,
    getKeyRevocationStatus: ({ keyId }) => revocationRegistry.get(keyId)
  });

  assert.equal(verification.ok, true);
  assert.equal(verification.revocation.current_key_status, "REVOKED");
  assert.equal(verification.revocation.historical_validity, "INDETERMINATE_UNATTESTED");
  assert.equal(verification.revocation.revocation_record.key_id, registration.proofPackage.key_id);
});

test("createRevocationRegistry persists records when filePath is configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-revocation-registry-"));
  const filePath = path.join(tempDir, "revocations.json");
  const registry = createRevocationRegistry({ filePath });

  registry.revoke({
    keyId: "key_persisted",
    creatorId: "creator_123",
    publicKey: "0xpub",
    effectiveAt: 1700000000,
    reason: "key_compromise"
  });

  const reloaded = createRevocationRegistry({ filePath });
  const persisted = JSON.parse(await readFile(filePath, "utf8"));

  assert.equal(reloaded.get("key_persisted")?.reason, "key_compromise");
  assert.equal(Array.isArray(persisted.records), true);
  assert.equal(persisted.records[0].key_id, "key_persisted");
});

test("createNonceReplayTracker persists creator nonce observations when filePath is configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-replay-tracker-"));
  const filePath = path.join(tempDir, "nonce-replay.json");
  const tracker = createNonceReplayTracker({ filePath });

  tracker.add("0xcreator", "nonce-1");

  const reloaded = createNonceReplayTracker({ filePath });
  const persisted = JSON.parse(await readFile(filePath, "utf8"));

  assert.equal(reloaded.has("0xcreator", "nonce-1"), true);
  assert.equal(Array.isArray(persisted.records), true);
  assert.equal(persisted.records[0].creator_id, "0xcreator");
});

test("timestamp attestation receipt digest is deterministic", async () => {
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [50, -50, 75, -75]
  });
  const registration = await registerVoice(wav, {
    proofType: "GENERATED",
    complianceLevel: 2,
    metadata: {
      operation: "voice_synthesis"
    }
  });
  const proofPackage = {
    ...registration.proofPackage,
    compliance_level: 3,
    usage_event_id: "evt_level3_test",
    ledger_anchor: "0xabc123"
  };

  const receipt = buildTimestampAttestationReceipt(proofPackage);
  const digestA = getTimestampAttestationReceiptDigest(proofPackage);
  const digestB = getTimestampAttestationReceiptDigest({
    ...proofPackage,
    metadata: {
      ignored: true
    }
  });

  assert.equal(receipt.protocol_version, "2.0");
  assert.equal(receipt.usage_event_id, "evt_level3_test");
  assert.equal(digestA, digestB);
});

test("normalized RFC3161 timestamp attestation profile verifies trusted TSAs", () => {
  const attestation = {
    type: "RFC3161",
    tsa: "tsa.vri.example",
    policy_oid: "1.2.3.4.5",
    serial_number: "0x1234",
    message_imprint_alg: "sha256",
    message_imprint: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    attested_at: 1711892410,
    gen_time: 1711892410,
    token: "base64(tsr)"
  };

  const trusted = verifyRfc3161TimestampAttestation(attestation, {
    expectedDigest: attestation.message_imprint,
    trustedAuthorities: ["tsa.vri.example"]
  });
  assert.equal(trusted.ok, true);

  const untrusted = verifyRfc3161TimestampAttestation(attestation, {
    expectedDigest: attestation.message_imprint,
    trustedAuthorities: ["other.example"]
  });
  assert.equal(untrusted.ok, false);
});

test("normalized RFC3161 timestamp attestation profile enforces policy_oid allowlists when configured", () => {
  const attestation = {
    type: "RFC3161",
    tsa: "tsa.vri.example",
    policy_oid: "1.2.3.4.9",
    serial_number: "0x1234",
    message_imprint_alg: "sha256",
    message_imprint: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    attested_at: 1711892410,
    gen_time: 1711892410,
    token: "base64(tsr)"
  };

  const verification = verifyRfc3161TimestampAttestation(attestation, {
    expectedDigest: attestation.message_imprint,
    trustedAuthorities: [
      {
        tsa: "tsa.vri.example",
        policy_oids: ["1.2.3.4.5"]
      }
    ]
  });

  assert.equal(verification.ok, false);
  assert.match(verification.reason, /policy_oid is not trusted/);
});

test("raw RFC3161 token normalization requires a parser and validates normalized output", () => {
  const rawToken = "base64(raw-tsr)";
  const withoutParser = normalizeRfc3161TimestampAttestation(rawToken, {
    expectedDigest: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  assert.equal(withoutParser.ok, false);

  const withParser = normalizeRfc3161TimestampAttestation(rawToken, {
    expectedDigest: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    trustedAuthorities: ["tsa.vri.example"],
    parseRfc3161Token: () => ({
      type: "RFC3161",
      tsa: "tsa.vri.example",
      policy_oid: "1.2.3.4.5",
      serial_number: "0x1234",
      message_imprint_alg: "sha256",
      message_imprint: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      attested_at: 1711892410,
      gen_time: 1711892410,
      token: rawToken
    })
  });

  assert.equal(withParser.ok, true);
  assert.equal(withParser.attestation.token, rawToken);
});

test("timestamp token input normalization accepts explicit encodings and rejects invalid ones", () => {
  const base64Token = normalizeTimestampTokenInput({
    encoding: "base64",
    data: Buffer.from("tsr").toString("base64")
  });
  assert.equal(base64Token.ok, true);

  const hexToken = normalizeTimestampTokenInput({
    encoding: "hex",
    data: "0xdeadbeef"
  });
  assert.equal(hexToken.ok, true);

  const invalidEncoding = normalizeTimestampTokenInput({
    encoding: "der",
    data: "abcd"
  });
  assert.equal(invalidEncoding.ok, false);
});

test("RFC3161 parser result normalization accepts object and wrapped success forms", () => {
  const plain = normalizeParsedRfc3161TokenResult({
    type: "RFC3161",
    tsa: "tsa.vri.example"
  });
  assert.equal(plain.ok, true);
  assert.equal(plain.attestation.type, "RFC3161");

  const wrapped = normalizeParsedRfc3161TokenResult({
    ok: true,
    attestation: {
      type: "RFC3161",
      tsa: "tsa.vri.example"
    }
  });
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.attestation.tsa, "tsa.vri.example");

  const failed = normalizeParsedRfc3161TokenResult({
    ok: false,
    reason: "bad cms signature"
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "bad cms signature");
});

test("parseOpenSslTsReplyText extracts normalized RFC3161 fields from openssl output", () => {
  const parsed = parseOpenSslTsReplyText(`
Status info:
Status: Granted.

TST info:
Version: 1
Policy OID: 1.2.3.4.5
Hash Algorithm: sha256
Message data:
    0000 - aa aa aa aa aa aa aa aa-aa aa aa aa aa aa aa aa   ................
    0010 - aa aa aa aa aa aa aa aa-aa aa aa aa aa aa aa aa   ................
Serial number: 0x1234
Time stamp: Apr  1 12:00:10 2026 GMT
TSA: DirName:/CN=tsa.vri.example
`, {
    token: "base64(tsr)"
  });

  assert.equal(parsed.tsa, "tsa.vri.example");
  assert.equal(parsed.policy_oid, "1.2.3.4.5");
  assert.equal(parsed.serial_number, "0x1234");
  assert.equal(parsed.message_imprint_alg, "sha256");
  assert.equal(parsed.message_imprint, `0x${"aa".repeat(32)}`);
  assert.equal(parsed.attested_at, 1775044810);
});

test("parseRfc3161TokenWithOpenSsl uses openssl parse and verify commands fail-closed", () => {
  const calls = [];
  const result = parseRfc3161TokenWithOpenSsl("YmFzZTY0LXRva2Vu", {
    tokenEncoding: "base64",
    expectedDigest: `0x${"aa".repeat(32)}`,
    openSslOptions: {
      caFile: "/tmp/test-ca.pem",
      execFileSync: (binary, args) => {
        calls.push([binary, args]);

        if (args.includes("-reply")) {
          return `
Status info:
Status: Granted.
TST info:
Policy OID: 1.2.3.4.5
Hash Algorithm: sha256
Message data:
    0000 - aa aa aa aa aa aa aa aa-aa aa aa aa aa aa aa aa
    0010 - aa aa aa aa aa aa aa aa-aa aa aa aa aa aa aa aa
Serial number: 0x1234
Time stamp: Apr  1 12:00:10 2026 GMT
TSA: DirName:/CN=tsa.vri.example
`;
        }

        return "";
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "openssl");
  assert.equal(calls[1][1].includes("-verify"), true);
});

test("buildOpenSslTimestampVerifyArgs maps trust and revocation policy options deterministically", () => {
  const args = buildOpenSslTimestampVerifyArgs({
    tokenIn: true,
    caFile: "/tmp/root.pem",
    untrustedFile: "/tmp/intermediate.pem",
    purpose: "timestamp_sign",
    verifyName: "tsa_policy",
    verifyDepth: 3,
    authLevel: 2,
    attime: 1775044800,
    policy: "1.2.3.4.5",
    crlCheck: true,
    crlCheckAll: true,
    policyCheck: true,
    explicitPolicy: true,
    inhibitAny: true,
    inhibitMap: true,
    x509Strict: true,
    useDeltas: true,
    extendedCrl: true,
    checkSsSig: true,
    partialChain: true,
    noCheckTime: true,
    verifyArgs: ["-allow_proxy_certs"]
  });

  assert.deepEqual(args, [
    "-token_in",
    "-CAfile", "/tmp/root.pem",
    "-untrusted", "/tmp/intermediate.pem",
    "-purpose", "timestamp_sign",
    "-verify_name", "tsa_policy",
    "-verify_depth", "3",
    "-auth_level", "2",
    "-attime", "1775044800",
    "-policy", "1.2.3.4.5",
    "-crl_check",
    "-crl_check_all",
    "-policy_check",
    "-explicit_policy",
    "-inhibit_any",
    "-inhibit_map",
    "-x509_strict",
    "-use_deltas",
    "-extended_crl",
    "-check_ss_sig",
    "-partial_chain",
    "-no_check_time",
    "-allow_proxy_certs"
  ]);
});

test("parseRfc3161TokenWithOpenSsl validates a real RFC3161 token generated by openssl", async () => {
  const expectedDigest = `0x${"aa".repeat(32)}`;
  const fixture = await createRealOpenSslTimestampFixture(expectedDigest);

  try {
    const parsed = parseRfc3161TokenWithOpenSsl(fixture.tokenBase64, {
      tokenEncoding: "base64",
      expectedDigest,
      openSslOptions: {
        caFile: fixture.certPath
      }
    });

    assert.equal(parsed.ok, true);
    assert.equal(parsed.attestation.type, "RFC3161");
    assert.equal(parsed.attestation.message_imprint, expectedDigest);
    assert.equal(parsed.attestation.policy_oid, "1.2.3.4.5");
    assert.equal(parsed.attestation.tsa, "Test TSA");
  } finally {
    execFileSync("rm", ["-rf", fixture.tempDir]);
  }
});

test("timestamp trust release artifact generator publishes a manifest aligned with the catalog", async () => {
  execFileSync("node", ["scripts/generate-timestamp-trust-release.mjs"], {
    cwd: path.resolve(process.cwd()),
    stdio: "ignore"
  });

  const catalog = JSON.parse(await readFile("docs/formal/timestamp-trust-profiles.catalog.json", "utf8"));
  const release = JSON.parse(await readFile("docs/release/timestamp-trust-profiles.release.json", "utf8"));

  assert.equal(release.artifact, "vri.timestamp-trust-profiles.release");
  assert.equal(release.source_catalog, "docs/formal/timestamp-trust-profiles.catalog.json");
  assert.equal(release.profile_count, catalog.profiles.length);
  assert.deepEqual(
    release.profiles.map((entry) => entry.profile_id),
    catalog.profiles.map((entry) => entry.profile_id)
  );
  assert.match(release.catalog_digest, /^0x[0-9a-f]{64}$/);
});

test("Level 3 verification requires a valid timestamp attestation verifier", async () => {
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [300, -300, 600, -600]
  });
  const registration = await registerVoice(wav, {
    proofType: "GENERATED",
    complianceLevel: 3,
    ledgerAnchor: "0xfeedface",
    usageEventId: "evt_level3_valid",
    timestampAttestation: {
      type: "RFC3161",
      tsa: "tsa.vri.example",
      policy_oid: "1.2.3.4.5",
      serial_number: "0x1234",
      message_imprint_alg: "sha256",
      attested_at: 1711892500,
      gen_time: 1711892500,
      token: "base64(tsr)",
      digest: "0xplaceholder"
    },
    timestamp: 1711892400,
    metadata: {
      operation: "voice_synthesis"
    }
  });
  const proofPackage = {
    ...registration.proofPackage,
    timestamp_attestation: {
      ...registration.proofPackage.timestamp_attestation,
      digest: getTimestampAttestationReceiptDigest(registration.proofPackage)
    }
  };

  const missingVerifier = verifyProofPackage(wav, proofPackage, {
    watermarkStatus: "present",
    requireWatermarkCheck: true
  });
  assert.equal(missingVerifier.ok, false);
  assert.equal(missingVerifier.reason, "TIMESTAMP_ATTESTATION_VERIFIER_REQUIRED");

  const verified = verifyProofPackage(wav, proofPackage, {
    watermarkStatus: "present",
    requireWatermarkCheck: true,
    verifyTimestampAttestation: (attestation, { expectedDigest }) => verifyRfc3161TimestampAttestation(
      {
        ...attestation,
        message_imprint: expectedDigest
      },
      {
        expectedDigest,
        trustedAuthorities: ["tsa.vri.example"]
      }
    )
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.trust_level, "HIGH");
});

test("identity assertion verifies and expires fail-closed", () => {
  const challenge = createSessionChallenge({
    verifierOrigin: "https://studio.vri.example",
    expiresAt: 1711892600,
    sessionScope: ["recording", "export"],
    sessionPublicKey: "0x1234abcd"
  });
  const identity = createIdentityAssertion(challenge, {
    privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
      format: "pem",
      type: "pkcs8"
    }),
    sessionTimestamp: 1711892400
  });

  const valid = verifyIdentityAssertion(identity, {
    nowTimestamp: 1711892500,
    trustedVerifierOrigins: ["https://studio.vri.example"]
  });
  assert.equal(valid.ok, true);

  const expired = verifyIdentityAssertion(identity, {
    nowTimestamp: 1711892700,
    trustedVerifierOrigins: ["https://studio.vri.example"]
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "IDENTITY_SESSION_EXPIRED");
});

test("proof signature is bound to identity object", async () => {
  const proofTimestamp = Math.floor(Date.now() / 1000);
  const devicePrivateKeyPem = crypto.generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8"
  });
  const challenge = createSessionChallenge({
    verifierOrigin: "https://studio.vri.example",
    expiresAt: proofTimestamp + 300,
    sessionScope: ["generation"],
    sessionPublicKey: "0xsessionpub"
  });
  const identity = createIdentityAssertion(challenge, {
    privateKeyPem: devicePrivateKeyPem,
    sessionTimestamp: proofTimestamp
  });
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [1000, -1000, 2000, -2000]
  });

  const registration = await registerVoice(wav, {
    proofType: "GENERATED",
    complianceLevel: 2,
    identity,
    timestamp: proofTimestamp,
    metadata: {
      operation: "voice_synthesis"
    }
  });

  const ok = verifyProofPackage(wav, registration.proofPackage, {
    watermarkStatus: "present",
    requireWatermarkCheck: true,
    trustedVerifierOrigins: ["https://studio.vri.example"]
  });
  assert.equal(ok.ok, true);

  const tampered = {
    ...registration.proofPackage,
    identity: {
      ...registration.proofPackage.identity,
      session_id: "tampered-session"
    }
  };
  const verification = verifyProofPackage(wav, tampered, {
    watermarkStatus: "present",
    requireWatermarkCheck: true,
    trustedVerifierOrigins: ["https://studio.vri.example"]
  });
  assert.equal(verification.ok, false);
  assert.equal(verification.reason, "IDENTITY_SIGNATURE_INVALID");
});

test("createKeyManager generates an ephemeral Ed25519 key when no PEM is provided", () => {
  const km = createKeyManager();

  assert.ok(km instanceof KeyManager);
  assert.equal(typeof km.getKeyId(), "string");
  assert.equal(km.getKeyId().length, 16);
  assert.equal(km.getPublicKeyBytes().length, 32);
});

test("createKeyManager uses provided PEM and produces a stable keyId", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });

  const km1 = createKeyManager({ privateKeyPem: pem });
  const km2 = createKeyManager({ privateKeyPem: pem });

  assert.equal(km1.getKeyId(), km2.getKeyId());
  assert.deepEqual(km1.getPublicKeyBytes(), km2.getPublicKeyBytes());
});

test("KeyManager.sign produces a valid Ed25519 signature", () => {
  const km = createKeyManager();
  const digest = crypto.randomBytes(32);
  const signature = km.sign(digest);

  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), km.getPublicKeyBytes()]),
    format: "der",
    type: "spki"
  });

  assert.ok(crypto.verify(null, digest, publicKey, signature));
});

test("KeyManager.rotate changes keyId, archives the previous key", () => {
  const km = createKeyManager();
  const originalKeyId = km.getKeyId();
  const originalPubBytes = km.getPublicKeyBytes();

  const newKeyId = km.rotate();

  assert.notEqual(newKeyId, originalKeyId);
  assert.equal(km.getKeyId(), newKeyId);
  assert.notDeepEqual(km.getPublicKeyBytes(), originalPubBytes);

  const archived = km.getArchivedKeys();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].keyId, originalKeyId);
  assert.deepEqual(archived[0].publicKeyBytes, originalPubBytes);
});

test("registerVoice accepts a keyManager and embeds the correct public key", async () => {
  const km = createKeyManager();
  const expectedPubKeyHex = "0x" + km.getPublicKeyBytes().toString("hex");
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [500, -500, 1000, -1000]
  });

  const registration = await registerVoice(wav, {
    keyManager: km,
    timestamp: 1711892400,
    nonce: 0x11,
    metadata: { model_id: "tts-v3", operation: "voice_synthesis" }
  });

  assert.equal(registration.proofPackage.public_key, expectedPubKeyHex);
  assert.equal(registration.proofPackage.key_id, km.getKeyId());
  assert.equal(registration.signingKeyGenerated, false);

  const verification = verifyProofPackage(wav, registration.proofPackage);
  assert.equal(verification.ok, true);
});

test("createKmsKeyManager validates the provider interface", () => {
  assert.throws(
    () => createKmsKeyManager({}),
    /must implement sign/
  );

  assert.throws(
    () => createKmsKeyManager({ sign: () => {}, getPublicKeyBytes: () => {} }),
    /must implement sign/
  );
});

test("createKmsKeyManager wraps a valid provider and delegates calls", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const realKm = createKeyManager();

  const provider = {
    sign: (digest) => realKm.sign(digest),
    getPublicKeyBytes: () => realKm.getPublicKeyBytes(),
    getKeyId: () => realKm.getKeyId()
  };

  const kms = createKmsKeyManager(provider);

  assert.equal(kms.getKeyId(), realKm.getKeyId());
  assert.deepEqual(kms.getPublicKeyBytes(), realKm.getPublicKeyBytes());

  const digest = crypto.randomBytes(32);
  const sig = kms.sign(digest);

  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), kms.getPublicKeyBytes()]),
    format: "der",
    type: "spki"
  });
  assert.ok(crypto.verify(null, digest, publicKey, sig));
});

// ── Worker Thread DSP ─────────────────────────────────────────────────────────

test("canonicalizeWavTo24BitLEAsync produces same result as sync version", async () => {
  const wav = createPcmWav({ sampleRate: 48000, channels: 1, bitsPerSample: 16, samples: [100, 200, -100, -200] });
  const sync = canonicalizeWavTo24BitLE(wav);
  const async_ = await canonicalizeWavTo24BitLEAsync(wav);
  assert.deepEqual(sync, async_);
});

test("canonicalizeWavTo24BitLEAsync resamples 44.1 kHz deterministically via Worker Thread", async () => {
  const wav44 = createPcmWav({ sampleRate: 44100, channels: 1, bitsPerSample: 16, samples: [1000, 2000, 3000, 4000] });
  const sync = canonicalizeWavTo24BitLE(wav44);
  const async_ = await canonicalizeWavTo24BitLEAsync(wav44);
  assert.deepEqual(sync, async_);
});

test("DspPool canonicalizes multiple buffers concurrently and deterministically", async () => {
  const pool = createDspPool({ size: 2 });
  try {
    const wav = createPcmWav({ sampleRate: 48000, channels: 1, bitsPerSample: 16, samples: [500, 1000, -500, -1000] });
    const sync = canonicalizeWavTo24BitLE(wav);

    const results = await Promise.all([
      pool.canonicalize(wav),
      pool.canonicalize(wav),
      pool.canonicalize(wav)
    ]);

    for (const result of results) {
      assert.deepEqual(result, sync);
    }
  } finally {
    await pool.terminate();
  }
});

test("DspPool rejects invalid WAV buffers with a clear error", async () => {
  const pool = createDspPool({ size: 1 });
  try {
    await assert.rejects(
      () => pool.canonicalize(Buffer.from("not a wav")),
      /WAV|RIFF/
    );
  } finally {
    await pool.terminate();
  }
});
