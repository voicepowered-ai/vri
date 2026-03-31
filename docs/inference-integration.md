# VRI Inference Integration: Embedding Ownership Into Generation

This document defines the technical architecture for integrating Voice Rights Infrastructure (VRI) directly into AI text-to-speech (TTS) inference pipelines, ensuring that every audio generation is automatically watermarked, signed, and registered.

**Key Principle**: VRI operates at generation time, not distribution time. The watermark is embedded as the final step of the inference process.

---

## 1. Inference Integration Model

### 1.1 Core Principle

VRI integration transforms a traditional TTS pipeline:

```
User Input → Model → Audio Output → Copy/Share
```

Into a rights-native pipeline:

```
User Input → Model → Watermark Daemon → Signing Service → Ledger Registration → Output
             └──────────────────────────────────────────────────────────────────────┘
                              VRI Inference Integrated
```

### 1.2 Integration Points

VRI can integrate at three architectural levels:

#### **Level 1: Post-Inference Wrapping (Minimal Coupling)**

```
┌─────────────────────────────────────────────────────────────┐
│ Inference Engine                                              │
│  ┌───────────────────────────────────────────┐               │
│  │ TTS Model (Coqui, ElevenLabs, Custom)    │               │
│  │       text → waveform (raw, unsigned)    │               │
│  └───────────────────────────────────────────┘               │
│                        ↓                                      │
│  ┌───────────────────────────────────────────┐               │
│  │ VRI Inference Adapter (this document)    │               │
│  │  • Intercept waveform                     │               │
│  │  • Watermark injection                    │               │
│  │  • Signing                                │               │
│  │  • Ledger registration                    │               │
│  └───────────────────────────────────────────┘               │
│                        ↓                                      │
│  Output: Audio + Proof Package (watermarked, signed)         │
└─────────────────────────────────────────────────────────────┘
```

**Advantage**: Works with any TTS engine (custom, commercial, open-source)
**Disadvantage**: Post-processing latency, no model visibility

#### **Level 2: Model-Integrated Watermarking (Tight Coupling)**

```
┌────────────────────────────────────────────────────────────┐
│ Custom TTS Pipeline                                          │
│  ┌────────────────────────────────────────────────────┐    │
│  │ Spectrogram Generation (mel-scale)                 │    │
│  │         text → features → decoder                  │    │
│  └────────────────────────────────────────────────────┘    │
│                        ↓                                    │
│  ┌────────────────────────────────────────────────────┐    │
│  │ VRI Watermark Injection (in-model)                 │    │
│  │  • Modify spectrogram before vocoder               │    │
│  │  • Inject watermark during synthesis               │    │
│  │  • Preserve audio quality (phase control)          │    │
│  └────────────────────────────────────────────────────┘    │
│                        ↓                                    │
│  ┌────────────────────────────────────────────────────┐    │
│  │ Vocoder (convert spectrogram → PCM)                │    │
│  └────────────────────────────────────────────────────┘    │
│                        ↓                                    │
│  Output: Watermarked Audio (signed externally)              │
└────────────────────────────────────────────────────────────┘
```

**Advantage**: Minimal latency, watermark placement optimized
**Disadvantage**: Requires model modification, harder with external APIs

#### **Level 3: Hardware-Level Integration (Maximum Control)**

```
┌─────────────────────────────────────────────────────────────┐
│ GPU-Accelerated Inference with VRI                           │
│  ┌───────────────────────────────┐                           │
│  │ CUDA Kernel: TTS Model        │                           │
│  │ (NVIDIA GPU)                  │                           │
│  └───────────────────────────────┘                           │
│           ↓ (GPU memory)                                      │
│  ┌───────────────────────────────┐                           │
│  │ CUDA Kernel: Watermark        │                           │
│  │ Injection (DSP on GPU)        │                           │
│  └───────────────────────────────┘                           │
│           ↓ (GPU → CPU)                                      │
│  ┌───────────────────────────────┐                           │
│  │ CPU: Signing Service          │                           │
│  │ (EdDSA, HSM-backed)           │                           │
│  └───────────────────────────────┘                           │
│                                                               │
│  Output: Audio + Proof Package                               │
└─────────────────────────────────────────────────────────────┘
```

**Advantage**: Maximum throughput, minimal PCM copies
**Disadvantage**: Complex, requires GPU support development

### 1.3 Synchronous vs Asynchronous Pipelines

#### **Synchronous (Blocking)**

```
User Request
    ↓
[Generate Audio] 300ms
    ↓
[Watermark] 80ms
    ↓
[Sign] 20ms
    ↓
[Register Ledger] 50ms
    ↓
Return to Client (450ms total)
```

**Use Case**: Real-time API calls (user-facing endpoints)
**Latency Budget**: <500ms
**Concurrency**: Limited by single-threaded inference

#### **Asynchronous (Non-blocking)**

```
User Request
    ↓
[Generate Audio] 300ms (return async token)
    ↓
[Watermark] 80ms (background queue)
    ↓
[Sign] 20ms (background queue)
    ↓
[Register Ledger] 50ms (background queue)
    ↓
[Notify User] via webhook/poll (eventually consistent)
```

**Use Case**: Batch generation, offline processing, deployment integration
**Latency**: Unbounded (minutes acceptable)
**Concurrency**: Unlimited via queue scaling

#### **Streaming (Chunked)**

```
User Request
    ↓
[TTS Model] → Streaming output (chunks every 100ms)
    ↓
[Watermark Chunks]: Watermark injected per-chunk
    ↓
[Buffer Strategy]: Hold 2-second buffer for signature computation
    ↓
[Incremental Signing]: Hash accumulator updated per chunk
    ↓
[Final Signature]: Computed once full audio arrives
    ↓
[Return Chunks] + [Queue Ledger Registration]
```

**Use Case**: Real-time streaming endpoints, live voice generation
**Latency**: Streaming latency only (no watermark delay)
**Complexity**: High (state management across chunks)

---

## 2. VRI Inference Adapter Design

The **VRI Inference Adapter** is the core component that intercepts model output and orchestrates watermarking, signing, and registration.

### 2.1 Adapter Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ VRI Inference Adapter                                         │
│                                                               │
│ ┌────────────────────────────────────────────────────┐       │
│ │ Interception Layer                                  │       │
│ │  • Intercept model output (PCM, float, mono/stereo)│       │
│ │  • Buffer management (max 1GB)                      │       │
│ │  • Format validation                               │       │
│ └────────────────────────────────────────────────────┘       │
│                          ↓                                    │
│ ┌────────────────────────────────────────────────────┐       │
│ │ Watermark Orchestrator                              │       │
│ │  • Dispatch to watermark daemon                     │       │
│ │  • Handle failures (retry logic)                    │       │
│ │  • Track latency metrics                            │       │
│ └────────────────────────────────────────────────────┘       │
│                          ↓                                    │
│ ┌────────────────────────────────────────────────────┐       │
│ │ Signing Orchestrator                                │       │
│ │  • Compute audio hash (SHA256)                      │       │
│ │  • Call signing service (EdDSA)                     │       │
│ │  • Assemble proof package                           │       │
│ └────────────────────────────────────────────────────┘       │
│                          ↓                                    │
│ ┌────────────────────────────────────────────────────┐       │
│ │ Ledger Publisher                                    │       │
│ │  • Enqueue usage event (async)                      │       │
│ │  • Assign ledger anchor (batch)                     │       │
│ │  • Publish to ledger service                        │       │
│ └────────────────────────────────────────────────────┘       │
│                          ↓                                    │
│ Return: (audio, proof_package, metadata)                     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Node.js Interface

