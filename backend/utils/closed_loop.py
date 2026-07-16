"""Closed-loop event workflow utilities.

This module provides a lightweight event lifecycle model:
detected -> assessed -> assigned -> handling -> verified -> closed
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any

from utils.database import get_db

STAGE_FLOW = [
    "detected",
    "assessed",
    "assigned",
    "handling",
    "verified",
    "closed",
]
STAGE_SET = set(STAGE_FLOW)
RISK_LEVELS = {"low", "medium", "high", "critical"}


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _row_to_dict(row: Any) -> dict[str, Any]:
    return dict(row) if row is not None else {}


def normalize_stage(stage: str | None) -> str:
    stage = (stage or "").strip().lower()
    return stage if stage in STAGE_SET else "detected"


def next_stage(current_stage: str | None) -> str | None:
    stage = normalize_stage(current_stage)
    idx = STAGE_FLOW.index(stage)
    if idx >= len(STAGE_FLOW) - 1:
        return None
    return STAGE_FLOW[idx + 1]


def _normalize_risk_level(level: str | None) -> str:
    level = (level or "low").strip().lower()
    return level if level in RISK_LEVELS else "low"


def append_event_action(
    *,
    event_id: str,
    stage: str,
    action_type: str,
    action_text: str,
    action_status: str = "done",
    actor: str = "system",
    detail: str = "",
    conn=None,
) -> None:
    own_conn = conn is None
    if own_conn:
        conn = get_db()
    try:
        conn.execute(
            """
            INSERT INTO closed_loop_actions
            (event_id, stage, action_type, action_text, action_status, actor, detail, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                normalize_stage(stage),
                (action_type or "action").strip()[:48],
                (action_text or "").strip()[:255],
                (action_status or "done").strip()[:24],
                (actor or "system").strip()[:64],
                (detail or "").strip()[:500],
                _now_str(),
            ),
        )
        if own_conn:
            conn.commit()
    finally:
        if own_conn:
            conn.close()


