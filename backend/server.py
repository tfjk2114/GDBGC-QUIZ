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
        "testCompleted": False,
        "test": None,
        "captains": {},
        "pendingBets": {},
        "bets": {},
        "results": {},
        "teamAnswers": {},
        "suggestions": {},
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
        game.setdefault("teamAnswers", {})
        game.setdefault("suggestions", {})
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


def question_for_player(question):
    """Split the host answer from entries written as: Question text [Answer]."""
    if not question:
        return None
    prompt = str(question.get("prompt", "")).strip()
    answer = str(question.get("answer", "")).strip()
    bracketed = re.fullmatch(r"(?s)(.*?)\s*\[([^\[\]]+)\]\s*", prompt)
    if bracketed:
        prompt = bracketed.group(1).strip()
        answer = answer or bracketed.group(2).strip()
    return {
        "id": question["id"],
        "number": question["number"],
        "categoryIndex": question["categoryIndex"],
        "prompt": prompt,
        "answer": answer,
        "media": question.get("media", []),
    }


def question_bank_for_host():
    return [question_for_player(question) for question in QUESTIONS]


def captain_for(team):
    player_index = GAME["captains"].get(team["id"])
    if isinstance(player_index, int) and 0 <= player_index < len(team["players"]):
        return {"playerIndex": player_index, "name": team["players"][player_index]}
    return None


def game_mode():
    return GAME.get("gameMode", "full")


def player_capacity():
    return 2 if game_mode() == "duo" else 16


def active_teams():
    return GAME["teams"][:1] if game_mode() == "duo" else GAME["teams"]


def answerer_for(team):
    if game_mode() != "duo" or team["id"] != GAME["teams"][0]["id"]:
        return None
    captain_index = GAME["captains"].get(team["id"])
    if not isinstance(captain_index, int):
        return None
    for player_index, player in enumerate(team["players"]):
        if player and player_index != captain_index:
            return {"playerIndex": player_index, "name": player}
    return None


def draw_captains():
    captains = {}
    for team in active_teams():
        filled = [index for index, player in enumerate(team["players"]) if player]
        if not filled:
            raise ValueError(f"{team['name']} has no players")
        captains[team["id"]] = random.choice(filled)
    return captains


def player_count():
    return sum(1 for team in GAME["teams"] for player in team["players"] if player)


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


