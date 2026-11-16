"""CSV 数据可视化助手：解析列结构 → 统计摘要 → DeepSeek 生成学术图注。

图表本身由前端 Chart.js 渲染，这里只负责"看懂数据"并写出 Figure Caption。
"""

import csv
import io
import json
import re

from fastapi import APIRouter, File, HTTPException, UploadFile

from .. import llm_client

router = APIRouter(prefix="/api/csv", tags=["CSV 可视化"])

MAX_ROWS = 5000  # 单个文件最多解析的行数，避免超大 CSV 打爆内存


def _to_number(value: str) -> float | None:
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _summarize(rows: list[list[str]], header: list[str]) -> list[dict]:
    """逐列判断类型并给出统计量，供图注生成与前端选轴参考。"""
    columns: list[dict] = []
    for position, name in enumerate(header):
        values = [row[position] for row in rows if position < len(row) and row[position] != ""]
        numbers = [number for number in (_to_number(value) for value in values) if number is not None]
        is_numeric = len(values) > 0 and len(numbers) >= max(1, len(values) * 0.8)

        column = {
            "name": name,
            "type": "numeric" if is_numeric else "category",
            "count": len(values),
            "missing": len(rows) - len(values),
        }
        if is_numeric and numbers:
            ordered = sorted(numbers)
            column.update(
                {
                    "min": round(ordered[0], 4),
                    "max": round(ordered[-1], 4),
                    "mean": round(sum(numbers) / len(numbers), 4),
                    "median": round(ordered[len(ordered) // 2], 4),
                }
            )
        else:
            column["distinct"] = len(set(values))
            column["sample"] = values[:5]
        columns.append(column)
    return columns


CAPTION_PROMPT = (
    "你是学术论文写作助手。给你一份 CSV 数据的结构摘要和样本，请写一段英文学术图注（Figure Caption）。\n"
    "要求：\n"
    "1) 英文 2-3 句，学术书面语，先说明图表展示什么，再点出关键数值趋势或对比结论；\n"
    "2) 不要编造数据中不存在的结论，只依据给出的统计量与样本；\n"
    "3) 再给一段中文说明（1-2 句），解释这张图想表达什么；\n"
    "4) 只输出 JSON，不要 markdown 代码块，格式："
    '{"caption_en": "...", "caption_zh": "..."}'
)


def _fallback_caption(columns: list[dict], row_count: int) -> dict:
    """模型不可用时的兜底图注，保证页面始终有内容。"""
    numeric = [column for column in columns if column["type"] == "numeric"]
    parts = ", ".join(
        f"{column['name']} (mean {column.get('mean')}, range {column.get('min')}-{column.get('max')})"
        for column in numeric[:3]
    )
    return {
        "caption_en": (
            f"Figure 1. Overview of the dataset containing {row_count} records across "
            f"{len(columns)} variables. Numeric variables include {parts or 'no numeric fields'}."
        ),
        "caption_zh": f"该图展示 {row_count} 条记录在 {len(columns)} 个字段上的分布情况。",
        "model": "fallback",
    }


@router.post("/analyze")
async def analyze_csv(file: UploadFile = File(...)) -> dict:
    """解析 CSV 并生成学术图注。"""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="文件为空")

    # 兼容 UTF-8 与 Excel 常见的 GBK 导出
    text = None
    for encoding in ("utf-8-sig", "gbk", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise HTTPException(status_code=400, detail="无法识别文件编码")

    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration as exc:
        raise HTTPException(status_code=400, detail="CSV 没有表头") from exc

    rows: list[list[str]] = []
    for row in reader:
        if not row or all(cell.strip() == "" for cell in row):
            continue
        rows.append(row)
        if len(rows) >= MAX_ROWS:
            break

    if not rows:
        raise HTTPException(status_code=400, detail="CSV 没有数据行")

    columns = _summarize(rows, header)

    payload = {
        "filename": file.filename,
        "row_count": len(rows),
        "columns": columns,
        "sample_rows": [dict(zip(header, row)) for row in rows[:8]],
    }

    try:
        reply = llm_client.chat(
            [
                {"role": "system", "content": CAPTION_PROMPT},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)[:6000]},
            ],
            temperature=0.3,
        )
        matched = re.search(r"\{.*\}", reply, re.S)
        parsed = json.loads(matched.group(0)) if matched else {}
        caption_en = (parsed.get("caption_en") or "").strip()
        caption_zh = (parsed.get("caption_zh") or "").strip()
        if not caption_en:
            raise ValueError("模型未返回英文图注")
        # 统一学术编号，避免模型有时写有时不写 Figure 1.
        if not caption_en.lower().startswith("figure"):
            caption_en = f"Figure 1. {caption_en}"
        result = {"caption_en": caption_en, "caption_zh": caption_zh, "model": "deepseek"}
    except Exception:
        result = _fallback_caption(columns, len(rows))

    return {
        "filename": file.filename,
        "row_count": len(rows),
        "columns": columns,
        "preview": rows[:20],
        "header": header,
        **result,
    }
