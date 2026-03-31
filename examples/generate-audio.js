/**
 * VRI Example: Generate a proof-carrying audio artifact.
 *
 * This example is illustrative. It shows how a generation request could
 * be submitted to a VRI-enabled generation system and how the returned
 * proof package could be stored for later verification.
 */

const fetch = require('node-fetch');
const fs = require('fs');

const VRI_API_KEY = process.env.VRI_API_KEY;
const VRI_API_URL = 'https://api.vri.app/v1';

async function generateVoiceWithWatermark() {
  const voiceId = 'voice_ref_001';
  const text = 'This is a reference VRI synthesis request.';

  console.log('[1/4] Requesting voice generation with proof-carrying output...');

  const generateResponse = await fetch(`${VRI_API_URL}/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VRI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      model: 'openai-tts',
      model_params: {
        voice: 'nova',
        speed: 1.0,
      },
      metadata: {
        model_id: 'tts-v3',
        operation: 'voice_synthesis',
        request_id: 'req_demo_0001',
        tenant_id: 'org_demo',
      },
      quality: 'high',
    }),
  });

  if (!generateResponse.ok) {
    throw new Error(`Generation failed: ${generateResponse.statusText}`);
  }

  const generateResult = await generateResponse.json();

  console.log('✓ Audio artifact generated');
  console.log(`  Audio URL: ${generateResult.audio_url}`);
  console.log(`  Duration: ${generateResult.audio_duration_seconds}s`);
  console.log(`  Watermark SNR: ${generateResult.watermark.quality.snr_db}dB`);
  console.log(`  Watermark confidence: ${(generateResult.watermark.quality.confidence * 100).toFixed(1)}%`);

  console.log('\n[2/4] Downloading emitted audio artifact...');
  const audioBuffer = await downloadAudio(generateResult.audio_url);
  fs.writeFileSync('output_watermarked.wav', audioBuffer);
  console.log('✓ Audio saved to output_watermarked.wav');

  console.log('\n[3/4] Extracting proof package...');
  const proofPackage = generateResult.proof_package;
  console.log('✓ Proof package generated');
  console.log(`  Public key: ${proofPackage.creator?.public_key || proofPackage.public_key}`);
  console.log(`  Signature: ${(proofPackage.signature?.value || '').substring(0, 32)}...`);
  console.log(`  Ledger anchor: ${proofPackage.ledger?.anchor || proofPackage.ledger_anchor}`);

  console.log('\n[4/4] Saving proof package...');
  fs.writeFileSync('proof_package.json', JSON.stringify(proofPackage, null, 2));
  console.log('✓ Proof package saved to proof_package.json');

  console.log('\nNext steps:\n');
  console.log('1. Preserve the emitted audio artifact and its proof package.\n');
  console.log('2. Use local verification or a protocol-aligned verifier to validate provenance.\n');
  console.log('3. Treat the proof package as part of the emitted artifact boundary.\n');

  return {
    audioPath: 'output_watermarked.wav',
    proofPath: 'proof_package.json',
    metadata: {
      creator: proofPackage.creator?.public_key || proofPackage.public_key,
      createdAt: new Date().toISOString(),
      requestId: 'req_demo_0001',
      voiceId,
    },
  };
}

async function downloadAudio(audioUrl) {
  const response = await fetch(audioUrl);

  if (!response.ok) {
    throw new Error(`Download failed: ${response.statusText}`);
  }

  return await response.buffer();
}

async function verifyLocalAudio() {
  console.log('\nLocal Verification Example\n');

  const proofPackage = JSON.parse(fs.readFileSync('proof_package.json', 'utf-8'));

  console.log('[1] Proof Package Contents:');
  console.log(`  Watermark payload: ${proofPackage.watermark?.payload_hex || proofPackage.watermark_hex}`);
  console.log(`  Creator public key: ${proofPackage.creator?.public_key || proofPackage.public_key}`);
  console.log(`  Signature: ${(proofPackage.signature?.value || '').substring(0, 64)}...`);
  console.log(`  Algorithm: ${proofPackage.signature?.algorithm}`);
  console.log(`  Timestamp: ${new Date((proofPackage.watermark?.timestamp || proofPackage.timestamp) * 1000).toISOString()}`);

  console.log('\n[2] Proof Package Validation:');
  console.log(`  ✓ Protocol version: ${proofPackage.protocol_version || proofPackage.version}`);
  console.log(`  ✓ Signature algorithm: ${proofPackage.signature?.algorithm}`);
  console.log(`  ✓ Ledger anchored: ${(proofPackage.ledger?.anchor || proofPackage.ledger_anchor) ? 'Yes' : 'No'}`);

  console.log('\n[3] Full Verification Requires:');
  console.log('  • Watermark extraction from the audio artifact');
  console.log('  • Ed25519 signature verification');
  console.log('  • Usage Event lookup when ledger validation is required\n');
}

if (require.main === module) {
  (async () => {
    try {
      if (!VRI_API_KEY) {
        console.error('Error: VRI_API_KEY environment variable not set');
        console.error('Set it with: export VRI_API_KEY="your-api-key"');
        process.exit(1);
      }

      await generateVoiceWithWatermark();
      await verifyLocalAudio();
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  })();
}

module.exports = { generateVoiceWithWatermark, verifyLocalAudio };
