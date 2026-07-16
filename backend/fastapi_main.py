"""FastAPI entrypoint."""

import os
import sys
from pathlib import Path

import ee
import matplotlib
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = (BASE_DIR / "output").resolve()

# Load environment before importing route modules that read env vars.
load_dotenv(BASE_DIR / ".env")

from routes_fastapi.admin import router as admin_router
from routes_fastapi.auth import router as auth_router
from routes_fastapi.chat import router as chat_router
from routes_fastapi.closed_loop import router as closed_loop_router
from routes_fastapi.sentinel import router as sentinel_router
from utils.database import init_db

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

init_db()

service_account = os.getenv("GEE_SERVICE_ACCOUNT", "").strip()
key_file = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
try:
    if service_account and key_file and Path(key_file).exists():
        ee.Initialize(ee.ServiceAccountCredentials(service_account, key_file))
        print("[OK] Google Earth Engine initialized")
    else:
        print("[WARN] Google Earth Engine credentials are not configured; GEE features are disabled in public version")
except Exception as exc:
    print(f"[WARN] Google Earth Engine init failed, backend still running: {exc}")

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
matplotlib.use("Agg")
matplotlib.rcParams["font.family"] = "Microsoft YaHei"
matplotlib.rcParams["font.size"] = 12
matplotlib.rcParams["axes.unicode_minus"] = False

app = FastAPI(
    title="SkyMethane API",
    description="FastAPI backend.",
    version="2.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:8090",
        "http://127.0.0.1:8090",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(chat_router)
app.include_router(sentinel_router)
app.include_router(closed_loop_router)


@app.get("/health-fastapi")
def health_fastapi():
    return {"status": "healthy", "message": "FastAPI backend running", "mode": "fastapi-full"}


@app.get("/health")
def health():
    return {"status": "healthy", "message": "Backend API running", "mode": "fastapi-full"}


@app.get("/flaskk/output/{filename:path}")
def serve_output_file(filename: str):
    requested = (OUTPUT_DIR / filename).resolve()
    output_prefix = str(OUTPUT_DIR) + os.sep
    if str(requested) != str(OUTPUT_DIR) and not str(requested).startswith(output_prefix):
        return JSONResponse(status_code=403, content={"error": "Forbidden"})
    if not requested.exists() or not requested.is_file():
        return JSONResponse(status_code=404, content={"error": "File not found"})
    return FileResponse(str(requested))