```javascript
/**
 * VRI Inference Adapter (Node.js)
 * 
 * Wraps TTS inference with automatic watermarking and signing.
 */

class VRIInferenceAdapter {
  constructor(options = {}) {
    this.watermarkDaemon = new WatermarkDaemon({
      endpoint: options.watermarkEndpoint || 'http://localhost:9000',
      timeout: options.watermarkTimeout || 2000
    });

    this.signingService = new SigningService({
      endpoint: options.signingEndpoint || 'http://localhost:9001',
      timeout: options.signingTimeout || 500
    });

    this.ledgerPublisher = new LedgerPublisher({
      queue: options.queue || 'amqp://localhost',
      batchSize: options.batchSize || 100
    });

    this.metrics = new MetricsCollector();
  }

  /**
   * Wrap any TTS inference function with VRI processing.
   * 
   * @param {Function} inferenceFn - Async function that returns audio buffer
   * @param {Object} options - Model, voice_id, metadata
   * @returns {Promise<{audio, proof_package, duration_ms}>}
   */
  async wrapInference(inferenceFn, options = {}) {
    const startTime = Date.now();
    const requestId = generateUUID();

    try {
      // Step 1: Run inference (user's responsibility)
      const audio = await this._measureTime(
        'inference',
        () => inferenceFn()
      );

      if (!audio || audio.length === 0) {
        throw new Error('Inference returned empty audio');
      }

      // Step 2: Watermark audio
      const watermarked = await this._measureTime(
        'watermarking',
        () => this._watermarkAudio(audio, requestId, options)
      );

      // Step 3: Compute hash and sign
      const { audioHash, proof } = await this._measureTime(
        'signing',
        () => this._signAudio(watermarked, options)
      );

      // Step 4: Register usage event (async, fire-and-forget)
      this._registerUsageEvent(requestId, audio.length, audioHash, options);

      const totalDuration = Date.now() - startTime;

      return {
        audio: watermarked,
        proof_package: proof,
        duration_ms: totalDuration,
        request_id: requestId,
        voiceId: options.voiceId,
        model: options.model
      };

    } catch (error) {
      this.metrics.recordError('vri_inference_wrapper', error);
      throw error;
    }
  }

  /**
   * High-level API for common TTS providers.
   * Handles provider-specific audio format conversions.
   */
  async generateVRIAudio(provider, text, options = {}) {
    const inferenceFn = async () => {
      switch (provider) {
        case 'elevenlabs':
          return await this._elevenLabsInference(text, options);
        case 'coqui':
          return await this._coquiInference(text, options);
        case 'openai':
          return await this._openaiInference(text, options);
        default:
          throw new Error(`Unknown provider: ${provider}`);
      }
    };

    return this.wrapInference(inferenceFn, {
      provider,
      voiceId: options.voiceId,
      model: options.model || 'default',
      text: text
    });
  }

  // Private methods

  async _watermarkAudio(audio, requestId, options) {
    const response = await fetch(
      `${this.watermarkDaemon.endpoint}/v1/watermark`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(audio)
      }
    );

    if (!response.ok) {
      throw new Error(`Watermark failed: ${response.statusText}`);
    }

    const watermarked = await response.arrayBuffer();
    return new Float32Array(watermarked);
  }

  async _signAudio(audio, options) {
    // Compute SHA256 hash of watermarked audio
    const audioHash = crypto
      .createHash('sha256')
      .update(Buffer.from(audio))
      .digest('hex');

    // Request signature from signing service
    const response = await fetch(
      `${this.signingService.endpoint}/v1/sign`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioHash,
          voiceId: options.voiceId,
          timestamp: Date.now(),
          metadata: options.metadata || {}
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Signing failed: ${response.statusText}`);
    }

    const { signature, public_key, proof_package } = await response.json();

    return {
      audioHash,
      proof: {
        audio_hash: audioHash,
        signature,
        public_key,
        timestamp: Date.now(),
        ...proof_package
      }
    };
  }

  async _registerUsageEvent(requestId, audioBytes, audioHash, options) {
    // Enqueue async ledger event (non-blocking)
    const event = {
      request_id: requestId,
      voice_id: options.voiceId,
      audio_hash: audioHash,
      duration_seconds: audioBytes / (44100 * 4), // assuming 44.1kHz, 32-bit
      timestamp: Date.now(),
      model: options.model,
      metadata: options.metadata
    };

    // Fire-and-forget to queue
    this.ledgerPublisher.enqueue(event).catch(err => {
      this.metrics.recordError('ledger_enqueue', err);
      // Don't throw—audio already returned
    });
  }

  async _measureTime(label, fn) {
    const start = Date.now();
    const result = await fn();
    const duration = Date.now() - start;
    this.metrics.recordLatency(label, duration);
    return result;
  }

  // Provider-specific inference implementations

  async _elevenLabsInference(text, options) {
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech', {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        voice_id: options.voiceId || 'default',
        model_id: 'eleven_monolingual_v1'
      })
    });

    const audio = await response.arrayBuffer();
    return new Float32Array(audio);
  }

  async _coquiInference(text, options) {
    // Local Coqui TTS inference via Python subprocess
    const result = await this._pythonSubprocess('tts_inference.py', {
      text,
      language: options.language || 'en',
      voice_id: options.voiceId
    });

    return new Float32Array(result.audio);
  }

  async _openaiInference(text, options) {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: options.voiceId || 'alloy'
      })
    });

    const audio = await response.arrayBuffer();
    return new Float32Array(audio);
  }
}

module.exports = VRIInferenceAdapter;
```

### 2.3 Python Interface

```python
"""
VRI Inference Adapter (Python)

Integrates with local TTS models (Coqui, bark, glow-tts) and external APIs.
"""

import asyncio
import hashlib
import httpx
import numpy as np
import uuid
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Tuple
from enum import Enum

class AudioFormat(Enum):
    FLOAT32 = "float32"  # [-1.0, 1.0]
    PCM16 = "pcm16"       # [-32768, 32767]
    PCM24 = "pcm24"

@dataclass
class VRIAudioOutput:
    """Result of VRI-integrated inference."""
    audio: np.ndarray
    proof_package: Dict
    duration_ms: float
    request_id: str
    voice_id: str
    model: str

class VRIInferenceAdapter:
    """
    Wraps TTS inference with automatic watermarking, signing, and registration.
    
    Usage:
        adapter = VRIInferenceAdapter()
        result = await adapter.wrap_inference(
            inference_fn=my_tts_model,
            options={'voice_id': 'speaker_001', 'model': 'tts-1'}
        )
    """

    def __init__(self, config: Dict = None):
        self.config = config or {}
        
        self.watermark_endpoint = self.config.get(
            'watermark_endpoint', 'http://localhost:9000'
        )
        self.signing_endpoint = self.config.get(
            'signing_endpoint', 'http://localhost:9001'
        )
        self.ledger_queue_url = self.config.get(
            'ledger_queue_url', 'amqp://localhost'
        )
        
        self.http_client = httpx.AsyncClient(timeout=30.0)
        self.metrics = MetricsCollector()

    async def wrap_inference(
        self,
        inference_fn: Callable,
        options: Dict = None
    ) -> VRIAudioOutput:
        """
        Wrap any TTS inference function with VRI processing.
        
        Args:
            inference_fn: Async function returning audio numpy array
            options: { voice_id, model, metadata, ... }
        
        Returns:
            VRIAudioOutput with audio, proof package, and metadata
        """
        options = options or {}
        request_id = str(uuid.uuid4())
        start_time = asyncio.get_event_loop().time()

        try:
            # Step 1: Run inference
            audio = await self._measure_time(
                'inference',
                self._run_inference_safe(inference_fn)
            )

            # Step 2: Watermark
            watermarked = await self._measure_time(
                'watermarking',
                self._watermark_audio(audio, request_id, options)
            )

            # Step 3: Sign
            audio_hash, proof = await self._measure_time(
                'signing',
                self._sign_audio(watermarked, options)
            )

            # Step 4: Queue usage event (fire-and-forget)
            asyncio.create_task(
                self._register_usage_event(
                    request_id, audio, audio_hash, options
                )
            )

            duration_ms = (asyncio.get_event_loop().time() - start_time) * 1000

            return VRIAudioOutput(
                audio=watermarked,
                proof_package=proof,
                duration_ms=duration_ms,
                request_id=request_id,
                voice_id=options.get('voice_id', 'unknown'),
                model=options.get('model', 'default')
            )

        except Exception as e:
            self.metrics.record_error('vri_inference_wrapper', str(e))
            raise

    async def generate_vri_audio(
        self,
        provider: str,
        text: str,
        options: Dict = None
    ) -> VRIAudioOutput:
        """
        High-level API for common TTS providers.
        
        Args:
            provider: 'elevenlabs', 'coqui', 'openai'
            text: Input text to synthesize
            options: Provider-specific options
        
        Returns:
            VRIAudioOutput
        """
        options = options or {}
        
        inference_map = {
            'elevenlabs': self._elevenlabs_inference,
            'coqui': self._coqui_inference,
            'openai': self._openai_inference
        }

        if provider not in inference_map:
            raise ValueError(f"Unknown provider: {provider}")

        inference_fn = lambda: inference_map[provider](text, options)

        return await self.wrap_inference(
            inference_fn,
            {
                'provider': provider,
                'voice_id': options.get('voice_id'),
                'model': options.get('model', 'default'),
                'text': text
            }
        )

    # Private methods

    async def _watermark_audio(
        self,
        audio: np.ndarray,
        request_id: str,
        options: Dict
    ) -> np.ndarray:
        """Call watermark daemon to inject inaudible marker."""
        audio_bytes = audio.astype(np.float32).tobytes()

        response = await self.http_client.post(
            f"{self.watermark_endpoint}/v1/watermark",
            content=audio_bytes,
            headers={'Content-Type': 'application/octet-stream'}
        )

        if response.status_code != 200:
            raise Exception(f"Watermarking failed: {response.text}")

        watermarked_bytes = response.content
        return np.frombuffer(watermarked_bytes, dtype=np.float32)

    async def _sign_audio(
        self,
        audio: np.ndarray,
        options: Dict
    ) -> Tuple[str, Dict]:
        """Compute hash and get EdDSA signature."""
        # SHA256 hash of watermarked audio
        audio_hash = hashlib.sha256(audio.tobytes()).hexdigest()

        # Request signature
        response = await self.http_client.post(
            f"{self.signing_endpoint}/v1/sign",
            json={
                'audio_hash': audio_hash,
                'voice_id': options.get('voice_id'),
                'timestamp': int(asyncio.get_event_loop().time() * 1000),
                'metadata': options.get('metadata', {})
            }
        )

        if response.status_code != 200:
            raise Exception(f"Signing failed: {response.text}")

        proof_data = response.json()

        return audio_hash, {
            'audio_hash': audio_hash,
            'signature': proof_data['signature'],
            'public_key': proof_data['public_key'],
            'timestamp': proof_data.get('timestamp'),
            **proof_data.get('proof_package', {})
        }

    async def _register_usage_event(
        self,
        request_id: str,
        audio: np.ndarray,
        audio_hash: str,
        options: Dict
    ) -> None:
        """Queue usage event to ledger (async, non-blocking)."""
        try:
            duration_seconds = len(audio) / 44100  # assume 44.1kHz

            event = {
                'request_id': request_id,
                'voice_id': options.get('voice_id'),
                'audio_hash': audio_hash,
                'duration_seconds': duration_seconds,
                'timestamp': int(asyncio.get_event_loop().time() * 1000),
                'model': options.get('model'),
                'metadata': options.get('metadata', {})
            }

            # Enqueue to ledger service
            await self._enqueue_to_ledger(event)

        except Exception as e:
            # Don't fail the inference—just log
            self.metrics.record_error('ledger_enqueue', str(e))

    async def _run_inference_safe(self, fn: Callable) -> np.ndarray:
        """Run inference safely with error handling."""
        if asyncio.iscoroutinefunction(fn):
            return await fn()
        else:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, fn)

    async def _measure_time(self, label: str, coro):
        """Measure execution time of async operation."""
        start = asyncio.get_event_loop().time()
        result = await coro
        duration_ms = (asyncio.get_event_loop().time() - start) * 1000
        self.metrics.record_latency(label, duration_ms)
        return result

    async def _enqueue_to_ledger(self, event: Dict) -> None:
        """Publish event to ledger queue (RabbitMQ/SQS)."""
        # Implementation depends on queue system (RabbitMQ, SQS, Kafka, etc.)
        # Example: pika for RabbitMQ
        pass

    # Provider-specific implementations

    async def _elevenlabs_inference(self, text: str, options: Dict) -> np.ndarray:
        """Call ElevenLabs API."""
        response = await self.http_client.post(
            'https://api.elevenlabs.io/v1/text-to-speech',
            headers={'xi-api-key': os.getenv('ELEVENLABS_API_KEY')},
            json={
                'text': text,
                'voice_id': options.get('voice_id', 'default'),
                'model_id': 'eleven_monolingual_v1'
            }
        )
        audio_bytes = response.content
        return np.frombuffer(audio_bytes, dtype=np.float32)

    async def _coqui_inference(self, text: str, options: Dict) -> np.ndarray:
        """Local Coqui inference via subprocess."""
        import subprocess
        result = subprocess.run([
            'python', 'coqui_tts_inference.py',
            '--text', text,
            '--voice_id', options.get('voice_id', 'default')
        ], capture_output=True)

        audio_bytes = result.stdout
        return np.frombuffer(audio_bytes, dtype=np.float32)

    async def _openai_inference(self, text: str, options: Dict) -> np.ndarray:
        """Call OpenAI TTS API."""
        response = await self.http_client.post(
            'https://api.openai.com/v1/audio/speech',
            headers={'Authorization': f"Bearer {os.getenv('OPENAI_API_KEY')}"},
            json={
                'model': 'tts-1',
                'input': text,
                'voice': options.get('voice_id', 'alloy')
            }
        )
        audio_bytes = response.content
        return np.frombuffer(audio_bytes, dtype=np.float32)

