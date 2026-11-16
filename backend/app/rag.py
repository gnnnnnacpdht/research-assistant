"""RAG 核心：切块 → 向量入库 → 检索 → 重排 → 带页码锚点的抗幻觉生成。

设计要点（答辩可用）：
1. 切块带页码：每个片段都记录 (paper_id, 页码, 块序号)，
   页码是后面所有引用标记 [第X页] 的唯一来源，模型无法凭空编造。
2. 检索两段式：先用 BGE-M3 向量召回 top5，再用 reranker 精排取前 3，
   向量模型擅长"大致相关"，重排模型擅长"逐字相关的精细判断"。
3. 抗幻觉靠 prompt 约束 + 片段可见范围：模型只能看被检索出来的文本，
   并在 system prompt 里被要求"片段里没有就说没有"。
"""

import logging
import threading

import chromadb

from . import config, db, llm_client

logger = logging.getLogger(__name__)

# Chroma 的 PersistentClient 是重量级对象，全进程复用一个实例；
# 索引是写操作，用锁避免"上传触发后台索引"与"启动补偿索引"同时写同一个集合。
_client_lock = threading.Lock()
_index_lock = threading.Lock()
_client: chromadb.api.ClientAPI | None = None


def get_collection() -> chromadb.api.models.Collection.Collection:
    """返回 papers 集合，首次调用时创建（等价于建表）。"""
    global _client
    with _client_lock:
        if _client is None:
            config.CHROMA_DIR.mkdir(parents=True, exist_ok=True)
            _client = chromadb.PersistentClient(path=str(config.CHROMA_DIR))
    return _client.get_or_create_collection(
        name=config.CHROMA_COLLECTION, metadata={"hnsw:space": "cosine"}
    )


def chunk_text(text: str) -> list[str]:
    """把一页文本切成约 500 字符、相邻重叠 80 字符的片段。"""
    # PDF 抽出的一行一个换行，会稀释语义，先压成连续文本。
    normalized = " ".join(text.split())
    if len(normalized) <= config.CHUNK_SIZE:
        return [normalized] if normalized else []

    step = config.CHUNK_SIZE - config.CHUNK_OVERLAP
    chunks: list[str] = []
    for start in range(0, len(normalized), step):
        chunk = normalized[start : start + config.CHUNK_SIZE]
        if chunk:
            chunks.append(chunk)
        if start + config.CHUNK_SIZE >= len(normalized):
            break
    return chunks


def index_paper(paper_id: int) -> int:
    """为一篇论文建立/重建向量索引，返回写入的片段数。

    先删后建：重复上传或重新索引时不会留下旧片段导致检索结果重复。
    """
    paper = db.get_paper(paper_id)
    if paper is None:
        raise ValueError(f"论文 {paper_id} 不存在")

    chunks: list[str] = []
    metadatas: list[dict] = []
    ids: list[str] = []

    for page_number, page_text in db.get_pages(paper_id):
        # 扫描件页几乎提不出文字，硬塞进去只会污染检索。
        if len(page_text.strip()) < config.MIN_PAGE_CHARS:
            continue
        for chunk_index, chunk in enumerate(chunk_text(page_text)):
            chunks.append(chunk)
            metadatas.append(
                {
                    "paper_id": paper_id,
                    "filename": paper["filename"],
                    "page": page_number,
                    "chunk": chunk_index,
                }
            )
            ids.append(f"{paper_id}:{page_number}:{chunk_index}")

    collection = get_collection()
    with _index_lock:
        collection.delete(where={"paper_id": paper_id})
        if not chunks:
            return 0
        embeddings = llm_client.embed_texts(chunks)
        # 分批写入，避免单次请求体过大。
        for start in range(0, len(chunks), 64):
            collection.add(
                ids=ids[start : start + 64],
                documents=chunks[start : start + 64],
                embeddings=embeddings[start : start + 64],
                metadatas=metadatas[start : start + 64],
            )

    return len(chunks)


def delete_paper_vectors(paper_id: int) -> None:
    """删除某篇论文在向量库中的全部片段。

    必须与 SQLite 的删除同步执行，否则已删论文仍会被检索到并出现在引用里。
    """
    collection = get_collection()
    with _index_lock:
        collection.delete(where={"paper_id": paper_id})


def pending_paper_ids() -> list[int]:
    """返回尚未建立索引的论文 id，供启动时补偿索引使用。"""
    collection = get_collection()
    ready: set[int] = set()
    if collection.count() > 0:
        # 一次取出所有已入库的 paper_id，避免逐篇查询。
        existing = collection.get(include=["metadatas"])
        ready = {int(meta["paper_id"]) for meta in existing["metadatas"]}
    return [paper["id"] for paper in db.list_papers() if paper["id"] not in ready]


def index_paper_safely(paper_id: int) -> None:
    """后台索引入口：耗时且可重试，失败只记录日志，不能影响上传请求。"""
    try:
        count = index_paper(paper_id)
        logger.info("论文 %s 向量化完成，共 %s 个片段", paper_id, count)
    except Exception:  # 后台线程里的异常没人接收，必须在这里兜住
        logger.exception("论文 %s 向量化失败", paper_id)


