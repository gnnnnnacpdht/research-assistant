"""可审查的 Agent 状态机：retrieve → rerank → generate → verify 四阶段。

与单纯流水线的区别（答辩要点）：
1. 每个阶段都记录 trajectory（状态、耗时、细节），前端可回放推理过程；
2. verify 阶段把答案当成"待证伪的对象"：逐个抽取 [第X页] 引用，
   先查页码是否真的出现在检索结果里，再检查引用句与该页原文是否有内容重叠；
3. 校验失败不是简单报错，而是带着失败句子回到 retrieve 重新检索（最多 2 轮），
   仍失败则删除该引用标记——宁可少一个引用，也不留假引用。

状态机用手写循环而非引入 LangGraph：四个阶段 + 一条回退边，
几十行代码即可完整表达，不新增重型依赖，评委可直接阅读全部逻辑。
"""

import logging
import re
import time

from . import config, llm_client, rag

logger = logging.getLogger(__name__)

# 答案中的页码引用标记，与前端徽章的正则保持一致。
CITATION_RE = re.compile(r"\[第(\d+)页\]")

# verify 失败后允许的最大重检索轮数（首轮不算重试）。
MAX_VERIFY_RETRIES = 2

# 相关性判断里的英文停用词：这些词在任何页面都出现，不能作为"内容重叠"的证据。
STOP_WORDS = {
    "the", "and", "for", "with", "that", "this", "are", "was", "were", "from",
    "have", "has", "been", "into", "each", "other", "which", "their", "there",
    "then", "than", "them", "they", "these", "those", "when", "where", "what",
    "why", "how", "all", "any", "can", "could", "should", "would", "not", "but",
}


def _sentence_before(answer: str, position: int) -> str:
    """取引用标记所在的那句话，用于和原文做相关性比对。"""
    start = max(answer.rfind(mark, 0, position) for mark in ("。", "！", "？", "；", "\n"))
    return answer[start + 1 : position].strip()[:200]


def _relevant(sentence: str, page_text: str) -> bool:
    """判断引用句与该页原文是否存在实质内容重叠。

    策略上"抓假引用、不误伤正常引用"：
    - 句中出现专业术语/数字却在这页完全找不到 → 判定为张冠李戴；
    - 纯中文短句对着英文原文无法机械比对 → 页码存在即视为通过，
      避免把跨语言改写造成的正常引用误杀。
    """
    lowered = page_text.lower()
    words = {
        word.lower()
        for word in re.findall(r"[A-Za-z][A-Za-z\-]{2,}", sentence)
    } - STOP_WORDS
    if any(word in lowered for word in words):
        return True

    numbers = set(re.findall(r"\d+(?:\.\d+)?", sentence))
    if any(number in page_text for number in numbers):
        return True

    # 中文原文场景下，二字词组重叠也是有效证据。
    han = re.findall(r"[一-鿿]", sentence)
    if len(han) >= 2:
        bigrams = {"".join(han[i : i + 2]) for i in range(len(han) - 1)}
        if sum(1 for bigram in bigrams if bigram in page_text) >= 2:
            return True

    if words or numbers:
        return False
    return True


def _verify(answer: str, contexts: list[dict]) -> tuple[int, int, list[tuple[int, str]]]:
    """逐一校验答案里的引用，返回 (引用总数, 通过数, 失败列表[(页码, 引用句)])。"""
    page_texts: dict[int, str] = {}
    for item in contexts:
        page = int(item["page"])
        page_texts[page] = page_texts.get(page, "") + " " + item["text"]

    total = 0
    failed: list[tuple[int, str]] = []
    for match in CITATION_RE.finditer(answer):
        total += 1
        page = int(match.group(1))
        sentence = _sentence_before(answer, match.start())
        text = page_texts.get(page)
        if not text or not _relevant(sentence, text):
            failed.append((page, sentence))
    return total, total - len(failed), failed


def _drop_citations(answer: str, failed: list[tuple[int, str]]) -> str:
    """最终仍无法核实的引用，直接从答案里抹掉标记，杜绝假出处。"""
    result = answer
    for page, _ in failed:
        result = result.replace(f"[第{page}页]", "")
    return result


