

"""
main.py — FastAPI application, all API routes, and static file serving.
Run with: uvicorn main:app --reload
"""

import csv
import io
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Path
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

import db
import engine
from schemas import (
    DailyReview,
    ProjectCreate,
    ProjectOut,
    ProjectStatusUpdate,
    ReviewSession,
    SessionOut,
    SessionStart,
    SessionStop,
    StaleProject,
)

# ── App setup ─────────────────────────────────────────────────────────────────

db.init_db()

app = FastAPI(title="LoopCloser", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _project_out(row) -> ProjectOut:
    return ProjectOut(
        id=row["id"],
        name=row["name"],
        status=row["status"],
        created_at=row["created_at"],
        last_touched_at=row["last_touched_at"],
        total_minutes=row["total_minutes"],
        is_stale=engine.is_stale(row["last_touched_at"]) and row["status"] == "active",
    )


def _session_out(row, elapsed: Optional[int] = None) -> SessionOut:
    return SessionOut(
        id=row["id"],
        project_id=row["project_id"],
        project_name=row["project_name"],
        task_title=row["task_title"],
        planned_minutes=row["planned_minutes"],
        actual_minutes=row["actual_minutes"] or 0,
        outcome=row["outcome"] or "",
        status=row["status"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        elapsed_seconds=elapsed,
    )


def _elapsed(started_at: str) -> int:
    ts = datetime.fromisoformat(started_at)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return int((datetime.now(timezone.utc) - ts).total_seconds())


# ── Static files & root ───────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", include_in_schema=False)
def root():
    from fastapi.responses import FileResponse
    return FileResponse("static/index.html")


# ── Projects ─────────────────────────────────────────────────────────────────

@app.get("/api/projects", response_model=list[ProjectOut])
def list_projects():
    rows = db.get_all_projects()
    return [_project_out(r) for r in rows]


@app.post("/api/projects", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectCreate):
    engine.enforce_wip_limit()
    row = db.create_project(body.name)
    return _project_out(row)


@app.patch("/api/projects/{project_id}", response_model=ProjectOut)
def update_project_status(project_id: int = Path(...), body: ProjectStatusUpdate = ...):
    existing = db.get_project(project_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    if body.status == "active":
        engine.enforce_wip_limit(current_status=existing["status"])

    row = db.update_project_status(project_id, body.status)
    return _project_out(row)


# ── Sessions ─────────────────────────────────────────────────────────────────

@app.get("/api/sessions/active", response_model=Optional[SessionOut])
def get_active_session():
    row = db.get_running_session()
    if row is None:
        return None
    return _session_out(row, elapsed=_elapsed(row["started_at"]))


@app.post("/api/sessions/start", response_model=SessionOut, status_code=201)
def start_session(body: SessionStart):
    engine.enforce_single_tasking_lock()

    project = db.get_project(body.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    if project["status"] != "active":
        raise HTTPException(
            status_code=400,
            detail="Cannot start a session on a non-active project.",
        )

    row = db.create_session(body.project_id, body.task_title, body.planned_minutes)
    return _session_out(row, elapsed=0)


@app.post("/api/sessions/{session_id}/stop", response_model=SessionOut)
def stop_session(body: SessionStop, session_id: int = Path(...)):
    engine.enforce_outcome(body.outcome)

    running = db.get_running_session()
    if running is None or running["id"] != session_id:
        raise HTTPException(
            status_code=400,
            detail=f"Session #{session_id} is not currently running.",
        )

    row = db.stop_session(session_id, body.outcome, body.status)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return _session_out(row)


# ── Review ────────────────────────────────────────────────────────────────────

@app.get("/api/review/today", response_model=DailyReview)
def review_today():
    today_sessions = db.get_today_sessions()
    all_projects = db.get_all_projects()

    stale = [
        StaleProject(id=p["id"], name=p["name"], last_touched_at=p["last_touched_at"])
        for p in all_projects
        if p["status"] == "active" and engine.is_stale(p["last_touched_at"])
    ]

    completed_sessions = [s for s in today_sessions if s["status"] == "completed"]
    total_minutes = sum(s["actual_minutes"] for s in completed_sessions)
    abandoned_count = sum(1 for s in today_sessions if s["status"] == "abandoned")

    review_list = [
        ReviewSession(
            id=s["id"],
            project_name=s["project_name"],
            task_title=s["task_title"],
            actual_minutes=s["actual_minutes"] or 0,
            outcome=s["outcome"] or "",
            status=s["status"],
            started_at=s["started_at"],
        )
        for s in today_sessions
    ]

    return DailyReview(
        total_deep_work_minutes=total_minutes,
        completed_sessions_count=len(completed_sessions),
        abandoned_sessions_count=abandoned_count,
        sessions=review_list,
        stale_projects=stale,
        focus_score=engine.compute_focus_score(today_sessions),
    )


# ── CSV Export ────────────────────────────────────────────────────────────────

@app.get("/api/export/csv")
def export_csv():
    rows = db.get_all_sessions_for_export()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "id",
            "project_name",
            "task_title",
            "planned_minutes",
            "actual_minutes",
            "outcome",
            "status",
            "started_at",
            "ended_at",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                r["id"],
                r["project_name"],
                r["task_title"],
                r["planned_minutes"],
                r["actual_minutes"],
                r["outcome"],
                r["status"],
                r["started_at"],
                r["ended_at"] or "",
            ]
        )

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=loopcloser_sessions.csv"},
    )
