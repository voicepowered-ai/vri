# VRI Protocol Fixtures

This directory contains test fixtures for validating VRI Protocol v1.0 compliance.

## Structure

- `cases/`: Protocol test cases (registration and deterministic-canonicalization scenarios)
- `invalid-cases/`: Intentionally invalid scenarios for rejection-path testing

## Test Cases

### case-001-basic-registration.json
Standard 16-bit PCM WAV registration with metadata.
- Input: mono 48 kHz PCM WAV
- Expected: valid proof_package with Ed25519 signature

### case-002-float32-stereo-96khz.json
Float32 IEEE PCM WAV registration (wider audio support).
- Input: stereo 96 kHz float32 PCM WAV
- Expected: valid proof_package after canonical resampling

### invalid-case-001-audio-mismatch.json
Deliberately corrupted audio paired with original proof.
- Expected: verification fails with "audio does not match proof"

## Running Fixture Tests

```bash
# Run protocol compliance suite
node --test packages/api/test/fixtures.test.js

# Validate a single fixture
node validate-fixtures.js
```

## Adding New Fixtures

1. Create test case JSON with `input`, `expected_output`, and `description`
2. Add any required synthetic audio description to the fixture payload
3. Document expected behavior
4. Add test in `packages/api/test/fixtures.test.js`

## Protocol Compliance Checklist

- [x] Canonical audio from PCM 16-bit
- [x] Canonical audio from PCM 24-bit
- [x] Canonical audio from IEEE float32
- [x] Deterministic resampling 44.1 kHz → 48 kHz
- [x] Deterministic resampling 96 kHz → 48 kHz
- [x] Ed25519 signature generation
- [x] Proof package JSON serialization
- [x] Compliance and interoperability fixture suite (Node reference)
- [ ] Cross-implementation compatibility (independent implementations)
- [ ] Language bindings validation
