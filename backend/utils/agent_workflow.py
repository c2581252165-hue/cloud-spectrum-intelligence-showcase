"""Smart-agent closed-loop workflow helpers.

This module turns raw detection outputs into a full closed-loop payload:
detect -> diagnose -> risk-level -> recommendation -> persistence.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from utils.database import get_db
from utils.closed_loop import create_detection_event

RISK_ORDER = ["low", "medium", "high", "critical"]
RISK_LABELS = {
    "low": "低风险",
    "medium": "中风险",
    "high": "高风险",
    "critical": "严重风险",
}
GAS_UNITS = {
    "CH4": "ppm",
    "CO": "mol/m²",
    "NO2": "mol/m²",
}


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def evaluate_risk(gas_type: str, detection_ratio: float, mean_concentration: float) -> dict[str, Any]:
    """Rule-based risk scoring for the agent closed loop."""
    gas_type = (gas_type or "CH4").upper()
    ratio = _clamp(_to_float(detection_ratio, 0.0), 0.0, 1.0)
    concentration = max(_to_float(mean_concentration, 0.0), 0.0)

    score = ratio * 100.0

    if gas_type == "CH4":
        if concentration >= 0.65:
            score += 8
        if concentration >= 0.80:
            score += 8
    elif gas_type == "CO":
        if concentration >= 0.035:
            score += 8
        if concentration >= 0.060:
            score += 8
    elif gas_type == "NO2":
        if concentration >= 6e-5:
            score += 8
        if concentration >= 1.2e-4:
            score += 8

    score = round(_clamp(score, 0.0, 100.0), 2)

    if score >= 75:
        risk_level = "critical"
    elif score >= 45:
        risk_level = "high"
    elif score >= 15:
        risk_level = "medium"
    else:
        risk_level = "low"

    # Keep sensitivity for tiny but non-zero plume ratio.
    if risk_level == "low" and ratio >= 0.02:
        risk_level = "medium"

    return {
        "risk_level": risk_level,
        "risk_level_text": RISK_LABELS[risk_level],
        "risk_score": score,
        "is_anomaly": risk_level != "low",
    }


def generate_recommendations(gas_type: str, risk_level: str) -> list[str]:
    gas_type = (gas_type or "CH4").upper()
    risk_level = risk_level if risk_level in RISK_LABELS else "low"

    gas_specific = {
        "CH4": [
            "优先排查压缩机站、阀组和法兰接口，确认是否存在甲烷泄漏点。",
            "结合风向回溯上游 3-5 公里设备，定位潜在排放源。",
        ],
        "CO": [
            "核查周边燃烧设施工况，重点关注锅炉和火炬系统。",
            "对高负荷时段做分时复测，确认异常是否与工况波动相关。",
        ],
        "NO2": [
            "排查交通干线与工业燃烧源，识别 NO2 高值贡献区域。",
            "结合气象扩散条件判断是否需要临时减排联动。",
        ],
    }.get(
        gas_type,
        [
            "复核异常区域近 24 小时的作业活动与环境条件。",
            "对异常点执行下一周期复测，确认是否持续异常。",
        ],
    )

    common = [
        "核对同区域最近三期卫星结果，确认异常持续性。",
        "将异常位置加入下一轮优先复测清单。",
    ]
    urgent = []
    if risk_level in {"high", "critical"}:
        urgent.append("在 2 小时内派工现场核查关键设备并拍照回传。")
    if risk_level == "critical":
        urgent.append("立即触发应急告警流程并通知值班负责人。")

    recommendations = gas_specific + common + urgent
    return recommendations[:4]


def build_feedback_message(risk_level: str, location_name: str, gas_type: str) -> tuple[str, str]:
    label = location_name or "监测点"
    gas_name = (gas_type or "CH4").upper()

    if risk_level == "low":
        return (
            "运行正常",
            f"{label} 的 {gas_name} 指标整体平稳，当前建议维持常规巡检频率。",
        )
    if risk_level == "medium":
        return (
            "建议关注",
            f"{label} 出现轻度异常，建议尽快复测并检查上游潜在排放源。",
        )
    if risk_level == "high":
        return (
            "需要处置",
            f"{label} 出现明显异常，建议启动现场排查并安排人工复核。",
        )
    return (
        "紧急告警",
        f"{label} 出现高风险异常，建议立即执行应急联动处置。",
    )


def _persist_closed_loop(
    *,
    lat: float,
    lon: float,
    gas_type: str,
    mean_concentration: float,
    threshold_used: float,
    location_name: str,
    city: str,
    result: str,
    risk_level_text: str,
    summary: str,
    recommendation: str,
    rgb_image: str,
    mask_image: str,
    operator: str,
) -> dict[str, Any]:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    history_id = str(uuid.uuid4())[:8]
    alarm_id: str | None = None

    station_name = location_name or "监测点"
    if city:
        station_name = f"{city}-{station_name}"

    conn = get_db()
    try:
        conn.execute(
            """
            INSERT INTO detection_history
            (id, lat, lon, time, gas_type, result, concentration, unit, rgb_image, mask_image, operator, remark)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                history_id,
                _to_float(lat, 0.0),
                _to_float(lon, 0.0),
                now,
                gas_type,
                result,
                _to_float(mean_concentration, 0.0),
                GAS_UNITS.get(gas_type, "ppb"),
                rgb_image or "",
                mask_image or "",
                operator or "agent-auto",
                f"[Agent] {risk_level_text} | {summary} | 建议: {recommendation}",
            ),
        )

        if result == "anomaly":
            alarm_id = str(uuid.uuid4())[:8]
            conn.execute(
                """
                INSERT INTO alarms (id, station, value, threshold, unit, time, status, remark)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    alarm_id,
                    station_name,
                    _to_float(mean_concentration, 0.0),
                    _to_float(threshold_used, 0.0),
                    GAS_UNITS.get(gas_type, "ppb"),
                    now,
                    "pending",
                    f"[Agent] 自动生成告警：{risk_level_text}",
                ),
            )

        conn.commit()
        return {"history_record_id": history_id, "alarm_id": alarm_id, "error": None}
    except Exception as exc:
        conn.rollback()
        return {"history_record_id": None, "alarm_id": None, "error": str(exc)}
    finally:
        conn.close()


def run_agent_closed_loop(
    *,
    lat: float,
    lon: float,
    location_name: str,
    city: str,
    gas_type: str,
    mean_concentration: float,
    detection_ratio: float,
    threshold_used: float,
    time_start: str,
    time_end: str,
    rgb_image: str = "",
    mask_image: str = "",
    operator: str = "agent-auto",
    persist: bool = True,
) -> dict[str, Any]:
    """Build and optionally persist one unified smart-agent workflow."""
    gas_type = (gas_type or "CH4").upper()
    assessment = evaluate_risk(gas_type, detection_ratio, mean_concentration)
    risk_level = assessment["risk_level"]

    recommendations = generate_recommendations(gas_type, risk_level)
    summary = (
        f"{location_name or '监测点'} 在 {time_start}~{time_end} 的 {gas_type} "
        f"检测率为 {max(_to_float(detection_ratio, 0.0), 0.0):.2%}，"
        f"综合评估为 {assessment['risk_level_text']}。"
    )
    title, user_msg = build_feedback_message(risk_level, location_name, gas_type)

    causes = {
        "CH4": ["设备密封件老化导致微泄漏", "上游输送环节存在间歇性逸散"],
        "CO": ["燃烧效率波动造成 CO 排放升高", "局地扩散条件不佳导致浓度累积"],
        "NO2": ["交通与工业燃烧叠加影响", "大气稳定层结导致扩散受限"],
    }.get(gas_type, ["局地排放源增强", "气象扩散条件变化"])

    execution_actions = [
        {"step": "异常检测", "status": "done"},
        {"step": "原因分析", "status": "done"},
        {"step": "风险分级", "status": "done"},
        {"step": "生成建议", "status": "done"},
    ]

    record_info = {"history_record_id": None, "alarm_id": None}
    event_info = {"event_id": None, "stage": None, "error": None}
    db_error = None

    if persist:
        persisted = _persist_closed_loop(
            lat=lat,
            lon=lon,
            gas_type=gas_type,
            mean_concentration=mean_concentration,
            threshold_used=threshold_used,
            location_name=location_name,
            city=city,
            result="anomaly" if assessment["is_anomaly"] else "normal",
            risk_level_text=assessment["risk_level_text"],
            summary=summary,
            recommendation=recommendations[0] if recommendations else "维持例行巡检",
            rgb_image=rgb_image,
            mask_image=mask_image,
            operator=operator,
        )
        db_error = persisted.get("error")
        record_info = {
            "history_record_id": persisted.get("history_record_id"),
            "alarm_id": persisted.get("alarm_id"),
        }

        execution_actions.append(
            {
                "step": "回传记录",
                "status": "failed" if db_error else "done",
                "detail": "数据库写入失败" if db_error else "检测历史已入库",
            }
        )
        if assessment["is_anomaly"]:
            execution_actions.append(
                {
                    "step": "告警生成",
                    "status": "done" if record_info["alarm_id"] else "skipped",
                    "detail": "自动创建待处理告警" if record_info["alarm_id"] else "未创建告警",
                }
            )
    else:
        execution_actions.append({"step": "回传记录", "status": "skipped", "detail": "persist=False"})

    workflow_id = str(uuid.uuid4())
    try:
        event_info = create_detection_event(
            workflow_id=workflow_id,
            location_name=location_name,
            city=city,
            gas_type=gas_type,
            lat=lat,
            lon=lon,
            risk_level=assessment["risk_level"],
            result="anomaly" if assessment["is_anomaly"] else "normal",
            summary=summary,
            recommendations=recommendations,
            history_record_id=record_info.get("history_record_id"),
            alarm_id=record_info.get("alarm_id"),
            operator=operator,
        )
        execution_actions.append(
            {
                "step": "event_lifecycle",
                "status": "failed" if event_info.get("error") else "done",
                "detail": event_info.get("error") or f"event_id={event_info.get('event_id')}",
            }
        )
    except Exception as exc:
        event_info = {"event_id": None, "stage": None, "error": str(exc)}
        execution_actions.append(
            {
                "step": "event_lifecycle",
                "status": "failed",
                "detail": str(exc),
            }
        )

    return {
        "workflow_id": workflow_id,
        "status": "completed",
        "result": "anomaly" if assessment["is_anomaly"] else "normal",
        "risk_level": assessment["risk_level"],
        "risk_level_text": assessment["risk_level_text"],
        "risk_score": assessment["risk_score"],
        "diagnosis": {
            "summary": summary,
            "possible_causes": causes,
        },
        "recommendations": recommendations,
        "user_feedback": {
            "title": title,
            "message": user_msg,
            "need_manual_confirmation": risk_level in {"high", "critical"},
        },
        "execution": {
            "mode": "auto",
            "actions": execution_actions,
            "records": {
                **record_info,
                "event_id": event_info.get("event_id"),
                "event_stage": event_info.get("stage"),
            },
            "db_error": db_error,
            "event_error": event_info.get("error"),
        },
    }
