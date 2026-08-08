#!/usr/bin/env python3
"""Import the exported MANGO quiz archive into quiz-data.json and local media assets."""

import argparse
import html
import json
import mimetypes
import re
import shutil
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "quiz-data.json"
ASSET_DIR = ROOT / "assets" / "questions"
ANSWER_PATTERN = re.compile(r"\s*\(([^()]*)\)\s*$", re.DOTALL)


class QuizExportParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.list_stack = []
        self.current_item = None
        self.anchor_depth = 0
        self.categories = []
        self.current_category = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag in {"ol", "ul"}:
            self.list_stack.append(tag)
        elif tag == "li":
            self.current_item = {"text": [], "plainText": [], "images": [], "links": [], "parent": self.list_stack[-1] if self.list_stack else None}
        elif self.current_item and tag == "img":
            source = attributes.get("src", "").strip()
            if source:
                self.current_item["images"].append(source)
        elif self.current_item and tag == "a":
            self.anchor_depth += 1
            href = attributes.get("href", "").strip()
            if href:
                self.current_item["links"].append(href)

    def handle_data(self, data):
        if not self.current_item:
            return
        self.current_item["text"].append(data)
        if not self.anchor_depth:
            self.current_item["plainText"].append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.anchor_depth:
            self.anchor_depth -= 1
        elif tag == "li" and self.current_item:
            for key in ("text", "plainText"):
                self.current_item[key] = " ".join("".join(self.current_item[key]).split())
            if self.current_item["parent"] == "ol":
                self.current_category = {"name": self.current_item["text"], "questions": []}
                self.categories.append(self.current_category)
            elif self.current_item["parent"] == "ul" and self.current_category:
                self.current_category["questions"].append(self.current_item)
            self.current_item = None
        elif tag in {"ol", "ul"} and self.list_stack:
            self.list_stack.pop()


def direct_url(google_redirect):
    parsed = urllib.parse.urlparse(google_redirect)
    return urllib.parse.parse_qs(parsed.query).get("q", [google_redirect])[0].rstrip("&")


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 GDBGC-Quiz-Importer/1.0"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read(), response.headers.get_content_type()


def resolve_tenor(url):
    body, _ = fetch(url)
    page = body.decode("utf-8", errors="replace")
    match = re.search(r'<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"', page)
    return html.unescape(match.group(1)) if match else url


def extension_for(url, content_type):
    known = {"image/gif": ".gif", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "audio/mpeg": ".mp3", "audio/mpeg3": ".mp3"}
    if content_type in known:
        return known[content_type]
    return Path(urllib.parse.urlparse(url).path).suffix.lower() or mimetypes.guess_extension(content_type) or ".bin"


def split_answer(text):
    match = ANSWER_PATTERN.search(text)
    if not match:
        return text.strip(), ""
    return text[:match.start()].strip(), match.group(1).strip()


def import_archive(archive_path):
    with ZipFile(archive_path) as archive:
        parser = QuizExportParser()
        parser.feed(archive.read("index.html").decode("utf-8"))
        if len(parser.categories) != 10:
            raise ValueError(f"Expected 10 categories, found {len(parser.categories)}")

        ASSET_DIR.mkdir(parents=True, exist_ok=True)
        for existing in ASSET_DIR.iterdir():
            if existing.is_file():
                existing.unlink()

        categories = []
        questions = []
        skipped = []
        number = 0
        copied_images = set()
        for category_index, category in enumerate(parser.categories):
            selected = category["questions"][:10]
            if len(category["questions"]) > 10:
                skipped.extend((category_index + 1, item) for item in category["questions"][10:])
            if len(selected) != 10:
                raise ValueError(f"Category {category_index + 1} has {len(selected)} questions, expected at least 10")
            categories.append({
                "id": f"category-{category_index + 1}",
                "name": category["name"],
                "start": category_index * 10 + 1,
                "end": category_index * 10 + 10,
            })
            for item in selected:
                number += 1
                source_text = item["plainText"] if item["links"] else item["text"]
                prompt, answer = split_answer(source_text)
                media = []
                for image_path in item["images"]:
                    filename = Path(image_path).name
                    if filename not in copied_images:
                        (ASSET_DIR / filename).write_bytes(archive.read(image_path))
                        copied_images.add(filename)
                    media.append({"type": "image", "src": f"assets/questions/{filename}", "alt": f"Attachment for question {number}"})
                for link_index, wrapped_url in enumerate(item["links"], start=1):
                    url = direct_url(wrapped_url)
                    if "tenor.com/view/" in url:
                        url = resolve_tenor(url)
                    try:
                        body, content_type = fetch(url)
                        extension = extension_for(url, content_type)
                        filename = f"question-{number:03}-attachment-{link_index}{extension}"
                        (ASSET_DIR / filename).write_bytes(body)
                        kind = "audio" if content_type.startswith("audio/") else "image" if content_type.startswith("image/") else "link"
                        media.append({"type": kind, "src": f"assets/questions/{filename}", "alt": f"Attachment for question {number}"})
                    except Exception as error:
                        print(f"Warning: could not download {url}: {error}")
                        media.append({"type": "link", "src": url, "label": "Open question attachment"})
                questions.append({
                    "id": f"question-{number}",
                    "number": number,
                    "categoryIndex": category_index,
                    "prompt": prompt,
                    "answer": answer,
                    "media": media,
                })

    OUTPUT_PATH.write_text(json.dumps({"categories": categories, "questions": questions}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Imported {len(categories)} categories and {len(questions)} questions")
    print(f"Saved {len(list(ASSET_DIR.iterdir()))} local media files")
    for category_number, item in skipped:
        print(f"Skipped extra item after the first 10 in category {category_number}: {item['text'][:100]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    import_archive(args.archive)


if __name__ == "__main__":
    main()
