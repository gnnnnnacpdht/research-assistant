"""论文接口：PDF 上传解析入库、去重确认、版本对比、论文列表查询、向量索引重建、结构化查询。"""

import re
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from .. import arxiv_client, db, dedupe, rag, structure
from ..pdf_parser import extract_pages
from ..structure import parse_references

router = APIRouter(prefix="/api/papers", tags=["论文"])

MAX_PDF_BYTES = 100 * 1024 * 1024  # 单文件上限 100MB，防止误传超大文件占满磁盘


def _do_save_and_index(
    background_tasks: BackgroundTasks,
    filename: str,
    stored_path: Path,
    pages: list,
    github_url: str = "",
) -> dict:
    """解析完成后的共用逻辑：写库 + 后台索引 + 后台结构化抽取 + 返回摘要。"""
    # arXiv 元信息里没写代码地址时，再从正文里找一遍（很多论文把仓库放在脚注/实验章节）
    if not github_url:
        github_url = arxiv_client.extract_github_url(
            "\n".join(page.text for page in pages[:5])
        )
    paper = db.save_paper(filename, stored_path, pages, github_url=github_url)
    background_tasks.add_task(rag.index_paper_safely, paper["id"])
    # 结构化抽取涉及版式分析，体积大的 PDF 可能耗时，放后台避免拖慢上传响应。
    background_tasks.add_task(structure.extract_and_save_safely, paper["id"], stored_path)
    result = {**paper, "indexing": True}
    if paper["empty_pages"]:
        result["warning"] = (
            f"{paper['empty_pages']} 页未提取到文字，OCR 可能失败，"
            "这些页暂时无法参与问答，请检查多模态模型配置与账户余额"
        )
    return result


@router.post("/upload")
def upload_paper(background_tasks: BackgroundTasks, file: UploadFile = File(...)) -> dict:
    """第一阶段：上传 → 解析 → 相似度检测。

    若库内无高度相似论文，直接入库返回；
    若发现疑似重复，返回 309 + duplicates + token，等待前端走 confirm 接口。
    """
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
    # 解析前把文件存到临时位置（不是最终目录）：若最终走"取消"，这个文件被直接删掉。
    tmp_path = db.PDF_DIR / f"pending_{uuid.uuid4().hex}_{filename}"
    tmp_path.write_bytes(content)

    try:
        pages = extract_pages(tmp_path)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"PDF 解析失败：{exc}") from exc

    if not pages:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="PDF 没有可读取的页面")

    full_text = "\n\n".join(page.text for page in pages)

    # 相似度检测失败时（向量化接口挂了）直接降级入库，不阻塞正常上传。
    duplicates: list[dict] = []
    try:
        duplicates = dedupe.compare_full_texts(full_text)
    except RuntimeError as exc:
        duplicates = []  # 降级：跳过相似检测，放行

    if duplicates:
        # 不能 raise HTTPException：FastAPI 默认异常处理器会剥离自定义 headers。
        # 直接返回 JSONResponse，body 里也放 token 和 duplicates，方便前端一次性取全。
        token = dedupe.enqueue_pending(tmp_path, filename, pages, full_text)
        return JSONResponse(
            status_code=309,
            headers={
                "X-Dedupe-Token": token,
                "X-Dedupe-Count": str(len(duplicates)),
            },
            content={
                "detail": "检测到疑似重复论文",
                "token": token,
                "filename": filename,
                "duplicates": duplicates,
            },
        )

    # 无重复：直接入库
    # 移动到最终目录（去掉 pending_ 前缀）
    stored_path = db.PDF_DIR / f"{uuid.uuid4().hex}_{filename}"
    tmp_path.rename(stored_path)
    return _do_save_and_index(background_tasks, filename, stored_path, pages)


def _pop_pending_or_404(token: str):
    item = dedupe.dequeue_pending(token)
    if item is None:
        raise HTTPException(
            status_code=404,
            detail="暂存的上传结果已过期或已处理，请重新上传",
        )
    return item


@router.post("/confirm-overwrite")
def confirm_overwrite(
    background_tasks: BackgroundTasks, payload: dict
) -> dict:
    """前端选"覆盖"：删除指定旧论文 → 把新论文正式入库并索引。"""
    token = payload.get("token", "")
    replace_ids = payload.get("replace_ids") or []

    tmp_path, filename, pages, _full_text, _ts = _pop_pending_or_404(token)

    # 先删旧论文（和删除接口一样：向量库 → SQLite → 文件）
    for old_id in replace_ids:
        try:
            rag.delete_paper_vectors(int(old_id))
        except Exception:
            pass
        db_row = db.delete_paper(int(old_id))
        if db_row is not None:
            Path(db_row["stored_path"]).unlink(missing_ok=True)

    stored_path = db.PDF_DIR / f"{uuid.uuid4().hex}_{filename}"
    tmp_path.rename(stored_path)
    return _do_save_and_index(background_tasks, filename, stored_path, pages)


