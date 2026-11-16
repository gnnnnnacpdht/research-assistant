"""SQLite 数据访问层：论文元数据与逐页文本的建表、写入与查询。"""

import os
import re
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
                full_text TEXT NOT NULL,
                github_url TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                page_number INTEGER NOT NULL,
                text TEXT NOT NULL,
                ocr INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_pages_paper_id ON pages (paper_id);

            -- 细粒度结构化条目：标题/作者/摘要/章节/表格/公式/参考文献
            CREATE TABLE IF NOT EXISTS structure (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                level INTEGER NOT NULL DEFAULT 0,
                page_num INTEGER NOT NULL DEFAULT 0,
                seq INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_structure_paper
                ON structure (paper_id, type);

            -- 自动综述缓存：同一论文的生成结果只算一次（DeepSeek 调用要花钱）
            CREATE TABLE IF NOT EXISTS survey_cache (
                paper_id INTEGER PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        _migrate_pages_ocr_column(connection)
        _migrate_papers_github_column(connection)


def _migrate_papers_github_column(connection: sqlite3.Connection) -> None:
    """老库的 papers 表没有 github_url 字段，启动时补上（默认空串）。"""
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(papers)").fetchall()
    }
    if "github_url" not in columns:
        connection.execute(
            "ALTER TABLE papers ADD COLUMN github_url TEXT NOT NULL DEFAULT ''"
        )


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
    filename: str,
    stored_path: Path,
    pages: "list[ParsedPage]",
    github_url: str = "",
) -> dict:
    """写入论文及其分页文本，返回给接口使用的摘要信息。"""
    full_text = "\n\n".join(page.text for page in pages)
    uploaded_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with _connect() as connection:
        cursor = connection.execute(
            """
            INSERT INTO papers
                (filename, stored_path, page_count, uploaded_at, full_text, github_url)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (filename, str(stored_path), len(pages), uploaded_at, full_text, github_url),
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
        "github_url": github_url,
        "ocr_pages": sum(1 for page in pages if page.ocr),
        # OCR 失败或页面本身空白时，这些页在检索里查不到，需要提示用户。
        "empty_pages": sum(1 for page in pages if not page.text.strip()),
    }


def list_papers() -> list[dict]:
    """按上传时间倒序返回论文列表，不含全文以减小响应体积。"""
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT id, filename, page_count, uploaded_at, github_url
            FROM papers ORDER BY id DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def get_paper(paper_id: int) -> dict | None:
    """按 id 取单篇论文元数据；带上 stored_path 供 PDF 原文件下载接口使用。"""
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT id, filename, stored_path, page_count, uploaded_at, github_url
            FROM papers WHERE id = ?
            """,
            (paper_id,),
        ).fetchone()
    return dict(row) if row else None


def find_paper_by_arxiv_id(arxiv_id: str) -> dict | None:
    """按文件名里的 arXiv ID 判断论文是否已入库，避免重复导入。"""
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT id, filename, page_count, uploaded_at, github_url
            FROM papers WHERE filename LIKE ? ORDER BY id LIMIT 1
            """,
            (f"%{arxiv_id}%",),
        ).fetchone()
    return dict(row) if row else None


def list_paper_titles() -> list[str]:
    """取库内论文标题（结构化抽取的 title）与文件名，供参考文献"库内已收录"判断。"""
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT p.filename AS filename, s.content AS title
            FROM papers p
            LEFT JOIN structure s
                ON s.paper_id = p.id AND s.type = 'title'
            """
        ).fetchall()

    titles: list[str] = []
    for row in rows:
        if row["title"]:
            titles.append(str(row["title"]))
        # 文件名去掉扩展名/arXiv 前缀后也当作一个可匹配的标题片段
        stem = Path(str(row["filename"])).stem
        titles.append(stem)
    return titles


def list_structure_titles() -> list[str]:
    """只取结构化抽取出的论文标题（推荐接口统计关键词用，标题比正文干净）。"""
    with _connect() as connection:
        rows = connection.execute(
            "SELECT content FROM structure WHERE type = 'title' ORDER BY paper_id"
        ).fetchall()
    return [str(row["content"]) for row in rows if row["content"]]


