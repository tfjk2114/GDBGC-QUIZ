#!/usr/bin/env python3
import hmac
import hashlib
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
QUIZ_DATA_PATH = ROOT / "quiz-data.json"
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

# Generated once. The first question in each category remains in place; slots 2–10
# use this same shuffled order for every new game and every server restart.
FIXED_QUESTION_ORDER = [
    0, 8, 2, 5, 7, 4, 9, 3, 1, 6,
    10, 12, 19, 13, 14, 15, 11, 16, 18, 17,
    20, 24, 23, 22, 26, 27, 28, 21, 25, 29,
    30, 37, 36, 34, 38, 31, 35, 33, 39, 32,
    40, 46, 42, 45, 47, 41, 49, 43, 44, 48,
    50, 58, 53, 56, 51, 57, 54, 52, 55, 59,
    60, 68, 64, 69, 63, 65, 62, 66, 67, 61,
    70, 77, 76, 75, 72, 78, 74, 73, 71, 79,
    80, 84, 85, 89, 87, 88, 81, 82, 83, 86,
    90, 94, 92, 98, 95, 99, 91, 93, 97, 96,
]

def load_quiz_data():
    payload = json.loads(QUIZ_DATA_PATH.read_text(encoding="utf-8"))
    categories = payload.get("categories")
    questions = payload.get("questions")
    if not isinstance(categories, list) or len(categories) != 10:
        raise ValueError("quiz-data.json must contain exactly 10 categories")
    if not isinstance(questions, list) or len(questions) != 100:
        raise ValueError("quiz-data.json must contain exactly 100 questions")
    for index, question in enumerate(questions):
        if question.get("number") != index + 1 or question.get("categoryIndex") != index // 10:
            raise ValueError(f"Invalid ordering for question {index + 1}")
        if not isinstance(question.get("media", []), list):
            raise ValueError(f"Invalid media for question {index + 1}")
    return categories, questions


CATEGORIES, QUESTIONS = load_quiz_data()


def default_teams():
    return [
        {
            "id": f"team-{index + 1}",
            "name": f"Team {index + 1}",
            "players": ["" for _ in range(4)],
            "playerTokens": ["" for _ in range(4)],
            "requiredPlayers": 4,
            "points": 0,
            "usedWagers": [],
        }
        for index in range(4)
    ]


