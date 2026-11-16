"""SQLite 数据访问层：论文元数据与逐页文本的建表、写入与查询。"""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 仅用于类型标注，避免 db 模块被迫依赖 PyMuPDF
    from .pdf_parser import ParsedPage

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
                text TEXT NOT NULL,
                ocr INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_pages_paper_id ON pages (paper_id);
            """
        )
        _migrate_pages_ocr_column(connection)


def _migrate_pages_ocr_column(connection: sqlite3.Connection) -> None:
    """老库的 pages 表没有 ocr 字段，启动时补上（SQLite 的加列成本很低）。"""
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(pages)").fetchall()
    }
    if "ocr" not in columns:
        connection.execute(
            "ALTER TABLE pages ADD COLUMN ocr INTEGER NOT NULL DEFAULT 0"
        )


def save_paper(
    filename: str, stored_path: Path, pages: "list[ParsedPage]"
) -> dict:
    """写入论文及其分页文本，返回给接口使用的摘要信息。"""
    full_text = "\n\n".join(page.text for page in pages)
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
            "INSERT INTO pages (paper_id, page_number, text, ocr) VALUES (?, ?, ?, ?)",
            [
                (paper_id, page.page_number, page.text, int(page.ocr))
                for page in pages
            ],
        )

    return {
        "id": paper_id,
        "filename": filename,
        "page_count": len(pages),
        "uploaded_at": uploaded_at,
        "text_chars": len(full_text),
        "ocr_pages": sum(1 for page in pages if page.ocr),
        # OCR 失败或页面本身空白时，这些页在检索里查不到，需要提示用户。
        "empty_pages": sum(1 for page in pages if not page.text.strip()),
    }


def list_papers() -> list[dict]:
    """按上传时间倒序返回论文列表，不含全文以减小响应体积。"""
    with _connect() as connection:
        rows = connection.execute(
            "SELECT id, filename, page_count, uploaded_at FROM papers ORDER BY id DESC"
        ).fetchall()
    return [dict(row) for row in rows]


def get_paper(paper_id: int) -> dict | None:
    """按 id 取单篇论文元数据，供向量库写入片段时带上文件名。"""
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, filename, page_count, uploaded_at FROM papers WHERE id = ?",
            (paper_id,),
        ).fetchone()
    return dict(row) if row else None


def get_pages(paper_id: int) -> list[tuple[int, str]]:
    """按页码顺序返回某篇论文的分页文本，切块时依赖页码顺序保持原文先后。"""
    with _connect() as connection:
        rows = connection.execute(
            "SELECT page_number, text FROM pages WHERE paper_id = ? ORDER BY page_number",
            (paper_id,),
        ).fetchall()
    return [(int(row["page_number"]), str(row["text"])) for row in rows]
