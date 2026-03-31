# FAQ

---

## General Questions

### What is VRI?

VRI (Voice Rights Infrastructure) is a cryptographic system that lets creators prove they own AI-generated voices and get paid every time someone uses them. Think of it as a "receipt system for audio" — every time your voice is used, the system records it and pays you.

### How is VRI different from other watermarking systems?

1. **Cryptographic proof**: VRI uses EdDSA signatures, not just markers. You can mathematically prove you created it.
2. **Works everywhere**: Embed the proof once, use your voice on YouTube, Spotify, TikTok, anywhere.
3. **Micropayments**: Every usage is tracked and monetized. Get paid for each use.
4. **Ledger-based**: All payments recorded immutably on a blockchain-anchored ledger.

Traditional watermarking (DRM) is platform-specific and fragile. VRI is portable and cryptographically strong.

### Can I use my existing TTS-generated voice with VRI?

**New voices**: Yes, just generate them through VRI and they automatically get watermarked.

**Existing voices**: You can submit them manually, but VRI will watermark them going forward. Past uses without watermarks can fall back to fingerprinting-based detection.

### Is the watermark audible?

No. VRI watermarks have SNR > 40dB, meaning they're imperceptible to human hearing. Professional audio engineers with enhanced monitoring equipment might notice a very slight change, but you won't hear it in normal listening.

---

## Watermark & Security

### Can someone remove the watermark?

Technically yes, but with trade-offs:

- **Low-pass filter**: Removes high frequencies (watermark lives there) but kills audio quality (sounds muffled)
- **Source separation**: Isolates vocals but loses acoustic richness
- **Re-synthesis**: Complete re-generation loses all proof but sounds unnatural (different voice)

**Bottom line**: Removing watermarks without audible degradation is hard. Even if watermark evidence is lost, VRI's fingerprinting forensic layer can still flag the audio as similar to the original.

### What if someone steals my private key?

VRI's mitigations:

1. **Private keys stored in HSMs** (hardware security modules), never in plain memory
2. **Key rotation**: Annual automatic rotation + emergency rotation on suspicion
3. **Audit logs**: All signing operations logged, anomalies trigger alerts
4. **Revocation**: You can revoke old keys, making old signatures detectable as compromised

**If compromise is detected**: You can immediately revoke the key. New signatures use new key. Old signatures remain valid (ledger is immutable) but marked as compromised.

### Can VRI be hacked?

VRI has multiple security layers:

1. **Watermarks**: Hard to remove without quality loss
2. **EdDSA signatures**: Cryptographically unforgeable (no known attacks)
3. **Ledger**: Write-once, anchored to blockchain (immutable)
4. **Fingerprinting forensic layer**: Even watermark-less audio can still be investigated for similarity

Like any system, VRI can be attacked. But each layer has independent protections. An attacker would need to breach multiple layers simultaneously, which is infeasible.

---

## Generation & Watermarking

### How long does watermarking take?

Typical: 2–3 seconds for a 10-minute podcast episode.

- Extraction: ~200ms
- Embedding: ~2s for ~500MB audio
- Signing: ~50ms
- Ledger logging: ~100ms

Total: Usually < 5 seconds end-to-end.

### Does watermarking reduce audio quality?

No. VRI uses perceptual masking to hide the watermark in the psychoacoustic "deaf spots" where human ears can't detect it.

**Quality metrics**:
- SNR: > 40dB (imperceptible)
- No audible artifacts
- No frequency response changes
- MP3 @ 128kbps or higher: Watermark is typically still recoverable under normal conditions

### What TTS models are supported?

- OpenAI TTS ✅
- ElevenLabs ✅
- Google Cloud TTS ✅
- Microsoft Azure Speech ✅
- Custom/local models ✅

Any TTS model works. VRI watermarks the output, not the model itself.

### Can I regenerate the same text with different output?

Yes, but:

- If you use same TTS model + voice + settings → Same audio hashes → VRI consolidates as single voice
- If you use different settings (speed, pitch) → Different audio → Different hashes → Logged as separate events

**Recommendation**: For the same voice, use consistent generation settings. You'll get more accurate usage analytics.

---

## Verification & Proof

### How do I verify that audio uses my voice?

**If you have the proof package** (JSON):
```javascript
const result = await vri.verify({
  audioUrl: 'https://youtube.com/audio.wav',
  proofPackage: {...}
});
```

Result: `verified: true/false`

**Without proof package**:
```javascript
const result = await vri.verify({
  audioUrl: 'https://youtube.com/audio.wav'
});
```

If watermark in audio: `verified: true`
If no watermark but acoustic match: `fingerprint_matches: [...]`

### What does "verified=false" mean?

