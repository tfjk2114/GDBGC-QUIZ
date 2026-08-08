# GDBGC Quiz

A full-stack, host-controlled team quiz. GitHub Pages serves the player screen and host panel while game state and scoring run locally in WSL.

## Game format

- Four teams with four editable player slots each
- 100 questions split into ten categories of ten
- A randomly selected captain for each team at the start of every category
- One unique wager from 1–100 per team before each question is revealed
- Correct answers add the wager to the team score; incorrect answers add zero
- Host-controlled verdicts and manual score overrides
- A live hover leaderboard on the player screen

Category names and question prompts are placeholders until the final content is supplied.

## Architecture

```text
GitHub Pages frontend
        │ reads api.json
        ▼
Cloudflare Quick Tunnel ──► Python API in WSL
                              ├─ host-authenticated game controls
                              └─ persistent teams, wagers, and scores
```

The discovery-and-tunnel deployment pattern is adapted from [DebelToni/UnderLeaf](https://github.com/DebelToni/UnderLeaf), licensed under AGPL-3.0.

## Run

```bash
python3 scripts/tunnel.py
```

The supervisor starts the WSL backend, creates a Cloudflare Quick Tunnel, verifies it, updates `api.json`, and pushes the live backend address to GitHub Pages. Press `Ctrl+C` to stop it cleanly and publish the offline state.

The public game board is at `index.html`; the protected control panel is at `host.html`. The host key is generated on first launch at `/var/lib/gdbgc-quiz/host-token`.

Local backend data is saved in `data/game.json` and is intentionally excluded from Git.

## License

GNU Affero General Public License v3.0. See `LICENSE` and `NOTICE`.
