# Threat Model

## Overview

This document analyzes potential attacks against VRI as an inference-layer traceability protocol and describes mitigations for each threat.

---

## Threat Categories

### 1. Watermark Attacks

#### 1.1 Watermark Removal

**Threat**: Remove watermark without losing audio quality, making it appear unoriginal.

**Attack Methods**:
- Low-pass filter (removes high frequencies)
- Spectral subtraction (isolates and removes modulation)
- Source separation (isolate vocals from background)
- Temporal editing (remove watermark from segments)

**Likelihood**: High (simple to attempt)  
**Impact**: Loss of cryptographic proof, forcing reliance on forensic similarity analysis

**Mitigation**:
- **Multi-band redundancy**: Watermark spread across entire audible spectrum (125Hz–16kHz)
- **Temporal spreading**: Watermark repeated throughout audio, not in one segment
- **Perceptual loss**: Removing watermark introduces audible artifacts (EQ changes, noise floor)
- **Fingerprinting forensic detection layer**: Even if watermark evidence is absent, forensic similarity analysis can still support discovery and triage

**Residual Risk**: **Medium**. Determined attacker can remove watermark by accepting audio quality loss or re-synthesis time.

---

#### 1.2 Watermark Inversion

**Threat**: Reverse-engineer and cancel out watermark via phase inversion.

**Attack Methods**:
- Estimate watermark modulation via deep learning
- Generate inverse-phase copy
- Subtract from original audio

**Likelihood**: Low (requires ML expertise + compute)  
**Impact**: If successful, watermark destroyed without quality loss

**Mitigation**:
- **Blind extraction assumption**: Watermark design assumes attacker cannot extract it intact
- **Non-linear masking**: Watermark amplitude depends on local content (adaptive), hard to model
- **Stochastic modulation**: Nonce + LDPC create randomized pattern per audio
- **Detection**: Inversion artifacts usually create phase distortions (detectable)

**Residual Risk**: **Low**. Requires advanced attack, signature verification fails anyway (watermark modified).

---

#### 1.3 Re-recording Attack

**Threat**: Attacker claims they independently created same voice by re-synthesizing audio.

**Attack Methods**:
- Download watermarked audio
- Use voice cloning (OpenAI API, local model) to recreate similar-sounding audio
- Claim original authorship

**Likelihood**: High (easy to attempt)  
**Impact**: Two conflicting claims of authorship

**Mitigation**:
- **Ledger timestamp**: Creator's first generation is permanently recorded with timestamp
- **Fingerprint database**: New cloning attempt has slight acoustic differences
- **Legal remedy**: Courts can subpoena ledger to prove prior creation
- **External enforcement systems**: downstream governance systems may provide additional controls
- **Operational barriers**: legitimate operators retain earlier traceability evidence at the inference boundary

**Residual Risk**: **Medium-High**. Requires external governance intervention, not purely technical.

---

### 2. Cryptographic Attacks

#### 1.4 Input Audio Substitution

**Threat**: Attacker uses audio captured outside the VRI trust boundary (e.g., audio recorded on a phone or obtained from an external source) as the TTS model input, bypassing source-audio traceability.

**Attack Methods**:
- Submit non-VRI audio as the model's voice reference or input
- Combine a VRI-registered actor voice with an untracked training corpus
- Import arbitrary audio into the inference pipeline without registering it as `RECORDED`

**Likelihood**: High (any client can send arbitrary audio to a TTS API)  
**Impact**: The chain of custody for the voice actor's contribution is broken; the GENERATED proof cannot attest that the source audio was itself system-verified

**Mitigation**:
- **`requireInputVerification` server flag**: gates inference on `input_reference` pointing to a `RECORDED` ledger event from this system
- **Input audio hash binding**: when verified, `input_audio_hash` and `input_verified: true` are embedded inside the signed `canonical_metadata`, making the source attestation tamper-evident
- **Ledger event type check**: server rejects `input_reference` events that are not `proof_type = RECORDED`

**Residual Risk**: **Low** when `requireInputVerification` is on. Without it: **High** (by design — default is permissive for backward compatibility).

---

#### 1.5 Unverified Actor Identity

