#!/usr/bin/env python3
import hmac
import json
import os
import random
import re
import secrets
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
GAME_PATH = DATA_DIR / "game.json"
TOKEN_PATH = Path(os.getenv("GDBGC_HOST_TOKEN_PATH", "/var/lib/gdbgc-quiz/host-token"))
HOST = os.getenv("GDBGC_HOST", "127.0.0.1")
PORT = int(os.getenv("GDBGC_PORT", "4317"))
ALLOWED_ORIGINS = {
    "https://tfjk2114.github.io",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
}
LOCK = threading.RLock()
STARTED_AT = time.monotonic()

CATEGORIES = [
    {"id": f"category-{index + 1}", "name": f"Category {index + 1}", "start": index * 10 + 1, "end": index * 10 + 10}
    for index in range(10)
]
QUESTIONS = [
    {
        "id": f"question-{index + 1}",
        "number": index + 1,
        "categoryIndex": index // 10,
        "prompt": f"Question {index + 1} will be supplied with the final category content.",
    }
    for index in range(100)
]


def default_teams():
    return [
        {
            "id": f"team-{index + 1}",
            "name": f"Team {index + 1}",
            "players": [f"Player {seat + 1}" for seat in range(4)],
            "points": 0,
            "usedWagers": [],
        }
        for index in range(4)
    ]


def default_game(teams=None):
    return {
        "version": 1,
        "phase": "category_start",
        "currentQuestionIndex": 0,
        "captains": {},
        "bets": {},
        "results": {},
        "teams": teams or default_teams(),
    }


def atomic_json_write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f"{path.stem}-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def load_game():
    try:
        game = json.loads(GAME_PATH.read_text(encoding="utf-8"))
        if len(game.get("teams", [])) != 4:
            raise ValueError("Invalid team count")
        return game
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        game = default_game()
        atomic_json_write(GAME_PATH, game)
        return game


def ensure_host_token():
    try:
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
        if token:
            return token
    except FileNotFoundError:
        pass
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    TOKEN_PATH.write_text(f"{token}\n", encoding="utf-8")
    os.chmod(TOKEN_PATH, 0o600)
    return token


GAME = load_game()
HOST_TOKEN = ensure_host_token()


