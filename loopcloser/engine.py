"""
engine.py — Business logic: WIP limit enforcement, active session lock, stale detection.
"""

from datetime import datetime, timezone, timedelta

from fastapi import HTTPException

import db

WIP_LIMIT = 3
STALE_HOURS = 48


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def is_stale(last_touched_at: str) -> bool:
    """Return True if the project has not been touched in STALE_HOURS hours."""
    try:
        ts = datetime.fromisoformat(last_touched_at)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return (_utcnow() - ts) > timedelta(hours=STALE_HOURS)


def enforce_wip_limit(current_status: str | None = None) -> None:
    """
    Raise 400 if creating/activating a project would exceed WIP_LIMIT active projects.
    Pass current_status when updating a project so we don't double-count it.
    """
    count = db.count_active_projects()
    # If the project being updated is already active, activating it again is a no-op.
    if current_status == "active":
        return
    if count >= WIP_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=(
                f"WIP limit reached: you already have {WIP_LIMIT} active projects. "
                "Complete or archive one before starting another."
            ),
        )


def enforce_single_tasking_lock() -> None:
    """Raise 400 if a session is already running."""
    running = db.get_running_session()
    if running is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Single-tasking lock: session #{running['id']} "
                f"('{running['task_title']}') is already running. "
                "End it before starting a new one."
            ),
        )


def enforce_outcome(outcome: str) -> None:
    """Raise 400 if outcome is too short (redundant with Pydantic but kept for direct calls)."""
    if not outcome or len(outcome.strip()) < 5:
        raise HTTPException(
            status_code=400,
            detail="A meaningful outcome (min 5 characters) is required to close a session.",
        )


def compute_focus_score(sessions: list) -> int:
    """
    0-100 score based on:
      - 60 pts from completion ratio (completed / total sessions)
      - 40 pts from deep-work volume (capped at 240 minutes = 4 h as full credit)
    """
    total = len(sessions)
    if total == 0:
        return 0

    completed = sum(1 for s in sessions if s["status"] == "completed")
    total_minutes = sum(s["actual_minutes"] for s in sessions if s["status"] == "completed")

    completion_ratio = completed / total
    volume_ratio = min(total_minutes / 240, 1.0)

    score = int(completion_ratio * 60 + volume_ratio * 40)
    return max(0, min(100, score))