class MetricsCollector:
    """Simple metrics collection for latency and errors."""
    def __init__(self):
        self.latencies = {}
        self.errors = []

    def record_latency(self, label: str, duration_ms: float):
        if label not in self.latencies:
            self.latencies[label] = []
        self.latencies[label].append(duration_ms)

    def record_error(self, label: str, error: str):
        self.errors.append({'label': label, 'error': error})
```

---

## 3. Watermark Insertion Pipeline

### 3.1 Where Watermark is Applied

The watermark is injected as a **post-processing step** after the model generates raw audio:

```
Text Input
    ↓
Tokenize
    ↓
TTS Model (spectrogram or waveform)
    ↓
Vocoder (if model outputs spectrogram)
    ↓
[RAW PCM AUDIO]  ← this is the critical point
    ↓
Watermark Insertion ← VRI enters here
    ↓
[WATERMARKED AUDIO]
    ↓
Signing
    ↓
Output
```

### 3.2 Audio Buffer Handling

#### **Format Standardization**

Different models output different audio formats:

| Model | Output Format | Sample Rate | Bit Depth |
|-------|---------------|-------------|-----------|
| Coqui TTS | Float32 [-1, 1] | 22.05 kHz | 32-bit |
| ElevenLabs API | PCM 16-bit | 24 kHz | 16-bit |
| OpenAI TTS | MP3 | 24 kHz | 16-bit |
| Bark | Float32 [-1, 1] | 24 kHz | 32-bit |

VRI Adapter must **normalize to a canonical format**:

```
Canonical Format:
  - Float32 PCM [-1.0, 1.0]
  - 44.1 kHz sample rate
  - Mono (mix to mono if stereo)
  - No compression
```

#### **Memory-Efficient Streaming**

For long audio (>60 seconds):

```
Input: RAW_AUDIO (large buffer, may exceed 1GB for 10min audio)
    ↓
Chunk: [0:2s], [2s:4s], [4s:6s], ...
    ↓
Process Each Chunk:
  - Load into watermark daemon
  - Get watermarked chunk back
  - Append to output buffer
  ↓
Output: WATERMARKED_AUDIO
```

**Buffer Management**:

```python
def process_audio_with_streaming_watermark(audio: np.ndarray) -> np.ndarray:
    """Process large audio in 2-second chunks."""
    sample_rate = 44100
    chunk_size = 2 * sample_rate  # 2-second chunks
    output = []

    for i in range(0, len(audio), chunk_size):
        chunk = audio[i:i+chunk_size]
        
        # Watermark this chunk
        watermarked_chunk = watermark_daemon.watermark(chunk)
        
        output.append(watermarked_chunk)

    return np.concatenate(output)
```

### 3.3 Latency Minimization

#### **Latency Budget**

| Component | Target | Notes |
|-----------|--------|-------|
| Model Inference | 300ms | User's responsibility |
| Audio Normalization | 5ms | CPU-bound |
| Watermark Injection | 80ms | DSP-bound (STFT, LDPC) |
| Hash Computation | 20ms | CPU-bound |
| Signature Generation | 20ms | Crypto-bound |
| Ledger Enqueue | <1ms | Non-blocking (async) |
| **Total** | **<500ms** | Synchronous critical path |

#### **Optimization Strategies**

1. **Parallel Watermarking & Hashing** (when possible):

```python
async def optimized_post_processing(audio):
    """Hash and watermark in parallel."""
    # Start watermarking immediately
    watermark_task = asyncio.create_task(
        watermark_daemon.watermark(audio)
    )
    
    # Hash computation is cheap, start early
    audio_hash = compute_hash(audio)
    
    # Wait for watermarking
    watermarked = await watermark_task
    
    # Now sign (uses hash computed earlier)
    signature = signing_service.sign(audio_hash)
    
    return watermarked, signature
```

2. **GPU Acceleration for Watermarking**:

If using CUDA-capable watermark daemon:

```python
# Watermark daemon configured to use GPU:9000
watermark_endpoint = 'http://localhost:9000'  # CUDA-accelerated

# On NVIDIA A100:
# - 2-second audio watermarking: 8ms
# - Throughput: 250 audio-gen/sec on single card
```

3. **Caching of Public Keys**:

```python
class SigningService:
    def __init__(self):
        self.public_key_cache = {}  # voice_id → public_key
        self.cache_ttl = 3600  # 1 hour
    
    async def sign(self, audio_hash, voice_id):
        # Signing requires public key lookup
        # Cache to avoid repeated lookups
        public_key = await self._get_public_key(voice_id)
        return EdDSA_Sign(private_key, audio_hash)
```

### 3.4 Streaming Watermarking

For real-time streaming audio (speech-to-speech, live TTS):

```
User Stream
    ↓
TTS Model (generates chunks incrementally)
    ↓
Chunk 1 [0-100ms]: Watermark & queue
    ↓
Chunk 2 [100-200ms]: Watermark & queue
    ↓
Chunk 3 [200-300ms]: Watermark & queue
    ↓
(...continuous stream...)
    ↓
Output Stream (with chunks watermarked live)
```

**Challenge**: Audio signature requires the entire watermarked audio to compute hash.

**Solution**: Incremental signature using hash accumulators:

```
Watermark Stream
    ↓
Chunk 1: Watermark, compute partial hash
    ↓
Chunk 2: Watermark, update hash with new chunk
    ↓
Chunk N (final): Watermark, finalize hash
    ↓
Sign(final_hash)
```

Implementation:

```python
class StreamingWatermarkPipeline:
    def __init__(self):
        self.hash_state = hashlib.sha256()  # Incremental hasher
        self.signed = False
    
    async def process_chunk(self, chunk: np.ndarray) -> np.ndarray:
        """Process one chunk of streaming audio."""
        # Watermark chunk
        watermarked_chunk = await self.watermark_daemon.watermark(chunk)
        
        # Update hash incrementally
        self.hash_state.update(watermarked_chunk.tobytes())
        
        # Return watermarked chunk immediately (streaming output)
        return watermarked_chunk
    
    async def finalize(self) -> Dict:
        """Called when stream ends. Generates signature."""
        final_hash = self.hash_state.hexdigest()
        signature = await self.signing_service.sign(final_hash)
        
        self.signed = True
        return {'hash': final_hash, 'signature': signature}
```

---

## 4. Signing Pipeline

### 4.1 Hash Computation Timing

```
Decision: When to compute the audio hash?

Option A: Before watermarking
  Hash(raw_audio) → early computation
  Issue: Signature doesn't cover watermark itself
  Status: ❌ Not recommended

Option B: After watermarking
  Watermark(audio) → Hash(watermarked_audio) → Sign(hash)
  Status: ✅ Recommended (signature proves watermark inclusion)