def current_category_index():
    return min(GAME["currentQuestionIndex"] // 10, 9)


def current_question():
    if GAME["currentQuestionIndex"] >= len(QUESTIONS):
        return None
    return QUESTIONS[GAME["currentQuestionIndex"]]


def captain_for(team):
    player_index = GAME["captains"].get(team["id"])
    if isinstance(player_index, int) and 0 <= player_index < len(team["players"]):
        return {"playerIndex": player_index, "name": team["players"][player_index]}
    return None


def public_game():
    question = current_question()
    phase = GAME["phase"]
    visible_question = None
    if question and phase in {"question", "results"}:
        visible_question = question
    teams = []
    for team in GAME["teams"]:
        team_view = {
            "id": team["id"],
            "name": team["name"],
            "players": team["players"],
            "points": team["points"],
            "usedWagerCount": len(team["usedWagers"]),
            "captain": captain_for(team),
        }
        if phase in {"question", "results"}:
            team_view["bet"] = GAME["bets"].get(team["id"])
        if phase == "results":
            team_view["correct"] = GAME["results"].get(team["id"])
        teams.append(team_view)
    return {
        "version": GAME["version"],
        "phase": phase,
        "questionNumber": GAME["currentQuestionIndex"] + 1 if question else 100,
        "totalQuestions": 100,
        "categoryIndex": current_category_index(),
        "category": CATEGORIES[current_category_index()],
        "question": visible_question,
        "teams": teams,
        "categories": CATEGORIES,
    }


def host_game():
    view = public_game()
    view["teams"] = [
        {
            **public_team,
            "usedWagers": next(team["usedWagers"] for team in GAME["teams"] if team["id"] == public_team["id"]),
        }
        for public_team in view["teams"]
    ]
    view["bets"] = GAME["bets"]
    view["results"] = GAME["results"]
    return view


def save_game():
    GAME["version"] += 1
    atomic_json_write(GAME_PATH, GAME)


def clean_label(value, fallback, maximum=32):
    cleaned = re.sub(r"[^\w .&'!-]", "", str(value), flags=re.UNICODE).strip()
    return cleaned[:maximum] or fallback


class QuizHandler(BaseHTTPRequestHandler):
    server_version = "GDBGCQuiz/2.0"

    def log_message(self, message, *args):
        print(f"{self.address_string()} - {message % args}", flush=True)

    def end_headers(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 65_536:
            raise ValueError("Invalid request size")
        return json.loads(self.rfile.read(length))

    def is_host(self):
        value = self.headers.get("Authorization", "")
        token = value.removeprefix("Bearer ").strip()
        return bool(token) and hmac.compare_digest(token, HOST_TOKEN)

    def require_host(self):
        if self.is_host():
            return True
        self.send_json(401, {"error": "Invalid host access key"})
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self.send_json(200, {"ok": True, "service": "gdbgc-quiz", "version": 2, "uptimeSeconds": round(time.monotonic() - STARTED_AT)})
        elif path == "/api/game":
            with LOCK:
                self.send_json(200, public_game())
        elif path == "/api/host/state":
            if self.require_host():
                with LOCK:
                    self.send_json(200, host_game())
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if not self.require_host():
            return
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            with LOCK:
                if path == "/api/host/teams":
                    self.update_teams(payload)
                elif path == "/api/host/category/start":
                    self.start_category()
                elif path == "/api/host/question/reveal":
                    self.reveal_question(payload)
                elif path == "/api/host/question/score":
                    self.score_question(payload)
                elif path == "/api/host/question/next":
                    self.next_question()
                elif path == "/api/host/points":
                    self.update_points(payload)
                elif path == "/api/host/reset":
                    self.reset_game(payload)
                else:
                    self.send_json(404, {"error": "Not found"})
                    return
                save_game()
                self.send_json(200, host_game())
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})

    def update_teams(self, payload):
        teams = payload.get("teams")
        if not isinstance(teams, list) or len(teams) != 4:
            raise ValueError("Exactly four teams are required")
        for index, submitted in enumerate(teams):
            players = submitted.get("players")
            if not isinstance(players, list) or len(players) != 4:
                raise ValueError("Every team requires exactly four players")
            team = GAME["teams"][index]
            team["name"] = clean_label(submitted.get("name"), f"Team {index + 1}")
            team["players"] = [clean_label(name, f"Player {seat + 1}") for seat, name in enumerate(players)]

    def start_category(self):
        if GAME["phase"] not in {"category_start", "setup"}:
            raise ValueError("Finish the current question before starting a category")
        GAME["captains"] = {team["id"]: random.randrange(4) for team in GAME["teams"]}
        GAME["bets"] = {}
        GAME["results"] = {}
        GAME["phase"] = "betting"

    def reveal_question(self, payload):
        if GAME["phase"] != "betting":
            raise ValueError("Wagers can only be locked during the betting phase")
        submitted = payload.get("bets")
        if not isinstance(submitted, dict):
            raise ValueError("A wager is required for every team")
        bets = {}
        for team in GAME["teams"]:
            wager = submitted.get(team["id"])
            if isinstance(wager, bool) or not isinstance(wager, int) or not 1 <= wager <= 100:
                raise ValueError(f"{team['name']} must choose a whole number from 1 to 100")
            if wager in team["usedWagers"]:
                raise ValueError(f"{team['name']} already used {wager}")
            bets[team["id"]] = wager
        GAME["bets"] = bets
        for team in GAME["teams"]:
            team["usedWagers"].append(bets[team["id"]])
            team["usedWagers"].sort()
        GAME["results"] = {}
        GAME["phase"] = "question"

    def score_question(self, payload):
        if GAME["phase"] != "question":
            raise ValueError("The question is not ready to score")
        submitted = payload.get("results")
        if not isinstance(submitted, dict):
            raise ValueError("A result is required for every team")
        results = {}
        for team in GAME["teams"]:
            result = submitted.get(team["id"])
            if not isinstance(result, bool):
                raise ValueError(f"Choose correct or incorrect for {team['name']}")
            results[team["id"]] = result
            if result:
                team["points"] += GAME["bets"][team["id"]]
        GAME["results"] = results
        GAME["phase"] = "results"

    def next_question(self):
        if GAME["phase"] != "results":
            raise ValueError("Score the current question before moving on")
        GAME["currentQuestionIndex"] += 1
        GAME["bets"] = {}
        GAME["results"] = {}
        if GAME["currentQuestionIndex"] >= 100:
            GAME["currentQuestionIndex"] = 100
            GAME["phase"] = "finished"
        elif GAME["currentQuestionIndex"] % 10 == 0:
            GAME["captains"] = {}
            GAME["phase"] = "category_start"
        else:
            GAME["phase"] = "betting"

    def update_points(self, payload):
        team_id = str(payload.get("teamId", ""))
        points = payload.get("points")
        if isinstance(points, bool) or not isinstance(points, int) or not -1_000_000 <= points <= 1_000_000:
            raise ValueError("Points must be a whole number between -1,000,000 and 1,000,000")
        team = next((item for item in GAME["teams"] if item["id"] == team_id), None)
        if not team:
            raise ValueError("Unknown team")
        team["points"] = points

    def reset_game(self, payload):
        if payload.get("confirmation") != "RESET":
            raise ValueError("Reset confirmation is required")
        teams = [
            {**team, "points": 0, "usedWagers": []}
            for team in GAME["teams"]
        ]
        GAME.clear()
        GAME.update(default_game(teams))


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), QuizHandler)
    print(f"GDBGC Quiz API listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
