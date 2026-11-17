# 当前进度快照

更新时间：2026-11-17  
当前阶段：P0 / P1 / P2 全部完成；阅读页三项增强、图谱 ECharts 重构与视觉打磨已完成并实测；正在进行夜间自主收尾。

## 2026-11-17 · 夜间自主收尾

- 阶段一 1.1 完成：首页改为五张竖向功能入口卡片，更新副标题、技术栈与页脚调试链接，`pnpm build` 通过。
- 阶段一 1.2 完成：阅读页改为吸顶工具栏，加入面包屑、真实标题、页码及同侧翻页/整篇翻译操作；窄屏可折行，构建通过并确认 #24 标题为“Attention Is All You Need”。
- 阶段一 1.3 完成：论文库 ≥1024px 采用 60%/40% 两栏，上传与 arXiv 在左，已入库列表和推荐在右；表格精简为四列并支持长文件名截断，生产构建通过。
- 阶段一 1.4 完成：统一 #2563EB 主色、成功/警告/危险色、白卡与 8px 圆角；新增全站响应式导航、统一页头、骨架屏/spinner、引导空状态及可关闭重试的中文错误横幅，补齐按钮/输入框/表格交互态并移除原生确认框；`pnpm build` 通过。
- 阶段一 1.5 完成：以 375px 宽同源 iframe 逐页实测首页、论文库、阅读页、问答、图谱与 Copilot，六页均折叠导航且无页面级横向溢出；修复窄屏阅读页网格最小宽度导致 PDF 画布撑破页面的问题，改为网格可收缩、PDF 区域内部横向滚动，生产构建通过。
- 阶段二完成：六页回归无白屏或错误横幅，优化器问答正确返回 Adam 及第 7 页双引用；README 补齐公网入口、六大模块、环境变量与启动指南，确认 Git 仅跟踪 .env.example。阶段一二完成，剩余：审阅技术文档、录演示视频。
- 阶段三完成：docs/技术文档.md 已含目录、七章、Mermaid 架构图和 13 张验证截图引用；官方用例、OCR、541 页与 RAG 数据均按 Git/实测记录写明。旧版首屏毫秒耗时未留档，文档如实说明并给出同条件补测方法，未虚构对比数字。技术文档初稿完成，待人工审阅后转 PDF；剩余：录演示视频。
- 阶段三推送阻塞（已停止重试）：连续三次 `git push origin main` 失败，报错原文依次为 `fatal: unable to access 'https://github.com/gnnnnnacpdht/research-assistant.git/': Recv failure: Connection was reset`、`fatal: unable to access 'https://github.com/gnnnnnacpdht/research-assistant.git/': Failed to connect to github.com port 443 after 21087 ms: Could not connect to server`、`fatal: unable to access 'https://github.com/gnnnnnacpdht/research-assistant.git/': Recv failure: Connection was reset`。网络诊断显示 DNS 解析与 Ping 正常，但 `Test-NetConnection github.com -Port 443` 返回 `TcpTestSucceeded: False`，判断为当前网络到 GitHub HTTPS 连接受阻，并非文档或 Git 提交错误。技术文档已完整保存在本地 commit `06f59d1`，记录本阻塞前工作区干净；建议明早网络恢复后执行 `git push origin main`，不要重复修改文档或密钥。
- 阶段三推送收尾（手动推送成功）：用户手动执行 `git push origin main` 成功，`0ac5f70..2fcdda5 main -> main`。技术文档与 README 已全部推送 GitHub，远程仓库已验证为最新。剩余：审阅技术文档 → 转 PDF → 录演示视频 → 提交。

## 2026-11-17 · 阅读页增强 + 图谱视觉重构

### 已完成

