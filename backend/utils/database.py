"""
database.py - SQLite 数据库管理
统一管理所有数据表：用户、设备、告警、检测历史
"""
import sqlite3
import os
import json
import hashlib
import secrets
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'skymethane.db')


def get_db():
    """获取数据库连接"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """初始化所有数据表"""
    conn = get_db()
    c = conn.cursor()

    # 用户表
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        salt TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user' CHECK(role IN ('admin','user')),
        created_at TEXT DEFAULT (datetime('now','localtime')),
        last_login TEXT
    )''')

    # 设备表
    c.execute('''CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT DEFAULT '',
        type TEXT DEFAULT '传感器',
        lat REAL DEFAULT 0,
        lon REAL DEFAULT 0,
        status TEXT DEFAULT 'online' CHECK(status IN ('online','offline','maintenance')),
        created_at TEXT DEFAULT (datetime('now','localtime')),
        created_by TEXT DEFAULT ''
    )''')

    # 告警日志表
    c.execute('''CREATE TABLE IF NOT EXISTS alarms (
        id TEXT PRIMARY KEY,
        station TEXT NOT NULL,
        value REAL DEFAULT 0,
        threshold REAL DEFAULT 0,
        unit TEXT DEFAULT 'ppb',
        time TEXT DEFAULT (datetime('now','localtime')),
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
        handler TEXT DEFAULT '',
        handle_time TEXT DEFAULT '',
        remark TEXT DEFAULT ''
    )''')

    # 检测历史表
    c.execute('''CREATE TABLE IF NOT EXISTS detection_history (
        id TEXT PRIMARY KEY,
        lat REAL DEFAULT 0,
        lon REAL DEFAULT 0,
        time TEXT DEFAULT (datetime('now','localtime')),
        gas_type TEXT DEFAULT 'CH4',
        result TEXT DEFAULT 'normal' CHECK(result IN ('normal','anomaly')),
        concentration REAL DEFAULT 0,
        unit TEXT DEFAULT 'ppb',
        rgb_image TEXT DEFAULT '',
        mask_image TEXT DEFAULT '',
        operator TEXT DEFAULT '',
        remark TEXT DEFAULT ''
    )''')

    # Closed-loop events table
    c.execute('''CREATE TABLE IF NOT EXISTS closed_loop_events (
        id TEXT PRIMARY KEY,
        workflow_id TEXT DEFAULT '',
        source TEXT DEFAULT 'sentinel-auto',
        location_name TEXT DEFAULT '',
        city TEXT DEFAULT '',
        gas_type TEXT DEFAULT 'CH4',
        risk_level TEXT DEFAULT 'low' CHECK(risk_level IN ('low','medium','high','critical')),
        result TEXT DEFAULT 'normal' CHECK(result IN ('normal','anomaly')),
        stage TEXT DEFAULT 'detected' CHECK(stage IN ('detected','assessed','assigned','handling','verified','closed')),
        summary TEXT DEFAULT '',
        recommendations TEXT DEFAULT '[]',
        lat REAL DEFAULT 0,
        lon REAL DEFAULT 0,
        detection_history_id TEXT DEFAULT '',
        alarm_id TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        closed_at TEXT DEFAULT '',
        operator TEXT DEFAULT ''
    )''')

    # Closed-loop action logs table
    c.execute('''CREATE TABLE IF NOT EXISTS closed_loop_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        stage TEXT DEFAULT 'detected',
        action_type TEXT DEFAULT '',
        action_text TEXT DEFAULT '',
        action_status TEXT DEFAULT 'done',
        actor TEXT DEFAULT '',
        detail TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY(event_id) REFERENCES closed_loop_events(id) ON DELETE CASCADE
    )''')

    # Helpful indexes for dashboard queries
    c.execute('CREATE INDEX IF NOT EXISTS idx_closed_loop_events_stage ON closed_loop_events(stage)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_closed_loop_events_updated_at ON closed_loop_events(updated_at)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_closed_loop_actions_event_id ON closed_loop_actions(event_id)')

    conn.commit()

    # 迁移旧 JSON 数据
    _migrate_json_data(conn)

    conn.close()


def _migrate_json_data(conn):
    """将旧的 JSON 文件数据迁移到 SQLite"""
    data_dir = os.path.dirname(DB_PATH)

    # 迁移用户数据
    users_json = os.path.join(data_dir, 'users.json')
    if os.path.exists(users_json):
        try:
            with open(users_json, 'r', encoding='utf-8') as f:
                users = json.load(f)
            c = conn.cursor()
            for username, info in users.items():
                try:
                    c.execute('''INSERT OR IGNORE INTO users (username, email, salt, password, role)
                                 VALUES (?, ?, ?, ?, ?)''',
                              (username, info.get('email', ''),
                               info.get('salt', ''), info.get('password', ''),
                               info.get('role', 'admin' if username == 'jwx' else 'user')))
                except sqlite3.IntegrityError:
                    pass
            conn.commit()
            # 重命名旧文件
            os.rename(users_json, users_json + '.bak')
        except Exception as e:
            print(f"⚠️ 用户数据迁移: {e}")

    # 迁移设备数据
    _migrate_list_json(conn, os.path.join(data_dir, 'devices.json'), 'devices',
                       ['id', 'name', 'location', 'type', 'lat', 'lon', 'status', 'created_at', 'created_by'])

    # 迁移告警数据
    _migrate_list_json(conn, os.path.join(data_dir, 'alarms.json'), 'alarms',
                       ['id', 'station', 'value', 'threshold', 'unit', 'time', 'status', 'handler', 'handle_time', 'remark'])

    # 迁移检测历史
    _migrate_list_json(conn, os.path.join(data_dir, 'detection_history.json'), 'detection_history',
                       ['id', 'lat', 'lon', 'time', 'gas_type', 'result', 'concentration', 'unit', 'rgb_image', 'mask_image', 'operator', 'remark'])


def _migrate_list_json(conn, json_path, table, columns):
    """迁移列表型 JSON 数据"""
    if not os.path.exists(json_path):
        return
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            items = json.load(f)
        if not items:
            return
        c = conn.cursor()
        placeholders = ','.join(['?' for _ in columns])
        col_names = ','.join(columns)
        for item in items:
            vals = [item.get(col, '') for col in columns]
            try:
                c.execute(f'INSERT OR IGNORE INTO {table} ({col_names}) VALUES ({placeholders})', vals)
            except Exception:
                pass
        conn.commit()
        os.rename(json_path, json_path + '.bak')
    except Exception as e:
        print(f"⚠️ {table} 数据迁移: {e}")
