"""FastAPI sentinel routes.

This module forwards sentinel requests through a local Flask blueprint adapter.
It removes global Flask app mounting while keeping existing sentinel behavior.
"""

from threading import Lock

from fastapi import APIRouter, Request, Response
from flask import Flask
from werkzeug.test import Client
from werkzeug.wrappers import Response as WSGIResponse

from routes.sentinel_route import sentinel_bp

router = APIRouter(prefix="/sentinel", tags=["sentinel"])

_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}
_DROP_REQUEST_HEADERS = {"host", "content-length"}

_legacy_app = Flask(__name__)
_legacy_app.register_blueprint(sentinel_bp, url_prefix="/sentinel")
_legacy_client = Client(_legacy_app, WSGIResponse)
_legacy_lock = Lock()


def _to_fastapi_response(legacy_response: WSGIResponse) -> Response:
    response = Response(
        content=legacy_response.get_data(),
        status_code=legacy_response.status_code,
    )
    for key, value in legacy_response.headers.items():
        key_lower = key.lower()
        if key_lower in _HOP_HEADERS or key_lower == "content-length":
            continue
        if key_lower == "content-type":
            response.headers["content-type"] = value
        else:
            response.headers[key] = value
    return response


async def _forward_to_legacy(request: Request, subpath: str) -> Response:
    path = "/sentinel"
    if subpath:
        path = f"{path}/{subpath}"

    request_body = await request.body()
    request_headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in _DROP_REQUEST_HEADERS
    }

    with _legacy_lock:
        legacy_response = _legacy_client.open(
            path=path,
            method=request.method,
            query_string=request.url.query,
            headers=request_headers,
            data=request_body,
        )
    return _to_fastapi_response(legacy_response)


_ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


@router.api_route("", methods=_ALL_METHODS, include_in_schema=False)
async def sentinel_root(request: Request):
    return await _forward_to_legacy(request, "")


@router.api_route("/", methods=_ALL_METHODS, include_in_schema=False)
async def sentinel_root_slash(request: Request):
    return await _forward_to_legacy(request, "")


@router.api_route("/{subpath:path}", methods=_ALL_METHODS)
async def sentinel_forward(subpath: str, request: Request):
    return await _forward_to_legacy(request, subpath)