| 功能 | commit | 结果 |
|---|---|---|
| 阅读页：标题树目录 / 整篇翻译 / 同步滚动 | `0e3b9f0` | 左栏新增可折叠目录（v7 共 21 条 heading，点击跳页并按"页码≤当前页的最后一个标题"高亮）；页头「整篇翻译」按页串行调用 `/api/translate`，显示 `x/15` 进度条与完成提示，译文写入本地缓存避免重复计费；左右两栏按可滚动百分比联动，提供「同步滚动」开关 + 120ms 时间锁防回声抖动 |
| 图谱：图例替换空白 MiniMap + 视野修复 | `7747e21` | 右下角白框实为 `MiniMap`（40 节点缩略后近似空白），移除后换成图例 `Panel`；节点渲染完成后延迟 60ms 再 `fitView`、`minZoom` 降至 0.05，解决初次适配按未测量尺寸计算导致的裁切 |
| 图谱：React Flow → ECharts 力导向重构 | `2b3e514` | 渲染层改为 ECharts graph（按需引入，graph 页首屏 260KB）：force 布局、本论文固定居中、importance→14-42px、橙金/蓝配色 + 基石光晕、曲线连线（curveness 0.2 / 0.35 透明）、hover `focus:adjacency` 相邻高亮其余淡化至 0.08、前 10 节点常显短标题（12 字截断）、tooltip 展示年份/提及/importance、点击节点右侧抽屉、顶部统计条（40 篇 / 40 条 / 基石 6 篇）、空状态提示；移除不再使用的 `@xyflow/react`；顺带修复无参考文献时 `citations.py` 中 `max()` 空集合 500（接口结构不变） |
| 图谱：居中与缩放控制 | `56788b5` | 关闭 `layoutAnimation` 并按节点真实包围盒自适应 `center/zoom`（左留 24px、右预留 110px 给常显标签），整群水平垂直居中、一屏看全；右下角新增 `+ / − / 复位` 浅灰圆角按钮，基于 `series.zoom` 控制视野，复位回到初始适配视图 |

### 实测（浏览器 + 像素级核验，paper 24 = 1706.03762v7）

- 阅读页：目录 21 条可跳页并高亮；整篇翻译 15 页进度递增至完成（约 35s），缓存后重进不重复请求；左栏 scrollTop 500 时右栏 382（=可滚动区间比例 610/798），关闭开关后不再联动。
- 图谱：`node_count=40`；统计条「40 篇文献 | 40 条引用关系 | 基石文献 6 篇」；画布内容包围盒占宽 87%、高 72%，左右上下边距对称；点击 `+` 两次包围盒 655→753，复位回 656，`−` 回 559；点击节点抽屉显示作者/年份/页码/提及/importance/PageRank/原文。
- 空状态：paper 27（无参考文献）接口由 500 修复为 `node_count=0`，页面显示「该论文未解析到参考文献」，统计条全 0，「生成综述」禁用。

### 进行中

- 无。工作区干净（`git status` 无改动），全部改动已提交；后端 8000 端口运行最新代码，前端静态产物已构建。

### 下一步待办

1. **阅读页提速**：整篇翻译改为小并发（如 3 路）或进入页面后预取相邻页译文；PDF 页渲染结果做 LRU 缓存，减少翻页重绘；541 页长文档按需加载页面文本。
2. **视觉打磨**：统一各页加载骨架与空状态；检查窄屏（<1100px）下阅读页双栏折叠、图谱抽屉遮挡；图表配色与全站主题再对齐一次。
3. **收尾 push**：把本地 commit（含 `0e3b9f0`、`7747e21`、`2b3e514`、`56788b5` 及模块四/五/六）推送到远端仓库，确认公网演示地址指向最新构建。
4. **技术文档**：30 页内 PDF 初稿（项目概述、需求分析、架构图、AI 选型理由、核心功能、测试结果、AI 协同与 Prompt 调优、创新点），并核对演示视频脚本。

## 2026-11-16 · 模块四/五/六（arXiv 检索、自动综述、写作 Copilot）

