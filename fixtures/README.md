# VRI Protocol Fixtures

This directory contains test fixtures for validating VRI Protocol v1.0 compliance.

## Structure

- `cases/`: Protocol test cases (registration, verification, edge cases)
- `vectors/`: Canonical audio vectors for deterministic testing
- `invalid-proofs/`: Intentionally invalid proof packages for rejection testing

## Test Cases

### case-001-basic-registration.json
Standard 16-bit PCM WAV registration with metadata.
- Input: mono 48 kHz PCM WAV
- Expected: valid proof_package with Ed25519 signature

### case-002-float32-input.json
Float32 IEEE PCM WAV registration (wider audio support).
- Input: stereo 96 kHz float32 PCM WAV
- Expected: valid proof_package after canonical resampling

### case-003-multilingual-metadata.json
Registration with non-ASCII metadata (protocol canonicalization test).
- Input: 16-bit PCM WAV with UTF-8 metadata keys
- Expected: valid canonical metadata serialization

### invalid-case-001-tampered-audio.json
Deliberately corrupted audio paired with original proof.
- Expected: verification fails with "audio does not match proof"

### invalid-case-002-forged-signature.json
Valid audio with cryptographically impossible signature.
- Expected: verification fails with "signature verification failed"

## Running Fixture Tests

```bash
# Run protocol compliance suite
npm run test:fixtures

# Validate a single fixture
node verify-fixture.js fixtures/cases/case-001-basic-registration.json
```

## Adding New Fixtures

1. Create test case JSON with `input`, `expected_output`, and `description`
2. Add audio vectors to `vectors/` if needed
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
- [ ] Cross-implementation compatibility (reference vectors)
- [ ] Language bindings validation
