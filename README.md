# 云创智谷 · 园区级数字孪生底座

一个可直接运行的园区级（0.47 km²）数字孪生最小闭环：**CesiumJS 三维场景 + FastAPI/PostGIS 轻量数据服务 + WebSocket 实时遥测**。
含 12 栋建筑、200 台物联设备、48 段综合管网的可复现演示数据。

![驾驶舱](docs/screenshot.png)

---

## 三条设计约束怎么落地的

### 1. 以场景定引擎 → CesiumJS 主引擎

园区级场景的输入是**带地理坐标的 GIS 数据**（楼栋面、管网线、设备点），需要的不是炫技渲染，而是坐标系、瓦片调度、空间拾取和 2D/3D 切换——这些 Cesium 全都内置。

- **不用 Three.js 做主引擎**：它没有地理坐标系、没有瓦片调度、没有拾取，补这一层等于重写半个 Cesium。
- **不引入 OpenLayers 双引擎**：Cesium 自带 `SCENE2D`，二维视图够用；双引擎的相机/图层同步是长期负债。
- **Three.js 只做设备级局部增强**：选中设备时叠一层透明画布，相机矩阵每帧从 Cesium 同步，渲染该设备的实体高模（冷水机组 / 水泵 / 配电柜 / 立杆摄像机…）；不做全场景混渲染，见 [`docs/01-架构决策.md`](docs/01-架构决策.md)。

> 推翻条件、对比表见 [`docs/01-架构决策.md`](docs/01-架构决策.md)。

### 2. 数据轻量化优先于渲染优化

建筑用 **2.5D 拉伸体块**而不是 BIM/glTF；设备用**点位**而不是模型；树木用**点位 + 树冠半径**。
服务端实现四级 LOD 管线，每个响应自带压缩指标：

| LOD | 场景 | 几何 | 坐标精度 | 标签可见属性 | gzip 降幅 |
| --- | --- | --- | --- | --- | --- |
| LOD0 概览 | 园区全景 / 大屏轮播 | 8 m 抽稀 + 面要素包络框 | 4 位（≈11 m） | 仅楼名 | **62.1%** |
| LOD1 标准 | 日常巡检 / 单栋浏览 | 1.5 m 抽稀 | 5 位（≈1.1 m） | 楼名 + 层数 | 22.4% |
| LOD2 精细 | 专题分析 / 上报归档 | 不抽稀 | 7 位（≈1 cm） | 楼名 + 层数 + 建筑面积 | 5.2% |

精度切换是**看得见**的：楼栋轮廓（保/丢折角）、标签内容、左侧实测降幅都会变化，并弹出一条实测提示（要素数 / 传输量 / 降幅）。

四步：**几何抽稀 → 坐标量化 → 属性白名单 → 视口 bbox 增量拉取**。
数据库只存一份原始要素，LOD 实时生成，绝不落三套数据。

界面左侧「数据轻量化」面板显示的是**这次请求的实测降幅**，切换视图精度会真实重新取数。

### 3. 后端从开源栈起步，按需演进

```
FastAPI
 ├── repository/memory.py    零依赖，直接读 data/*.geojson（默认）
 └── repository/postgis.py   配 DATABASE_URL 即切换，接口一模一样
```

- **GeoServer 不是起步必需品**，它是「要给第三方 GIS / 上级平台提供 WMS/WFS」时才需要的中间件。
  本仓库用 `geo` profile 预留，`docker compose --profile ogc up -d` 按需启用，主链路不依赖它。
- 单园区、200 台设备的体量，明确**不做**微服务拆分、不引 Kafka/K8s。

---

## 快速开始

### 形态零：容器（一条命令起全栈，交付给第三方时用这个）

```powershell
cd park-digital-twin
docker compose up -d --build         # api + postgis + redis + gateway，自动等库/导入/起服务
docker compose up -d --scale api=2   # 可选：扩到两副本，网关自动轮询
```

打开 <http://127.0.0.1:8000> 即可（底部状态栏「数据源」显示 `PostGIS`）。
想退回「零依赖内存仓库」：注释掉 `docker-compose.yml` 里 api 的 `DATABASE_URL` 与 `REDIS_URL` 再 `up -d`。
多副本依赖 Redis（缓存/广播/设备状态/告警确认四项已外置），细节与排障见 [`docs/03-环境与部署.md`](docs/03-环境与部署.md) 的容器化附录。

### 形态一：单端口（前后端一起，推荐首跑）