Two scenarios:

1. **Watermark not found**: Audio doesn't contain recognizable VRI watermark (either removed, or not watermarked)
2. **Signature invalid**: Watermark found but signature check failed (audio tampered)

In both cases, you fall back to fingerprinting, which provides probabilistic (not cryptographic) evidence.

### Can verification work offline?

Yes. If you have the proof package, you can verify without querying VRI API:

```javascript
// Offline verification
const valid = vri.verifySignature(
  watermarkPayload,
  signature,
  publicKey
);
```

This checks the cryptographic signature locally. Only requires the proof package.

**Full verification** (with ledger check) requires API connection.

### How long does verification take?

**Critical path** (watermark present): ~300–400ms
**Forensic path** (fingerprinting): ~1–2s

Typically completes in < 500ms.

---

## Royalties & Payments

### How much do I earn per use?

Depends on platform and context:

```
YouTube:    $0.001 per view (×2 if commercial)
Spotify:    $0.0003 per stream
TikTok:     $0.0002 per video use
Podcast:    $0.00005 per download
```

**Examples**:
- YouTube video with 50k views: ~$100 (or $200 if commercial)
- Spotify track with 100k streams: ~$30
- TikTok video with 1k uses: ~$0.20

### When do I get paid?

Royalties accrue in real-time:
1. Audio verified
2. Usage event logged to ledger
3. Wallet balance updated immediately

**Settlement**: Request payout anytime. Min $10, typically processes within 1–2 days (Stripe/ACH) or 1 minute (crypto).

### Can I see earnings per platform?

Yes. Dashboard shows:
- Total earnings (lifetime)
- Earnings per platform (YouTube, Spotify, etc.)
- Earnings by geography
- Earnings trend over time

### Do I have to pay taxes on my earnings?

Yes. VRI operates like a contractor payment system.

- **US creators**: Form 1099-NEC issued if earnings > $600/year
- **Non-US creators**: Withholding per country agreements
- **You're responsible for** reporting income in your country's tax system

VRI provides tax documents, but consult a tax professional.

### What are the payout fees?

**Stripe/ACH**: 2% processing fee (VRI covers most of the cost; you pay the difference in lower rates)  
**Crypto (Polygon/Solana)**: < 1% conversion spread  
**Bank transfer**: Minimal

**Bottom line**: You keep ~98% of your earnings. VRI takes small fee to cover payment processing.

---

## Fingerprinting

### What is fingerprinting? How is it different from watermarks?

| Aspect | Watermark | Fingerprint |
|--------|-----------|------------|
| **Proof** | Cryptographic | Probabilistic |
| **Embeds data** | Yes (proof packet) | No (acoustic features only) |
| **After removal attempts** | May become unrecoverable with quality loss | Still useful for forensic similarity analysis |
| **Spoofing risk** | None (signature unforgeable) | Yes (voice can be cloned) |
| **Use case** | Prove authorship | Detect similar audio |

### Is fingerprinting as good as watermarks?

**No**. Fingerprinting is a forensic detection layer:

✅ **Good for**: Detecting suspicious copies even if watermark removed  
❌ **Bad for**: Proving authorship (anyone with similar voice is match)

If watermark exists, always use cryptographic proof. Use fingerprinting only when watermark is lost.

### What if someone voice clones me?

VRI can detect it's similar (fingerprinting), but **cannot prove who created it**. 

Legal remedies:
1. You prove prior creation date via ledger timestamp
2. Platform (YouTube, Spotify) uses Content ID to block clones
3. Legal action (copyright, personality rights)

This is an asymmetric threat — easier to clone than to detect. VRI provides evidence, but human judgment (courts, platforms) is needed.

---

## Data & Privacy

### What data does VRI store about me?

**Stored**:
- Creator ID + public key
- Payment address (wallet)
- Usage events (platform, timestamp, views, etc.)
- Wallet balance + transaction history
- Audit logs

**Not stored**:
- Your voice biometrics (no speaker recognition)
- Payee personal information (only payment address)
- Metadata you don't provide

### Is my data safe?

- **Encryption in transit**: TLS/HTTPS for all API calls
- **Encryption at rest**: AES-256 for sensitive fields (addresses, keys)
- **Access control**: IAM policies, only VRI services can access
- **Audit log**: All access logged for compliance

### Can VRI track where my voice is used?

Only **after you verify it**. VRI doesn't proactively scan the internet for your voice. You (or a platform) must submit audio to verification endpoint.

**Privacy note**: Verification is optional. You can generate watermarked audio and not verify it — you just won't get paid (and we won't know it's being used).

### GDPR/Privacy compliance?

