"""论文接口：PDF 上传解析入库、论文列表查询。"""

import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from .. import db
from ..pdf_parser import extract_pages

router = APIRouter(prefix="/api/papers", tags=["论文"])

MAX_PDF_BYTES = 100 * 1024 * 1024  # 单文件上限 100MB，防止误传超大文件占满磁盘


@router.post("/upload", status_code=201)
def upload_paper(file: UploadFile = File(...)) -> dict:
    """接收 PDF，保存原文件到 data/pdfs/，逐页提取文本后写入 SQLite。"""
    filename = Path(file.filename or "").name
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="仅支持 .pdf 文件")

    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if len(content) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 100MB 上限")
    if not content.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="文件内容不是有效的 PDF")

    db.PDF_DIR.mkdir(parents=True, exist_ok=True)
    # 原名前加随机前缀，避免同名文件互相覆盖，同时保留可读文件名。
    stored_path = db.PDF_DIR / f"{uuid.uuid4().hex}_{filename}"
    stored_path.write_bytes(content)

    try:
        pages = extract_pages(stored_path)
    except Exception as exc:  # 损坏或加密的 PDF 属于用户输入问题，需回滚已保存的文件
        stored_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"PDF 解析失败：{exc}") from exc

    if not pages:
        stored_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="PDF 没有可读取的页面")

    return db.save_paper(filename, stored_path, pages)


@router.get("")
def get_papers() -> list[dict]:
    """返回论文列表（id、文件名、页数、上传时间），按最新上传在前排序。"""
    return db.list_papers()
