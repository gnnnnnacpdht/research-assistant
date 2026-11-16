"""集中配置：全项目只在这里读取 .env，避免密钥散落到各个模块。

安全约定：密钥只从环境变量/.env 读取，代码里绝不出现明文；
缺失时给出可读的报错，而不是在 import 阶段整站崩溃。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent
DATA_DIR = BACKEND_DIR / "data"

# .env 带 UTF-8 BOM（Windows 记事本保存会写 BOM），必须用 utf-8-sig 解码。
for env_file in (PROJECT_ROOT / ".env", BACKEND_DIR / ".env"):
    if env_file.exists():
        load_dotenv(env_file, encoding="utf-8-sig", override=False)

# ---- 密钥 ----
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
SILICONFLOW_API_KEY = os.getenv("SILICONFLOW_API_KEY", "").strip()
# 多模态密钥未单独配置时复用 SiliconFlow 的密钥（其平台同时提供 Qwen-VL）。
MULTIMODAL_API_KEY = (
    os.getenv("MULTIMODAL_API_KEY", "").strip() or SILICONFLOW_API_KEY
)

# ---- 接口地址与模型名称（可用环境变量覆盖，默认值即官方推荐配置）----
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
SILICONFLOW_BASE_URL = os.getenv(
    "SILICONFLOW_BASE_URL", "https://api.siliconflow.cn"
).rstrip("/")

CHAT_MODEL = os.getenv("CHAT_MODEL", "deepseek-chat")
# BGE-M3 向量维度 1024，检索与入库必须使用同一个模型，否则向量不可比。
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")
# SiliconFlow 当前在售的重排模型是 v2-m3（bge-reranker-large 已下线），
# 通过环境变量可切换，避免把模型名写死在业务代码里。
RERANK_MODEL = os.getenv("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")

# ---- 向量库 ----
CHROMA_DIR = Path(os.getenv("CHROMA_DIR", DATA_DIR / "chroma"))
CHROMA_COLLECTION = os.getenv("CHROMA_COLLECTION", "papers")

# ---- 检索参数（PROJECT.md 要求：检索 top5，重排后取前 3）----
RETRIEVE_TOP_K = int(os.getenv("RETRIEVE_TOP_K", "5"))
RERANK_TOP_K = int(os.getenv("RERANK_TOP_K", "3"))

# ---- 切块参数（500 字符一块，相邻块重叠 80 字符）----
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "500"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "80"))

# 单次 embedding 请求携带的文本条数：批量能提速，但不能超过服务端限制。
EMBED_BATCH_SIZE = int(os.getenv("EMBED_BATCH_SIZE", "16"))

# 文本太少的页（扫描件、纯图表页）不建索引，避免噪声片段干扰检索。
MIN_PAGE_CHARS = int(os.getenv("MIN_PAGE_CHARS", "30"))

# 中文提问先改写成英文检索式：库内论文正文基本是英文，
# 同语言匹配的召回率明显高于跨语言直检（可用环境变量关掉）。
QUERY_REWRITE = os.getenv("QUERY_REWRITE", "1") == "1"

# ---- 扫描件 OCR ----
# 多模态接口地址默认与 SiliconFlow 相同；换成 GPT-4o 时改这里和 VISION_MODEL 即可。
MULTIMODAL_BASE_URL = os.getenv(
    "MULTIMODAL_BASE_URL", SILICONFLOW_BASE_URL
).rstrip("/")
# 平台在售的 Qwen-VL 系列模型；未开通或余额不足会在上传时给出明确报错。
VISION_MODEL = os.getenv("VISION_MODEL", "Qwen/Qwen3-VL-32B-Instruct")
# 一页提取出的文字少于该字符数就判定为扫描页，转图片走 OCR。
OCR_MIN_CHARS = int(os.getenv("OCR_MIN_CHARS", "50"))
# 渲染分辨率：150dpi 对正文识别足够，且能显著降低图片体积与识别耗时。
OCR_DPI = int(os.getenv("OCR_DPI", "150"))
# 并发识别的页数：太高会触发平台限流。
OCR_CONCURRENCY = int(os.getenv("OCR_CONCURRENCY", "4"))


def require_api_key(name: str) -> str:
    """取密钥并在缺失时抛出中文可读错误，便于前端直接展示原因。"""
    keys = {
        "deepseek": (DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY"),
        "siliconflow": (SILICONFLOW_API_KEY, "SILICONFLOW_API_KEY"),
        "multimodal": (MULTIMODAL_API_KEY, "MULTIMODAL_API_KEY 或 SILICONFLOW_API_KEY"),
    }
    value, env_name = keys[name]
    if not value:
        raise RuntimeError(f"未配置 {env_name}，请在项目根目录 .env 中填写后重启后端")
    return value
