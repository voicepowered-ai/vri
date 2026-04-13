# @vri-protocol/watermark 🌊

Audio DSP engine for embedding forensic metadata without affecting sound quality.

## Installation
`pnpm add @vri-protocol/watermark`

## Usage
```javascript
import { Watermark } from '@vri-protocol/watermark';

const wm = new Watermark();
const signedAudio = await wm.embed('./rec.wav', {
  payload: 'VRI-SESSION-001',
  strength: 0.8
});