| 功能 | commit | 要点 |
|---|---|---|
| arXiv 检索入库与推荐 | `d350439` | `POST /api/papers/fetch`（ID/关键词两种模式，下载后复用解析入库）；参考文献含金量打分与低含金量折叠；`papers.github_url` 开源复现徽章；`GET /api/papers/recommend` 关键词共现推荐 3 篇 |
| 自动综述与 Future Work | `3d938db` | `GET /api/papers/{id}/survey`：以论文 + 引用图为素材生成领域综述与三个未来方向，结论绑定 `[n]`，结果缓存 `survey_cache`；图谱页弹层展示并支持复制 |
| 学术写作 Copilot | `88b4add` | `POST /api/writing/framework` 生成六节无幻觉框架（Related Work 引用二次校验，库内不存在则丢弃）+ Mermaid/TikZ 脚本；`POST /api/translate/zh2en` 中译英；Copilot 页三标签 |
| 综述弹层关闭交互 | `bf84396` | 右上角 ✕ + Esc + 点遮罩三种关闭方式 |


## 2026-11-16 · 最终收尾：Agent 状态机 / 跨论文对比 / 结构化解析

### 已完成

| 功能 | commit | 结果 |
|---|---|---|
| Agent 状态机与引用自检 | `8e8df52` | retrieve→rerank→generate→verify 四阶段，返回 `trajectory`；verify 失败带着问题重检索（最多 2 轮），仍失败则删除假引用；前端「Agent 推理轨迹」折叠面板。实测"优化器/多少 GPU"两问一轮通过 |
| 跨论文对比问答 | `eb0d58b` | 命中"对比/区别/演化"等词且未指定单篇时进入对比模式：按 paper_id 聚合检索（每篇最多 2 片段）→ 分条 prompt（`[论文N 第X页]`）→ 按论文编号+页码联合校验；前端分条卡片与论文页码徽章。实测"这几篇论文在模型架构上有什么区别"覆盖并引用 3 篇不同论文 |
| 细粒度结构化解析与结构化视图 | `0d1e7b0` | 新增 `structure` 表（paper_id/type/content/level/page_num）与 `GET /api/papers/{id}/structure?type=heading`；上传后后台自动抽取，旧论文可手动 rebuild；前端阅读页「结构化视图」标签页（可折叠标题树点击跳页）。v7 实测：21 个章节标题（二级 12 个）、2 个表格（Markdown）、10 条公式、40 条参考文献、标题/作者机构/摘要齐全 |
| 541 页大文件分级解析与验证 | `0b9f291` | 上传+解析 9.74s、1,314,451 字符、峰值内存 352MB、3716 chunk，指定页检索命中；页码覆盖 537/541 |
| 阅读页修复 | 已包含在阅读页提交中 | pdfjs 降级 4.10.38、`docReady` 计数修复首屏空白、`response_class=FileResponse`、`stored_path` 字段补齐 |
| 公网演示与文档 | `7eeba75`、`768133b` | cpolar 内网穿透（前后端同域 8000），README 更新演示地址；`docs/演示视频脚本.md` 逐字稿 |

### 进行中

- 无。工作区干净，后端 8000 端口运行最新代码，前端静态产物已重新构建。

### 下一步待办

1. arXiv 检索入库（P2-1）：调 arXiv API 检索 → 下载 PDF → 走现有上传/解析/索引流程。
2. 收尾 push：把本地 commit（含 `0d1e7b0`、`eb0d58b` 等）推送到远端仓库。
3. 技术文档：30 页内 PDF 初稿（项目概述、需求分析、架构图、AI 选型理由、核心功能、测试结果、AI 协同与 Prompt 调优、创新点）。
4. 演示前检查：录制前去重弹窗需先移除 v1（ID 25）；问答演示先选 v7 而非"全部论文"。

## 2026-11-16 · P2-2 CSV 数据可视化 Copilot

### 后端

| 文件 | 内容 |
|---|---|
| `app/routers/csv_view.py`（新增） | `POST /api/csv/analyze`：CSV 解析（兼容 UTF-8/GBK）→ 逐列类型判断与统计 → DeepSeek 生成英文图注 + 中文说明 |
| `app/main.py` | 注册 CSV 路由 |