Option C: Pre-compute while watermarking
  Parallel: Watermark([chunk 1, 2, 3]) + Hash([chunk 1, 2, 3])
  Status: ✅ Optimal (minimizes latency)
```

### 4.2 Signature Generation Workflow

```
┌────────────────────────────────────────┐
│ Signing Service                         │
│                                         │
│ Input: audio_hash (SHA256, 32 bytes)   │
│                                         │
│ ┌──────────────────────────────────┐   │
│ │ 1. Lookup creator's keys         │   │
│ │    voice_id → private_key (HSM)  │   │
│ └──────────────────────────────────┘   │
│           ↓                             │
│ ┌──────────────────────────────────┐   │
│ │ 2. Construct message             │   │
│ │ {                                 │   │
│ │   "audio_hash": 0x...,           │   │
│ │   "voice_id": "creator_001",     │   │
│ │   "timestamp": 1711892400,       │   │
│ │   "metadata": {...}              │   │
│ │ }                                 │   │
│ └──────────────────────────────────┘   │
│           ↓                             │
│ ┌──────────────────────────────────┐   │
│ │ 3. Canonical JSON encoding       │   │
│ │ message_json = sorted keys       │   │
│ └──────────────────────────────────┘   │
│           ↓                             │
│ ┌──────────────────────────────────┐   │
│ │ 4. EdDSA signature               │   │
│ │ sig = Ed25519_Sign(               │   │
│ │  private_key,                    │   │
│ │  SHA256(message_json)            │   │
│ │ )                                 │   │
│ └──────────────────────────────────┘   │
│           ↓                             │
│ ┌──────────────────────────────────┐   │
│ │ 5. Construct proof package       │   │
│ │ {                                 │   │
│ │   "watermark_payload": base64(.),│   │
│ │   "signature": hex(...),         │   │
│ │   "public_key": hex(...),        │   │
│ │   "timestamp": 1711892400,       │   │
│ │   "metadata": {...},             │   │
│ │   "ledger_anchor": null,         │   │
│ │   "verification_endpoint": url   │   │
│ │ }                                 │   │
│ └──────────────────────────────────┘   │
│           ↓                             │
│ Output: proof_package (JSON)            │
└────────────────────────────────────────┘
```

### 4.3 Proof Package Construction

The proof package is the carrier of cryptographic evidence:

```json
{
  "version": "1.0",
  "watermark": {
    "payload": "base64-encoded payload",
    "payload_hex": "0x...",
    "creator_id": "0x2f8b9a...",
    "timestamp": 1711892400,
    "nonce": 42,
    "confidence_extraction": 0.98
  },
  "signature": {
    "value": "0x...",  // 64-byte EdDSA signature
    "algorithm": "EdDSA",
    "curve": "Ed25519",
    "message_hash": "0x..."
  },
  "creator": {
    "public_key": "0x...",
    "voice_id": "creator_001",
    "kyc_verified": true
  },
  "metadata": {
    "model_id": "tts-v3",
    "operation": "voice_synthesis",
    "request_id": "req_123456",
    "tenant_id": "org_789"
  },
  "ledger": {
    "anchor": null,  // Filled during ledger registration
    "batch_id": null,
    "blockchain_tx": null,
    "confirmed": false
  },
  "verification": {
    "endpoint": "https://api.vri.app/v1/verify",
    "flags": {
      "watermark_valid": true,
      "signature_valid": true,
      "ledger_anchored": false
    }
  }
}
```

### 4.4 Key Management Integration

```
Private Key Storage:

Development:
  ~/.vri/keys/voice_id.key (plaintext for testing only)

Production:
  AWS KMS: arn:aws:kms:us-east-1:123456:key/abc123
  Azure Key Vault: https://vault.azure.net/secrets/voice-001
  HSM: Thales Luna, Gemalto, YubiHSM
  Google Cloud KMS: projects/PROJECT/locations/global/keyRings/vri
```

Signing service **never holds keys**—it calls HSM/KMS:

```python
async def sign_with_kms(audio_hash, voice_id):
    """Sign using cloud KMS (AWS, Azure, GCP)."""
    
    # Request signature from KMS (private key never leaves HSM)
    kms_response = await kms_client.sign(
        key_id=f"voice_{voice_id}",
        algorithm='EdDSA',
        message=audio_hash
    )
    
    return kms_response['signature']
```

---

## 5. Usage Event Creation

### 5.1 Event Structure

```typescript
interface UsageEvent {
  // Identity
  event_id: string;              // UUID
  request_id: string;            // Linked to inference request
  voice_id: string;              // creator voice identifier
  
  // Audio Characteristics
  audio_hash: string;            // SHA256(watermarked_audio)
  duration_seconds: number;
  sample_rate: number;           // 44100, 48000, 16000
  
  // Timing
  generated_at: timestamp;       // when audio was generated
  detected_at: timestamp;        // when verification happened (if later)
  
  // Inference Details
  model: string;                 // "coqui-tts-2", "elevenlabs-v2", etc.
  inference_provider: string;    // "internal", "elevenlabs", "openai"
  inference_latency_ms: number;
  
  // Proof
  audio_proof_package: object;   // Full proof package
  watermark_payload: string;     // base64
  signature: string;             // hex(EdDSA)
  
  // Metadata
  metadata: {
    request_id?: string;         // request identifier
    model_id?: string;           // generation model identifier
    tenant_id?: string;          // tenant identifier
    operation?: string;          // "voice_synthesis"
    tags?: string[];
  };
  
  // Ledger
  ledger_batch_id?: string;      // Assigned during registration
  ledger_anchor?: string;        // Hash root after anchoring
  blockchain_tx?: string;        // Ethereum/Solana tx hash
  
  // Status
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;                // if failed
}
```

### 5.2 Event Lifecycle State Machine

```
┌──────────┐
│ PENDING  │  Event created, queued for processing
└────┬─────┘
     ↓
┌──────────────┐
│ PROCESSING   │  Validation, format normalization
└────┬─────────┘
     ↓
┌─────────────────┐
│ BATCHING        │  Accumulated in ledger batch (wait for batch trigger)
└────┬────────────┘
     ├──→ [Batch not full after 10s] ─→ Timeout trigger
     │
     └──→ [Batch reaches 1000 events] ─→ Immediate trigger
           ↓
     ┌──────────────────┐
     │ COMPUTING_ANCHOR │  Merkle hash of all events in batch
     └────┬─────────────┘
          ↓
     ┌──────────────────┐
     │ SUBMITTING_CHAIN │  Send Merkle root to blockchain
     └────┬─────────────┘
          ↓
     ┌──────────────────┐
     │ COMPLETED        │  Blockchain confirmed, ledger immutable
     └──────────────────┘
     
Failure path:
     ┌──────────────────┐
     │ FAILED           │  Validation error, retry scheduled
     └──────────────────┘
```

State transitions:

```python
class UsageEventStateMachine:
    def __init__(self, event_id: str):
        self.event_id = event_id
        self.state = 'pending'
        self.state_history = [(self.state, time.time())]
    
    async def transition(self, new_state: str, reason: str = ''):
        """Transition to new state with logging."""
        valid_transitions = {
            'pending': ['processing', 'failed'],
            'processing': ['batching', 'failed'],
            'batching': ['computing_anchor', 'failed'],
            'computing_anchor': ['submitting_chain', 'failed'],
            'submitting_chain': ['completed', 'failed'],
            'completed': [],
            'failed': ['pending']  # Retry
        }
        
        if new_state not in valid_transitions.get(self.state, []):
            raise ValueError(
                f"Invalid transition: {self.state} → {new_state}"
            )
        
        self.state = new_state
        self.state_history.append((new_state, time.time(), reason))
        
        # Persist state to database
        await db.update_event(self.event_id, {'status': self.state})
```

### 5.3 Event Publishing

Events are published to a message queue for async processing:

```python
async def publish_usage_event(event: UsageEvent) -> None:
    """
    Publish event to ledger processing queue.
    
    Queue system chosen: RabbitMQ (reliable, transactional)
    Queue name: "vri.usage_events"
    Persistence: Yes
    """
    
    # Serialize event
    event_json = json.dumps(
        event.__dict__,
        default=str  # Handle datetime, UUID
    )
    
    # Publish with delivery guarantee
    channel = rabbitmq_connection.channel()
    channel.queue_declare(
        queue='vri.usage_events',
        durable=True  # Persist across restarts
    )
    
    channel.basic_publish(
        exchange='',
        routing_key='vri.usage_events',
        body=event_json,
        properties=pika.BasicProperties(
            delivery_mode=2,  # Persistent
            content_type='application/json'
        )
    )
