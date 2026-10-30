# Advanced configuration and developer notes

## Use from a phone on your network

Run Boson Studio on a computer that can reach ComfyUI and your language model. To listen on your local network, set the listening address and explicitly allow the computer's LAN IP.

PowerShell:

```powershell
$env:HOST = '0.0.0.0'
$env:BOSON_ALLOWED_HOSTS = '192.168.1.50'
npm start
```

macOS / Linux:

```sh
HOST=0.0.0.0 BOSON_ALLOWED_HOSTS=192.168.1.50 npm start
```

Replace the example IP with your computer's LAN IP. Open `http://192.168.1.50:3210` on your phone, on the same network. Allow the app through the computer's firewall if necessary.

Anyone who can access this instance can view its media, use its configured services and change settings. Use a trusted private network. Public hosting requires authentication and TLS added separately.

All service requests come from the backend computer; ComfyUI does not need browser CORS configuration.

## Environment variables

Set these before launching the app. Settings in the app handle ComfyUI and LLM connections; environment variables are optional startup overrides. The app does not automatically load `.env` files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3210` | Web server port |
| `HOST` | `127.0.0.1` | Listening address |
| `BOSON_ALLOWED_HOSTS` | empty | Additional allowed hostnames or IPs, comma-separated |
| `BOSON_DATA_DIR` | `./data` | Local data folder |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg if it is not on PATH |
| `FFPROBE_PATH` | `ffprobe` | Path to ffprobe if it is not on PATH |

If you place data outside the default folder, exclude that location separately from version control and release archives.

## Preparing a separate Git repository

Use **BosonStudio itself** as the repository root. Keep:

- `public/` and `lib/` — application source and interface assets.
- `server.mjs`, `package.json`, `start.bat` and `start.sh` — server and launch files.
- `README.md`, `LICENSE` and `.gitignore`.
- `tests/`, `scripts/` and public documentation in `docs/` — useful for contributors; not required to launch the app.

Omit:

- `data/` in its entirety, especially `data/studio.json`, which contains saved credentials.
- Real environment files, logs, generated outputs, uploaded references, model weights and local audit reports.
- `node_modules/`, coverage output, machine-specific editor settings and OS metadata.
- `docs/WORKFLOW-AUDIT.md`, which is an internal development report.
- Unrelated sibling projects or parent repository metadata.

The supplied `.gitignore` covers these local files. Keep source assets such as `public/mark.svg`; do not exclude all images or all JSON files. `package.json` is required. A clean repository does not need an empty `data/` folder: the server creates it automatically.

Git ignore rules do not remove files already tracked in a repository. Before publishing, review `git status` and the staged filenames. If credentials were previously committed, removing the file from the latest commit alone does not remove them from history.

A hand-made release ZIP must exclude the same private files: ZIP tools do not generally apply `.gitignore` automatically. A repository archive containing only reviewed, tracked files avoids bundling ignored local data.

## Checks

```sh
npm run check
```

This runs syntax checks and Node's built-in tests. The tests exercise validation, graph construction, prompts, Markdown, theme behavior, image context, authentication, persistence and job handling. Media integration tests use local FFmpeg/ffprobe when available. Ordinary tests do not call paid services or run a model.

The optional `scripts/audit-live.mjs` and `scripts/audit-gpu.mjs` are manual acceptance helpers. They use real configured services and isolated temporary data. They can consume LLM/GPU resources. The live helper's bundled image assertion expects a grey-shirted person eating a burger; adapt the fixture/assertion for your own acceptance suite. These scripts are not needed to run the app. Never publish a real configuration file alongside them.

## Prompt and workflow implementation

The assistant writes a human-readable brief and optional structured creative details. An independent JavaScript compiler prepares the exact mode-specific H3 prompt, including shot timing, first/last-frame alignment, reference subjects, retention and dialogue/voice bindings. The submitted final prompt is stored with the result rather than reconstructed later.

Graphs target full, non-distilled H3 weights using native sigma shifts, Euler, 20 steps and the simple schedule. Still images use the minimum five-frame latent and save the first decoded frame. Guidance is positive-only BasicGuider: no separate negative prompt or NAG node is included.

Connection diagnostics check ComfyUI version and required node presence per workflow. Actual graph submission also validates node input contracts. Neither can prove model-loader library or weight compatibility without a generation test.

## Public implementation references

- [ComfyUI server API](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [ComfyUI native H3 nodes](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py)
- [MiniMax base-mode prompt guide](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt)
- [MiniMax full-reference prompt guide](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt)