- 列类型判定：可转数值比例 ≥ 80% 视为 numeric，给出 min/max/mean/median；否则视为 category，给出 distinct 与样例值。
- 图注 prompt 要求"只依据给定统计量，不得编造"，输出严格 JSON；解析失败或模型不可用时回退到本地统计拼出的兜底图注（页面不会空白）。
- 统一补 `Figure 1.` 前缀，避免模型有时写有时不写。

### 前端 `/copilot`

- 上传 CSV 后前端自己解析（支持引号转义）用于画图，后端只负责"看懂数据 + 写图注"；
- Chart.js 渲染柱状图 / 折线图，可一键切表格视图；
- 自动选轴：第一个非数值列作 X，第一个数值列作 Y；
- 图注区英文 + 中文，「一键复制」复制两段文本；
- 首页增加「数据可视化 Copilot」入口。

### 实测结果（`samples/transformer_bleu.csv`，9 行 × 5 列）

- 列判定：model/task 为类别，bleu/train_hours/params_m 为数值；
- 图注（DeepSeek 生成）：
  > Figure 1. BLEU scores on the WMT14 EN-DE and EN-FR translation tasks for five model architectures, plotted against training time and parameter count. Transformer (big) attains the highest BLEU on both tasks (28.4 EN-DE, 41.0 EN-FR)...
- 柱状图 canvas 高 404px 正常渲染；折线图、表格切换正常；复制按钮点击后显示「已复制 ✓」。

截图存证：`.screenshots/p2-copilot/`。

## 2026-11-16 · P1-2 引用图谱与基石文献挖掘

### 后端

| 文件 | 内容 |
|---|---|
| `app/citations.py`（新增） | 参考文献结构化解析 → networkx 有向图 → PageRank → 加权 importance → Top5 基石文献 |
| `app/routers/papers.py` | 新增 `GET /api/papers/{id}/citations` |
| `pyproject.toml` | 依赖加入 `networkx` |

**打分公式**（importance 0-100）：

```
importance = 100 × (0.35 × PageRank归一 + 0.15 × 正文提及占比 + 0.40 × 领域经典度 + 0.10 × 年份新鲜度)
```

- 边权 = 1 + 该编号在正文被提及次数，PageRank 因此能区分"作者反复引用的工作"；
- 领域经典度关键词表覆盖 LSTM / Adam / ResNet / BatchNorm / Dropout / word2vec 等，
  通用词 attention 权重压低（NMT 领域几乎人人提，区分度低）；
- 年份新鲜度按最新年份线性衰减到 0（20 年窗口）。

**条目解析**：先按 `作者. 标题. 出处, 年份` 正则切分；作者名含缩写（如 "Yann N. Dauphin"）
或标题疑似作者列表时，改用候选段落打分（小写词多、不含 arXiv/年份者胜出）；
最后修复 PDF 断词（`Convolu- tional` → `Convolutional`）。

### 前端 `/graph?paper_id=X`

- React Flow（`@xyflow/react`）渲染：中心节点是论文，被引文献按重要性排序沿圆环辐射；
- 节点直径 30-88px 随 importance 变化，≥80 橙色、≥60 蓝色、其余灰色；
- 悬停显示黑底提示（标题 + 年份 + 重要性），点击右侧展示作者/年份/页码/提及次数/原始条目；
- 右侧「基石文献 Top5」列出分数与理由（正文提及次数、经典命中、发表年份）。

### 实测结果（论文 #24 1706.03762v7.pdf）

- 节点 41 个（1 中心 + 40 被引）、边 40 条，Top5：
  [9] Convolutional sequence to sequence learning 87.0、
  [21] Factorization tricks for LSTM networks 85.1、
  [20] Adam 84.1、[11] Deep residual learning 83.4、[4] LSTM-networks 82.5