```

---

## 6. Latency Constraints

### 6.1 Acceptable Latency Budget

The critical path (inference → watermark → sign → return) must complete in <500ms for API latency SLAs.

```
Latency Target: <500ms total
├─ Model Inference: 300ms (user's responsibility)
├─ Watermark Injection: 80ms
├─ Signature Generation: 20ms
├─ Ledger Enqueue: 1ms
└─ Network Overhead: ~50ms (HTTP, serialization)

Failure: If watermark takes >150ms, total could exceed 500ms.
Action: Degrade gracefully or async.
```

### 6.2 Synchronous vs Asynchronous Trade-offs

#### **Synchronous (Blocking)**

```
Requirement: Return result in <500ms

Pros:
  ✅ User gets immediate result
  ✅ No state management complexity
  ✅ Error handling is simple (fail-fast)
  ✅ Suitable for user-facing APIs

Cons:
  ❌ Inference timeout blocks user
  ❌ Watermark failures block user
  ❌ Can't scale beyond CPU cores
  ❌ No recovery without user retry

Implementation:
  client.generate_audio() 
    → wait 500ms 
    → return audio + proof
```

#### **Asynchronous (Non-blocking)**

```
Requirement: Return token immediately, deliver result via webhook

Pros:
  ✅ No timeout pressure
  ✅ Full retry capability
  ✅ Scales infinitely (queue-based)
  ✅ Failures are recoverable
  ✅ Suitable for batch processing

Cons:
  ❌ User gets token, not audio (async)
  ❌ Eventual consistency (minutes/hours)
  ❌ Webhook complexity
  ❌ Harder to debug

Implementation:
  request_id = client.request_audio()  // returns immediately (token)
  
  [background processing]
  
  webhook: client.on_audio_ready(request_id, audio, proof)
```

#### **Hybrid (Optimist + Fallback)**

```
Strategy: Attempt synchronous, fall back to async on timeout

Execution Plan:

1. Start inference + watermark async
2. Wait up to 400ms for completion
3. If done: return immediately (sync path)
4. If timeout: return token + background processing (async path)

```python
async def generate_with_fallback(text, voice_id, options):
    """
    Try synchronous return, fall back to async.
    """
    request_id = uuid.uuid4()
    
    # Start background task
    inference_task = asyncio.create_task(
        full_inference_pipeline(text, voice_id, request_id)
    )
    
    # Wait max 400ms for completion
    try:
        result = await asyncio.wait_for(inference_task, timeout=0.4)
        # Success: return immediately
        return {
            'status': 'completed',
            'audio': result['audio'],
            'proof_package': result['proof']
        }
    except asyncio.TimeoutError:
        # Timeout: return token, let background finish
        return {
            'status': 'pending',
            'request_id': request_id,
            'check_status_url': f'/api/status/{request_id}',
            'estimated_seconds': 10
        }
```

### 6.3 Queue-Based Architecture

For high-throughput, async-based system:

```
┌────────────────────────────────────────±──────────────────────┐
│ Inference Request Queue (RabbitMQ)                             │
│                                                                │
│ [Request 1] [Request 2] [Request 3] [...] [Request N]        │
│      ↓            ↓             ↓                   ↓          │
├────────┬────────────────────────┬────────────────────────────┤
│        │        Workers         │                            │
│  ┌─────▼──────┐  ┌──────────┐  ┌─────────────┐              │
│  │  Worker 1  │  │ Worker 2 │  │  Worker K   │              │
│  │ inference  │  │ inference│  │ inference   │              │
│  └─────┬──────┘  └─────┬────┘  └──────┬──────┘              │
│        │                │             │                      │
│        └────────┬───────┴─────────────┘                      │
│                 ↓                                             │
│         [Watermark Daemon]                                    │
│         (shared resource)                                     │
│                 ↓                                             │
│         [Signing Service]                                     │
│         (shared resource)                                     │
│                 ↓                                             │
│    [Usage Events Queue (Ledger)]                              │
│   [Event 1] [Event 2] [Event 3] ...                           │
│                 ↓                                             │
│         [Ledger Processor]                                    │
│     Batches events, anchors to blockchain                     │
│                                                               │
│  Result: Completed job pushed to result queue                │
│  ✓ Audio + Proof delivered to S3/CDN                          │
│  ✓ Webhook sent to client                                     │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. Failure Modes & Fallback Behavior

### 7.1 Watermark Failure

```
Scenario: Watermark daemon returns error

Error Types:
  • Daemon timeout (watermark service unavailable)
  • Invalid audio format (unsupported sample rate)
  • Watermark injection failed (DSP error)
  • Quality validation failed (SNR too low)
```

**Fallback Decision Tree**:

```
Watermark fails?
    ↓
[Is watermarking critical?]
    ├─ YES (user explicitly requires it)
    │   └─→ Fail the request, return error
    │       User can retry or fallback to un-watermarked generation
    │
    └─ NO (watermarking is optional)
        └─→ Log error, continue with unwatermarked audio
            ├─ Sign the raw audio instead
            ├─ Mark proof package: watermark_included=false
            └─ Return audio + reduced-trust proof

Response format:
  {
    "audio": "...",
    "proof_package": {
      "watermark": null,
      "watermark_attempted": true,
      "watermark_error": "daemon_timeout",
      "signature": "...",  // signature covers raw audio
      "trust_level": "low"
    }
  }
```

### 7.2 Signing Failure

```
Scenario: Signing service returns error

Error Types:
  • Private key unavailable (HSM offline)
  • Signature service timeout
  • Invalid audio hash format
  • Key rotation in progress
```

**Fallback Strategy**:

```
Sign fails?
    ↓
[Can we retry with fallback key?]
    ├─ YES (backup key available, key rotation protocol)
    │   └─→ Try backup key → return signature
    │
    └─ NO (critical signing service failure)
        └─→ Queue for later signing
            ├─ Persist audio to S3 with temporary key
            ├─ Return token + "signature pending"
            ├─ Signing service catches up in background
            └─ Push result to client webhook when ready

Response format (temporary):
  {
    "audio": "...",
    "audio_location": "s3://bucket/temp/request_id.wav",
    "request_id": "...",
    "proof_package": null,
    "status": "awaiting_signature",
    "estimated_signature_ready": 60  // seconds
  }
```

### 7.3 Partial Generation Failure

```
Scenario: Audio generated but watermark + signing fail

Situation:
  • Model produced valid audio (100s)
  • Watermark daemon down
  • Signing service down
  • Network partition

Options for Degradation:

Option A: Hard Fail (immediate error)
  Pros: No security compromise
  Cons: User gets nothing
  Use: Financial/security-critical applications

Option B: Graceful Degrade (return audio without proof)
  Pros: User gets usable audio
  Cons: Audio is unverified/untracked
  Use: Non-critical, development, testing

Option C: Queue for Later (async recovery)
  Pros: User gets token, audio preserved, retry automatic
  Cons: Asynchronous, delayed result
  Use: Batch processing, asynchronous recovery
```

### 7.4 Fallback Behavior Configuration

```python
class VRIAdapterConfig:
    """Configure fallback behavior per failure type."""
    
    # Watermark failures
    watermark_timeout_ms: int = 2000
    watermark_on_failure: str = "fail_hard"  # or "degrade"
    
    # Signing failures
    signing_timeout_ms: int = 500
    signing_on_failure: str = "queue_for_later"  # or "fail_hard"
    
    # Generation failures
    inference_timeout_ms: int = 5000
    inference_on_failure: str = "fail_hard"
    
    # Overall latency
    total_timeout_ms: int = 500  # for sync endpoints
    fallback_to_async: bool = True  # if total exceeds budget

# Usage
config = VRIAdapterConfig(
    watermark_on_failure="degrade",  # if watermark fails, continue anyway
    signing_on_failure="queue_for_later",  # save audio, sign later
    fallback_to_async=True  # return token if sync takes >500ms
)

adapter = VRIInferenceAdapter(config=config)
```

---

## 8. Multi-Model Support

### 8.1 Internal Models (Full Control)

For models you host directly:

```
Architecture:

Your Server
    ↓
LLM/TTS Model (e.g., Coqui, Bark, Tortoise)
    ↓
VRI Watermark Daemon (in-process or nearby)
    ↓
VRI Signing Service
    ↓
Output
```

**Implementation**: Direct Python/Node.js function calls

```python
from transformers import pipeline
from vri_adapter import VRIInferenceAdapter

# Load model
tts_model = pipeline("text-to-speech", model="coqui/tts_models_en")

# Create adapter
vri = VRIInferenceAdapter()

# Wrap the inference function
async def generate_vri_audio(text, voice_id):
    def model_inference():
        wav = tts_model(text)
        return np.array(wav[0]['audio'])
    
    result = await vri.wrap_inference(
        inference_fn=model_inference,
        options={'voice_id': voice_id, 'model': 'coqui-tts'}
    )
    
    return result
```

### 8.2 External APIs (Wrapper Approach)

For third-party APIs (ElevenLabs, OpenAI, Google):

```
Architecture:

Your Server (Edge)
    ↓
[API Call to External Service]
    ElevenLabs API / OpenAI API / Google TTS
    ↓
[Downloaded Audio]
    ↓
VRI Watermark Daemon (local)
    ↓
VRI Signing Service (local)
    ↓
Output
```

**Key Insight**: VRI adds a "verification wrapper" layer around external APIs.

```python
async def generate_with_elevenlabs(text, voice_id):
    """
    Use ElevenLabs for TTS, VRI for rights management.
    """
    vri = VRIInferenceAdapter()
    
    # Wrapper function that calls ElevenLabs
    async def elevenlabs_tts():
        async with httpx.AsyncClient() as client:
            response = await client.post(
                'https://api.elevenlabs.io/v1/text-to-speech',
                headers={'xi-api-key': ELEVENLABS_KEY},
                json={'text': text, 'voice_id': voice_id}
            )
            return np.frombuffer(response.content, dtype=np.float32)
    
    # Wrap with VRI
    result = await vri.wrap_inference(
        inference_fn=elevenlabs_tts,
        options={
            'voice_id': voice_id,
            'model': 'elevenlabs-v2',
            'provider': 'elevenlabs'
        }
    )
    
    return result
```

**Licensing Implication**: 

If you're using ElevenLabs API and adding your own watermark:
- Your terms of service must disclose watermarking
- ElevenLabs may have restrictions on derivative works
- Consider licensing agreement with ElevenLabs

### 8.3 Open-Source Models (Plugin Architecture)

Support a variety of open-source TTS engines as plugins:

```python
class TTSModelPlugin:
    """Base class for TTS model plugins."""
    
    async def infer(self, text: str, options: Dict) -> np.ndarray:
        """Must return audio as numpy float32 array."""
        raise NotImplementedError

class CoquiTTSPlugin(TTSModelPlugin):
    def __init__(self):
        from TTS.api import TTS
        self.model = TTS(model_name="tts_models/en/ljspeech/glow-tts", 
                         gpu=True)
    
    async def infer(self, text: str, options: Dict) -> np.ndarray:
        wav = self.model.synthesize(text, speaker=options.get('voice_id'))
        return np.array(wav)

class BarkPlugin(TTSModelPlugin):
    def __init__(self):
        from bark import SAMPLE_RATE, generate_audio, preload_models
        preload_models()
        self.sample_rate = SAMPLE_RATE
    
    async def infer(self, text: str, options: Dict) -> np.ndarray:
        audio_array = generate_audio(text, history_prompt=options.get('voice_id'))
        return audio_array

class TortoisePlugin(TTSModelPlugin):
    def __init__(self):
        from tortoise import api
        self.tts = api.TextToSpeech()
    
    async def infer(self, text: str, options: Dict) -> np.ndarray:
        gpts = [self.tts.get_gpt_cond_latents(v) 
                for v in options.get('voice_samples', [])]
        cond_latents = self.tts.get_conditioning_latents(gpts)
        wav_chunks = self.tts.synthesize(text, conditioning_latents=cond_latents)
        return np.concatenate(wav_chunks)

# Plugin registry
PLUGIN_REGISTRY = {
    'coqui': CoquiTTSPlugin,
    'bark': BarkPlugin,
    'tortoise': TortoisePlugin,
}

# Unified interface
async def generate_with_plugin(model_name, text, voice_id):
    PluginClass = PLUGIN_REGISTRY[model_name]
    plugin = PluginClass()
    
    vri = VRIInferenceAdapter()
    result = await vri.wrap_inference(
        inference_fn=lambda: plugin.infer(text, {'voice_id': voice_id}),
        options={'voice_id': voice_id, 'model': model_name}
    )
    
    return result
```

---

## 9. Streaming Audio Support (Advanced)

### 9.1 Streaming Architecture

For real-time voice interactions (speech-to-speech, live TTS):

```
User Input Stream
    ↓
TTS Model (chunk-based generation)
    ↓
[Output chunks: Start → Chunk1 → Chunk2 → ... → Chunk N → End]
    ↓
VRI Watermark Stream (per-chunk injection)
    ↓
[Watermarked chunks, returned to user immediately]
    ↓
VRI Hash Accumulator (incremental computation)
    ↓
[When stream ends: finalize hash, sign, return proof]
```

### 9.2 Chunk-Based Watermarking

```python
class StreamingWatermarkingPipeline:
    """Apply watermarking to streaming audio chunks."""
    
    def __init__(self):
        self.watermark_daemon = WatermarkDaemon()
        self.chunk_buffer = []
        self.hash_state = hashlib.sha256()
    
    async def process_chunk(self, chunk: np.ndarray) -> np.ndarray:
        """
        Watermark one chunk and return it immediately.
        
        Challenge: Watermarks must be continuous across chunks.
        Solution: Use overlapping buffers.
        
        Chunk Structure:
          ┌─────────────────────────────────────┐
          │ Previous Overlap │ New Chunk │ Future Overlap│
          │ 100ms            │  1000ms   │ 100ms (buffered)
          └─────────────────────────────────────┘
        """
        
        # Create overlapping buffer
        if self.chunk_buffer:
            # Prepend last 100ms of previous chunk
            overlap = self.chunk_buffer[-100*44.1:]  # 100ms at 44.1kHz
            full_chunk = np.concatenate([overlap, chunk])
        else:
            full_chunk = chunk
        
        # Watermark the full chunk
        watermarked = await self.watermark_daemon.watermark(full_chunk)
        
        # Update hash with new chunk (exclude overlap to avoid double-hashing)
        new_part = watermarked[len(watermarked)-len(chunk):]
        self.hash_state.update(new_part.tobytes())
        
        # Buffer for next iteration
        self.chunk_buffer = chunk.copy()
        
        # Return only the new part (matching user's input size)
        return new_part
    
    async def finalize(self) -> Dict:
        """Called when stream ends. Compute signature."""
        final_hash = self.hash_state.hexdigest()
        signature = await SigningService().sign(final_hash)
        
        return {
            'audio_hash': final_hash,
            'signature': signature,
            'total_duration_seconds': self._total_duration(),
            'chunks_processed': len(self.chunk_buffer)
        }
    
    def _total_duration(self) -> float:
        """Estimate total duration from hash accumulation."""
        bytes_hashed = self.hash_state.block_size * 1000  # rough estimate
        return bytes_hashed / (44100 * 4)  # assuming 44.1kHz, float32
```

### 9.3 Incremental Signing Strategy

```
Design Choice: When to compute the final signature?

Option A: Sign each chunk individually
  ❌ Results in many signatures, only last one valid
  ❌ Confusing to users

Option B: Accumulate hash, sign at stream end
  ✅ Single signature covers entire stream
  ✅ Simpler architecture
  ❌ Must buffer until stream ends

Option C: Use hash chain (Merkle chain)
  ✅ Can sign incrementally
  ✅ Proof is layered
  ❌ Complex to verify

Chosen: Option B + Option C hybrid

Implementation:
  - Compute hash incrementally (per chunk)
  - At stream end, finalize hash
  - Sign final hash
  - Also provide Merkle proofs for chunks (optional)
```

### 9.4 Buffering Strategy for Streaming

```
┌─────────────────────────────────────────────────────────┐
│ Streaming Buffer Strategy                                │
│                                                           │
│ User → TTS Model → Chunks (1-2s each)                   │
│                      ↓                                   │
│ Chunk 1 [0-1s]    ┌──────────────────┐                 │
│   Watermark → Send to user, buffer for overlap          │
│   Hash-update                                            │
│                    │                                      │
│ Chunk 2 [1-2s]    │                                      │
│   Load overlap    ├─→ Watermark → Send to user          │
│   Concatenate     │   Hash-update                        │
│                    │                                      │
│ Chunk 3 [2-3s]    │                                      │
│   Load overlap    ├─→ Watermark → Send to user          │
│   Concatenate     │   Hash-update                        │
│                    │                                      │
│ ... (stream continues) ...                               │
│                    │                                      │
│ [STREAM END]      │                                      │
│   Finalize hash   ├─→ Sign → Proof Package              │
│   Generate sig    │                                      │
│                   └──────────────────┘                  │
│                                                           │
│ Total Buffering: ~2 seconds (1 full chunk + overlap)     │
│ Watermark Latency: ~80ms per chunk (overlapped in time) │
│ Total Stream Latency: Overhead ~80ms + model latency    │
└─────────────────────────────────────────────────────────┘
```

---

## 10. Security Model

### 10.1 Private Key Protection

```
Requirement: Creator's private key must never leak or be exposed.

Architecture:

┌──────────────────────────────────────────────┐
│ Inference Server                              │
│  (can generate tokens, call APIs)             │
│                                                │
│  ❌ NEVER store private keys here              │
│  ❌ NEVER keep keys in memory                  │
│  ✅ Only communicates via APIs                │
└───────────┬────────────────────────────────────┘
            │ HTTPS + mTLS
            │ (encrypted channel)
            ↓
┌──────────────────────────────────────────────┐
│ Signing Service (HSM-Backed)                  │
│  (can only sign, never return keys)           │
│                                                │
│  ✅ Runs on secure server (VPN, private net)  │
│  ✅ Integrates with HSM (Thales, YubiHSM)    │
│  ✅ Rate-limited and audited                  │
│  ✅ Auto-rotates keys                         │
└────────────────────────────────────────────────┘
             ↑
           HSM
      (Hardware Security Module)
      Private keys in tamper-proof hardware
      Firmware-controlled signing only
      Export-restricted
```

### 10.2 Inference Pipeline Isolation

```
Security Boundary:

┌─────────────────────────────────────────────────────┐
│ Inference Container (untrusted code)                 │
│                                                       │
│ • Runs user's TTS model code                        │
│ • May download untrusted weights                    │
│ • Could be compromised by adversary                 │
│                                                       │
│ ❌ No access to private keys                         │
│ ❌ No direct signing capability                      │
│ ✅ Network-isolated to signing service               │
└────────┬─────────────────────────────────────────────┘
         │
         │ [Encrypted Network Channel]
         │ [Rate-limited, authenticated]
         │
         ↓
┌─────────────────────────────────────────────────────┐
│ Signing Service (trusted)                            │
│                                                       │
│ • Hardware-backed (HSM, TPM)                        │
│ • No user code execution                            │
│ • Only accepts signing requests                     │
│ • Signs deterministically (EdDSA)                   │
│ • Audits all signing operations                     │
│                                                       │
│ ✅ Keys never leave hardware                         │
│ ✅ Impossible to forge signatures                   │
└─────────────────────────────────────────────────────┘
```

### 10.3 Prevention of Bypass

```
Attack: Adversary tries to forge audio without watermarking

Threat Model:

1. Adversary controls inference container
   → Can generate audio without calling VRI

Mitigation:
   → Enforce VRI at API gateway level
   → All audio served through /api/generate endpoint
   → Endpoint enforces VRI pipeline
   → Direct model inference unavailable to users

2. Adversary modifies VRI adapter code
   → Can skip watermarking step

Mitigation:
   → Code signing (verify adapter integrity before execution)
   → Immutable deployment (read-only filesystem)
   → Runtime attestation (TPM/TEE validates execution)

3. Adversary intercepts network traffic
   → Can steal signatures or forge requests

Mitigation:
   → Mandatory mTLS (mutual TLS)
   → API key rotation
   → Rate limiting (detects bulk forging)
   → Signature timestamp validation (prevents replay)

4. Adversary accesses HSM firmware
   → Can extract private keys

Mitigation:
   → Only user can initialize HSM (biometric unlock)
   → Tamper detection (HSM self-destructs keys)
   → Hardware-level security (certified FIPS 140-2)
   → No software-only HSM (only hardware devices)
```

### 10.4 Security Configuration

```python
class VRISecurityConfig:
    """Configure security properties of VRI adapter."""
    
    # Key Management
    hms_endpoint = os.getenv('HSM_ENDPOINT')
    hms_pin = os.getenv('HSM_PIN')  # from secure env
    key_rotation_days = 90
    emergency_key_revocation_timeout_seconds = 300
    
    # Network Security
    signing_service_certificate = '/secrets/signing-service.crt'
    signing_service_key = '/secrets/client-key.pem'
    require_mtls = True
    cipher_suites = [
        'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
        'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305'
    ]
    
    # Rate Limiting
    max_signing_requests_per_minute = 10000
    max_signing_requests_per_voice = 1000
    throttle_burst_requests = True
    
    # Auditing
    log_all_signing_operations = True
    audit_log_location = '/var/log/vri/audit.log'
    audit_log_immutable = True  # write-once append
    
    # Code Integrity
    verify_adapter_signature_on_startup = True
    fail_on_unsigned_adapter = True  # strict mode
    runtime_attestation_enabled = True
    
    # Deployment
    deployment_environment = os.getenv('ENVIRONMENT')  # dev, staging, prod
    
    # Validate configuration at startup
    @classmethod
    def validate(cls):
        assert os.path.exists(cls.signing_service_certificate), \
            "Signing service certificate not found"
        assert os.getenv('HSM_PIN'), \
            "HSM PIN not set in environment"
        assert cls.deployment_environment in ['dev', 'staging', 'prod'], \
            "Invalid deployment environment"
        
        if cls.deployment_environment == 'prod':
            assert cls.require_mtls, "mTLS required in production"
            assert cls.fail_on_unsigned_adapter, "Strict mode required"
            assert cls.log_all_signing_operations, "Auditing required"
```

---

## 11. Code Examples

### 11.1 Node.js Complete Example

```javascript
/**
 * Complete VRI Inference Integration Example (Node.js)
 * 
 * Demonstrates:
 * - Wrapping TTS model inference with VRI
 * - Handling watermarking and signing
 * - Error handling and fallback
 * - Async ledger registration
 */

const VRIInferenceAdapter = require('./vri-adapter');
const fs = require('fs');
const path = require('path');

class VRIVoiceGeneration {
  constructor() {
    this.adapter = new VRIInferenceAdapter({
      watermarkEndpoint: 'http://localhost:9000',
      signingEndpoint: 'http://localhost:9001',
      queue: 'amqp://localhost'
    });
  }

  /**
   * Example 1: Generate voice from custom TTS model
   */
  async generateWithCustomModel(text, voiceId) {
    console.log(`[VRI] Generating audio for voice: ${voiceId}`);
    
    // Local model inference
    const inferenceFn = async () => {
      // Simulate TTS model generating audio
      const audio = await this._runLocalTTSModel(text);
      return audio;
    };

    try {
      const result = await this.adapter.wrapInference(inferenceFn, {
        voiceId,
        model: 'coqui-tts-v2',
        metadata: {
          campaign: 'podcast-episode-42',
          license: 'commercial'
        }
      });

      console.log(`[VRI] ✅ Generation complete`);
      console.log(`  Duration: ${result.duration_ms}ms`);
      console.log(`  Request ID: ${result.request_id}`);
      console.log(`  Proof Package Signature: ${result.proof_package.signature.substring(0, 16)}...`);

      // Save audio to file
      await this._saveAudio(result.audio, `output_${voiceId}.wav`);
      
      // Save proof package
      await this._saveProof(result.proof_package, `proof_${voiceId}.json`);

      return result;

    } catch (error) {
      console.error(`[VRI] ❌ Generation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Example 2: Generate voice from ElevenLabs API
   */
  async generateWithElevenLabs(text, voiceId) {
    console.log(`[VRI] Generating audio via ElevenLabs for voice: ${voiceId}`);

    const result = await this.adapter.generateVRIAudio(
      'elevenlabs',
      text,
      {
        voiceId: 'EXAVITQu4MsJ3PRGipl', // ElevenLabs voice ID
        model: 'eleven_monolingual_v1',
        metadata: {
          platform: 'youtube',
          campaign: 'tutorial-series'
        }
      }
    );

    console.log(`[VRI] ✅ ElevenLabs generation + VRI complete`);
    console.log(`  Audio received: ${result.audio.length} samples`);
    console.log(`  Watermark verified: ${result.proof_package.watermark.confidence_extraction}`);

    return result;
  }

  /**
   * Example 3: Batch generation with error handling
   */
  async generateBatch(textList, voiceId) {
    console.log(`[VRI] Starting batch generation: ${textList.length} items`);
    
    const results = [];
    const failures = [];

    for (let i = 0; i < textList.length; i++) {
      const text = textList[i];
      
      try {
        console.log(`  [${i + 1}/${textList.length}] Generating...`);
        
        const result = await this.generateWithCustomModel(text, voiceId);
        results.push({
          index: i,
          text: text.substring(0, 50) + '...',
          request_id: result.request_id,
          duration_ms: result.duration_ms
        });

      } catch (error) {
        console.warn(`  [${i + 1}/${textList.length}] Failed: ${error.message}`);
        failures.push({
          index: i,
          text: text.substring(0, 50) + '...',
          error: error.message
        });
      }
    }

    console.log(`\n[VRI] Batch complete: ${results.length} succeeded, ${failures.length} failed`);

    return { results, failures };
  }

  /**
   * Example 4: Stream-based generation
   */
  async generateStreaming(textStream, voiceId) {
    console.log(`[VRI] Starting streaming generation for voice: ${voiceId}`);

    const streamingPipeline = new this.adapter.StreamingWatermarkPipeline();
    const proofPromise = new Promise(async (resolve) => {
      // Finalize signature once stream ends
      setTimeout(async () => {
        const proof = await streamingPipeline.finalize();
        resolve(proof);
      }, 5000);  // Assume 5-second stream
    });

    // Process chunks as they arrive
    for const chunk of textStream {
      const watermarkedChunk = await streamingPipeline.processChunk(chunk);
      // Send watermarked chunk to user immediately
      process.stdout.write(`[🎵${watermarkedChunk.length} samples]\n`);
    }

    const proof = await proofPromise;
    console.log(`[VRI] ✅ Streaming generation complete`);
    console.log(`  Final signature: ${proof.signature.substring(0, 16)}...`);

    return proof;
  }

  /**
   * Example 5: Verify generated audio
   */
  async verifyAudio(audioPath, proofPackagePath) {
    console.log(`[VRI] Verifying audio: ${audioPath}`);

    const audio = fs.readFileSync(audioPath);
    const proof = JSON.parse(fs.readFileSync(proofPackagePath, 'utf8'));

    const response = await fetch('http://localhost:8000/v1/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VRI_API_KEY}`
      },
      body: JSON.stringify({
        audio: Buffer.from(audio).toString('base64'),
        proof_package: proof
      })
    });

    const result = await response.json();

    console.log(`[VRI] Verification result:`);
    console.log(`  Status: ${result.verified ? '✅ VERIFIED' : '❌ UNVERIFIED'}`);
    console.log(`  Confidence: ${result.confidence}`);
    console.log(`  Watermark: ${result.watermark ? '✅ Found' : '❌ Not found'}`);
    console.log(`  Signature: ${result.signature_valid ? '✅ Valid' : '❌ Invalid'}`);

    return result;
  }

  // Helper methods

  async _runLocalTTSModel(text) {
    // Simulate local TTS model
    return new Float32Array(44100 * 5);  // 5 seconds of silence
  }

  async _saveAudio(audio, filename) {
    // Save WAV file (placeholder)
    fs.writeFileSync(filename, Buffer.from(audio));
    console.log(`Saved audio to ${filename}`);
  }

  async _saveProof(proof, filename) {
    fs.writeFileSync(filename, JSON.stringify(proof, null, 2));
    console.log(`Saved proof to ${filename}`);
  }
}

