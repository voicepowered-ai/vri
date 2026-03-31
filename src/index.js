#!/usr/bin/env node

import { registerVoice, verifyVoice } from "./sdk.js";

function printUsage() {
  console.error("Usage:");
  console.error("  vri register <voice-file>");
  console.error("  vri verify <voice-id>");
}

async function main() {
  const [, , command, value] = process.argv;

  if (!command || !value) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  let result;

  if (command === "register") {
    result = await registerVoice(value);
  } else if (command === "verify") {
    result = await verifyVoice(value);
  } else {
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "error",
    message: error.message
  }, null, 2));
  process.exitCode = 1;
});
