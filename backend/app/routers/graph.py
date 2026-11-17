"""独立 graph 路由：单篇 PDF 引用图谱 + 全局跨库图谱。

旧接口 GET /api/papers/{id}/citations 保持不动（build_citation_graph 已升级，
新字段 in_library/source_page 对前端是向后兼容的），
这里的新路由是用户显式要求的"单篇图谱专用入口"。
"""

from fastapi import APIRouter, HTTPException, Query

from .. import citations, db

router = APIRouter(prefix="/api/graph", tags=["引用图谱"])


@router.get("/paper/{paper_id}")
def get_single_paper_graph(paper_id: int) -> dict:
    """单篇 PDF 引用图谱：

    返回以该论文为中心节点、它解析出的参考文献为子节点的力导向图。
    每条边的 source_page = 引用出现在原论文里的参考文献页码，
    方便前端 tooltip 展示"引自第 X 页"。

    每条参考文献节点额外带 in_library 字段：
      - True：通过 embedding 余弦相似度 > 0.8 与库内已有论文匹配上了，
        同时返回 in_library_paper_id（可跳转）与 in_library_score；
      - False：库内没有高度相似的论文。

    扫描件或没有参考文献的论文，返回空 nodes/edges 并带 message 字段，
    前端据此显示友好提示，不要白屏。
    """
    paper = db.get_paper(paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail=f"论文 {paper_id} 不存在")

    # 扫描件判断：该论文所有 page 的文本总字符数过少 → 全文 OCR 失败或图片无文本层
    pages = db.get_pages(paper_id)
    if not pages:
        raise HTTPException(status_code=400, detail="该论文还没有解析出的页面文本")

    total_chars = sum(len(text) for _, text in pages)
    if total_chars < 50 * len(pages):
        # 每页平均不足 50 字符，基本判定为扫描件或空白；先让它跑解析，
        # parse_references 会返回空 entries，这里也允许函数返回空结构
        # 但要在 message 里告诉前端这可能是扫描件
        pass

    try:
        result = citations.build_citation_graph(paper_id)
    except LookupError:
        raise HTTPException(status_code=404, detail=f"论文 {paper_id} 不存在")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"图谱构建失败：{exc}") from exc

    if not result.get("nodes"):
        # 没解析出参考文献：加上扫描件候选提示
        if total_chars < 50 * len(pages):
            result.setdefault("message", "")
            result["message"] = (
                "该论文疑似扫描件（每页平均文本不足 50 字符），"
                "或没有可识别的参考文献列表。可先确认 OCR 是否已完成。"
            )
    return result


@router.get("/library")
def get_global_library_graph() -> dict:
    """全局跨库图谱（轻量版）：

    对库内每篇论文分别解析它的参考文献，然后用 in_library 匹配
    把这些参考文献指向库内其它已收录论文，画出"谁引用了谁"的跨库网络。
    只匹配 in_library=true 的边，避免把 arXiv 外部文献也塞进来让图爆炸。
    """
    library_refs = db.list_library_references()
    if not library_refs:
        return {"nodes": [], "edges": [], "message": "论文库为空，先上传几篇论文再看图谱"}

    paper_ids = [item["id"] for item in library_refs]

    nodes: list[dict] = []
    edges: list[dict] = []
    seen_edge_keys: set[tuple[int, int]] = set()

    for pid in paper_ids:
        try:
            result = citations.build_citation_graph(pid)
        except Exception:
            continue
        root = next((n for n in result["nodes"] if n.get("kind") == "root"), None)
        if root is None:
            continue

        # 中心节点：库内 id + 论文 id 双锚点
        nodes.append({
            "id": f"lib-{pid}",
            "kind": "paper",
            "paper_id": pid,
            "title": result["filename"],
        })

        for edge in result["edges"]:
            target_id = edge["target"]
            # 找到对应 node，看是否 in_library
            target_node = next((n for n in result["nodes"] if n["id"] == target_id), None)
            if not target_node or not target_node.get("in_library"):
                continue
            target_paper_id = target_node.get("in_library_paper_id")
            if target_paper_id is None:
                continue
            if target_paper_id == pid:
                continue  # 自环跳过
            key = (pid, target_paper_id)
            if key in seen_edge_keys:
                continue
            seen_edge_keys.add(key)
            edges.append({
                "source": f"lib-{pid}",
                "target": f"lib-{target_paper_id}",
                "source_page": edge.get("source_page"),
                "weight": edge.get("weight", 1),
            })

    # 为每条边补 target 节点（可能在之前某轮已经加过，这里去重）
    existing_ids = {n["id"] for n in nodes}
    for edge in edges:
        if edge["target"] not in existing_ids:
            matched = next((item for item in library_refs if item["id"] == edge["target"].replace("lib-", "")), None)
            if matched:
                nodes.append({
                    "id": edge["target"],
                    "kind": "paper",
                    "paper_id": matched["id"],
                    "title": matched["filename"],
                })
                existing_ids.add(edge["target"])

    return {
        "nodes": nodes,
        "edges": edges,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "paper_count": len(paper_ids),
    }
