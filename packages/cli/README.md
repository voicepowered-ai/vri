# @vri-protocol/cli 💻

CLI tools to seal and verify audio files from the terminal.

## Installation
`npm install -g @vri-protocol/cli`

## Usage
```bash
# Verify file
vri-verify ./recording.wav

# Seal file
vri-seal ./audio.wav --tsa [http://timestamp.apple.com](http://timestamp.apple.com)