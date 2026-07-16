"""FastAPI auth routes."""

import hashlib
import re
import secrets
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from utils.database import get_db

router = APIRouter(prefix="/auth", tags=["auth"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _error(message: str, status_code: int) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"success": False, "message": message})


async def _read_json(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_hex(16)
    hashed = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
    return salt, hashed


def _is_admin(username: str) -> bool:
    if not username:
        return False
    conn = get_db()
    try:
        row = conn.execute("SELECT role FROM users WHERE username=?", (username,)).fetchone()
        return bool(row and row["role"] == "admin")
    finally:
        conn.close()


@router.post("/register")
async def register(request: Request):
    data = await _read_json(request)

    username = str(data.get("username", "")).strip()
    email = str(data.get("email", "")).strip()
    password = str(data.get("password", ""))

    if not username or not email or not password:
        return _error("Please fill in all required fields.", 400)
    if len(username) < 3 or len(username) > 20:
        return _error("Username length must be between 3 and 20.", 400)
    if len(password) < 6:
        return _error("Password must be at least 6 characters.", 400)
    if not EMAIL_RE.match(email):
        return _error("Invalid email format.", 400)

    conn = get_db()
    try:
        existing = conn.execute("SELECT username FROM users WHERE username=?", (username,)).fetchone()
        if existing:
            return _error("Username already exists.", 409)

        salt, hashed = _hash_password(password)
        conn.execute(
            "INSERT INTO users (username, email, salt, password, role) VALUES (?, ?, ?, ?, ?)",
            (username, email, salt, hashed, "user"),
        )
        conn.commit()
    finally:
        conn.close()

    return {"success": True, "message": "Register successful."}


@router.post("/login")
async def login(request: Request):
    data = await _read_json(request)

    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    if not username or not password:
        return _error("Username and password are required.", 400)

    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if not user:
            return _error("Invalid username or password.", 401)

        _, hashed = _hash_password(password, user["salt"])
        if hashed != user["password"]:
            return _error("Invalid username or password.", 401)

        conn.execute(
            "UPDATE users SET last_login=? WHERE username=?",
            (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), username),
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "success": True,
        "message": "Login successful.",
        "username": username,
        "role": user["role"],
        "email": user["email"],
    }


@router.get("/users")
async def list_users(admin: str = Query("", description="Admin username")):
    if not _is_admin(admin):
        return _error("Admin permission required.", 403)

    conn = get_db()
    try:
        rows = conn.execute("SELECT username, email, role, created_at, last_login FROM users").fetchall()
    finally:
        conn.close()

    return {"success": True, "users": [dict(row) for row in rows]}


@router.put("/users/{username}/role")
async def update_user_role(username: str, request: Request):
    data = await _read_json(request)

    admin = str(data.get("admin", "")).strip()
    role = str(data.get("role", "")).strip()

    if role not in ("admin", "user"):
        return _error("Invalid role.", 400)
    if not _is_admin(admin):
        return _error("Admin permission required.", 403)

    conn = get_db()
    try:
        row = conn.execute("SELECT username FROM users WHERE username=?", (username,)).fetchone()
        if not row:
            return _error("User not found.", 404)
        conn.execute("UPDATE users SET role=? WHERE username=?", (role, username))
        conn.commit()
    finally:
        conn.close()

    return {"success": True, "message": f"User {username} role updated to {role}."}


@router.delete("/users/{username}")
async def delete_user(username: str, admin: str = Query("", description="Admin username")):
    if not _is_admin(admin):
        return _error("Admin permission required.", 403)
    if username == admin:
        return _error("You cannot delete your own account.", 400)

    conn = get_db()
    try:
        row = conn.execute("SELECT username FROM users WHERE username=?", (username,)).fetchone()
        if not row:
            return _error("User not found.", 404)
        conn.execute("DELETE FROM users WHERE username=?", (username,))
        conn.commit()
    finally:
        conn.close()

    return {"success": True, "message": f"User {username} deleted."}


@router.get("/profile")
async def get_profile(username: str = Query("", description="Username")):
    username = username.strip()
    if not username:
        return _error("Username is required.", 400)

    conn = get_db()
    try:
        user = conn.execute(
            "SELECT username, email, role, created_at, last_login FROM users WHERE username=?",
            (username,),
        ).fetchone()
    finally:
        conn.close()

    if not user:
        return _error("User not found.", 404)

    user_data = dict(user)
    # Keep both keys for frontend compatibility.
    return {"success": True, "user": user_data, "profile": user_data}


@router.put("/profile")
async def update_profile(request: Request):
    data = await _read_json(request)

    username = str(data.get("username", "")).strip()
    email = str(data.get("email", "")).strip()
    old_password = str(data.get("old_password", ""))
    new_password = str(data.get("new_password", ""))

    if not username:
        return _error("Username is required.", 400)

    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if not user:
            return _error("User not found.", 404)

        if email:
            if not EMAIL_RE.match(email):
                return _error("Invalid email format.", 400)
            conn.execute("UPDATE users SET email=? WHERE username=?", (email, username))

        if new_password:
            if not old_password:
                return _error("Current password is required.", 400)
            if len(new_password) < 6:
                return _error("New password must be at least 6 characters.", 400)

            _, check_hash = _hash_password(old_password, user["salt"])
            if check_hash != user["password"]:
                return _error("Current password is incorrect.", 401)

            salt, new_hash = _hash_password(new_password)
            conn.execute("UPDATE users SET salt=?, password=? WHERE username=?", (salt, new_hash, username))

        conn.commit()
    finally:
        conn.close()

    return {"success": True, "message": "Profile updated successfully."}