def list_paper_samples(char_limit: int = 4000) -> list[dict]:
    """取每篇论文的开头一段文本（标题+摘要），用于推荐接口的关键词统计。

    不返回全文：541 页教材单篇就有 130 万字符，全量拼接会拖慢推荐响应。
    """
    with _connect() as connection:
        rows = connection.execute(
            "SELECT id, filename, substr(full_text, 1, ?) AS sample FROM papers",
            (char_limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_pages(paper_id: int) -> list[tuple[int, str]]:
    """按页码顺序返回某篇论文的分页文本，切块时依赖页码顺序保持原文先后。"""
    with _connect() as connection:
        rows = connection.execute(
            "SELECT page_number, text FROM pages WHERE paper_id = ? ORDER BY page_number",
            (paper_id,),
        ).fetchall()
    return [(int(row["page_number"]), str(row["text"])) for row in rows]


def save_structure(paper_id: int, items: list[dict]) -> int:
    """覆盖写入某篇论文的结构化条目，返回写入条数（重复抽取是幂等的）。"""
    with _connect() as connection:
        connection.execute("DELETE FROM structure WHERE paper_id = ?", (paper_id,))
        connection.executemany(
            """
            INSERT INTO structure (paper_id, type, content, level, page_num, seq)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    paper_id,
                    item["type"],
                    item["content"],
                    int(item.get("level", 0)),
                    int(item.get("page_num", 0)),
                    position,
                )
                for position, item in enumerate(items)
            ],
        )
    return len(items)


def get_structure(paper_id: int, item_type: str | None = None) -> list[dict]:
    """按抽取顺序返回结构化条目；item_type 为空时返回全部类型。"""
    sql = "SELECT type, content, level, page_num FROM structure WHERE paper_id = ?"
    params: list = [paper_id]
    if item_type:
        sql += " AND type = ?"
        params.append(item_type)
    sql += " ORDER BY seq"

    with _connect() as connection:
        rows = connection.execute(sql, params).fetchall()
    return [dict(row) for row in rows]


def get_survey(paper_id: int) -> dict | None:
    """取已缓存的自动综述，没有则返回 None。"""
    with _connect() as connection:
        row = connection.execute(
            "SELECT content, created_at FROM survey_cache WHERE paper_id = ?",
            (paper_id,),
        ).fetchone()
    return dict(row) if row else None


def save_survey(paper_id: int, content: str) -> None:
    """覆盖写入综述缓存（重新生成时用 REPLACE，避免主键冲突）。"""
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _connect() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO survey_cache (paper_id, content, created_at) VALUES (?, ?, ?)",
            (paper_id, content, created_at),
        )


def _year_from_filename(filename: str) -> int | None:
    """arXiv 新式 ID 的前四位是 YYMM（1706.03762 → 2017 年），比正文正则更可靠。"""
    matched = re.match(r"(\d{2})(\d{2})\.\d{4,5}", filename or "")
    if not matched:
        return None
    year = 2000 + int(matched.group(1))
    month = int(matched.group(2))
    if 1991 <= year <= 2030 and 1 <= month <= 12:
        return year
    return None


def list_library_references() -> list[dict]:
    """返回库内论文的"可引用信息"：标题 + 年份 + 文件名。

    arXiv 论文年份优先从 ID 前缀推断；其它来源退回首页文本里的 4 位年份，
    都推断不到时年份为空，前端显示"年份未知"。
    """
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT p.id, p.filename, substr(p.full_text, 1, 1500) AS head,
                   (SELECT content FROM structure s
                     WHERE s.paper_id = p.id AND s.type = 'title' LIMIT 1) AS title
            FROM papers p ORDER BY p.id DESC
            """
        ).fetchall()

    results: list[dict] = []
    for row in rows:
        filename = str(row["filename"])
        year = _year_from_filename(filename)
        if year is None:
            years = [
                int(value) for value in re.findall(r"\b((?:19|20)\d{2})\b", row["head"] or "")
            ]
            year = max((value for value in years if 1950 <= value <= 2030), default=None)
        results.append(
            {
                "id": int(row["id"]),
                "filename": filename,
                "title": str(row["title"] or Path(filename).stem),
                "year": year,
            }
        )
    return results


def delete_paper(paper_id: int) -> dict | None:
    """删除论文及其全部分页记录，返回被删论文信息（含文件路径）供调用方清理文件。

    论文不存在时返回 None，让接口层能区分 404 与成功。
    """
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, filename, stored_path FROM papers WHERE id = ?", (paper_id,)
        ).fetchone()
        if row is None:
            return None
        connection.execute("DELETE FROM pages WHERE paper_id = ?", (paper_id,))
        connection.execute("DELETE FROM papers WHERE id = ?", (paper_id,))
    return dict(row)
