# @vri-protocol/ledger 📑

Handles immutable registration and chain of custody for audio evidence.

## Installation
`pnpm add @vri-protocol/ledger`

## Usage
```javascript
import { VriLedger } from '@vri-protocol/ledger';

const ledger = new VriLedger('./audit.json');
await ledger.register({
  sessionId: 'abc',
  evidenceHash: 'hash-123',
  timestamp: new Date()
});