**Threat**: Attacker claims to be a legitimate voice actor by supplying a known `actor_id` and `session_id` without actual QR-based verification.

**Attack Methods**:
- Provide a known `actor_id` string in a POST /register request body
- Create a `RecordingSession` manually (`verification_method: manual`) to bypass QR requirement

**Likelihood**: Medium (easy if `requireVerifiedSession` is not enabled)  
**Impact**: False actor attribution in the proof; non-repudiability is weakened

**Mitigation**:
- **`requireVerifiedSession` server flag**: rejects any GENERATED proof request unless `session_id` references a QR-verified `RecordingSession` (`session_verified: true`)
- **QR-activated sessions**: `session_verified: true` is only set when `from_qr: true` or `verification_method: qr_scan` is used; manual sessions always produce `session_verified: false`
- **Combined with IdentitySession**: high-security deployments can additionally require a QR/Secure-Enclave `IdentitySession` via `registerRequireAuthorizedIdentitySession`

**Residual Risk**: **Low** when both `requireVerifiedSession` and identity session controls are enabled. Without them: `actor_id` is an unverified string (**High**).

---

### 2. Cryptographic Attacks

#### 2.1 Signature Forgery

**Threat**: Create fake EdDSA signature to prove false authorship.

**Attack Methods**:
- Brute-force Ed25519 (2^256 operations, infeasible)
- Exploit cryptographic weakness (none known)
- Obtain private key through other means (see 2.2)

**Likelihood**: Negligible (cryptographically hard)  
**Impact**: If successful, can forge arbitrary signatures

**Mitigation**:
- **EdDSA security**: NIST-approved, no known polynomial-time attacks
- **Key derivation**: Seed → SHA512 pruning → scalar multiplication
- **Signature verification**: Deterministic, can be verified by anyone

**Residual Risk**: **Negligible** (cryptographic guarantee).

---

#### 2.2 Private Key Theft

**Threat**: Steal creator's private key to sign forged audio.

**Attack Methods**:
- Compromise HSM (hardware security module)
- Compromise KMS (AWS KMS, GCP Secret Manager)
- Phishing creator's machine
- Supply chain attack on VRI infrastructure

**Likelihood**: Low (requires sophisticated attack)  
**Impact**: Attacker can forge signatures for arbitrary audio

**Mitigation**:
- **HSM isolation**: Private key never exits HSM, operations performed in secure enclave
- **KMS access control**: IAM policies restrict signing operations, audit logs all uses
- **Key rotation**: Annual rotation + emergency rotation on suspicion
- **Clock skew detection**: Sudden burst of signatures triggers investigation
- **Revocation mechanism**: Creator can revoke old key, new signatures use new key

**Residual Risk**: **Medium**. Requires sophisticated attack. Detectable via usage anomalies. Recoverable via key rotation.

---

#### 2.3 Timestamp Manipulation

**Threat**: Embed false timestamp to claim earlier creation date.

**Attack Methods**:
- Modify timestamp in watermark (requires re-watermarking)
- Modify timestamp in signature (invalidates signature)
- Intercept at network level and modify ledger (requires system compromise)

**Likelihood**: Low (signature covers timestamp)  
**Impact**: If successful, can claim priority over legitimate creator

**Mitigation**:
- **Signature covers timestamp**: Changing timestamp invalidates signature
- **Server-side timestamp**: Ledger records server time (client-supplied timestamp ignored)
- **Blockchain anchor**: Merkle root anchored to blockchain every 10 minutes (immutable)
- **Temporal verification**: Courts can verify via blockchain timestamps

**Residual Risk**: **Low**. Signature prevents tampering. Blockchain anchors prevent retroactive backdating.

---

### 3. Ledger Attacks

#### 3.1 Ledger Tampering

**Threat**: Modify usage records to inflate earnings or remove origin traces.

**Attack Methods**:
- Compromise database (SQL injection, credential theft)
- Modify Merkle tree and recompute hash
- Backdoor VRI infrastructure

**Likelihood**: Medium (requires system compromise)  
**Impact**: False earnings, loss of audit trail