def public_game():
    question = question_for_player(current_question())
    phase = GAME["phase"]
    visible_question = None
    if question and phase in {"question", "results"}:
        visible_question = {key: value for key, value in question.items() if key != "answer"}
    teams = []
    active_team_ids = {team["id"] for team in active_teams()}
    for team in GAME["teams"]:
        is_active = team["id"] in active_team_ids
        team_view = {
            "id": team["id"],
            "name": team["name"],
            "players": team["players"],
            "points": team["points"],
            "usedWagerCount": len(team["usedWagers"]),
            "captain": captain_for(team),
            "answerer": answerer_for(team),
            "active": is_active,
        }
        if phase in {"question", "results"}:
            team_view["bet"] = GAME["bets"].get(team["id"])
        if phase == "betting":
            team_view["hasPendingBet"] = team["id"] in GAME["pendingBets"]
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
        "playerCount": player_count(),
        "playerCapacity": player_capacity(),
        "gameMode": game_mode(),
        "testCompleted": GAME["testCompleted"],
        "test": GAME["test"] if phase in {"test_question", "test_result"} else None,
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
    view["pendingBets"] = GAME["pendingBets"]
    view["results"] = GAME["results"]
    view["teamAnswers"] = GAME["teamAnswers"]
    view["questionBank"] = question_bank_for_host()
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
    server_version = "GDBGCQuiz/10.0"

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
            self.send_json(200, {"ok": True, "service": "gdbgc-quiz", "version": 10, "uptimeSeconds": round(time.monotonic() - STARTED_AT)})
        elif path == "/api/game":
            with LOCK:
                self.send_json(200, public_game())
        elif path == "/api/player/status":
            with LOCK:
                identity = find_player_by_token(self.player_token())
                if not identity:
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
                    if is_captain:
                        status["teamAnswer"] = GAME["teamAnswers"].get(team["id"], "")
                        status["suggestions"] = GAME["suggestions"].get(team["id"], [])
                    else:
                        status["ownSuggestions"] = [
                            suggestion for suggestion in GAME["suggestions"].get(team["id"], [])
                            if suggestion.get("playerIndex") == player_index
                        ]
                    self.send_json(200, status)
        elif path == "/api/host/state":
            if self.require_host():
                with LOCK:
                    self.send_json(200, host_game())
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            if path in {"/api/players/join", "/api/players/leave", "/api/captain/wager", "/api/captain/answer", "/api/player/suggestion"}:
                with LOCK:
                    if path == "/api/players/join":
                        response = self.join_player(payload)
                    elif path == "/api/players/leave":
                        response = self.leave_player()
                    elif path == "/api/captain/wager":
                        response = self.submit_captain_wager(payload)
                    elif path == "/api/captain/answer":
                        response = self.submit_captain_answer(payload)
                    else:
                        response = self.submit_player_suggestion(payload)
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
        if GAME["phase"] not in {"lobby", "test_question", "test_result"}:
            raise ValueError("Играта вече е започнала")
        name = clean_label(payload.get("name"), "", 28)
        if not name:
            raise ValueError("Въведете име")
        existing_names = [player.casefold() for team in GAME["teams"] for player in team["players"] if player]
        if name.casefold() in existing_names:
            raise ValueError("Вече има играч с това име")
        capacity = player_capacity()
        if player_count() >= capacity:
            raise ValueError(f"Всички {capacity} места вече са заети")
        if game_mode() == "duo":
            team = GAME["teams"][0]
            player_index = next(index for index, player in enumerate(team["players"][:2]) if not player)
            team_index = 0
        else:
            available = []
            for team_index, team in enumerate(GAME["teams"]):
                filled = sum(1 for player in team["players"] if player)
                if filled < 4:
                    available.append((filled, team_index))
            _, team_index = min(available)
            team = GAME["teams"][team_index]
            player_index = next(index for index, player in enumerate(team["players"]) if not player)
        token = secrets.token_urlsafe(32)
        team["players"][player_index] = name
        team.setdefault("playerTokens", ["", "", "", ""])[player_index] = token_hash(token)
        return {
            "token": token,
            "player": {"name": name, "teamId": team["id"], "teamName": team["name"], "playerIndex": player_index},
            "game": public_game(),
        }

    def leave_player(self):
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
        answer = clean_text(payload.get("answer"), 500)
        GAME["teamAnswers"][team["id"]] = answer
        return {"answer": answer}

    def submit_player_suggestion(self, payload):
        if GAME["phase"] != "question":
            raise ValueError("Предложения се изпращат само докато въпросът е отворен")
        identity = find_player_by_token(self.player_token())
        if not identity:
            raise ValueError("Сесията на играча не е валидна")
        team_index, player_index = identity
        team = GAME["teams"][team_index]
        if team not in active_teams():
            raise ValueError("Отборът не участва в този режим")
        if GAME["captains"].get(team["id"]) == player_index:
            raise ValueError("Капитанът изпраща официалния отговор от менюто Отговор")
        suggestion = {
            "id": secrets.token_hex(8),
            "name": team["players"][player_index],
            "playerIndex": player_index,
            "text": clean_text(payload.get("suggestion"), 300),
        }
        team_suggestions = GAME["suggestions"].setdefault(team["id"], [])
        team_suggestions.append(suggestion)
        del team_suggestions[:-40]
        return {"suggestion": suggestion}

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
                raise ValueError("Two-player practice mode allows exactly two player seats")
        for index, submitted in enumerate(teams):
            players = submitted.get("players")
            if not isinstance(players, list) or len(players) != 4:
                raise ValueError("Every team requires exactly four seats")
            team = GAME["teams"][index]
            team["name"] = clean_label(submitted.get("name"), f"Team {index + 1}")
            old_players = team["players"]
            cleaned_players = [clean_label(name, "", 28) for name in players]
            team["players"] = cleaned_players
            tokens = team.setdefault("playerTokens", ["", "", "", ""])
            for seat, player in enumerate(cleaned_players):
                if not player or player != old_players[seat]:
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
        for index, (player, token) in enumerate(players):
            team = GAME["teams"][0] if game_mode() == "duo" else GAME["teams"][index % 4]
            seat = index if game_mode() == "duo" else index // 4
            team["players"][seat] = player
            team["playerTokens"][seat] = token

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
            raise ValueError("Two-player practice mode supports at most two joined players")
        if mode == "duo":
            for team in GAME["teams"]:
                team["players"] = ["", "", "", ""]
                team["playerTokens"] = ["", "", "", ""]
            for player_index, (player, token) in enumerate(players):
                GAME["teams"][0]["players"][player_index] = player
                GAME["teams"][0]["playerTokens"][player_index] = token
        GAME["gameMode"] = mode
        GAME["captains"] = {}
        GAME["pendingBets"] = {}
        GAME["bets"] = {}
        GAME["results"] = {}
        GAME["teamAnswers"] = {}
        GAME["suggestions"] = {}

    def start_test(self):
        if GAME["phase"] not in {"lobby", "test_result"}:
            raise ValueError("Finish the current test first")
        players = [
            (team_index, player_index, player)
            for team_index, team in enumerate(active_teams())
            for player_index, player in enumerate(team["players"])
            if player
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
        capacity = player_capacity()
        if player_count() != capacity:
            raise ValueError(f"All {capacity} players must join")
        GAME["captains"] = draw_captains()
        GAME["test"] = None
        GAME["pendingBets"] = {}
        GAME["bets"] = {}
        GAME["results"] = {}
        GAME["teamAnswers"] = {}
        GAME["suggestions"] = {}
        GAME["phase"] = "betting"

    def start_category(self):
        if GAME["phase"] not in {"category_start", "setup"}:
            raise ValueError("Finish the current question before starting a new category")
        GAME["captains"] = draw_captains()
        GAME["pendingBets"] = {}
        GAME["bets"] = {}
        GAME["results"] = {}
        GAME["teamAnswers"] = {}
        GAME["suggestions"] = {}
        GAME["phase"] = "betting"

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
        GAME["phase"] = "question"

    def score_question(self, payload):
        if GAME["phase"] != "question":
            raise ValueError("The question is not ready to score")
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