@router.post("/confirm-keep")
def confirm_keep(background_tasks: BackgroundTasks, payload: dict) -> dict:
    """前端选"保留"：和正常入库流程一样，新论文作为独立条目入库。"""
    token = payload.get("token", "")
    tmp_path, filename, pages, _full_text, _ts = _pop_pending_or_404(token)
    stored_path = db.PDF_DIR / f"{uuid.uuid4().hex}_{filename}"
    tmp_path.rename(stored_path)
    return _do_save_and_index(background_tasks, filename, stored_path, pages)


@router.post("/compare")
def compare_versions(payload: dict) -> dict:
    """对比两个版本文本，返回 DeepSeek 生成的修订摘要。"""
    token = payload.get("token", "")
    target_id = payload.get("target_id")
    if not token or target_id is None:
        raise HTTPException(status_code=400, detail="缺少 token 或 target_id")

    # 只读暂存，不消费 token——前端拿到对比结果后仍可走 confirm。
    item = dedupe.peek_pending(token)
    if item is None:
        raise HTTPException(status_code=404, detail="暂存结果已过期")
    _tmp_path, filename, _pages, new_text, _ts = item

    old_text = "\n\n".join(text for _, text in db.get_pages(int(target_id)))
    old_paper = db.get_paper(int(target_id))
    summary = dedupe.generate_revision_summary(
        old_text, new_text,
        old_paper["filename"] if old_paper else "旧版",
        filename,
    )
    return {
        "summary": summary,
        "token": token,  # 前端拿着 token 继续走 confirm
        "target_id": int(target_id),
    }


@router.post("/cancel")
def cancel_pending(payload: dict) -> dict:
    """前端点"取消"：清理暂存文件。"""
    token = payload.get("token", "")
    item = dedupe.dequeue_pending(token)
    if item is not None:
        tmp_path = item[0]
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
    return {"cancelled": True}


@router.post("/fetch")
def fetch_from_arxiv(background_tasks: BackgroundTasks, payload: dict) -> dict:
    """从 arXiv 检索第一篇结果并直接下载入库。

    入参 query 支持 arXiv ID（1706.03762 / arXiv:1706.03762v7）或标题关键词。
    入库复用上传接口的解析、相似度检测、索引与结构化流程，
    因此疑似重复时同样返回 309，交回前端去重弹窗处理。
    """
    query = str(payload.get("query") or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="请输入 arXiv ID 或标题关键词")

    try:
        results = arxiv_client.search(query, max_results=5)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"arXiv 检索失败：{exc}") from exc

    if not results:
        raise HTTPException(status_code=404, detail="arXiv 未找到匹配论文，请换个关键词")

    item = results[0]
    arxiv_id = item["arxiv_id"].split("/")[-1]
    base_id = re.sub(r"v\d+$", "", arxiv_id)

    # 已入库（文件名里含同一 arXiv ID）直接返回，不做重复下载
    existing = db.find_paper_by_arxiv_id(base_id) if base_id else None
    if existing is not None:
        return {"already_imported": True, "paper": existing, "arxiv": item}

    try:
        content = arxiv_client.download_pdf(item["pdf_url"])
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"PDF 下载失败：{exc}") from exc

    # 防御性校验：文件名必须是 arXiv ID + .pdf，不能是标题或带路径分隔符。
    # arxiv_id 已从 URL split("/") 取得，再把所有非安全字符替换成下划线，
    # 防止未来 arxiv.org 返回格式变化或 title 意外混入。
    safe_id = re.sub(r"[^\w.\-]", "_", arxiv_id) or arxiv_id
    filename = f"{safe_id}.pdf"
    db.PDF_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = db.PDF_DIR / f"pending_{uuid.uuid4().hex}_{filename}"
    tmp_path.write_bytes(content)

    try:
        pages = extract_pages(tmp_path)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"PDF 解析失败：{exc}") from exc
    if not pages:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="PDF 没有可读取的页面")

    full_text = "\n\n".join(page.text for page in pages)
    try:
        duplicates = dedupe.compare_full_texts(full_text)
    except RuntimeError:
        duplicates = []  # 向量化不可用时放行，与上传接口保持一致

    if duplicates:
        token = dedupe.enqueue_pending(tmp_path, filename, pages, full_text)
        return JSONResponse(
            status_code=309,
            headers={"X-Dedupe-Token": token, "X-Dedupe-Count": str(len(duplicates))},
            content={
                "detail": "检测到疑似重复论文",
                "token": token,
                "filename": filename,
                "duplicates": duplicates,
                "arxiv": item,
            },
        )

    stored_path = db.PDF_DIR / f"{uuid.uuid4().hex}_{filename}"
    tmp_path.rename(stored_path)
    paper = _do_save_and_index(
        background_tasks, filename, stored_path, pages, github_url=item["github_url"]
    )
    return {"already_imported": False, "paper": paper, "arxiv": item}


@router.get("/recommend")
def recommend_papers(limit: int = Query(default=3, ge=1, le=10)) -> dict:
    """基于库内论文关键词共现，推荐 arXiv 上的相关新论文。"""
    from .. import recommend

    return recommend.build_recommendations(limit)