// Main execution
async function main() {
  const vri = new VRIVoiceGeneration();

  // Example 1: Custom model
  console.log('\n=== Example 1: Custom TTS Model ===');
  const result1 = await vri.generateWithCustomModel(
    'Hello, this is a test message.',
    'voice_001'
  );

  // Example 2: ElevenLabs
  console.log('\n=== Example 2: ElevenLabs API ===');
  const result2 = await vri.generateWithElevenLabs(
    'Welcome to the VRI demo.',
    'voice_002'
  );

  // Example 3: Batch
  console.log('\n=== Example 3: Batch Generation ===');
  const texts = [
    'First sentence.',
    'Second sentence.',
    'Third sentence.'
  ];
  const batchResult = await vri.generateBatch(texts, 'voice_003');

  // Example 4: Verify
  console.log('\n=== Example 4: Verification ===');
  if (fs.existsSync('output_voice_001.wav')) {
    await vri.verifyAudio('output_voice_001.wav', 'proof_voice_001.json');
  }
}

main().catch(console.error);
```

### 11.2 Python Complete Example

```python
"""
Complete VRI Inference Integration Example (Python)

Demonstrates:
- Wrapping local TTS models with VRI
- Async/await patterns
- Error handling
- Metrics collection
"""

import asyncio
import numpy as np
from vri_adapter import VRIInferenceAdapter, VRIAudioOutput
from vri_adapter import AudioFormat
import json
import os