**Mitigation**:
- **Write-once ledger**: Entries append-only, no updates allowed
- **Cryptographic hash chains**: Merkle tree rooted in blockchain anchor
- **Immutable auditing**: Audit log signed and cannot be modified
- **Distributed anchors**: Every 10 minutes, root hash published to blockchain (Ethereum, Solana)
- **External verification**: Anyone can download ledger, verify against blockchain root

**Residual Risk**: **Low**. Write-once + blockchain anchoring make tampering impossible without breaking blockchain.

---

#### 3.2 Selective Record Deletion

**Threat**: Delete usage events selectively to hide unauthorized uses.

**Attack Methods**:
- Query database and delete rows
- Reconstruct Merkle tree without deleted records

**Likelihood**: Medium (requires database access)  
**Impact**: Loss of record, creator doesn't receive payment

**Mitigation**:
- **Write-once ledger**: Deletion triggers audit log entry (attempt recorded)
- **Merkle anchor mismatch**: Deleting records breaks Merkle root (detectable)
- **Distributed backups**: Replica databases in multiple regions
- **Full ledger snapshots**: Daily snapshots prevent data loss
- **Blockchain verification**: Root hash on blockchain proves tampering occurred

**Residual Risk**: **Very Low**. Deletion breaks cryptographic anchors, detected immediately.

---

### 4. System Architecture Attacks

#### 4.1 Man-in-the-Middle (MITLS)

**Threat**: Intercept verification requests and return false results.

**Attack Methods**:
- Compromise network (BGP hijacking, ARP spoofing)
- Intercept API responses and modify

**Likelihood**: Low (requires network attack)  
**Impact**: Return false verification results to clients

**Mitigation**:
- **HTTPS/TLS**: All traffic encrypted in transit
- **Certificate pinning**: Clients pin VRI API certificates
- **Request signing**: API requests signed (prevent forgery)
- **Response signatures**: Responses signed by verification service
- **Blockchain anchors**: Critical results anchored to blockchain

**Residual Risk**: **Low**. TLS + signing prevent interception.

---

#### 4.2 Denial-of-Service (DoS)

**Threat**: Overload VRI infrastructure to prevent legitimate verification.

**Attack Methods**:
- Volumetric DDoS (millions of requests/sec)
- Application layer attack (expensive operations)
- Distributed botnet

**Likelihood**: Medium (easy to attempt)  
**Impact**: Service unavailability and missed verification or accounting events

**Mitigation**:
- **Rate limiting**: Per-API-key limits (1K–10K req/min)
- **Auto-scaling**: Add capacity dynamically as load increases
- **DDoS protection**: CloudFlare, AWS Shield (filter malicious traffic)
- **Circuit breakers**: Graceful degradation when overloaded
- **Degraded verification mode**: Verification service can continue operating with reduced assurance under overload

**Residual Risk**: **Medium**. Rate limiting + scaling handle most attacks. Large-scale DDoS could still impact service.

---

### 5. Usage Accounting Attacks

#### 5.1 Accounting Inflation

**Threat**: Artificially inflate accounting outcomes by gaming usage metrics.

**Attack Methods**:
- Send same audio to verification multiple times
- Coordinate fake external systems to report false usage numbers
- Generate synthetic usage signals against legitimate services

**Likelihood**: Medium (economically incentivized)  
**Impact**: Incorrect downstream evidence interpretation

**Mitigation**:
- **Deduplication**: Same audio_hash examined within time window = 1 event, not N
- **External verification**: Cross-check with authoritative external systems where applicable
- **Anomaly detection**: Sudden spikes in usage are flagged for investigation
- **Proof-of-work**: Verification requires actual audio processing (computational cost)

**Residual Risk**: **Medium**. Requires external cooperation to detect sophisticated fraud.

---

#### 5.2 Creator Impersonation

**Threat**: Attacker claims to be the legitimate creator and attempts to redirect trust decisions based on false identity.

**Attack Methods**:
- Register new creator account with similar name
- Claim watermarked audio as their own
- Register fraudulent identity metadata or authorization state

**Likelihood**: Medium (if verification is lax)  
**Impact**: Trust is misassigned to the attacker

