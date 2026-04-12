# Recorder Dev Infra

This setup is intended for local infrastructure testing of the QR authorization flow used by `apps/recorder`.

## What It Starts

`npm run dev:api:infra` starts the VRI API with:

- a stable development signing key stored under `tmp/vri-dev/private_key.pem`
- file-backed ledger and batches
- file-backed identity sessions, recording sessions, revocations, and nonce replay tracking
- file-backed audit log
- CORS enabled for any local frontend origin in dev mode
- trusted verifier origin set to `https://studio.vri.example` by default

All generated files live under `tmp/vri-dev/` and are ignored by git.

## Commands

Start the API:

```bash
npm run dev:api:infra
```

Start the recorder:

```bash
npm run dev:recorder
```

Start the wallet:

```bash
npm run dev:wallet
```

## Recorder Settings

Inside `apps/recorder`, use:

- `API base URL`: `http://localhost:8787`
- `Verifier origin`: `https://studio.vri.example`

The wallet must trust the same `verifier_origin` for `POST /identity/redeem` to succeed.

## Useful Environment Variables

- `PORT`: API port, default `8787`
- `VRI_DEV_DATA_DIR`: data directory, default `tmp/vri-dev`
- `VRI_DEV_VERIFIER_ORIGIN`: primary trusted verifier origin
- `VRI_DEV_TRUSTED_VERIFIER_ORIGINS`: comma-separated trusted origins
- `VRI_DEV_CORS_ALLOWED_ORIGINS`: comma-separated browser origins allowed for CORS

## Notes

- The recorder currently records audio locally in the browser and offers it for playback/download; this setup does not add blob storage for recorded files.
- This is suitable for single-node dev and infrastructure testing. For multi-instance deployments, use shared state backends as described in [deployment-multi-instance.md](./deployment-multi-instance.md).
