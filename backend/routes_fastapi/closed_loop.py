"""FastAPI closed-loop event routes."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from utils.closed_loop import (
    append_event_action,
    create_detection_event,
    get_event,
    list_events,
    next_stage,
    normalize_stage,
    transition_event,
)
from utils.database import get_db

router = APIRouter(prefix="/closed-loop", tags=["closed-loop"])


def _body_or_empty(data: Any) -> dict[str, Any]:
    return data if isinstance(data, dict) else {}


@router.get("/events")
async def api_list_events(limit: int = 20, stage: str | None = None, risk_level: str | None = None):
    events = list_events(limit=limit, stage=stage, risk_level=risk_level)
    return {"success": True, "events": events}


@router.get("/events/{event_id}")
async def api_get_event(event_id: str):
    event = get_event(event_id)
    if not event:
        return JSONResponse(status_code=404, content={"success": False, "message": "event not found"})
    event["next_stage"] = next_stage(event.get("stage"))
    return {"success": True, "event": event}


@router.post("/events/{event_id}/transition")
async def api_transition_event(event_id: str, request: Request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    data = _body_or_empty(data)

    actor = str(data.get("actor") or data.get("operator") or "agent-ui").strip()
    detail = str(data.get("detail") or data.get("remark") or "").strip()
    target_stage = data.get("target_stage") or data.get("stage")

    result = transition_event(
        event_id=event_id,
        target_stage=target_stage,
        actor=actor,
        detail=detail,
    )
    if not result.get("success"):
        msg = result.get("error", "transition_failed")
        code = 409 if msg in {"already_closed", "stage_regression_not_allowed"} else 400
        if msg == "event_not_found":
            code = 404
        return JSONResponse(status_code=code, content={"success": False, "message": msg})

    event = get_event(event_id)
    return {"success": True, "stage": result.get("stage"), "event": event}


@router.post("/events/{event_id}/actions")
async def api_append_action(event_id: str, request: Request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    data = _body_or_empty(data)

    action_text = str(data.get("action_text") or data.get("text") or "").strip()
    if not action_text:
        return JSONResponse(status_code=400, content={"success": False, "message": "action_text is required"})

    append_event_action(
        event_id=event_id,
        stage=normalize_stage(str(data.get("stage") or "")),
        action_type=str(data.get("action_type") or "manual_note").strip(),
        action_text=action_text,
        action_status=str(data.get("action_status") or "done").strip(),
        actor=str(data.get("actor") or data.get("operator") or "agent-ui").strip(),
        detail=str(data.get("detail") or "").strip(),
    )
    event = get_event(event_id)
    return {"success": True, "event": event}


@router.post("/events")
async def api_create_manual_event(request: Request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    data = _body_or_empty(data)
    recommendations = data.get("recommendations")
    if not isinstance(recommendations, list):
        recommendations = []

    result = create_detection_event(
        workflow_id=str(data.get("workflow_id") or str(uuid.uuid4())[:12]).strip(),
        location_name=str(data.get("location_name") or "Manual Event").strip(),
        city=str(data.get("city") or "").strip(),
        gas_type=str(data.get("gas_type") or "CH4").strip().upper(),
        lat=float(data.get("lat") or 0.0),
        lon=float(data.get("lon") or 0.0),
        risk_level=str(data.get("risk_level") or "medium").strip().lower(),
        result=str(data.get("result") or "anomaly").strip().lower(),
        summary=str(data.get("summary") or "Created from manual API").strip(),
        recommendations=recommendations,
        history_record_id=str(data.get("history_record_id") or "").strip(),
        alarm_id=str(data.get("alarm_id") or "").strip(),
        operator=str(data.get("operator") or "agent-ui").strip(),
    )
    if result.get("error"):
        return JSONResponse(status_code=500, content={"success": False, "message": result["error"]})

    event = get_event(result["event_id"])
    return JSONResponse(status_code=201, content={"success": True, "event": event})


@router.get("/metrics")
async def api_closed_loop_metrics():
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT stage, COUNT(*) AS count
            FROM closed_loop_events
            GROUP BY stage
            """
        ).fetchall()
        stage_counts = {row["stage"]: row["count"] for row in rows}
        total = sum(stage_counts.values())
        closed = stage_counts.get("closed", 0)
        close_rate = round((closed / total) * 100.0, 2) if total else 0.0
        return {
            "success": True,
            "metrics": {
                "total_events": total,
                "closed_events": closed,
                "close_rate": close_rate,
                "stage_counts": stage_counts,
            },
        }
    finally:
        conn.close()