**Mitigation**:
- **Cryptographic proof**: Signature proves creator identity (can't be spoofed)
- **Identity proofing outside the protocol**: Deployments may bind keys to external identity systems where legally required
- **Manual review**: Suspicious creators flagged for verification
- **Destination or account controls outside the protocol**: Any downstream business workflow must validate its own recipients
- **Out-of-band confirmations**: Sensitive account changes should require separate confirmation channels

**Residual Risk**: **Low**. Cryptographic proof prevents spoofing. External identity controls can further reduce impersonation risk where needed.

---

### 6. Optional External Verifier Attacks

#### 6.1 Fake External Reporting

**Threat**: Attacker claims audio was processed by a legitimate external system in order to influence downstream trust decisions.

**Attack Methods**:
- Forge usage context (source, count, location)
- Pass context to verification endpoint
- Claim false downstream outcomes

**Likelihood**: Medium (economically incentivized)  
**Impact**: Incorrect accounting outcomes

**Mitigation**:
- **External confirmation**: VRI can query external systems or verification endpoints where available
- **Cryptographic context**: Context is signed by the external system or verified via API
- **Ledger audit**: Verification and accounting records remain auditable
- **Anomaly detection**: Unusual patterns flagged for investigation

**Residual Risk**: **Medium**. Requires external API integration for strong guarantees.

---

## Summary: Risk Matrix

| Threat | Likelihood | Impact | Mitigation | Residual Risk |
|--------|-----------|--------|-----------|---------------|
| Input Audio Substitution | High | Medium | `requireInputVerification`, input_audio_hash binding | **Low (enforced) / High (permissive)** |
| Unverified Actor Identity | Medium | Medium | `requireVerifiedSession`, QR session, IdentitySession | **Low (enforced) / High (permissive)** |
| Watermark Removal | High | Medium | Multi-band, fingerprinting | **Medium** |
| Signature Forgery | Negligible | Critical | EdDSA (crypto hard) | **Negligible** |
| Private Key Theft | Low | Critical | HSM, key rotation | **Medium** |
| Ledger Tampering | Medium | High | Write-once, blockchain | **Very Low** |
| Selective Deletion | Low | High | Merkle anchor, snapshots | **Very Low** |
| Man-in-the-Middle | Low | Medium | TLS, signing | **Low** |
| Denial-of-Service | Medium | Medium | Rate limiting, scaling | **Medium** |
| Accounting Inflation | Medium | High | Deduplication, anomaly | **Medium** |
| Creator Impersonation | Medium | High | Crypto proof, KYC | **Low** |
| Fake Platform Report | Medium | Medium | Platform API, audit | **Medium** |

---

## Defense Strategy

### Layered Defense

```
Layer 1 (Strongest): Cryptography
  • EdDSA signatures (unforgeable)
  • Watermarks (embedded proof)
  • Merkle anchors (immutable)
  • session_id + actor_id + inference_metadata signed into canonical_metadata

Layer 1b (Session Gates): Pre-Inference Policy Controls
  • requireVerifiedSession: QR-verified actor presence before GENERATED proof issuance
  • requireInputVerification: source audio must be a RECORDED ledger event from this system

Layer 2: Operational Security
  • Read-only ledger backups
  • Anomaly detection
  • Manual review triggers

Layer 3: Legal/Regulatory
  • Proof suitable for courts
  • Audit trail compliance
  • Creator agreements
```

### Assumption of Compromise

VRI design assumes:
- Watermarks can be removed with effort + quality loss
- Private keys could be stolen (but detected + revocable)
- Ledger could be breached (but breach detectable via blockchain)

Therefore, VRI is a **hybrid trust infrastructure**, not an impenetrable vault:
- Cryptographic guarantees are strong
- Operational security is robust with layered forensic and cryptographic controls
- Legal remedies are available for edge cases

---

## Reporting Security Issues

If you discover a vulnerability:

1. **Do NOT** post on public channels
2. Send details to: **security@vri.app**
3. Include:
   - Description of vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (optional)

4. VRI will:
   - Acknowledge receipt within 24 hours
   - Assess severity
   - Issue fix and coordinate disclosure timeline
   - Credit researcher (if desired)

---

**Next**: See companion reference documents for optional downstream integration notes.