```powershell
cd park-digital-twin
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt

python tools\gen_demo_data.py                 # 生成演示数据（幂等）
python tools\gen_demo_tileset.py              # 生成演示用三维外壳瓦片 (3D Tiles)
cd frontend; npm install; npm run build; cd ..

.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000>（前端构建产物由后端一并托管），API 文档在 <http://127.0.0.1:8000/docs>。

> 日常启动可以直接 `.\start.ps1`：会自检虚拟环境、缺失时补生成数据与瓦片、检查端口占用，然后前台起服务（Ctrl+C 停止）。

### 形态二：开发模式（前端热更新）

```powershell
# 终端 1
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000 --app-dir backend

# 终端 2
cd frontend
npm run dev        # http://127.0.0.1:5173 ，/api 与 /ws 已代理到 8000
```

### 切到 PostGIS

```powershell
docker compose up -d postgis                                    # 等 pg_isready 变 healthy
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-postgis.txt

$env:DATABASE_URL = "postgresql://park:park@localhost:5432/park_twin"
.\.venv\Scripts\python.exe backend\scripts\load_postgis.py      # 324 要素 / 12 栋 / 6 条告警
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --port 8000
```

切换后前端零改动，底部状态栏的「数据源」会从「内存 GeoJSON」变为「PostGIS」。

这条路径已用 `backend/tests/test_postgis.py` 固化：设置 `DATABASE_URL` 时跑 4 项集成测试（图层要素数、几何 Z 维度、楼栋明细、告警解析），**没配数据库时自动跳过**，不影响默认流程：

```powershell
cd backend
..\.venv\Scripts\python.exe -m pytest       # 无库: 25 passed, 4 skipped
$env:DATABASE_URL = "postgresql://park:park@localhost:5432/park_twin"
..\.venv\Scripts\python.exe -m pytest       # 有库: 29 passed
```

### 需要 OGC 服务时

```powershell
docker compose --profile ogc up -d      # postgis + geoserver:8080
```

### 测试

```powershell
cd backend
..\.venv\Scripts\python.exe -m pytest        # 抽稀/量化/属性裁剪 + 接口冒烟 + 加固回归
cd ..\frontend                              # ESLint + Prettier 检查 + 类型检查 + 构建
npm run lint; npm run format:check; npm run build
```

> 环境变量、测试/生产环境差异、systemd / Nginx / Windows 服务部署与排障，见 [`docs/03-环境与部署.md`](docs/03-环境与部署.md)。
> 三维外壳（3D Tiles）的接入方式、拾取代理与楼层裁剪，见 [`docs/04-三维外壳接入.md`](docs/04-三维外壳接入.md)。
> 后续是否上双引擎（UE/Unity 像素流）与云原生（容器化 / K8s / 微服务），见 [`docs/05-双引擎与云原生可行性.md`](docs/05-双引擎与云原生可行性.md)——含触发阈值、改造清单与成本量级。

---

## 界面能力

| 区域 | 能力 |
| --- | --- |
| 顶部 | 三维 / 平面视图切换、视图精度（LOD）切换、实时连接状态 |
| 左侧 | 七类图层开关（面/线/点分类标识）；轻量化实测面板（降幅、分层条形、LOD 对比） |
| 场景 | 楼栋悬停高亮 + 名称浮标、点击飞入、设备点位状态着色、实时值联动 |
| 建筑表现 | 「模型 / 体块」双模式：3D Tiles 外壳（带加载进度、楼层裁剪）或矢量拉伸体块，一键切换 |
| 右侧 | 未选中时：用能曲线、设备状态分布、告警中心（可确认）、能耗 Top5 |
| | 选中楼栋：楼层剖切滑杆、分层面积/房间/人数、设备清单、告警 |
| | 选中设备：三维高模（Three.js 局部增强）、实时指标与量程、位置信息、反控按钮（重启 / 负荷下调） |
| 底部 | 六项 KPI（设备、用能、碳排、告警、在园人数、占地），可一键收起给场景让位；状态栏显示经纬度、数据源、WS 连接 |
| 场景 | 标签按设备像素比渲染 + 低 DPI 屏 1.25× 超采样，避免文字锯齿；平面视图切换后自动按园区范围重新定位 |
| 过渡 | 视图切换、图层重载、详情拉取均有加载态：地图级遮罩（顶栏保持可操作）+ 右侧面板局部遮罩 |
| 适配 | 1366 笔记本 / 1920 与 4K 大屏 / 触屏一体机：分档字号与面板宽度、触屏加大点击区并隐藏 hover 浮标、所有滚动区统一细滚动条 |

深链：`/?building=B01` 落到指定楼栋，`/?mode=2d` 进平面视图，`/?lod=0` 指定视图精度，`/?shell=vector` 回到矢量体块，`/?floor=4` 直接剖切到第 4 层，可组合（例如 `/?building=B01&floor=4`）。

### 多端适配策略

| 场景 | 处理方式 |
| --- | --- |
| 小屏 PC（≤1440 / 高度 ≤800） | KPI 单行压缩、隐藏次要文案、面板收窄、左右面板下边距让位 |
| 大屏（≥1920 / ≥2560） | 面板加宽、KPI 与标签字号上调，避免远距离看不清 |
| 触屏一体机（`any-pointer: coarse`） | 开关/按钮/滑杆放大到 ≥32px 触控区、隐藏 hover 浮标、列表 `touch-action: pan-y` |
| 任意设备 | 滚动条统一为 6px 细样式（含右侧分层面积/设备/告警列表），`overscroll-behavior: contain` 防止滚动穿透 |

---

## 目录结构

```
park-digital-twin/
├── data/                     # 原始要素（唯一真源）
│   └── tileset/              # 三维外壳 3D Tiles（演示替身，可整体替换为倾斜摄影成果）
├── tools/
│   ├── gen_demo_data.py      # 可复现的演示数据生成器
│   └── gen_demo_tileset.py   # 演示用外壳瓦片生成器（3D Tiles 1.1 + glb）
├── backend/
│   ├── app/
│   │   ├── api/              # park / assets / ops / realtime 路由
│   │   ├── domain/catalog.py # 图层与 LOD 属性白名单（唯一事实来源）
│   │   ├── repository/       # memory / postgis 双实现
│   │   └── services/         # lightweight / telemetry / alarms / cache
│   ├── sql/001_schema.sql
│   ├── scripts/load_postgis.py
│   └── tests/
├── frontend/
│   ├── eslint.config.js      # ESLint 9 flat config（含 react-hooks 规则）
│   └── src/
│       ├── cesium/scene.ts   # 引擎封装：图层装载、拾取、剖切、视角
│       ├── three/            # 设备级高模：相机同步层 + 程序化几何
│       ├── components/       # 面板与驾驶舱 UI
│       ├── hooks/            # 场景引导 / 图层装载 / 实时数据 / 外壳加载
│       └── api/              # HTTP + WebSocket 客户端
├── docs/
│   ├── 01-架构决策.md         # ADR：引擎选型 / 轻量化 / 后端演进
│   ├── 02-数据与接口.md       # 数据模型、接口、实时协议
│   ├── 03-环境与部署.md       # 环境变量、启动形态、测试验收、部署与排障
│   ├── 04-三维外壳接入.md     # P1：3D Tiles 接入、拾取代理、楼层裁剪、替换步骤
│   └── 05-双引擎与云原生可行性.md # 双引擎三形态对比、云原生改造清单、触发阈值与成本
├── Dockerfile                # 多阶段：Node 构建前端 → Python 运行时
├── docker/entrypoint.sh      # 等库 → 导入 → 起服务（一条退出码，便于排障）
└── docker-compose.yml        # api + postgis + 可选 geoserver(ogc profile)
```

## 技术栈

| 层 | 选型 | 版本 |
| --- | --- | --- |
| 三维引擎 | CesiumJS | 1.147 |
| 设备高模 | Three.js（叠加画布，按需挂载） | 0.187 |
| 前端 | React 18 + TypeScript + Vite 6 | — |
| 服务 | FastAPI + Uvicorn | ≥0.115 |
| 空间数据库 | PostgreSQL 16 + PostGIS 3.4（可选） | docker 镜像 |
| 可视化服务 | GeoServer 2.25（可选，`ogc` profile） | — |
| 实时通道 | WebSocket（原生） | — |

前端默认**不加载任何在线底图、不依赖 Cesium ion token**，离线也能出图。

## 边界与后续

- 演示数据为**虚构园区**，坐标位于杭州城西，仅用于展示。
- 遥测是模拟器（状态机 + 抖动），生产替换为 MQTT 接入；对外接口已按生产形态设计。
- 楼栋目前是拉伸体块。要真实外立面时，走倾斜摄影 → 3D Tiles，引擎不用换。
- 要素量级到 5 万以上、或需要按视锥流式加载时，再引入矢量瓦片 / 3D Tiles。
