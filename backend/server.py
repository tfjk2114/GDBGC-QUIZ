#!/usr/bin/env python3
import json
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SCORES_PATH = DATA_DIR / "scores.json"
HOST = os.getenv("GDBGC_HOST", "127.0.0.1")
PORT = int(os.getenv("GDBGC_PORT", "4317"))
ALLOWED_ORIGINS = {
    "https://tfjk2114.github.io",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
}
LOCK = threading.Lock()
STARTED_AT = time.monotonic()

QUIZ = {
    "title": "How sharp are your dev instincts?",
    "description": "Five quick questions across the web, Git, and programming fundamentals.",
    "questions": [
        {
            "id": "http-method",
            "category": "Web APIs",
            "prompt": "Which HTTP method is normally used to create a new resource?",
            "options": ["GET", "POST", "TRACE", "HEAD"],
            "answer": 1,
            "explanation": "POST submits a representation for the server to process, commonly creating a resource.",
        },
        {
            "id": "git-branch",
            "category": "Git",
            "prompt": "What does a Git branch point to?",
            "options": ["A repository URL", "A commit", "A file tree only", "A remote server"],
            "answer": 1,
            "explanation": "A branch is a movable reference to a commit; it advances as new commits are added.",
        },
        {
            "id": "css-layout",
            "category": "CSS",
            "prompt": "Which CSS layout system is designed for rows and columns at the same time?",
            "options": ["Floats", "Grid", "Inline flow", "Position absolute"],
            "answer": 1,
            "explanation": "CSS Grid is two-dimensional, making it ideal for coordinated rows and columns.",
        },
        {
            "id": "js-promise",
            "category": "JavaScript",
            "prompt": "What does an async JavaScript function always return?",
            "options": ["A callback", "A Promise", "Undefined", "A generator"],
            "answer": 1,
            "explanation": "An async function always returns a Promise, wrapping non-Promise return values automatically.",
        },
        {
            "id": "database-index",
            "category": "Databases",
            "prompt": "What is the main tradeoff of adding a database index?",
            "options": ["Faster reads, extra storage and write cost", "Slower reads, faster network", "No storage cost", "Automatic encryption"],
            "answer": 0,
            "explanation": "Indexes speed up matching reads but consume storage and must be updated whenever indexed data changes.",
        },
    ],
}


def public_quiz():
    return {
        "title": QUIZ["title"],
        "description": QUIZ["description"],
        "questions": [
            {key: question[key] for key in ("id", "category", "prompt", "options")}
            for question in QUIZ["questions"]
        ],
    }


def load_scores():
    try:
        return json.loads(SCORES_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_scores(scores):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix="scores-", suffix=".json", dir=DATA_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(scores, handle, indent=2)
            handle.write("\n")
        os.replace(temp_path, SCORES_PATH)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def leaderboard(scores):
    ordered = sorted(scores, key=lambda item: (-item["score"], item["elapsedSeconds"], item["createdAt"]))
    return [{key: item[key] for key in ("name", "score", "total", "elapsedSeconds")} for item in ordered[:10]]


class QuizHandler(BaseHTTPRequestHandler):
    server_version = "GDBGCQuiz/1.0"

    def log_message(self, message, *args):
        print(f"{self.address_string()} - {message % args}", flush=True)

    def end_headers(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self.send_json(200, {"ok": True, "service": "gdbgc-quiz", "uptimeSeconds": round(time.monotonic() - STARTED_AT)})
        elif path == "/api/quiz":
            self.send_json(200, public_quiz())
        elif path == "/api/leaderboard":
            with LOCK:
                self.send_json(200, {"leaderboard": leaderboard(load_scores())})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/api/attempts":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16_384:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(length))
            name = re.sub(r"[^\w .'-]", "", str(payload.get("name", "Anonymous")), flags=re.UNICODE).strip()[:24] or "Anonymous"
            answers = payload.get("answers")
            if not isinstance(answers, dict):
                raise ValueError("Answers must be an object")
            review = []
            score = 0
            for question in QUIZ["questions"]:
                selected = answers.get(question["id"])
                correct = selected == question["answer"]
                score += int(correct)
                review.append({
                    "id": question["id"],
                    "prompt": question["prompt"],
                    "correct": correct,
                    "correctAnswer": question["options"][question["answer"]],
                    "explanation": question["explanation"],
                })
            elapsed = max(1, min(3600, int(payload.get("elapsedSeconds", len(QUIZ["questions"]) * 8))))
            entry = {
                "name": name,
                "score": score,
                "total": len(QUIZ["questions"]),
                "elapsedSeconds": elapsed,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
            with LOCK:
                scores = load_scores()
                scores.append(entry)
                scores = scores[-500:]
                save_scores(scores)
                board = leaderboard(scores)
            self.send_json(201, {**entry, "review": review, "leaderboard": board})
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})


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