- 点击 [20] 右侧显示 "Adam: A method for stochastic optimization / 2015 / 84.1"；
- 悬停出现提示框。

### 踩坑记录

1. **引用节点不渲染**：后端节点缺 `kind` 字段，前端按 `kind==="reference"` 过滤为空；补字段后 41 节点正常。
2. **重要性全部挤在 96-98 分**：初版只做 PageRank 归一，星型图各叶节点几乎相同；改为叠加提及占比与经典度后区分度恢复正常。
3. **标题解析错位**：作者缩写（"Yann N."）被当作分隔符，导致标题只剩 "Dauphin"；加缩写识别 + 候选段落打分兜底。

截图存证：`.screenshots/p1-graph/`。

## 2026-11-16 · P1-1 双语联动阅读与引用跳转

### 后端新增

| 接口 | 作用 |
|---|---|
| `GET /api/papers/{id}/file` | 返回原始 PDF，供前端 pdf.js 渲染 |
| `GET /api/papers/{id}/page/{n}` | 返回该页提取文本与总页数 |
| `GET /api/papers/{id}/references` | 解析参考文献条目 + 每个编号在正文的首现页码 |
| `POST /api/translate` | 英文学术文本 → 中文，进程内 LRU 缓存（512 条，命中直接返回 `cached: true`） |
| `GET /api/translate/cache-stats` | 缓存命中情况，便于演示"省钱" |

参考文献解析：取**最后一次**出现的 `References` 标题行作为起点（避开正文/表格里的同名字样），
从该页起按 `[n]` 切分条目，同编号保留文本最长的一条并按编号排序。

### 前端新页面 `/read?paper_id=X`

- 左侧 pdf.js 渲染原版页面：canvas 画图 + 手写文本层（`page.getTextContent()` 逐片段绝对定位、
  按 PDF 实际宽度横向 scaleX），因此可以鼠标拖选。
- 右侧两个标签页：中文翻译（整页）与参考文献（40 条，可滚动）。
- 划词翻译：选中英文 → 选区上方浮出「翻译」按钮 → 调 `/api/translate` → 结果显示在右栏卡片。
- 引用双向跳转：正文页提炼出「本页引用 [1] [2] …」徽章，点 [n] 切到参考文献并滚动高亮；
  文献条目点「↑ 跳到正文 P.x」回到该编号首次出现的页面。
- 论文库每行新增「阅读」入口。

### 实测结果

| 项 | 结果 |
|---|---|
| 首屏左侧 PDF | canvas 1239×1603，第 1/15 页正常渲染 |
| 右侧整页译文 | 正常，含标题、作者、摘要中文 |
| 划词翻译 | 选中 "Provided proper attribution is provided, Google hereby grants permission to" → 译文正确 |
| 引用跳转 | 正文 [3] → 参考文献 [3] 高亮；文献条目 → 回正文 P.4 |
| 翻译缓存 | 第二次相同文本 `cached: true` |

### 踩坑记录

1. **pdfjs-dist 6.x 依赖新版 Chrome**：报 `getOrInsertComputed is not a function`，降级到 4.10.38 解决。
2. **降级后报 API/Worker 版本不匹配**：Next dev 缓存了旧 vendor chunk，删除 `.next` 重启即可。
3. **`-> FileResponse` 返回注解会 500**：FastAPI 会当成 pydantic 响应模型，改用 `response_class=FileResponse`。
4. **`db.get_paper` 未返回 `stored_path`**：补上该字段，PDF 下载接口才能取到文件路径。
5. **首屏空白需刷新**：dev 模式 StrictMode 重挂载导致渲染 effect 在文档销毁后不再触发，
   改为依赖 `docReady` 计数修复。

截图存证：`.screenshots/p1-read/`。

## 2026-11-16 · 收尾：官方顺序二次实测（截图留证）

清空论文库后按官方顺序完整跑了一遍，全部通过：