class VRIVoiceGenerationPipeline:
    """Complete voice generation pipeline with VRI integration."""
    
    def __init__(self):
        self.adapter = VRIInferenceAdapter(config={
            'watermark_endpoint': 'http://localhost:9000',
            'signing_endpoint': 'http://localhost:9001',
            'ledger_queue_url': 'amqp://localhost'
        })
        self.metrics = []
    
    async def example_1_custom_model(self, text: str, voice_id: str):
        """Example 1: Generate with local Coqui TTS model."""
        print(f"\n[VRI] Example 1: Custom TTS Model")
        print(f"  Text: {text}")
        print(f"  Voice: {voice_id}")
        
        # Local model inference
        async def coqui_inference():
            # Simulate Coqui TTS
            from TTS.api import TTS
            tts = TTS(model_name='glow-tts', gpu=True)
            wav = tts.synthesize(text)
            return np.array(wav, dtype=np.float32)
        
        result = await self.adapter.wrap_inference(
            inference_fn=coqui_inference,
            options={
                'voice_id': voice_id,
                'model': 'coqui-glow-tts',
                'metadata': {
                    'campaign': 'demo',
                    'platform': 'internal'
                }
            }
        )
        
        print(f"✅ Generation complete")
        print(f"  Duration: {result.duration_ms:.0f}ms")
        print(f"  Audio samples: {len(result.audio)}")
        print(f"  Signature: {result.proof_package['signature'][:32]}...")
        
        # Save outputs
        self._save_audio(result.audio, f'output_{voice_id}.wav')
        self._save_proof(result.proof_package, f'proof_{voice_id}.json')
        
        return result
    
    async def example_2_elevenlabs_api(self, text: str, voice_id: str):
        """Example 2: Generate with ElevenLabs API + VRI."""
        print(f"\n[VRI] Example 2: ElevenLabs API")
        print(f"  Text: {text}")
        print(f"  Voice: {voice_id}")
        
        result = await self.adapter.generate_vri_audio(
            provider='elevenlabs',
            text=text,
            options={
                'voice_id': 'EXAVITQu4MsJ3PRGipl',  # ElevenLabs voice
                'metadata': {
                    'platform': 'youtube',
                    'campaign': 'tutorial'
                }
            }
        )
        
        print(f"✅ ElevenLabs + VRI complete")
        print(f"  Total latency: {result.duration_ms:.0f}ms")
        print(f"  Proof anchor: {result.proof_package.get('ledger', {}).get('anchor', 'pending')}")
        
        return result
    
    async def example_3_batch_processing(self, texts: list, voice_id: str):
        """Example 3: Batch generate multiple audios with error handling."""
        print(f"\n[VRI] Example 3: Batch Processing")
        print(f"  Items: {len(texts)}")
        print(f"  Voice: {voice_id}")
        
        results = []
        failures = []
        
        for i, text in enumerate(texts):
            try:
                print(f"  [{i+1}/{len(texts)}] Generating...", end=' ')
                
                result = await self.example_1_custom_model(
                    text[:100], 
                    f"{voice_id}_{i}"
                )
                
                results.append({
                    'index': i,
                    'request_id': result.request_id,
                    'duration_ms': result.duration_ms
                })
                
                print("✅")
                
            except Exception as e:
                print(f"❌ {str(e)}")
                failures.append({'index': i, 'error': str(e)})
        
        print(f"\n✅ Batch summary: {len(results)} succeeded, {len(failures)} failed")
        
        return {'results': results, 'failures': failures}
    
    async def example_4_streaming(self, chunks: list, voice_id: str):
        """Example 4: Stream-based watermarking with incremental signing."""
        print(f"\n[VRI] Example 4: Streaming Generation")
        print(f"  Chunks: {len(chunks)}")
        print(f"  Voice: {voice_id}")
        
        # Create streaming pipeline
        pipeline = StreamingWatermarkPipeline(self.adapter)
        
        # Process chunks as they arrive
        for i, chunk in enumerate(chunks):
            watermarked = await pipeline.process_chunk(chunk)
            print(f"  Chunk {i+1}: {len(watermarked)} samples watermarked")
        
        # Finalize and sign
        proof = await pipeline.finalize()
        
        print(f"✅ Streaming complete")
        print(f"  Final audio hash: {proof['audio_hash'][:32]}...")
        print(f"  Signature: {proof['signature'][:32]}...")
        
        return proof
    
    async def example_5_verify(self, audio_path: str, proof_path: str):
        """Example 5: Verify generated audio."""
        print(f"\n[VRI] Example 5: Verification")
        print(f"  Audio: {audio_path}")
        print(f"  Proof: {proof_path}")
        
        # In production, call VRI verification API
        # For demo, just load and display
        
        with open(audio_path, 'rb') as f:
            audio = np.frombuffer(f.read(), dtype=np.float32)
        
        with open(proof_path, 'r') as f:
            proof = json.load(f)
        
        print(f"✅ Verification result:")
        print(f"  Creator: {proof['creator']['voice_id']}")
        print(f"  Signature valid: {proof['signature']['value'][:32]}...")
        print(f"  Timestamp: {proof.get('timestamp')}")
        
        return proof
    
    # Helper methods
    
    def _save_audio(self, audio: np.ndarray, filename: str):
        """Save audio to file (placeholder)."""
        with open(filename, 'wb') as f:
            f.write(audio.astype(np.float32).tobytes())
        print(f"💾 Saved audio to {filename}")
    
    def _save_proof(self, proof: dict, filename: str):
        """Save proof package to JSON file."""
        with open(filename, 'w') as f:
            json.dump(proof, f, indent=2, default=str)
        print(f"💾 Saved proof to {filename}")

