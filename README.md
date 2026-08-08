# GDBGC Quiz

A full-stack quiz that serves its frontend from GitHub Pages while the API and leaderboard run locally in WSL.

## Architecture

```text
GitHub Pages frontend
        │ reads api.json
        ▼
Cloudflare Quick Tunnel ──► Python API in WSL
                              ├─ quiz questions and scoring
                              └─ local JSON leaderboard
```

The discovery-and-tunnel deployment pattern is adapted from [DebelToni/UnderLeaf](https://github.com/DebelToni/UnderLeaf), licensed under AGPL-3.0.

## Run

```bash
python3 scripts/tunnel.py
```

The supervisor starts the WSL backend, creates a Cloudflare Quick Tunnel, verifies it, updates `api.json`, and pushes the live backend address to GitHub Pages. Press `Ctrl+C` to stop it cleanly and publish the offline state.

Local backend data is saved in `data/scores.json` and is intentionally excluded from Git.

## License

GNU Affero General Public License v3.0. See `LICENSE` and `NOTICE`.
