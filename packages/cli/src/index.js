#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { registerVoice, verifyVoice, verifyProofPackage } from "../../core/src/index.js";

function getApiBaseUrl() {
  return process.env.VRI_API_URL ?? "http://localhost:8787";
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok) {
    const message = typeof payload?.message === "string"
      ? payload.message
      : typeof payload?.error === "string"
        ? payload.error
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function printUsage() {
  console.error("Usage:");
  console.error("  vri register <audio-file>");
  console.error("  vri verify <voice-id>");
  console.error("  vri verify-proof <audio-file> <proof-file>");
  console.error("  vri events <event-id>");
  console.error("  vri batches <batch-id>");
  console.error("  vri proofs <event-id>");
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (!command || args.length === 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (command === "register") {
    const [audioFile] = args;
    const metadata = {
      model_id: "tts-v3",
      operation: "voice_synthesis",
      request_id: "req_cli_register",
      tenant_id: "local_cli"
    };
    console.log(JSON.stringify(await registerVoice(audioFile, { metadata }), null, 2));
    return;
  }

  if (command === "verify") {
    const [voiceId] = args;
    console.log(JSON.stringify(await verifyVoice(voiceId), null, 2));
    return;
  }

  if (command === "verify-proof") {
    const [audioFile, proofFile] = args;

    if (!audioFile || !proofFile) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const [audio, proofRaw] = await Promise.all([
      readFile(audioFile),
      readFile(proofFile, "utf8")
    ]);

    console.log(JSON.stringify(verifyProofPackage(audio, JSON.parse(proofRaw)), null, 2));
    return;
  }

  if (command === "events") {
    const [eventId] = args;

    if (!eventId) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const baseUrl = getApiBaseUrl();
    const payload = await getJson(`${baseUrl}/events/${encodeURIComponent(eventId)}`);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "batches") {
    const [batchId] = args;

    if (!batchId) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const baseUrl = getApiBaseUrl();
    const payload = await getJson(`${baseUrl}/batches/${encodeURIComponent(batchId)}`);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "proofs") {
    const [eventId] = args;

    if (!eventId) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const baseUrl = getApiBaseUrl();
    const payload = await getJson(`${baseUrl}/proofs/${encodeURIComponent(eventId)}`);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exitCode = 1;
});