class StreamingWatermarkPipeline:
    """Pipeline for streaming watermarking with incremental signing."""
    
    def __init__(self, adapter: VRIInferenceAdapter):
        self.adapter = adapter
        self.chunks = []
        self.hash_state = None
    
    async def process_chunk(self, chunk: np.ndarray) -> np.ndarray:
        """Process one streaming chunk."""
        watermarked = await self.adapter._watermark_audio(
            chunk, 
            'streaming_request',
            {}
        )
        self.chunks.append(watermarked)
        return watermarked
    
    async def finalize(self) -> dict:
        """Finalize streaming and sign."""
        import hashlib
        
        # Concatenate all chunks
        full_audio = np.concatenate(self.chunks)
        
        # Compute final hash
        audio_hash = hashlib.sha256(full_audio.tobytes()).hexdigest()
        
        # Request signature
        proof = await self.adapter._sign_audio(full_audio, {})
        
        return {
            'audio_hash': audio_hash,
            'signature': proof['signature'],
            'total_chunks': len(self.chunks),
            'total_samples': len(full_audio)
        }

async def main():
    """Main execution."""
    pipeline = VRIVoiceGenerationPipeline()
    
    # Example 1: Custom model
    try:
        result = await pipeline.example_1_custom_model(
            "Hello, this is a test message.",
            "voice_001"
        )
    except Exception as e:
        print(f"Example 1 failed: {e}")
    
    # Example 2: ElevenLabs
    try:
        result = await pipeline.example_2_elevenlabs_api(
            "Welcome to VRI.",
            "voice_002"
        )
    except Exception as e:
        print(f"Example 2 failed: {e}")
    
    # Example 3: Batch
    try:
        texts = [
            "First message.",
            "Second message.",
            "Third message."
        ]
        batch = await pipeline.example_3_batch_processing(texts, "voice_batch")
    except Exception as e:
        print(f"Example 3 failed: {e}")
    
    print("\n✅ All examples complete!")

if __name__ == '__main__':
    asyncio.run(main())
```

---

## Summary

This document defines a production-ready architecture for embedding VRI into AI voice generation systems. Key design decisions:

1. **Post-Inference Wrapping**: VRI intercepts audio after model generation, enabling compatibility with any TTS engine
2. **Watermark + Signature**: Dual-layer proof (inaudible watermark + cryptographic signature)
3. **Async-First Ledger**: Usage events queued asynchronously, registered in batches
4. **Graceful Degradation**: Fail soft when optional services (watermark, signing) timeout
5. **HSM-Backed Signing**: Private keys never leave hardware security modules
6. **Streaming Support**: Chunk-based processing for real-time audio
7. **Multi-Model Support**: Works with custom models, external APIs, and open-source frameworks

The system is designed to be **the default layer inside any voice generation system**—not optional, not external, but embedded.