VRI is designed GDPR-compliant:
- ✅ No facial/voice biometrics (only audio features)
- ✅ Data minimization (only what's needed)
- ✅ Right to deletion (can request account + data removal)
- ✅ Data portability (export transaction history)

**Ledger exception**: Usage events are **immutable** (required for payment proof). You can request removal, but historical entries append a "deleted" flag (not erased).

---

## Troubleshooting

### Watermark not detected in my audio

**Possible causes**:
1. **Audio heavily compressed** (MP3 @ 64kbps): LDPC decoding fails, falls back to fingerprinting
2. **Audio heavily filtered** (aggressively EQ'd): Watermark energy too low
3. **Re-recorded** (played through speaker, re-recorded mic): High noise floor
4. **Intentionally removed** (source separation, re-synthesis)

**Solutions**:
- Check original audio (before any processing)
- Verify in VRI dashboard (shows watermark confidence)
- Fall back to fingerprinting (if acoustic match available)
- Contact support with audio sample

### Signature verification failing

**Possible causes**:
1. **Metadata mismatch**: Canonical JSON format changed
2. **Timestamp out of bounds**: Server clock skew
3. **Wrong public key**: Using old/rotated key
4. **Audio corrupted**: Watermark payload changed during transmission

**Solutions**:
- Check proof package metadata matches audio context
- Sync local clock with NTP server
- Query creator's current public key from ledger
- Re-download audio from original source

### Settlement delayed

**Possible causes**:
1. **Payment processor queue**: Stripe/ACH batches processed once daily
2. **KYC pending**: Need to submit government ID
3. **Suspicious activity**: Fraud check in progress
4. **Bank processing**: ACH can take 1–3 business days

**Solutions**:
- Check dashboard for status
- Complete KYC if pending
- Contact support
- For Stripe: Usually completes next business day

### I think I found a security vulnerability

**Don't post publicly**. Email security@vri.app with:
- Description
- Steps to reproduce
- Potential impact
- Suggested fix

We'll investigate and credit you if valid.

---

## Technical Deep-Dives

### How is the watermark designed to remain recoverable after MP3 compression?

MP3 @ 96kbps is lossy, so some watermark bits are lost. But VRI uses **LDPC error-correcting codes** (4x redundancy) to recover them.

**Typical post-MP3 robustness**:
- SNR after extraction: 30–35 dB
- Bit error rate: 6–10%
- LDPC correction: Recovers all bits

### Can I remove the watermark without quality loss?

Theoretically: No. The watermark is embedded in the audio, and removing it requires changing the audio (quality loss).

Practically: You'd need to:
1. **Re-synthesize audio** (generates "new" audio, loses watermark)
2. **Aggressive filtering** (kills quality)
3. **Source separation** (loses acoustic richness)

All involve trade-offs.

### How are signatures protected against replay attacks?

The signature covers a timestamp, so replaying the same signature with a different timestamp invalidates it.

```
signature = Sign(watermark_payload + timestamp + metadata)

If attacker tries:
  - New signature needed if timestamp changed
  - Signature forge requires private key (cryptographically hard)
```

### How often are merkle roots anchored?

Every **10 minutes** (or when batch >10k events), whichever comes first.

Trade-off:
- **More frequent**: Higher blockchain costs
- **Less frequent**: Slower finality for royalties

10-minute batches balance cost and speed.

---

## For Developers

### How do I integrate VRI into my platform?

1. **Install SDK**: `npm install @vri/sdk` (or Python, Go, Rust)
2. **Init client**: `const vri = new VRI({apiKey: '...'})`
3. **Verify audio**: `await vri.verify({audioUrl, proofPackage})`
4. **Log royalties**: VRI handles wallet updates
5. **Pay creators**: Use VRI settlement API or directly integrate Stripe

See [examples/](../examples/) for code samples.

### What's the API rate limit?

1,000 req/min for standard tier. Upgrade to pro (10k/min) for higher volume.

### Can I self-host VRI?

Not currently. VRI is a hosted service (SaaS model). Watermark daemon requires HSM for key management.

**Future**: Will offer on-premise licensing for enterprise customers.

### What's in your roadmap?

**Q2 2026**: Fingerprinting forensic detection layer (in development)  
**Q3 2026**: Stronger external anchoring options (Ethereum-based publication)  
**Q4 2026**: Creator marketplace (monetize templates)  
**2027**: Multi-model training (voice cloning detection)  
**2028**: Post-quantum cryptography migration

---

## Support

**Documentation**: [docs/](../)  
**Email**: support@vri.app  
**Discord**: https://discord.gg/vri  
**Status**: https://status.vri.app  
**Twitter**: @VRIHq

---

**Last updated**: March 31, 2026
