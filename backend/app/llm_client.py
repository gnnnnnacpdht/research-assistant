"""模型调用层：所有对外部大模型 API 的请求都集中在这里。

- 向量化：SiliconFlow 的 BGE-M3（OpenAI 兼容的 /v1/embeddings）
- 重排：SiliconFlow 的 bge-reranker（/v1/rerank，非 OpenAI 标准接口）
- 生成：DeepSeek 的 deepseek-chat（OpenAI 兼容的 /v1/chat/completions）
"""

from typing import Any

import httpx

from . import config


def embed_texts(texts: list[str]) -> list[list[float]]:
    """批量把文本转成 1024 维向量，按输入顺序返回。

    分批发送：一次塞几百段文本会被服务端拒绝或超时。
    """
    if not texts:
        return []

    api_key = config.require_api_key("siliconflow")
    vectors: list[list[float]] = []

    with httpx.Client(timeout=120.0) as client:
        for start in range(0, len(texts), config.EMBED_BATCH_SIZE):
            batch = texts[start : start + config.EMBED_BATCH_SIZE]
            response = client.post(
                f"{config.SILICONFLOW_BASE_URL}/v1/embeddings",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": config.EMBEDDING_MODEL, "input": batch},
            )
            if response.status_code != 200:
                raise RuntimeError(
                    f"向量化失败（HTTP {response.status_code}）：{response.text[:300]}"
                )
            payload = response.json()
            # 部分实现会乱序返回，按 index 排序保证与输入文本一一对应。
            items = sorted(payload["data"], key=lambda item: item["index"])
            vectors.extend(item["embedding"] for item in items)

    return vectors


def rerank(query: str, documents: list[str], top_n: int) -> list[tuple[int, float]]:
    """用重排模型给候选片段打分，返回 [(原始下标, 相关性分数)]，按分数降序。"""
    if not documents:
        return []

    api_key = config.require_api_key("siliconflow")
    with httpx.Client(timeout=120.0) as client:
        response = client.post(
            f"{config.SILICONFLOW_BASE_URL}/v1/rerank",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": config.RERANK_MODEL,
                "query": query,
                "documents": documents,
                "top_n": min(top_n, len(documents)),
            },
        )

    if response.status_code != 200:
        raise RuntimeError(
            f"重排失败（HTTP {response.status_code}）：{response.text[:300]}"
        )

    results = response.json().get("results", [])
    # index 指向 documents 里的原始位置，用它把分数映射回片段。
    return [(item["index"], item["relevance_score"]) for item in results]


def chat(messages: list[dict[str, str]], temperature: float = 0.2) -> str:
    """调用 DeepSeek 生成答案；温度调低，减少自由发挥带来的幻觉。"""
    api_key = config.require_api_key("deepseek")
    with httpx.Client(timeout=180.0) as client:
        response = client.post(
            f"{config.DEEPSEEK_BASE_URL}/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": config.CHAT_MODEL,
                "messages": messages,
                "temperature": temperature,
                "stream": False,
            },
        )

    if response.status_code != 200:
        raise RuntimeError(
            f"生成失败（HTTP {response.status_code}）：{response.text[:300]}"
        )

    data: dict[str, Any] = response.json()
    return data["choices"][0]["message"]["content"].strip()