def index_pending_papers() -> None:
    """启动时补齐历史论文的索引（上传接口刚加索引能力前入库的文档）。"""
    for paper_id in pending_paper_ids():
        index_paper_safely(paper_id)


def _has_cjk(text: str) -> bool:
    """判断问题里是否含中文，只有中文提问才需要改写成英文检索式。"""
    return any("\u4e00" <= char <= "\u9fff" for char in text)


REWRITE_SYSTEM = """你是学术检索的查询改写器。把用户的问题改写成一句适合检索英文学术论文的英文查询。
要求：只输出这一句英文查询，不要解释、不要加引号、不要翻译成中文。"""


def _search_query(question: str) -> str:
    """把中文问题改写成英文检索式，让向量检索与论文正文处于同一语言。

    改写失败不能影响主流程，直接退回原问题（跨语言检索只是稍弱，不是不可用）。
    """
    if not config.QUERY_REWRITE or not _has_cjk(question):
        return question
    try:
        rewritten = llm_client.chat(
            [
                {"role": "system", "content": REWRITE_SYSTEM},
                {"role": "user", "content": question},
            ],
            temperature=0.0,
        )
    except RuntimeError:
        logger.warning("查询改写失败，退回原问题检索")
        return question
    return rewritten.strip().strip('"“”').splitlines()[0][:300] or question


def _retrieve(question: str) -> list[dict]:
    """向量召回 top5，返回片段及其元数据（同一页码只保留最相关的一块）。"""
    collection = get_collection()
    if collection.count() == 0:
        return []

    query_vector = llm_client.embed_texts([question])[0]
    result = collection.query(
        query_embeddings=[query_vector],
        n_results=config.RETRIEVE_TOP_K,
        include=["documents", "metadatas", "distances"],
    )

    documents = result.get("documents") or [[]]
    metadatas = result.get("metadatas") or [[]]
    candidates: list[dict] = []
    seen_pages: set[tuple[int, int]] = set()
    for text, metadata in zip(documents[0], metadatas[0], strict=False):
        key = (int(metadata["paper_id"]), int(metadata["page"]))
        # 同一篇论文的同页只留排名最靠前的一块：
        # 重复上传的论文会贡献完全相同的片段，重叠切片也会自相重复。
        if key in seen_pages:
            continue
        seen_pages.add(key)
        candidates.append({"text": text, **metadata})
    return candidates


def _rerank(question: str, candidates: list[dict]) -> list[dict]:
    """精排并取前 3；重排接口异常时退回向量顺序，保证问答不整体失败。"""
    if not candidates:
        return []
    try:
        ranked = llm_client.rerank(
            question,
            [item["text"] for item in candidates],
            config.RERANK_TOP_K,
        )
    except RuntimeError:
        return candidates[: config.RERANK_TOP_K]

    ordered = [candidates[index] for index, _ in ranked if 0 <= index < len(candidates)]
    return ordered[: config.RERANK_TOP_K]


# system prompt 是抗幻觉的关键：明确"只能引用给定片段"，并规定标记格式。
SYSTEM_PROMPT = """你是严谨的科研论文问答助手，只能依据【检索片段】回答问题。

必须遵守的规则：
1. 每一个事实性陈述后面都必须紧跟页码引用标记，格式为 [第X页]；
   同一句引用了多页时写成 [第2页][第7页]。
2. 页码只能使用片段标题中给出的页码，禁止编造页码或引用未提供的页。
3. 检索片段中没有的信息，直接回答"检索到的原文中没有相关信息"，
   不要用常识补充，也不要猜测。
4. 回答使用中文，先给结论，再给必要的解释，不要复述整段原文。"""


def _build_messages(question: str, contexts: list[dict]) -> list[dict[str, str]]:
    """把命中的片段编号后拼进 user 消息，模型只能看到这些文本。"""
    blocks = []
    for number, item in enumerate(contexts, start=1):
        blocks.append(
            f"【片段{number}｜文件: {item['filename']}｜第{item['page']}页】\n{item['text']}"
        )
    context_text = "\n\n".join(blocks)
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"【检索片段】\n{context_text}\n\n【问题】\n{question}",
        },
    ]


def answer_question(question: str) -> dict:
    """完整问答流水线：改写检索式 → 召回 → 重排 → 生成，返回答案与可核验来源。"""
    search_query = _search_query(question)

    candidates = _retrieve(search_query)
    if not candidates:
        return {
            "answer": "当前知识库还没有可检索的内容，请先上传并等待论文完成向量化。",
            "sources": [],
        }

    contexts = _rerank(search_query, candidates)
    answer = llm_client.chat(_build_messages(question, contexts))

    sources = [
        {
            "paper_id": item["paper_id"],
            "filename": item["filename"],
            "page": item["page"],
            "text": item["text"],
        }
        for item in contexts
    ]
    return {"answer": answer, "sources": sources}