| 步骤 | 结果 |
|---|---|
| 上传 `1706.03762v7.pdf` | 直接入库，列表 1 条，无弹窗 |
| 上传 `1706.03762v1.pdf` | 弹出预警，显示 **相似度 94.9%**，橙色提示"库中已有更新版本 v7，建议保留两个版本而不是覆盖" |
| 点"点此对比版本差异" | DeepSeek 输出修订摘要（含 En-FR BLEU 41.0 → 41.8 的数值差异） |
| 点"保留两个版本" | 弹窗关闭，列表变 2 条（ID 24 v7、ID 25 v1） |
| 上传改名文件 `mypaper.pdf`（内容同 v1） | **仍触发预警**，与 v1 相似度 100.0%、与 v7 相似度 94.9% → 证明基于语义而非文件名 |

截图存证：`.screenshots/dedupe/`（1-v7直接入库 / 2-v1触发预警94.9 / 3-DeepSeek修订摘要 / 4-保留两个版本后2条 / 5-改名mypaper仍预警）。

## 2026-11-16 · 收尾：去重弹窗体验补强

- 弹窗直接显示**相似度百分比**（0.9489 → 94.9%），不再只写"≥0.92"。
- 新增**版本提示**：库中版本号高于待上传版本时，高亮提示
  "库中已有更新版本 xxx，建议保留两个版本而不是覆盖"。
- 「保留」按钮文案改为「保留两个版本」，含义更直白。
- 说明：预警基于语义而非文件名，把 v1 改名成 `mypaper.pdf` 仍会触发。

## 2026-11-16 · P0-3 语义去重（官方验收用例）

**验收用例：1706.03762v7.pdf 先入库 → 上传 1706.03762v1.pdf 必须基于语义（非文件名）预警。**

### 后端实现（`app/dedupe.py` + `routers/papers.py`）

- 上传解析后，把新论文全文截前 15000 字（BGE-M3 上限 8192 tokens ≈ 20000 字符）
  作为语义指纹，与库内所有已有论文**一次性 batch embedding**，逐对算余弦相似度。
- 阈值 0.92 经实测：v1/v7 余弦 0.9489 ✓；不同论文约 0.7 以下。
- 超过阈值时返回 **HTTP 309**（用 `JSONResponse`，FastAPI 默认 HTTPException 会剥离自定义 headers）：
  body 里带 `{token, filename, duplicates: [{paper_id, filename, similarity}]}`；
  headers 里带 `X-Dedupe-Token` 供前端双保险读取。
- 新增接口：`POST /confirm-keep`（保留为独立条目）、`POST /confirm-overwrite`（覆盖删旧）、
  `POST /compare`（只读暂存，调用 DeepSeek 生成四字段修订摘要：总体判断 / 修订章节 / 关键数字差异 / 一句话总结）、
  `POST /cancel`（清理暂存文件）。
- 待确认队列用进程内 dict + threading.Lock，token 是 uuid hex；compare 用 `peek_pending`
  只读不消费 token，让前端能先看对比再决定覆盖/保留/取消。
- 降级保护：相似检测失败（向量化挂了）时直接放行，不阻塞正常上传。

### 前端实现（`frontend/app/papers/page.js` + `globals.css`）

- 上传流程改为两阶段：正常 201 直接入库；309 时解析 body 拿 token+duplicates，
  弹出遮罩层 Modal。
- Modal 显示已有论文列表，每条点一下调 `/compare` 显示 DeepSeek 修订摘要
  （`revision-box` 灰底卡片）。
- 底部三个主操作："取消上传"（红）、"保留"（灰）、"覆盖"（蓝）。

### 实测结果（接口级 + 浏览器级）

