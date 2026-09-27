#!/usr/bin/env python3
"""Local controller for persistent project Sprites.

The controller keeps its token and SQLite state on the host, never in a Sprite.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / ".factory" / "state.sqlite3"
API_ROOT = "https://api.sprites.dev/v1"
PROJECT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


class FactoryError(Exception):
    pass


def sprite_token() -> str:
    token = os.environ.get("SPRITE_TOKEN", "").strip()
    if token:
        return token
    path = ROOT / ".env.local"
    if not path.exists():
        raise FactoryError("Set SPRITE_TOKEN in .env.local or the environment")
    values = [
        line.split("=", 1)[1].strip().strip('"').strip("'")
        for line in path.read_text().splitlines()
        if line.startswith("SPRITE_TOKEN=")
    ]
    if len(values) != 1 or not values[0]:
        raise FactoryError(".env.local needs exactly one nonempty SPRITE_TOKEN")
    return values[0]


class SpritesAPI:
    def __init__(self, token: str):
        self.token = token

    def request(self, method: str, path: str, *, body: object = None, query=()) -> bytes:
        url = API_ROOT + path
        if query:
            url += "?" + urlencode(query)
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        elif method == "POST":
            data = b""
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=120) as response:
                return response.read()
        except HTTPError as error:
            # Do not echo an upstream response: it could contain credentials.
            raise FactoryError(f"Sprites API returned HTTP {error.code} for {method} {path}") from None
        except URLError as error:
            raise FactoryError(f"Sprites API connection failed: {type(error.reason).__name__}") from None

    def get_sprite(self, name: str) -> dict | None:
        path = "/sprites/" + quote(name, safe="")
        try:
            return json.loads(self.request("GET", path))
        except FactoryError as error:
            if "HTTP 404" in str(error):
                return None
            raise

    def create_sprite(self, name: str) -> dict:
        return json.loads(self.request("POST", "/sprites", body={"name": name}))

    def exec(self, name: str, command: list[str]) -> bytes:
        path = "/sprites/" + quote(name, safe="") + "/exec"
        return self.request("POST", path, query=[("cmd", arg) for arg in command])


def database() -> sqlite3.Connection:
    STATE_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    connection = sqlite3.connect(STATE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """CREATE TABLE IF NOT EXISTS projects (
            project_id TEXT PRIMARY KEY,
            sprite_name TEXT NOT NULL UNIQUE,
            sprite_id TEXT,
            sprite_url TEXT,
            state TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    connection.commit()
    return connection


def project_row(db: sqlite3.Connection, project_id: str) -> sqlite3.Row:
    row = db.execute("SELECT * FROM projects WHERE project_id = ?", (project_id,)).fetchone()
    if row is None:
        raise FactoryError(f"Unknown project: {project_id}. Run provision first.")
    return row


def provision(db: sqlite3.Connection, api: SpritesAPI, project_id: str) -> dict:
    if not PROJECT_ID.fullmatch(project_id):
        raise FactoryError("Project ID must use lowercase letters, digits, and hyphens (max 40)")
    row = db.execute("SELECT * FROM projects WHERE project_id = ?", (project_id,)).fetchone()
    if row is None:
        # Save the intended name before the network call. A retry can reconcile
        # a Sprite created just before a controller crash.
        sprite_name = f"sf-{project_id[:35].rstrip('-')}-{uuid.uuid4().hex[:8]}"
        db.execute(
            "INSERT INTO projects (project_id, sprite_name, state) VALUES (?, ?, 'provisioning')",
            (project_id, sprite_name),
        )
        db.commit()
    else:
        sprite_name = row["sprite_name"]
    sprite = api.get_sprite(sprite_name)
    if sprite is None:
        sprite = api.create_sprite(sprite_name)
    if not sprite.get("id") or sprite.get("name") != sprite_name:
        raise FactoryError("Sprites API returned incomplete project identity")
    db.execute(
        """UPDATE projects SET sprite_id = ?, sprite_url = ?, state = 'ready',
           updated_at = CURRENT_TIMESTAMP WHERE project_id = ?""",
        (sprite["id"], sprite.get("url"), project_id),
    )
    db.commit()
    return sprite


def show_project(row: sqlite3.Row, sprite: dict | None = None) -> dict:
    result = {
        "project_id": row["project_id"],
        "sprite_name": row["sprite_name"],
        "sprite_id": row["sprite_id"],
        "sprite_url": row["sprite_url"],
        "state": row["state"],
    }
    if sprite is not None:
        result["sprite_status"] = sprite.get("status")
        result["url_auth"] = (sprite.get("url_settings") or {}).get("auth")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    provision_parser = commands.add_parser("provision", help="Create or reconnect to a project's Sprite")
    provision_parser.add_argument("project_id")
    commands.add_parser("projects", help="List locally known projects")
    status_parser = commands.add_parser("status", help="Inspect a project's live Sprite")
    status_parser.add_argument("project_id")
    exec_parser = commands.add_parser("exec", help="Run a command in a project's Sprite")
    exec_parser.add_argument("project_id")
    exec_parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    with database() as db:
        if args.command == "projects":
            rows = db.execute("SELECT * FROM projects ORDER BY project_id").fetchall()
            print(json.dumps([show_project(row) for row in rows], indent=2))
            return 0
        api = SpritesAPI(sprite_token())
        if args.command == "provision":
            provision(db, api, args.project_id)
            row = project_row(db, args.project_id)
            print(json.dumps(show_project(row, api.get_sprite(row["sprite_name"])), indent=2))
            return 0
        row = project_row(db, args.project_id)
        sprite = api.get_sprite(row["sprite_name"])
        if sprite is None:
            raise FactoryError(f"Sprite for {args.project_id} is missing; state is preserved")
        if args.command == "status":
            print(json.dumps(show_project(row, sprite), indent=2))
            return 0
        command = args.args[1:] if args.args and args.args[0] == "--" else args.args
        if not command:
            raise FactoryError("Pass a command after the project ID, for example: exec demo -- uname -a")
        output = api.exec(row["sprite_name"], command)
        sys.stdout.buffer.write(output)
        if output and not output.endswith(b"\n"):
            print()
        return 0
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FactoryError as error:
        print(f"factory: {error}", file=sys.stderr)
        raise SystemExit(1) from None