def create_detection_event(
    *,
    workflow_id: str,
    location_name: str,
    city: str,
    gas_type: str,
    lat: float,
    lon: float,
    risk_level: str,
    result: str,
    summary: str,
    recommendations: list[str] | None,
    history_record_id: str | None,
    alarm_id: str | None,
    operator: str,
) -> dict[str, Any]:
    """Create one lifecycle event after a detection workflow completes."""
    event_id = str(uuid.uuid4())[:10]
    risk_level = _normalize_risk_level(risk_level)
    result = "anomaly" if (result or "").lower() == "anomaly" else "normal"
    stage = "closed" if result == "normal" else ("assigned" if alarm_id else "assessed")
    now = _now_str()
    payload = json.dumps(recommendations or [], ensure_ascii=False)

    conn = get_db()
    try:
        conn.execute(
            """
            INSERT INTO closed_loop_events
            (
                id, workflow_id, source, location_name, city, gas_type, risk_level, result, stage,
                summary, recommendations, lat, lon, detection_history_id, alarm_id,
                created_at, updated_at, closed_at, operator
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                (workflow_id or "").strip()[:64],
                "sentinel-auto",
                (location_name or "Unknown Site").strip()[:128],
                (city or "").strip()[:64],
                (gas_type or "CH4").strip().upper()[:16],
                risk_level,
                result,
                stage,
                (summary or "").strip()[:1000],
                payload,
                float(lat or 0.0),
                float(lon or 0.0),
                (history_record_id or "").strip()[:32],
                (alarm_id or "").strip()[:32],
                now,
                now,
                now if stage == "closed" else "",
                (operator or "agent-auto").strip()[:64],
            ),
        )

        append_event_action(
            event_id=event_id,
            stage="detected",
            action_type="detection",
            action_text="Detection signal captured",
            action_status="done",
            actor="agent-auto",
            detail="Satellite detection completed and payload generated.",
            conn=conn,
        )
        append_event_action(
            event_id=event_id,
            stage="assessed",
            action_type="assessment",
            action_text="Risk assessment completed",
            action_status="done",
            actor="agent-auto",
            detail=f"Risk level: {risk_level}.",
            conn=conn,
        )

        if result == "anomaly":
            if alarm_id:
                append_event_action(
                    event_id=event_id,
                    stage="assigned",
                    action_type="dispatch",
                    action_text="Alarm ticket assigned",
                    action_status="done",
                    actor="agent-auto",
                    detail=f"Linked alarm id: {alarm_id}.",
                    conn=conn,
                )
            else:
                append_event_action(
                    event_id=event_id,
                    stage="assessed",
                    action_type="dispatch",
                    action_text="Waiting assignment",
                    action_status="pending",
                    actor="agent-auto",
                    detail="No alarm ticket generated yet.",
                    conn=conn,
                )
        else:
            append_event_action(
                event_id=event_id,
                stage="closed",
                action_type="close",
                action_text="Auto-closed as normal",
                action_status="done",
                actor="agent-auto",
                detail="No anomaly confirmed; workflow closed automatically.",
                conn=conn,
            )

        conn.commit()
        return {"event_id": event_id, "stage": stage, "error": None}
    except Exception as exc:
        conn.rollback()
        return {"event_id": None, "stage": None, "error": str(exc)}
    finally:
        conn.close()


def list_events(
    *,
    limit: int = 20,
    stage: str | None = None,
    risk_level: str | None = None,
) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit or 20), 200))
    where = []
    params: list[Any] = []

    if stage:
        where.append("stage=?")
        params.append(normalize_stage(stage))
    if risk_level:
        where.append("risk_level=?")
        params.append(_normalize_risk_level(risk_level))

    where_clause = f"WHERE {' AND '.join(where)}" if where else ""

    conn = get_db()
    try:
        rows = conn.execute(
            f"""
            SELECT *
            FROM closed_loop_events
            {where_clause}
            ORDER BY updated_at DESC, created_at DESC
            LIMIT ?
            """,
            params + [limit],
        ).fetchall()
        events = []
        for row in rows:
            item = _row_to_dict(row)
            item["recommendations"] = _safe_json_list(item.get("recommendations"))
            events.append(item)
        return events
    finally:
        conn.close()


def get_event(event_id: str) -> dict[str, Any] | None:
    conn = get_db()
    try:
        event_row = conn.execute(
            "SELECT * FROM closed_loop_events WHERE id=?",
            (event_id,),
        ).fetchone()
        if not event_row:
            return None
        event = _row_to_dict(event_row)
        event["recommendations"] = _safe_json_list(event.get("recommendations"))
        actions = conn.execute(
            """
            SELECT id, event_id, stage, action_type, action_text, action_status, actor, detail, created_at
            FROM closed_loop_actions
            WHERE event_id=?
            ORDER BY id ASC
            """,
            (event_id,),
        ).fetchall()
        event["actions"] = [_row_to_dict(r) for r in actions]
        return event
    finally:
        conn.close()


def transition_event(
    *,
    event_id: str,
    target_stage: str | None,
    actor: str,
    detail: str,
) -> dict[str, Any]:
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, stage FROM closed_loop_events WHERE id=?",
            (event_id,),
        ).fetchone()
        if not row:
            return {"success": False, "error": "event_not_found"}

        current_stage = normalize_stage(row["stage"])
        desired_stage = normalize_stage(target_stage) if target_stage else next_stage(current_stage)
        if desired_stage is None:
            return {"success": False, "error": "already_closed"}

        if STAGE_FLOW.index(desired_stage) < STAGE_FLOW.index(current_stage):
            return {"success": False, "error": "stage_regression_not_allowed"}

        now = _now_str()
        conn.execute(
            """
            UPDATE closed_loop_events
            SET stage=?, updated_at=?, closed_at=?
            WHERE id=?
            """,
            (desired_stage, now, now if desired_stage == "closed" else "", event_id),
        )
        append_event_action(
            event_id=event_id,
            stage=desired_stage,
            action_type="stage_transition",
            action_text=f"Stage moved to {desired_stage}",
            action_status="done",
            actor=(actor or "agent-ui"),
            detail=(detail or "").strip(),
            conn=conn,
        )
        conn.commit()
        return {"success": True, "stage": desired_stage}
    except Exception as exc:
        conn.rollback()
        return {"success": False, "error": str(exc)}
    finally:
        conn.close()


def _safe_json_list(payload: Any) -> list[Any]:
    if payload is None:
        return []
    if isinstance(payload, list):
        return payload
    text = str(payload).strip()
    if not text:
        return []
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else []
    except Exception:
        return []
