"""FastAPI chat routes."""

import os
from typing import Any

import requests
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/chat", tags=["chat"])

QWEN_API_URL = os.environ.get(
    "QWEN_API_URL",
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
)
QWEN_API_KEY = 
    
    os.environ.get("DASHSCOPE_API_KEY", os.environ.get("DOUBAO_API_KEY", "")),
)
QWEN_MODEL_ID = os.environ.get("QWEN_MODEL_ID", os.environ.get("QWEN_MODEL", "qwen-plus"))


def _reply_identity() -> str:
    return f"我是云谱智探智能助手，当前接入的是通义千问模型（{QWEN_MODEL_ID}）。"


VIEW_MAP = {
    "首页": "main-view",
    "主界面": "main-view",
    "地图": "main-view",
    "模型": "model-view",
    "模型输出": "model-view",
    "可视化": "visualization-view",
    "数据可视化": "visualization-view",
    "风场": "satellite-view",
    "风场数据": "satellite-view",
    "分析": "analysis-view",
    "排放率": "flux-view",
    "关于我们": "about-view",
}


def _extract_float(pattern: str, text: str):
    import re

    m = re.search(pattern, text, flags=re.IGNORECASE)
    if not m:
        return None
    try:
        return float(m.group(1))
    except (TypeError, ValueError):
        return None


def _parse_ui_command(command: str):
    text = (command or "").strip()
    if not text:
        return []

    actions = []
    for key, view_id in VIEW_MAP.items():
        if key in text:
            actions.append({"type": "switch_view", "target": view_id, "label": f"切换到 {key}"})
            break

    if "定位到中国" in text or "回到中国" in text:
        actions.append({"type": "click", "selector": "#btnFlyToChina", "label": "定位到中国"})
    if "切换影像" in text:
        actions.append({"type": "click", "selector": "#btnToggleImagery", "label": "切换影像图层"})
    if "显示地名" in text or "隐藏地名" in text or "切换地名" in text:
        actions.append({"type": "click", "selector": "#btnToggleNames", "label": "切换地名显示"})
    if "添加标记" in text or "加标记" in text:
        actions.append({"type": "click", "selector": "#btnAddMarker", "label": "开启添加标记模式"})
    if "清除标记" in text:
        actions.append({"type": "click", "selector": "#btnClearMarkers", "label": "清除全部标记"})
    if "加载" in text and "甲烷" in text:
        actions.append({"type": "click", "selector": "#btnLoadSentinel5PCH4", "label": "加载甲烷图层"})
    if ("移除" in text or "关闭" in text) and "甲烷" in text:
        actions.append({"type": "click", "selector": "#btnRemoveSentinel5PCH4", "label": "移除甲烷图层"})

    lon = _extract_float(r"经度\s*([\-]?\d+(?:\.\d+)?)", text)
    lat = _extract_float(r"纬度\s*([\-]?\d+(?:\.\d+)?)", text)
    if lon is not None:
        actions.append({"type": "set_value", "selector": "#customLongitude", "value": str(lon), "label": "设置经度"})
    if lat is not None:
        actions.append({"type": "set_value", "selector": "#customLatitude", "value": str(lat), "label": "设置纬度"})
    if (lon is not None or lat is not None) and any(k in text for k in ["定位", "飞到", "前往", "查看"]):
        actions.append({"type": "click", "selector": "#customLocateBtn", "label": "执行定位"})

    threshold = _extract_float(r"阈值\s*([0-9]+(?:\.[0-9]+)?)", text)
    if threshold is not None:
        actions.append({"type": "set_value", "selector": "#thresholdSlider", "value": str(threshold), "label": "设置甲烷阈值"})

    intensity = _extract_float(r"颜色强度\s*([0-9]+(?:\.[0-9]+)?)", text)
    if intensity is not None:
        actions.append({"type": "set_value", "selector": "#intensitySlider", "value": str(intensity), "label": "设置颜色强度"})

    opacity = _extract_float(r"透明度\s*([0-9]+(?:\.[0-9]+)?)", text)
    if opacity is not None:
        actions.append({"type": "set_value", "selector": "#opacitySlider", "value": str(opacity), "label": "设置图层透明度"})

    return actions


def _error(reply: str, status: int) -> JSONResponse:
    return JSONResponse(status_code=status, content={"reply": reply})


@router.api_route("/ui-command", methods=["POST", "OPTIONS"])
async def parse_ui_command(request: Request):
    if request.method == "OPTIONS":
        return Response(status_code=200)

    try:
        data: Any = await request.json()
    except Exception:
        data = {}

    if not isinstance(data, dict):
        data = {}
    command = str(data.get("command", "")).strip()
    if not command:
        return JSONResponse(status_code=400, content={"success": False, "message": "command is required"})

    actions = _parse_ui_command(command)
    return JSONResponse(
        content={
            "success": True,
            "command": command,
            "actions": actions,
            "can_execute": len(actions) > 0,
            "message": "ok" if actions else "未解析到可执行动作，请补充更具体指令",
        }
    )


@router.api_route("/chat", methods=["POST", "OPTIONS"])
async def chat(request: Request):
    if request.method == "OPTIONS":
        return Response(status_code=200)

    try:
        data: Any = await request.json()
    except Exception:
        data = {}

    if not isinstance(data, dict):
        data = {}

    if not QWEN_API_KEY or not QWEN_MODEL_ID:
        return _error("❌ 通义千问配置缺失，请检查 QWEN_API_KEY / QWEN_MODEL_ID", 500)

    user_message = str(data.get("message", "")).strip()
    if not user_message:
        return _error("❌ 请输入有效问题后再发送", 400)

    identity_keywords = ["你是什么模型", "什么模型", "哪个模型", "你是谁"]
    if any(keyword in user_message for keyword in identity_keywords):
        return JSONResponse(content={"reply": _reply_identity()})

    headers = {
        "Authorization": f"Bearer {QWEN_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": QWEN_MODEL_ID,
        "messages": [
            {
                "role": "system",
                "content": (
                    f"你是云谱智探平台的智能助手，当前模型为通义千问（{QWEN_MODEL_ID}）。"
                    "回答简洁专业，不要自称豆包或字节跳动助手。"
                ),
            },
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.7,
    }

    try:
        response = requests.post(
            url=QWEN_API_URL,
            headers=headers,
            json=payload,
            timeout=30,
        )
    except requests.Timeout:
        return _error("❌ 请求超时，请稍后重试", 504)
    except Exception as exc:
        return _error(f"❌ 服务器错误: {exc}", 500)

    if response.status_code != 200:
        return _error(f"❌ 通义千问接口请求失败（状态码 {response.status_code}）", 500)

    try:
        result = response.json()
    except Exception:
        return _error("❌ 解析模型回复失败", 500)

    try:
        if "choices" in result:
            reply_text = result["choices"][0]["message"]["content"]
        elif "data" in result and isinstance(result["data"], list):
            reply_text = result["data"][0]["choices"][0]["message"]["content"]
        else:
            reply_text = "❌ 无法解析通义千问返回数据"
    except (KeyError, IndexError, TypeError):
        reply_text = "❌ 解析模型回复失败"

    return JSONResponse(content={"reply": reply_text})

