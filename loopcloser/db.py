"""
db.py — SQLite connection, schema initialization, and CRUD helpers.
"""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "loopcloser.db"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT    NOT NULL,
                status         TEXT    NOT NULL DEFAULT 'active',
                created_at     TEXT    NOT NULL,
                last_touched_at TEXT   NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id      INTEGER NOT NULL REFERENCES projects(id),
                task_title      TEXT    NOT NULL,
                planned_minutes INTEGER NOT NULL,
                actual_minutes  INTEGER DEFAULT 0,
                outcome         TEXT    DEFAULT '',
                status          TEXT    NOT NULL DEFAULT 'running',
                started_at      TEXT    NOT NULL,
                ended_at        TEXT
            );
            """
        )


# ── Projects ────────────────────────────────────────────────────────────────

def create_project(name: str) -> sqlite3.Row:
    now = _now_iso()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO projects (name, status, created_at, last_touched_at) "
            "VALUES (?, 'active', ?, ?)",
            (name, now, now),
        )
        return _get_project(conn, cur.lastrowid)


def get_all_projects() -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            """
            SELECT
                p.*,
                COALESCE(SUM(s.actual_minutes), 0) AS total_minutes
            FROM projects p
            LEFT JOIN sessions s ON s.project_id = p.id
            GROUP BY p.id
            ORDER BY p.last_touched_at DESC
            """
        ).fetchall()


def get_project(project_id: int) -> sqlite3.Row | None:
    with get_conn() as conn:
        return _get_project(conn, project_id)


def _get_project(conn: sqlite3.Connection, project_id: int) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT
            p.*,
            COALESCE(SUM(s.actual_minutes), 0) AS total_minutes
        FROM projects p
        LEFT JOIN sessions s ON s.project_id = p.id
        WHERE p.id = ?
        GROUP BY p.id
        """,
        (project_id,),
    ).fetchone()


def update_project_status(project_id: int, status: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE projects SET status = ? WHERE id = ?",
            (status, project_id),
        )
        return _get_project(conn, project_id)


def touch_project(project_id: int, conn: sqlite3.Connection | None = None) -> None:
    """Update last_touched_at. Accepts an optional open connection for use inside transactions."""
    now = _now_iso()
    if conn is not None:
        conn.execute(
            "UPDATE projects SET last_touched_at = ? WHERE id = ?",
            (now, project_id),
        )
    else:
        with get_conn() as c:
            c.execute(
                "UPDATE projects SET last_touched_at = ? WHERE id = ?",
                (now, project_id),
            )


def count_active_projects() -> int:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM projects WHERE status = 'active'"
        ).fetchone()
        return row[0]


# ── Sessions ─────────────────────────────────────────────────────────────────

def create_session(project_id: int, task_title: str, planned_minutes: int) -> sqlite3.Row:
    now = _now_iso()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO sessions (project_id, task_title, planned_minutes, status, started_at) "
            "VALUES (?, ?, ?, 'running', ?)",
            (project_id, task_title, planned_minutes, now),
        )
        touch_project(project_id, conn)
        return _get_session(conn, cur.lastrowid)


def get_running_session() -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute(
            """
            SELECT s.*, p.name AS project_name
            FROM sessions s
            JOIN projects p ON p.id = s.project_id
            WHERE s.status = 'running'
            LIMIT 1
            """
        ).fetchone()


def stop_session(session_id: int, outcome: str, status: str) -> sqlite3.Row | None:
    now = _now_iso()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE id = ? AND status = 'running'",
            (session_id,),
        ).fetchone()
        if row is None:
            return None

        started = datetime.fromisoformat(row["started_at"])
        ended = datetime.fromisoformat(now)
        actual_minutes = max(1, int((ended - started).total_seconds() / 60))

        conn.execute(
            "UPDATE sessions SET outcome = ?, status = ?, ended_at = ?, actual_minutes = ? "
            "WHERE id = ?",
            (outcome, status, now, actual_minutes, session_id),
        )
        touch_project(row["project_id"], conn)
        return _get_session(conn, session_id)


def _get_session(conn: sqlite3.Connection, session_id: int) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT s.*, p.name AS project_name
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        WHERE s.id = ?
        """,
        (session_id,),
    ).fetchone()


def get_session(session_id: int) -> sqlite3.Row | None:
    with get_conn() as conn:
        return _get_session(conn, session_id)


def get_today_sessions() -> list[sqlite3.Row]:
    today = datetime.now(timezone.utc).date().isoformat()
    with get_conn() as conn:
        return conn.execute(
            """
            SELECT s.*, p.name AS project_name
            FROM sessions s
            JOIN projects p ON p.id = s.project_id
            WHERE s.started_at >= ?
            ORDER BY s.started_at ASC
            """,
            (today,),
        ).fetchall()


def get_all_sessions_for_export() -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            """
            SELECT
                s.id,
                p.name   AS project_name,
                s.task_title,
                s.planned_minutes,
                s.actual_minutes,
                s.outcome,
                s.status,
                s.started_at,
                s.ended_at
            FROM sessions s
            JOIN projects p ON p.id = s.project_id
            ORDER BY s.started_at DESC
            """
        ).fetchall()
