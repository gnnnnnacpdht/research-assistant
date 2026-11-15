"""SQLite 数据访问层：论文元数据与逐页文本的建表、写入与查询。"""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

# 所有持久化数据统一放在 backend/data/，该目录已被 .gitignore 忽略。
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PDF_DIR = Path(os.getenv("PDF_STORAGE_DIR", DATA_DIR / "pdfs"))
DB_PATH = Path(os.getenv("DATABASE_PATH", DATA_DIR / "app.db"))


def _connect() -> sqlite3.Connection:
    """每次请求新建连接，避免多线程共享连接导致的报错。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    """启动时建表；已存在则跳过，可重复调用。"""
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    with _connect() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS papers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                stored_path TEXT NOT NULL,
                page_count INTEGER NOT NULL,
                uploaded_at TEXT NOT NULL,
                full_text TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                page_number INTEGER NOT NULL,
                text TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_pages_paper_id ON pages (paper_id);
            """
        )


def save_paper(filename: str, stored_path: Path, pages: list[tuple[int, str]]) -> dict:
    """写入论文及其分页文本，返回给接口使用的摘要信息。"""
    full_text = "\n\n".join(text for _, text in pages)
    uploaded_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with _connect() as connection:
        cursor = connection.execute(
            """
            INSERT INTO papers (filename, stored_path, page_count, uploaded_at, full_text)
            VALUES (?, ?, ?, ?, ?)
            """,
            (filename, str(stored_path), len(pages), uploaded_at, full_text),
        )
        paper_id = int(cursor.lastrowid)
        connection.executemany(
            "INSERT INTO pages (paper_id, page_number, text) VALUES (?, ?, ?)",
            [(paper_id, page_number, text) for page_number, text in pages],
        )

    return {
        "id": paper_id,
        "filename": filename,
        "page_count": len(pages),
        "uploaded_at": uploaded_at,
        "text_chars": len(full_text),
    }


def list_papers() -> list[dict]:
    """按上传时间倒序返回论文列表，不含全文以减小响应体积。"""
    with _connect() as connection:
        rows = connection.execute(
            "SELECT id, filename, page_count, uploaded_at FROM papers ORDER BY id DESC"
        ).fetchall()
    return [dict(row) for row in rows]