| 步骤 | 预期 | 实际 |
|---|---|---|
| v7 上传 | 201 直接入库 | 201 ✅，98 条向量 |
| v1 上传 | 309 触发预警 | 309 ✅，token+body+header 全对，duplicates.similarity=0.9489 |
| 浏览器弹窗 | 列出已有论文+对比入口 | ✅ |
| 点对比 | DeepSeek 修订摘要 | ✅ 输出四字段结构化修订 |
| confirm-keep | 新条目入库 | ✅ 列表变 2 条 |
| confirm-overwrite | 删旧→新条目 | ✅ 最终只剩 1 条 |
| cancel | 清理暂存文件 | ✅ |

### 踩坑记录

1. **FastAPI HTTPException 剥离自定义 headers**：改成直接 `return JSONResponse(...)`。
2. **全文太长 embedding 接口 400**：BGE-M3 单次上限 8192 tokens ≈ 20000 字符，去重指纹截前 15000 字已足够区分版本（v1/v7 相似度 0.95 vs 不同论文 0.7）。
3. **compare 后 token 失效**：先 dequeue 又 enqueue 用了新 token。修复：compare 用 peek 只读不消费。
4. **Windows --reload 清空内存 pending 队列**：后端稳定运行必须不带 `--reload`。

### 下一步

P1 开始：双语联动阅读、引用图谱。

## 2026-11-16 · 论文删除与向量库同步清理

- 新增 `DELETE /api/papers/{id}`：先删 Chroma 中 `paper_id` 匹配的向量，再删 SQLite 的
  pages 与 papers 记录，最后删磁盘原文件；重复删除返回 404。
- 前端论文列表新增「删除」按钮（红色描边），点击后 `window.confirm` 二次确认，成功后刷新列表。
- 验证：用一条一次性测试论文（含 2 页文本 + 2 条向量）走接口删除，
  papers / pages / Chroma 三处残留均为 0，重复删除返回 404，其它论文不受影响。
- 删除 ID=1（重复的 v7）后列表为 3 条，符合预期。

### 事故记录（已修复）

- 现象：用浏览器自动化验证"删除二次确认"时，工具自动点击了原生确认框的「确定」，
  导致 2/3/4 号论文被真实删除。
- 处理：已用 `pdf/` 目录原文件重新入库，现为 7 号（v1）、8 号（v7）、9 号（扫描件）。
- 教训：删除类操作不要用会自动确认弹窗的浏览器自动化验证，改用手工点击或接口级测试。

### 阻塞问题（余额）

- 向量化（BGE-M3）、重排（bge-reranker）、OCR（Qwen-VL）均返回
  `HTTP 402 {"code":30001,"message":"Sorry, your account balance is insufficient"}`，
  因此重新入库的论文暂时没有向量，`/api/ask` 返回 503。
- 充值后重启后端即可：启动时会自动为缺索引的论文补建向量，无需重新上传。

## 2026-11-16 · 扫描件 OCR（P0-1 补充）

- 新增 `backend/app/ocr.py`：页面渲染成 150dpi PNG，走多模态模型识别成纯文本，4 页并发。
- `pdf_parser.py` 改为逐页判定：提取文字少于 50 字符即视为扫描页，渲染后 OCR，
  识别结果替代原文本入库；单页失败不影响整篇上传。
- `pages` 表新增 `ocr` 标记字段，`init_db` 内置老库自动加列迁移。
- 上传响应新增 `ocr_pages` / `empty_pages` / `warning`，前端在论文库页用红色提示展示。
- 用本地假视觉接口验证全链路：15 页全部判定为扫描页、全部走 OCR、入库 `ocr=1`，迁移正常。

### 阻塞问题（真实 OCR 未跑通）

- 现象：调用 `Qwen/Qwen3-VL-32B-Instruct` 返回
  `HTTP 402 {"code":30001,"message":"Sorry, your account balance is insufficient"}`。
- 同一问题影响 `Qwen/Qwen3-VL-30B-A3B-Instruct`、`PaddlePaddle/PaddleOCR-VL-1.5`、
  `Qwen/Qwen3-VL-8B-Instruct`；DeepSeek 文本模型正常，BGE-M3 向量化与重排正常。
