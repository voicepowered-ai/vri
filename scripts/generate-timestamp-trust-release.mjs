import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, "docs/formal/timestamp-trust-profiles.catalog.json");
const outputPath = path.join(repoRoot, "docs/release/timestamp-trust-profiles.release.json");

function canonicalize(value) {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }

  throw new TypeError("Unsupported value in trust-profile release manifest.");
}

function sha256Hex(value) {
  return `0x${crypto.createHash("sha256").update(value).digest("hex")}`;
}

async function main() {
  const catalog = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  const profiles = Array.isArray(catalog?.profiles) ? catalog.profiles : [];

  const profileDigests = profiles.map((profile) => ({
    profile_id: profile.profile_id ?? null,
    profile_name: profile.profile_name ?? null,
    version: profile.version ?? 1,
    effective_at: profile.effective_at ?? null,
    profile_digest: sha256Hex(canonicalize(profile))
  }));

  const manifest = {
    artifact: "vri.timestamp-trust-profiles.release",
    version: 1,
    source_catalog: "docs/formal/timestamp-trust-profiles.catalog.json",
    generated_at: new Date().toISOString(),
    catalog_digest: sha256Hex(canonicalize(catalog)),
    profile_count: profileDigests.length,
    profiles: profileDigests
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