def default_game(teams=None, game_mode="full"):
    return {
        "schemaVersion": 5,
        "version": 1,
        "phase": "lobby",
        "gameMode": game_mode,
        "currentQuestionIndex": 0,
        "questionOrder": list(FIXED_QUESTION_ORDER),
        "testCompleted": False,
        "test": None,
        "captains": {},
        "captainHistory": {},
        "captainVotes": {},
        "pendingBets": {},
        "bets": {},
        "results": {},
        "teamAnswers": {},
        "suggestions": {},
        "playerQueue": [],
        "activeTeamIds": [],
        "timer": {"duration": 30, "running": False, "startedAt": None, "deadline": None, "expired": False},
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
        if game.get("schemaVersion") != 5 or len(game.get("teams", [])) != 4:
            raise ValueError("Невалидна версия на играта")
        game.setdefault("gameMode", "full")
        game.setdefault("questionOrder", list(range(100)))
        order = game["questionOrder"]
        if not isinstance(order, list) or len(order) != 100 or set(order) != set(range(100)):
            raise ValueError("Невалиден ред на въпросите")
        for category_index in range(10):
            category_order = order[category_index * 10:(category_index + 1) * 10]
            if category_order[0] != category_index * 10 or any(item // 10 != category_index for item in category_order):
                raise ValueError("Невалиден ред в категория")
        game.setdefault("captainHistory", {})
        game.setdefault("captainVotes", {})
        game.setdefault("teamAnswers", {})
        game.setdefault("suggestions", {})
        game.setdefault("playerQueue", [])
        game.setdefault("activeTeamIds", [])
        game.setdefault("timer", {"duration": 30, "running": False, "startedAt": None, "deadline": None, "expired": False})
        for team in game["teams"]:
            team.setdefault("requiredPlayers", 4)
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
    return question_for_slot(GAME["currentQuestionIndex"])


def question_for_slot(slot_index):
    source_index = GAME.get("questionOrder", list(range(100)))[slot_index]
    source = QUESTIONS[source_index]
    media = []
    for item in source.get("media", []):
        copied = dict(item)
        if copied.get("alt", "").startswith("Attachment for question"):
            copied["alt"] = f"Attachment for question {slot_index + 1}"
        media.append(copied)
    return {
        **source,
        "id": f"question-{slot_index + 1}",
        "number": slot_index + 1,
        "categoryIndex": slot_index // 10,
        "media": media,
    }


def question_for_player(question):
    """Split the host answer from entries written as: Question text [Answer]."""
    if not question:
        return None
    prompt = str(question.get("prompt", "")).strip()
    answer = str(question.get("answer", "")).strip().upper()
    bracketed = re.fullmatch(r"(?s)(.*?)\s*\[([^\[\]]+)\]\s*", prompt)
    if bracketed:
        prompt = bracketed.group(1).strip()
        answer = answer or bracketed.group(2).strip().upper()
    return {
        "id": question["id"],
        "number": question["number"],
        "categoryIndex": question["categoryIndex"],
        "prompt": prompt,
        "answer": answer,
        "media": question.get("media", []),
    }


def question_bank_for_host():
    return [question_for_player(question_for_slot(index)) for index in range(100)]


def captain_for(team):
    player_index = GAME["captains"].get(team["id"])
    if isinstance(player_index, int) and 0 <= player_index < len(team["players"]):
        return {"playerIndex": player_index, "name": team["players"][player_index]}
    return None


def game_mode():
    return GAME.get("gameMode", "full")


def player_capacity():
    return 2 if game_mode() == "duo" else sum(required_players_for(team) for team in GAME["teams"])


def required_players_for(team):
    value = team.get("requiredPlayers", 4)
    return value if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 4 else 4


def active_teams():
    if game_mode() == "duo":
        return GAME["teams"][:2]
    frozen_ids = set(GAME.get("activeTeamIds", []))
    if frozen_ids and GAME.get("phase") not in {"lobby", "test_question", "test_result"}:
        return [team for team in GAME["teams"] if team["id"] in frozen_ids]
    participating = [team for team in GAME["teams"] if connected_player_indices(team)]
    return participating


def answerer_for(team):
    return None


def eligible_captain_indices(team):
    filled = connected_player_indices(team)
    history = GAME.get("captainHistory", {}).get(team["id"], [])
    recent_distinct = []
    for player_index in reversed(history):
        if player_index in filled and player_index not in recent_distinct:
            recent_distinct.append(player_index)
        if len(recent_distinct) == 2:
            break
    blocked = set(recent_distinct[:max(0, min(2, len(filled) - 1))])
    return [index for index in filled if index not in blocked]


def captain_vote_progress(team):
    votes = GAME.get("captainVotes", {}).get(team["id"], {})
    filled = connected_player_indices(team)
    return sum(str(index) in votes for index in filled), len(filled)


def finalize_captain_vote_if_ready():
    for team in active_teams():
        submitted, required = captain_vote_progress(team)
        if submitted != required:
            return False
    captains = {}
    history = GAME.setdefault("captainHistory", {})
    for team in active_teams():
        choices = list(GAME["captainVotes"][team["id"]].values())
        counts = {candidate: choices.count(candidate) for candidate in set(choices)}
        highest = max(counts.values())
        captain = random.choice([candidate for candidate, count in counts.items() if count == highest])
        captains[team["id"]] = captain
        history[team["id"]] = (history.get(team["id"], []) + [captain])[-2:]
    GAME["captains"] = captains
    GAME["captainVotes"] = {}
    GAME["phase"] = "betting"
    return True


def player_count():
    if game_mode() == "duo":
        return sum(bool(connected_player_indices(team)) for team in GAME["teams"][:2])
    return sum(len(connected_player_indices(team)) for team in GAME["teams"])


def connected_player_indices(team):
    required = 1 if game_mode() == "duo" and team in GAME["teams"][:2] else required_players_for(team)
    tokens = team.get("playerTokens", ["", "", "", ""])
    return [
        index for index, player in enumerate(team["players"][:required])
        if player and index < len(tokens) and tokens[index]
    ]


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def find_player_by_token(token):
    if not token:
        return None
    digest = token_hash(token)
    for team_index, team in enumerate(GAME["teams"]):
        for player_index, stored in enumerate(team.get("playerTokens", ["", "", "", ""])):
            if stored and hmac.compare_digest(stored, digest):
                return team_index, player_index
    return None


def find_queued_by_token(token):
    if not token:
        return None
    digest = token_hash(token)
    for index, queued in enumerate(GAME.get("playerQueue", [])):
        stored = queued.get("tokenHash", "")
        if stored and hmac.compare_digest(stored, digest):
            return index, queued
    return None


def first_open_seat(team):
    return next((index for index in range(required_players_for(team)) if not team["players"][index]), None)


def timer_for_client():
    timer = GAME.get("timer", {})
    return {
        "duration": timer.get("duration", 30),
        "running": bool(timer.get("running")),
        "deadline": round(timer["deadline"] * 1000) if timer.get("deadline") else None,
        "expired": bool(timer.get("expired")),
    }


def clear_running_timer():
    duration = GAME.get("timer", {}).get("duration", 30)
    GAME["timer"] = {"duration": duration, "running": False, "startedAt": None, "deadline": None, "expired": False}


def expire_timer_if_needed():
    timer = GAME.get("timer", {})
    if not timer.get("running") or not timer.get("deadline") or time.time() < timer["deadline"]:
        return False
    timer["running"] = False
    timer["expired"] = True
    if GAME["phase"] == "question":
        GAME["phase"] = "review"
    return True


def public_game():
    question = question_for_player(current_question())
    phase = GAME["phase"]
    visible_question = None
    if question and phase in {"question", "review"}:
        visible_question = {key: value for key, value in question.items() if key != "answer"}
    elif question and phase == "results":
        visible_question = question
    teams = []
    active_team_ids = {team["id"] for team in active_teams()}
    for team in GAME["teams"]:
        is_active = team["id"] in active_team_ids
        team_view = {
            "id": team["id"],
            "name": team["name"],
            "players": team["players"],
            "requiredPlayers": 1 if game_mode() == "duo" and team in GAME["teams"][:2] else required_players_for(team),
            "points": team["points"],
            "usedWagerCount": len(team["usedWagers"]),
            "captain": captain_for(team),
            "answerer": answerer_for(team),
            "active": is_active,
        }
        if phase in {"question", "review", "results"}:
            team_view["bet"] = GAME["bets"].get(team["id"])
        if phase == "betting":
            team_view["hasPendingBet"] = team["id"] in GAME["pendingBets"]
        if phase == "results":
            team_view["correct"] = GAME["results"].get(team["id"])
        if phase == "captain_vote" and is_active:
            submitted, required = captain_vote_progress(team)
            team_view["captainVoteCount"] = submitted
            team_view["captainVoteRequired"] = required
        teams.append(team_view)
    view = {
        "version": GAME["version"],
        "phase": phase,
        "questionNumber": GAME["currentQuestionIndex"] + 1 if question else 100,
        "totalQuestions": 100,
        "categoryIndex": current_category_index(),
        "category": CATEGORIES[current_category_index()],
        "question": visible_question,
        "playerCount": player_count(),
        "playerCapacity": player_capacity(),
        "gameMode": game_mode(),
        "queueCount": len(GAME.get("playerQueue", [])),
        "testCompleted": GAME["testCompleted"],
        "test": GAME["test"] if phase in {"test_question", "test_result"} else None,
        "timer": timer_for_client(),
        "teams": teams,
        "categories": CATEGORIES,
    }
    if phase == "results":
        view["teamAnswers"] = {
            team["id"]: GAME["teamAnswers"].get(team["id"], "") for team in active_teams()
        }
    return view


def host_game():
    view = public_game()
    view["teams"] = [
        {
            **public_team,
            "usedWagers": next(team["usedWagers"] for team in GAME["teams"] if team["id"] == public_team["id"]),
            "connectedPlayers": connected_player_indices(next(team for team in GAME["teams"] if team["id"] == public_team["id"])),
        }
        for public_team in view["teams"]
    ]
    view["bets"] = GAME["bets"]
    view["pendingBets"] = GAME["pendingBets"]
    view["results"] = GAME["results"]
    view["teamAnswers"] = GAME["teamAnswers"]
    view["questionBank"] = question_bank_for_host()
    view["playerQueue"] = [
        {"id": queued["id"], "name": queued["name"], "joinedAt": queued["joinedAt"]}
        for queued in GAME.get("playerQueue", [])
    ]
    if view.get("question"):
        view["question"]["answer"] = question_for_player(current_question())["answer"]
    return view


def save_game():
    GAME["version"] += 1
    atomic_json_write(GAME_PATH, GAME)


def clean_label(value, fallback, maximum=32):
    cleaned = re.sub(r"[^\w .&'!-]", "", str(value), flags=re.UNICODE).strip()
    return cleaned[:maximum] or fallback


def clean_text(value, maximum):
    cleaned = " ".join(str(value or "").split())
    cleaned = "".join(character for character in cleaned if character.isprintable()).strip()
    if not cleaned:
        raise ValueError("Текстът не може да бъде празен")
    return cleaned[:maximum]


class QuizHandler(BaseHTTPRequestHandler):
    server_version = "GDBGCQuiz/17.0"

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

    def player_token(self):
        value = self.headers.get("Authorization", "")
        return value.removeprefix("Player ").strip()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self.send_json(200, {"ok": True, "service": "gdbgc-quiz", "version": 17, "uptimeSeconds": round(time.monotonic() - STARTED_AT)})
        elif path == "/api/game":
            with LOCK:
                if expire_timer_if_needed():
                    save_game()
                self.send_json(200, public_game())
        elif path == "/api/player/status":
            with LOCK:
                if expire_timer_if_needed():
                    save_game()
                identity = find_player_by_token(self.player_token())
                if not identity:
                    queued_identity = find_queued_by_token(self.player_token())
                    if queued_identity:
                        queue_index, queued = queued_identity
                        self.send_json(200, {"name": queued["name"], "queued": True, "queuePosition": queue_index + 1})
                    else:
                        self.send_json(401, {"error": "Сесията на играча не е валидна"})
                else:
                    team_index, player_index = identity
                    team = GAME["teams"][team_index]
                    is_captain = GAME["captains"].get(team["id"]) == player_index
                    status = {
                        "name": team["players"][player_index],
                        "teamId": team["id"],
                        "teamName": team["name"],
                        "playerIndex": player_index,
                        "isCaptain": is_captain,
                        "isAnswerer": answerer_for(team) is not None and answerer_for(team)["playerIndex"] == player_index,
                        "usedWagers": team["usedWagers"],
                        "pendingBet": GAME["pendingBets"].get(team["id"]),
                    }
                    team_chat = GAME["suggestions"].get(team["id"], [])
                    status["teamChat"] = team_chat
                    if is_captain:
                        status["teamAnswer"] = GAME["teamAnswers"].get(team["id"], "")
                        status["suggestions"] = team_chat
                    else:
                        status["ownSuggestions"] = [
                            message for message in team_chat if message.get("playerIndex") == player_index
                        ]
                    if GAME["phase"] == "captain_vote" and team in active_teams():
                        votes = GAME["captainVotes"].get(team["id"], {})
                        status["captainVote"] = votes.get(str(player_index))
                        status["captainCandidates"] = [
                            {"playerIndex": index, "name": team["players"][index]}
                            for index in eligible_captain_indices(team)
                        ]
                    self.send_json(200, status)
        elif path == "/api/host/state":
            if self.require_host():
                with LOCK:
                    if expire_timer_if_needed():
                        save_game()
                    self.send_json(200, host_game())
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            with LOCK:
                if expire_timer_if_needed():
                    save_game()
            if path in {"/api/players/join", "/api/players/leave", "/api/player/captain-vote", "/api/captain/wager", "/api/captain/answer", "/api/player/chat", "/api/player/suggestion"}:
                with LOCK:
                    if path == "/api/players/join":
                        response = self.join_player(payload)
                    elif path == "/api/players/leave":
                        response = self.leave_player()
                    elif path == "/api/player/captain-vote":
                        response = self.submit_captain_vote(payload)
                    elif path == "/api/captain/wager":
                        response = self.submit_captain_wager(payload)
                    elif path == "/api/captain/answer":
                        response = self.submit_captain_answer(payload)
                    else:
                        response = self.submit_team_chat_message(payload)
                        if path == "/api/player/suggestion":
                            response["suggestion"] = response["message"]
                    save_game()
                    self.send_json(200, response)
                return
            if not self.require_host():
                return
            with LOCK:
                if path == "/api/host/teams":
                    self.update_teams(payload)
                elif path == "/api/host/mode":
                    self.set_game_mode(payload)
                elif path == "/api/host/players/randomize":
                    self.randomize_players()
                elif path == "/api/host/players/move":
                    self.move_player(payload)
                elif path == "/api/host/players/assign":
                    self.assign_queued_player(payload)
                elif path == "/api/host/test/start":
                    self.start_test()
                elif path == "/api/host/test/score":
                    self.score_test(payload)
                elif path == "/api/host/test/reset":
                    self.reset_test()
                elif path == "/api/host/game/start":
                    self.start_game()
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
                elif path == "/api/host/timer":
                    self.update_timer(payload)
                elif path == "/api/host/reset":
                    self.reset_game(payload)
                else:
                    self.send_json(404, {"error": "Not found"})
                    return
                save_game()
                self.send_json(200, host_game())
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})

    def join_player(self, payload):
        name = clean_label(payload.get("name"), "", 28)
        if not name:
            raise ValueError("Въведете име")
        existing = next(
            (
                (team_index, player_index)
                for team_index, team in enumerate(GAME["teams"])
                for player_index, player in enumerate(team["players"])
                if player and player.casefold() == name.casefold()
            ),
            None,
        )
        queued_duplicate = next(
            (queued for queued in GAME.get("playerQueue", []) if queued["name"].casefold() == name.casefold()),
            None,
        )
        pregame = GAME["phase"] in {"lobby", "test_question", "test_result"}
        if not pregame:
            if game_mode() != "full" or GAME["phase"] == "finished":
                raise ValueError("Играта вече е започнала")
            if existing or queued_duplicate:
                raise ValueError("Вече има играч с това име")
            if len(GAME.get("playerQueue", [])) >= 50:
                raise ValueError("Опашката за играчи е пълна")
            token = secrets.token_urlsafe(32)
            queued = {
                "id": secrets.token_hex(8),
                "name": name,
                "tokenHash": token_hash(token),
                "joinedAt": round(time.time() * 1000),
            }
            GAME.setdefault("playerQueue", []).append(queued)
            return {
                "token": token,
                "player": {"name": name, "queued": True, "queuePosition": len(GAME["playerQueue"])},
                "game": public_game(),
            }
        if existing:
            team_index, player_index = existing
            team = GAME["teams"][team_index]
            tokens = team.setdefault("playerTokens", ["", "", "", ""])
            if tokens[player_index]:
                raise ValueError("Вече има играч с това име")
            allowed = team_index < 2 and player_index == 0 if game_mode() == "duo" else player_index < required_players_for(team)
            if not allowed:
                raise ValueError("Запазеното място вече не е активно")
            token = secrets.token_urlsafe(32)
            tokens[player_index] = token_hash(token)
            return {
                "token": token,
                "player": {"name": name, "teamId": team["id"], "teamName": team["name"], "playerIndex": player_index},
                "game": public_game(),
            }
        capacity = player_capacity()
        if player_count() >= capacity:
            raise ValueError(f"Всички {capacity} места вече са заети")
        if game_mode() == "duo":
            team_index = next(index for index, team in enumerate(GAME["teams"][:2]) if not team["players"][0])
            team = GAME["teams"][team_index]
            player_index = 0
        else:
            available = []
            for team_index, team in enumerate(GAME["teams"]):
                required = required_players_for(team)
                filled = sum(1 for player in team["players"][:required] if player)
                if filled < required:
                    available.append((filled, team_index))
            if not available:
                raise ValueError("Няма свободни места в отборите")
            _, team_index = min(available)
            team = GAME["teams"][team_index]
            player_index = next(index for index, player in enumerate(team["players"][:required_players_for(team)]) if not player)
        token = secrets.token_urlsafe(32)
        team["players"][player_index] = name
        team.setdefault("playerTokens", ["", "", "", ""])[player_index] = token_hash(token)
        return {
            "token": token,
            "player": {"name": name, "teamId": team["id"], "teamName": team["name"], "playerIndex": player_index},
            "game": public_game(),
        }

    def leave_player(self):
        queued_identity = find_queued_by_token(self.player_token())
        if queued_identity:
            queue_index, _ = queued_identity
            del GAME["playerQueue"][queue_index]
            return {"left": True, "game": public_game()}
        if GAME["phase"] not in {"lobby", "test_question", "test_result"}:
            raise ValueError("Не можете да напуснете след началото на играта")
        identity = find_player_by_token(self.player_token())
        if not identity:
            raise ValueError("Сесията на играча не е валидна")
        team_index, player_index = identity
        team = GAME["teams"][team_index]
        if GAME.get("test") and GAME["test"].get("teamId") == team["id"] and GAME["test"].get("playerIndex") == player_index:
            GAME["test"] = None
            GAME["phase"] = "lobby"
        team["players"][player_index] = ""
        team["playerTokens"][player_index] = ""
        return {"left": True, "game": public_game()}

    def submit_captain_wager(self, payload):
        if GAME["phase"] != "betting":
            raise ValueError("Залог може да се избира само преди показването на въпроса")
        identity = find_player_by_token(self.player_token())
        if not identity:
            raise ValueError("Сесията на играча не е валидна")
        team_index, player_index = identity
        team = GAME["teams"][team_index]
        if GAME["captains"].get(team["id"]) != player_index:
            raise ValueError("Само капитанът може да избере залога на отбора")
        wager = payload.get("wager")
        if isinstance(wager, bool) or not isinstance(wager, int) or not 1 <= wager <= 100:
            raise ValueError("Изберете цяло число от 1 до 100")
        if wager in team["usedWagers"]:
            raise ValueError(f"Вашият отбор вече използва {wager}")
        GAME["pendingBets"][team["id"]] = wager
        return {
            "wager": wager,
            "usedWagers": team["usedWagers"],
            "game": public_game(),
        }

    def submit_captain_vote(self, payload):
        if GAME["phase"] != "captain_vote":
            raise ValueError("В момента няма гласуване за капитан")
        identity = find_player_by_token(self.player_token())
        if not identity:
            raise ValueError("Сесията на играча не е валидна")
        team_index, player_index = identity
        team = GAME["teams"][team_index]
        if team not in active_teams():
            raise ValueError("Отборът не участва в този режим")
        candidate = payload.get("playerIndex")
        if isinstance(candidate, bool) or not isinstance(candidate, int) or candidate not in eligible_captain_indices(team):
            raise ValueError("Избери играч, който не е бил сред последните двама капитани")
        GAME["captainVotes"].setdefault(team["id"], {})[str(player_index)] = candidate
        finalized = finalize_captain_vote_if_ready()
        return {"vote": candidate, "finalized": finalized, "game": public_game()}

    def submit_captain_answer(self, payload):
        if GAME["phase"] != "question":
            raise ValueError("Отговор може да се изпрати само докато въпросът е отворен")
        identity = find_player_by_token(self.player_token())
        if not identity:
            raise ValueError("Сесията на играча не е валидна")
        team_index, player_index = identity
        team = GAME["teams"][team_index]
        if team not in active_teams() or GAME["captains"].get(team["id"]) != player_index:
            raise ValueError("Само капитанът може да изпрати отговора на отбора")
        answer = clean_text(payload.get("answer"), 500).upper()
        GAME["teamAnswers"][team["id"]] = answer
        return {"answer": answer}

    def submit_team_chat_message(self, payload):
        if GAME["phase"] != "question":
            raise ValueError("Отборният чат е достъпен само докато въпросът е отворен")
        identity = find_player_by_token(self.player_token())
        if not identity:
            raise ValueError("Сесията на играча не е валидна")
        team_index, player_index = identity
        team = GAME["teams"][team_index]
        if team not in active_teams():
            raise ValueError("Отборът не участва в този режим")
        suggestion = {
            "id": secrets.token_hex(8),
            "name": team["players"][player_index],
            "playerIndex": player_index,
            "text": clean_text(payload.get("message", payload.get("suggestion")), 300),
            "sentAt": round(time.time() * 1000),
        }
        team_suggestions = GAME["suggestions"].setdefault(team["id"], [])
        team_suggestions.append(suggestion)
        del team_suggestions[:-100]
        return {"message": suggestion}

    def update_teams(self, payload):
        teams = payload.get("teams")
        if not isinstance(teams, list) or len(teams) != 4:
            raise ValueError("Exactly four teams are required")
        if game_mode() == "duo":
            submitted_count = sum(
                1
                for submitted in teams
                for player in submitted.get("players", [])
                if clean_label(player, "", 28)
            )
            if submitted_count > 2:
                raise ValueError("Two-player head-to-head mode allows exactly two player seats")
        for index, submitted in enumerate(teams):
            players = submitted.get("players")
            if not isinstance(players, list) or len(players) != 4:
                raise ValueError("Every team requires exactly four seats")
            team = GAME["teams"][index]
            required = submitted.get("requiredPlayers", required_players_for(team))
            if isinstance(required, bool) or not isinstance(required, int) or not 1 <= required <= 4:
                raise ValueError("Required players must be between 1 and 4")
            team["name"] = clean_label(submitted.get("name"), f"Team {index + 1}")
            old_players = team["players"]
            cleaned_players = [clean_label(name, "", 28) for name in players]
            if game_mode() != "duo" and any(cleaned_players[required:]):
                raise ValueError(f"Remove players outside {team['name']}'s required seats first")
            if GAME["phase"] not in {"lobby", "test_question", "test_result"}:
                occupancy_changed = any(bool(old_players[seat]) != bool(cleaned_players[seat]) for seat in range(4))
                if required != required_players_for(team) or occupancy_changed:
                    raise ValueError("Players and required team sizes can only change before the quiz starts")
            team["players"] = cleaned_players
            if game_mode() != "duo":
                team["requiredPlayers"] = required
            tokens = team.setdefault("playerTokens", ["", "", "", ""])
            for seat, player in enumerate(cleaned_players):
                if not player or not old_players[seat]:
                    tokens[seat] = ""
        if game_mode() == "duo":
            self.set_game_mode({"mode": "duo"})

    def randomize_players(self):
        if GAME["phase"] != "lobby":
            raise ValueError("Players can only be randomized from the lobby")
        players = [
            (player, team["playerTokens"][player_index])
            for team in GAME["teams"]
            for player_index, player in enumerate(team["players"])
            if player
        ]
        if len(players) < 2:
            raise ValueError("At least two players are required to randomize teams")
        random.shuffle(players)
        for team in GAME["teams"]:
            team["players"] = ["", "", "", ""]
            team["playerTokens"] = ["", "", "", ""]
        if game_mode() == "duo":
            available_seats = [(GAME["teams"][index], 0) for index in range(2)]
        else:
            available_seats = [
                (team, seat)
                for seat in range(4)
                for team in GAME["teams"]
                if seat < required_players_for(team)
            ]
        if len(players) > len(available_seats):
            raise ValueError("Increase the required team sizes before randomizing these players")
        for (player, token), (team, seat) in zip(players, available_seats):
            team["players"][seat] = player
            team["playerTokens"][seat] = token

    def move_player(self, payload):
        if game_mode() != "full":
            raise ValueError("Player transfers are only available in standard team mode")
        source_id = payload.get("sourceTeamId")
        target_id = payload.get("targetTeamId")
        player_index = payload.get("playerIndex")
        if source_id == target_id:
            raise ValueError("Choose a different team")
        if isinstance(player_index, bool) or not isinstance(player_index, int) or not 0 <= player_index < 4:
            raise ValueError("Invalid player seat")
        source = next((team for team in GAME["teams"] if team["id"] == source_id), None)
        target = next((team for team in GAME["teams"] if team["id"] == target_id), None)
        if not source or not target or not source["players"][player_index] or not source["playerTokens"][player_index]:
            raise ValueError("That connected player was not found")
        pregame = GAME["phase"] in {"lobby", "test_question", "test_result"}
        if not pregame:
            participating = set(GAME.get("activeTeamIds", []))
            if source_id not in participating or target_id not in participating:
                raise ValueError("Players can only move between participating teams after the start")
            if GAME["phase"] == "captain_vote":
                raise ValueError("Wait until captain voting is complete before moving a player")
            if GAME["captains"].get(source_id) == player_index:
                raise ValueError("The current captain cannot move during a round")
            if len(connected_player_indices(source)) <= 1:
                raise ValueError("A participating team must keep at least one active player")
        target_index = first_open_seat(target)
        if target_index is None:
            raise ValueError(f"{target['name']} has no open required seat")
        target["players"][target_index] = source["players"][player_index]
        target["playerTokens"][target_index] = source["playerTokens"][player_index]
        source["players"][player_index] = ""
        source["playerTokens"][player_index] = ""
        for team_id, seat in ((source_id, player_index), (target_id, target_index)):
            GAME.setdefault("captainHistory", {})[team_id] = [
                prior for prior in GAME["captainHistory"].get(team_id, []) if prior != seat
            ]

    def assign_queued_player(self, payload):
        if game_mode() != "full" or GAME["phase"] in {"lobby", "test_question", "test_result", "finished"}:
            raise ValueError("The waiting queue is only available during a standard game")
        queue_id = payload.get("queueId")
        queue_index = next((index for index, queued in enumerate(GAME.get("playerQueue", [])) if queued["id"] == queue_id), None)
        if queue_index is None:
            raise ValueError("That queued player was not found")
        target_id = payload.get("targetTeamId")
        target = next((team for team in GAME["teams"] if team["id"] == target_id), None)
        if not target or target_id not in set(GAME.get("activeTeamIds", [])):
            raise ValueError("Choose a participating team")
        target_index = first_open_seat(target)
        if target_index is None:
            raise ValueError(f"{target['name']} has no open required seat")
        queued = GAME["playerQueue"].pop(queue_index)
        target["players"][target_index] = queued["name"]
        target["playerTokens"][target_index] = queued["tokenHash"]
        GAME.setdefault("captainHistory", {})[target_id] = [
            prior for prior in GAME["captainHistory"].get(target_id, []) if prior != target_index
        ]

    def set_game_mode(self, payload):
        if GAME["phase"] != "lobby":
            raise ValueError("Game mode can only be changed from the lobby")
        mode = payload.get("mode")
        if mode not in {"full", "duo"}:
            raise ValueError("Choose full or duo mode")
        players = [
            (player, team["playerTokens"][player_index])
            for team in GAME["teams"]
            for player_index, player in enumerate(team["players"])
            if player
        ]
        if mode == "duo" and len(players) > 2:
            raise ValueError("Two-player head-to-head mode supports at most two joined players")
        if mode == "duo":
            for team in GAME["teams"]:
                team["players"] = ["", "", "", ""]
                team["playerTokens"] = ["", "", "", ""]
            for team_index, (player, token) in enumerate(players):
                GAME["teams"][team_index]["players"][0] = player
                GAME["teams"][team_index]["playerTokens"][0] = token
        GAME["gameMode"] = mode
        GAME["captains"] = {}
        GAME["captainVotes"] = {}
        GAME["pendingBets"] = {}
        GAME["bets"] = {}
        GAME["results"] = {}
        GAME["teamAnswers"] = {}
        GAME["suggestions"] = {}
        GAME["playerQueue"] = []
        GAME["activeTeamIds"] = []
        clear_running_timer()

    def start_test(self):
        if GAME["phase"] not in {"lobby", "test_result"}:
            raise ValueError("Finish the current test first")
        players = [
            (team_index, player_index, player)
            for team_index, team in enumerate(active_teams())
            for player_index, player in enumerate(team["players"])
            if player_index in connected_player_indices(team)
        ]
        if not players:
            raise ValueError("At least one player must join")
        team_index, player_index, player = random.choice(players)
        team = GAME["teams"][team_index]
        GAME["test"] = {
            "teamId": team["id"],
            "teamName": team["name"],
            "playerIndex": player_index,
            "playerName": player,
            "prompt": "Коя е столицата на България?",
            "result": None,
        }
        GAME["phase"] = "test_question"

    def score_test(self, payload):
        if GAME["phase"] != "test_question" or not GAME.get("test"):
            raise ValueError("There is no active test question")
        result = payload.get("correct")
        if not isinstance(result, bool):
            raise ValueError("Choose correct or incorrect")
        GAME["test"]["result"] = result
        GAME["testCompleted"] = True
        GAME["phase"] = "test_result"

    def reset_test(self):
        if GAME["phase"] not in {"test_question", "test_result"}:
            raise ValueError("There is no active test")
        GAME["test"] = None
        GAME["phase"] = "lobby"

    def start_game(self):
        if GAME["phase"] not in {"lobby", "test_result"}:
            raise ValueError("The game cannot start right now")
        if not GAME["testCompleted"]:
            raise ValueError("Complete the system test first")
        if game_mode() == "duo" and player_count() != 2:
            raise ValueError("Exactly two players must join the head-to-head mode")
        if game_mode() == "full" and player_count() < 1:
            raise ValueError("At least one player must join")
        GAME["activeTeamIds"] = [team["id"] for team in active_teams()]
        GAME["playerQueue"] = []
        GAME["captains"] = {}
        GAME["captainVotes"] = {}
        GAME["test"] = None
        GAME["pendingBets"] = {}
        GAME["bets"] = {}
        GAME["results"] = {}
        GAME["teamAnswers"] = {}
        GAME["suggestions"] = {}
        clear_running_timer()
        if game_mode() == "duo":
            GAME["captains"] = {team["id"]: 0 for team in active_teams()}
            GAME["phase"] = "betting"
        else:
            GAME["phase"] = "captain_vote"

    def start_category(self):
        if GAME["phase"] not in {"category_start", "setup"}:
            raise ValueError("Finish the current question before starting a new category")
        GAME["captains"] = {}
        GAME["captainVotes"] = {}
        GAME["pendingBets"] = {}
        GAME["bets"] = {}
        GAME["results"] = {}
        GAME["teamAnswers"] = {}
        GAME["suggestions"] = {}
        clear_running_timer()
        if game_mode() == "duo":
            GAME["captains"] = {team["id"]: 0 for team in active_teams()}
            GAME["phase"] = "betting"
        else:
            GAME["phase"] = "captain_vote"

    def reveal_question(self, payload):
        if GAME["phase"] != "betting":
            raise ValueError("Wagers can only be locked before the question")
        submitted = GAME["pendingBets"]
        expected_teams = active_teams()
        if not isinstance(submitted, dict) or len(submitted) != len(expected_teams):
            raise ValueError(f"Wait for all {len(expected_teams)} captain wager(s)")
        bets = {}
        for team in expected_teams:
            wager = submitted.get(team["id"])
            if isinstance(wager, bool) or not isinstance(wager, int) or not 1 <= wager <= 100:
                raise ValueError(f"{team['name']} must choose a whole number from 1 to 100")
            if wager in team["usedWagers"]:
                raise ValueError(f"{team['name']} already used {wager}")
            bets[team["id"]] = wager
        GAME["bets"] = bets
        GAME["pendingBets"] = {}
        for team in expected_teams:
            team["usedWagers"].append(bets[team["id"]])
            team["usedWagers"].sort()
        GAME["results"] = {}
        GAME["teamAnswers"] = {}
        GAME["suggestions"] = {}
        clear_running_timer()
        GAME["phase"] = "question"

    def score_question(self, payload):
        if GAME["phase"] not in {"question", "review"}:
            raise ValueError("The question is not ready to score")
        if GAME.get("timer", {}).get("running"):
            raise ValueError("Wait for the active timer to finish before scoring")
        submitted = payload.get("results")
        if not isinstance(submitted, dict):
            raise ValueError("A result is required for every team")
        results = {}
        for team in active_teams():
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
        GAME["pendingBets"] = {}
        GAME["bets"] = {}
        GAME["results"] = {}
        GAME["teamAnswers"] = {}
        GAME["suggestions"] = {}
        clear_running_timer()
        if GAME["currentQuestionIndex"] >= 100:
            GAME["currentQuestionIndex"] = 100
            GAME["phase"] = "finished"
        elif GAME["currentQuestionIndex"] % 10 == 0:
            GAME["captains"] = {}
            GAME["captainVotes"] = {}
            if game_mode() == "duo":
                GAME["captains"] = {team["id"]: 0 for team in active_teams()}
                GAME["phase"] = "betting"
            else:
                GAME["phase"] = "captain_vote"
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

    def update_timer(self, payload):
        action = payload.get("action")
        seconds = payload.get("seconds", GAME.get("timer", {}).get("duration", 30))
        if isinstance(seconds, bool) or not isinstance(seconds, int) or not 1 <= seconds <= 3600:
            raise ValueError("Timer seconds must be a whole number between 1 and 3600")
        if action == "start":
            now = time.time()
            GAME["timer"] = {"duration": seconds, "running": True, "startedAt": now, "deadline": now + seconds, "expired": False}
        elif action == "stop":
            GAME["timer"] = {"duration": seconds, "running": False, "startedAt": None, "deadline": None, "expired": False}
        else:
            raise ValueError("Choose start or stop for the timer")

    def reset_game(self, payload):
        if payload.get("confirmation") != "RESET":
            raise ValueError("Reset confirmation is required")
        teams = [
            {**team, "players": ["", "", "", ""], "playerTokens": ["", "", "", ""], "points": 0, "usedWagers": []}
            for team in GAME["teams"]
        ]
        GAME.clear()
        GAME.update(default_game(teams, game_mode()))


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