- 分析：SiliconFlow 账户余额耗尽（首轮单页试识别曾成功，随后全部 402），
  与代码无关；已用本地假接口证明请求链路、渲染、入库、标记全部正确。
- 建议方案（任选其一）：① 给 SiliconFlow 账户充值后重新上传 `pdf/1706.03762v1_img.pdf`；
  ② 在 `.env` 填 `MULTIMODAL_API_KEY` 并设置 `MULTIMODAL_BASE_URL`/`VISION_MODEL`
  切换到阿里云百炼 Qwen-VL 或 OpenAI GPT-4o。
- 充值后预期：上传返回 `ocr_pages: 15, empty_pages: 0`，论文库中该文件出现正文文本。

### 已知问题

- 本地 `uvicorn --reload` 在 Windows 上偶发热重载卡死（日志停在 Reloading 不再启动），
  联调时建议去掉 `--reload` 或改完代码手动重启。

## 2026-11-16 · P0-2 抗幻觉 RAG 问答

- 新增 `backend/app/config.py`：统一从根目录 `.env` 读取密钥与模型配置，代码内无明文密钥。
- 新增 `backend/app/llm_client.py`：封装 SiliconFlow BGE-M3 向量化、bge-reranker-v2-m3 重排、DeepSeek 生成。
- 新增 `backend/app/rag.py`：500 字符切块（重叠 80）、Chroma `papers` 集合入库、
  召回 top5 → 重排 top3 → 带 `[第X页]` 强制引用的抗幻觉生成。
- 新增 `backend/app/routers/ask.py`：`POST /api/ask` 返回 `{answer, sources}`。
- 上传接口改为后台任务自动建索引；启动时自动补齐历史论文索引；新增 `POST /api/papers/{id}/index` 手动重建。
- 前端新增 `/ask` 智能问答页：答案中 `[第X页]` 渲染为蓝色徽章，点击弹出对应原文片段；论文库页新增入口。
- 实测：4 篇论文中 3 篇矢量 PDF 入库 287 个片段（扫描件因无文本层暂为 0 片段）；
  中文提问"这篇论文使用的优化器是什么"答出 `Adam 优化器 [第7页]`，浏览器验收通过。

### 已知问题

- 中文提问需先经 LLM 改写成英文检索式（`QUERY_REWRITE=1`），否则跨语言召回不佳。
- 本地 `uvicorn --reload` 若监控整个 `backend/` 会被 `.venv` 的依赖写入触发，需加 `--reload-dir app`。

## 已完成（2026-11-13 骨架与 PDF 入库）

- 建立前后端分离目录：`backend/`（FastAPI）与 `frontend/`（Next.js 14 App Router）。
- 后端提供 `/api/health` 健康检查、CORS 配置和 `/docs` Swagger 文档。
- 前端提供项目首页，以及后端健康检查和 API 文档入口。
- 配置 uv 与 pnpm 依赖管理及锁文件，补充 README 启动指南。
- 配置 `.env.example` 占位符和 `.gitignore`；真实 DeepSeek、SiliconFlow 密钥只保存在被 Git 忽略的 `.env` 中。
- 初始化 Git 仓库并保存项目约定、项目骨架和依赖锁文件。

## 本地验证结果

- FastAPI 健康检查返回预期 JSON，Swagger 文档返回 HTTP 200。
- Next.js 开发服务器出现 `Ready`，首页返回 HTTP 200，`/papers` 与 `/ask` 页面正常。
- Next.js 生产构建成功。

## 下一步

1. 给 SiliconFlow 充值后重新上传 `pdf/1706.03762v1_img.pdf`，确认 `ocr_pages: 15`。
2. 进入 P0-3 语义去重（v7 已入库时上传 v1 须基于语义预警）。

## 尚未开始

- 语义去重及版本差异总结。
- 双语联动阅读、引用图谱、CSV 图表和 arXiv 入库。
- 541 页长文档 `UnderstandingDeepLearning_02_09_26_C.pdf` 的入库压测。
