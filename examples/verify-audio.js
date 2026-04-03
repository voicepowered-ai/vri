#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { verifyProofPackage } from "../packages/core/src/index.js";

async function main() {
  const [audioPath, proofPath] = process.argv.slice(2);

  if (!audioPath || !proofPath) {
    console.error("Usage: node examples/verify-audio.js <audio.wav> <proof.json>");
    process.exit(1);
  }

  const [audio, proofRaw] = await Promise.all([
    readFile(audioPath),
    readFile(proofPath, "utf8")
  ]);
  const proof = JSON.parse(proofRaw);
  const result = verifyProofPackage(audio, proof, {
    requireProtocolVersion: true,
    requiredComplianceLevel: 1
  });

  if (result.ok) {
    console.log("VALID");
    return;
  }

  console.error(result.reason);
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
