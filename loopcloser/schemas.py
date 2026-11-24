"""
schemas.py — Pydantic request/response models.
"""

from __future__ import annotations

from typing import Optional
from pydantic import BaseModel, field_validator


# ── Projects ─────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Project name must not be empty.")
        return v


class ProjectStatusUpdate(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def valid_status(cls, v: str) -> str:
        allowed = {"active", "completed", "archived"}
        if v not in allowed:
            raise ValueError(f"Status must be one of {sorted(allowed)}.")
        return v


class ProjectOut(BaseModel):
    id: int
    name: str
    status: str
    created_at: str
    last_touched_at: str
    total_minutes: int
    is_stale: bool


# ── Sessions ─────────────────────────────────────────────────────────────────

class SessionStart(BaseModel):
    project_id: int
    task_title: str
    planned_minutes: int

    @field_validator("task_title")
    @classmethod
    def title_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Task title must not be empty.")
        return v

    @field_validator("planned_minutes")
    @classmethod
    def positive_minutes(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("planned_minutes must be a positive integer.")
        return v


class SessionStop(BaseModel):
    outcome: str
    status: str

    @field_validator("outcome")
    @classmethod
    def outcome_not_empty(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 5:
            raise ValueError("outcome must be at least 5 characters describing what was shipped or resolved.")
        return v

    @field_validator("status")
    @classmethod
    def valid_status(cls, v: str) -> str:
        allowed = {"completed", "abandoned"}
        if v not in allowed:
            raise ValueError(f"Status must be one of {sorted(allowed)}.")
        return v


class SessionOut(BaseModel):
    id: int
    project_id: int
    project_name: str
    task_title: str
    planned_minutes: int
    actual_minutes: int
    outcome: str
    status: str
    started_at: str
    ended_at: Optional[str]
    elapsed_seconds: Optional[int] = None


# ── Review ───────────────────────────────────────────────────────────────────

class ReviewSession(BaseModel):
    id: int
    project_name: str
    task_title: str
    actual_minutes: int
    outcome: str
    status: str
    started_at: str


class StaleProject(BaseModel):
    id: int
    name: str
    last_touched_at: str


class DailyReview(BaseModel):
    total_deep_work_minutes: int
    completed_sessions_count: int
    abandoned_sessions_count: int
    sessions: list[ReviewSession]
    stale_projects: list[StaleProject]
    focus_score: int
