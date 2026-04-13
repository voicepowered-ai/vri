 
<p align="center">
  <img src="https://raw.githubusercontent.com/voicepowered-ai/vri/main/assets/banner.png" width="100%" alt="VRI Protocol Banner">
</p>

# VRI Protocol 🛡️🎙️
> **Voice Recording Integrity** — The open standard for authentic, verifiable, and tamper-proof audio evidence.

## Overview
In an era of deepfakes and advanced audio manipulation, proving the authenticity of a voice recording is critical. The **VRI Protocol** provides a multi-layered security framework to certify that an audio file is original, captured at a specific time, and has not been altered.

The protocol establishes a **Chain of Trust** by combining three core pillars:
1. **Cryptographic Anchoring:** Linking audio data to RFC 3161 Trusted Timestamps.
2. **Stealth Watermarking:** Embedding forensic data directly into the audio signal.
3. **Immutable Logging:** Maintaining a verifiable audit trail of every recording session.



## 🏗️ Architecture
The VRI ecosystem is modular, allowing developers to use specific parts of the protocol or the full stack:

* **`@vri-protocol/core`**: The brain. Handles hashing algorithms and manages Trust Profiles (TSA authorities).
* **`@vri-protocol/watermark`**: The forensic layer. Uses Digital Signal Processing (DSP) to hide integrity metadata within the sound itself.
* **`@vri-protocol/ledger`**: The memory. Stores and verifies the sequence of events and cryptographic proofs.
* **`@vri-protocol/cli`**: The toolkit. A command-line interface for manual verification and batch processing.

## 🛠 How it Works
1. **Capture & Hash:** As audio is recorded, the `core` generates a unique cryptographic fingerprint.
2. **Seal:** The hash is sent to a Trusted Timestamping Authority (TSA) to prove *when* it existed.
3. **Embed:** The `watermark` engine hides the proof inside the audio, making the file self-verifying.
4. **Register:** The `ledger` records the metadata for future legal or forensic audits.

## 🚀 Getting Started

### Prerequisites
- **Node.js** (v18 or higher)
- **pnpm** (v8+)

### Installation
```bash
# Install the entire workspace dependencies
pnpm install