@router.get("")
def get_papers() -> list[dict]:
    """返回论文列表（id、文件名、页数、上传时间），按最新上传在前排序。"""
    return db.list_papers()


@router.get("/{paper_id}/file", response_class=FileResponse)
def get_paper_file(paper_id: int):
    """把原始 PDF 交给前端 pdf.js 渲染。

    注意不要写 `-> FileResponse` 返回注解：FastAPI 会把它当成 pydantic 响应模型，
    直接报 500。用 response_class 声明即可。
    """
    paper = db.get_paper(paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail="论文不存在")
    path = Path(paper["stored_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="原始 PDF 文件已丢失")
    return FileResponse(path, media_type="application/pdf", filename=paper["filename"])


@router.get("/{paper_id}/page/{page_num}")
def get_paper_page(paper_id: int, page_num: int) -> dict:
    """返回某页的提取文本，阅读页右侧翻译与引用跳转都依赖它。"""
    paper = db.get_paper(paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail="论文不存在")

    for number, text in db.get_pages(paper_id):
        if number == page_num:
            return {
                "paper_id": paper_id,
                "filename": paper["filename"],
                "page": number,
                "page_count": paper["page_count"],
                "text": text,
            }
    raise HTTPException(status_code=404, detail=f"第 {page_num} 页不存在")


def _related_work_range(headings: list[dict]) -> tuple[int, int] | None:
    """Related Work 章节的页码范围：从该标题所在页到下一个标题的前一页。"""
    for position, heading in enumerate(headings):
        if re.search(r"(?i)related\s+work", heading["content"]):
            start = int(heading["page_num"])
            later = [
                int(item["page_num"])
                for item in headings[position + 1 :]
                if int(item["page_num"]) > start
            ]
            return start, (min(later) - 1 if later else start + 1)
    return None


@router.get("/{paper_id}/references")
def get_references(paper_id: int) -> dict:
    """解析参考文献条目，供正文 [n] 与文献列表双向跳转。

    末尾的 References 段落用正则按 [n] 切分；同时记录每个编号在正文里首次出现的页码，
    这样点文献条目能跳回正文。每条还会带含金量评分（库内/经典/位置/是否堆叠）。
    """
    paper = db.get_paper(paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail="论文不存在")

    pages = db.get_pages(paper_id)
    parsed = parse_references(
        pages,
        related_range=_related_work_range(db.get_structure(paper_id, "heading")),
        library_titles=db.list_paper_titles(),
    )
    return {"paper_id": paper_id, **parsed}


@router.get("/{paper_id}/structure")
def get_paper_structure(
    paper_id: int, item_type: str | None = Query(default=None, alias="type")
) -> dict:
    """返回某篇论文的结构化条目，可按 type 过滤（如 heading）。

    一次性返回全部条目并附带各类型计数，前端切换标签页时无需重复请求。
    """
    paper = db.get_paper(paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail="论文不存在")

    items = db.get_structure(paper_id)
    counts: dict[str, int] = {}
    for item in items:
        counts[item["type"]] = counts.get(item["type"], 0) + 1

    if item_type:
        items = [item for item in items if item["type"] == item_type]

    return {
        "paper_id": paper_id,
        "filename": paper["filename"],
        "counts": counts,
        "items": items,
    }


@router.post("/{paper_id}/structure/rebuild")
def rebuild_structure(paper_id: int) -> dict:
    """手动重抽结构（用于结构化能力上线前入库的历史论文）。"""
    paper = db.get_paper(paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail="论文不存在")
    try:
        return structure.extract_and_save(paper_id, Path(paper["stored_path"]))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"结构化抽取失败：{exc}") from exc


@router.get("/{paper_id}/citations")
def get_citations(paper_id: int) -> dict:
    """返回以该论文为中心的引用图谱：节点、边、重要性分数与 Top5 基石文献。"""
    from .. import citations

    try:
        return citations.build_citation_graph(paper_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/{paper_id}/survey")
def get_survey(paper_id: int, refresh: bool = False) -> dict:
    """生成或读取缓存的领域综述 + 三个 Future Work 方向。

    refresh=true 时忽略缓存重新生成（前端"重新生成"按钮用）。
    """
    from .. import survey

    try:
        return survey.build_survey(paper_id, refresh=refresh)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/{paper_id}/index")
def reindex_paper(paper_id: int) -> dict:
    """手动重建某篇论文的向量索引，用于索引失败后重试。"""
    try:
        chunk_count = rag.index_paper(paper_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"paper_id": paper_id, "chunks": chunk_count}


@router.delete("/{paper_id}")
def delete_paper(paper_id: int) -> dict:
    """删除论文：向量库 → SQLite → 原文件，三处同步清理。"""
    try:
        rag.delete_paper_vectors(paper_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"向量库清理失败：{exc}") from exc

    paper = db.delete_paper(paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail="论文不存在")

    Path(paper["stored_path"]).unlink(missing_ok=True)
    return {"deleted": paper_id, "filename": paper["filename"]}