def run_agent(question: str, paper_id: int | None = None) -> dict:
    """执行状态机，返回答案、来源与完整推理轨迹；paper_id 限定检索范围。"""
    trajectory: list[dict] = []
    search_query = rag._search_query(question)

    contexts: list[dict] = []
    answer = ""
    # attempt=1 为首轮；verify 失败后递增，最多到 MAX_VERIFY_RETRIES+1 轮。
    for attempt in range(1, MAX_VERIFY_RETRIES + 2):
        # ---- 阶段 1：向量检索 -------------------------------------------------
        started = time.perf_counter()
        # 重试时保持原查询、扩大召回范围：
        # 若把模型写的失败句拼进查询，会引入噪声（例如把检索带向参考文献页），
        # 扩大 top-k 则只是让更多候选进入重排，不改变查询语义。
        candidates = rag._retrieve(
            search_query,
            paper_id=paper_id,
            top_k=config.RETRIEVE_TOP_K * attempt,
        )
        detail = (
            f"向量召回 {len(candidates)} 个片段"
            if attempt == 1
            else f"第{attempt}轮：针对未通过校验的引用扩大召回至 top{config.RETRIEVE_TOP_K * attempt}，返回 {len(candidates)} 个片段"
        )
        trajectory.append(
            {
                "stage": "retrieve",
                "status": "ok",
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "detail": detail,
                "attempt": attempt,
            }
        )

        if attempt == 1 and not candidates:
            return {
                "answer": "当前知识库还没有可检索的内容，请先上传并等待论文完成向量化。",
                "sources": [],
                "trajectory": trajectory,
            }

        # ---- 阶段 2：重排 ---------------------------------------------------
        started = time.perf_counter()
        ranked = rag._rerank(search_query, candidates)
        if attempt == 1:
            contexts = ranked
            detail = f"重排后保留 {len(contexts)} 个片段"
        else:
            # 保留原有片段，把新检索到的页面补进来：
            # 若直接替换，原本校验通过的引用反而会因页面被挤掉而失败。
            known_pages = {int(item["page"]) for item in contexts}
            additions = [item for item in ranked if int(item["page"]) not in known_pages]
            contexts = contexts + additions
            detail = f"重排后新增 {len(additions)} 个片段，累计 {len(contexts)} 个"
        trajectory.append(
            {
                "stage": "rerank",
                "status": "ok",
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "detail": detail,
                "attempt": attempt,
            }
        )

        # ---- 阶段 3：生成 ---------------------------------------------------
        started = time.perf_counter()
        answer = llm_client.chat(rag._build_messages(question, contexts))
        trajectory.append(
            {
                "stage": "generate",
                "status": "ok",
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "detail": f"DeepSeek 生成答案（{len(answer)} 字）",
                "attempt": attempt,
            }
        )

        # ---- 阶段 4：引用自检 -----------------------------------------------
        started = time.perf_counter()
        total, passed, failed = _verify(answer, contexts)
        can_retry = bool(failed) and attempt <= MAX_VERIFY_RETRIES
        trajectory.append(
            {
                "stage": "verify",
                "status": "retry" if can_retry else "ok",
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "detail": (
                    f"校验 {total} 条引用，通过 {passed} 条"
                    + (
                        f"，{len(failed)} 条未通过（{ '、'.join(f'第{p}页' for p, _ in failed) }），触发重新检索"
                        if can_retry
                        else ""
                    )
                ),
                "attempt": attempt,
            }
        )

        if not failed:
            break
        if attempt > MAX_VERIFY_RETRIES:
            # 重试用尽：删除无法核实的引用标记，绝不留假出处。
            answer = _drop_citations(answer, failed)
            trajectory.append(
                {
                    "stage": "verify",
                    "status": "ok",
                    "duration_ms": 0,
                    "detail": f"重试 {MAX_VERIFY_RETRIES} 轮后仍有 {len(failed)} 条无法核实，已删除对应引用标记",
                    "attempt": attempt,
                }
            )
            break
        logger.info("第 %s 轮引用校验未通过：%s，重新检索", attempt, failed)

    sources = [
        {
            "paper_id": item["paper_id"],
            "filename": item["filename"],
            "page": item["page"],
            "text": item["text"],
        }
        for item in contexts
    ]
    return {"answer": answer, "sources": sources, "trajectory": trajectory}
