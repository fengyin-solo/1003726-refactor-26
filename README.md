# 水文监测站网管理系统

面向水文监测站点运行、水位流量雨量数据采集、遥测设备维护与数据整编发布的水文站网管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 监测站点 | `station` | 水文监测站 | 站点编号、站点名称、站点类型 |
| 水位监测 | `waterlevel` | 水位记录 | 记录编号、站点编号、观测时间 |
| 流量监测 | `discharge` | 流量记录 | 记录编号、站点编号、测量方法 |
| 雨量观测 | `rainfall` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 水质检测 | `waterquality` | 水质检测报告 | 报告编号、采样站点、采样时间 |
| 断面测量 | `crosssection` | 断面测量记录 | 记录编号、站点编号、断面名称 |
| 遥测设备 | `telemetry` | 遥测设备 | 设备编号、设备类型、所属站点 |
| 数据整编 | `compilation` | 整编成果 | 成果编号、整编年份、站点编号 |
| 预警阈值 | `warning` | 预警阈值配置 | 配置编号、站点编号、监测类型 |
| 地下水观测 | `groundwater` | 地下水观测记录 | 记录编号、井点编号、观测日期 |
| 蒸发观测 | `evaporation` | 蒸发观测记录 | 记录编号、站点编号、观测日期 |
| 测流缆道 | `cableway` | 测流缆道 | 缆道编号、所属站点、跨度米数 |
| 泥沙监测 | `sediment` | 泥沙监测记录 | 记录编号、站点编号、采样时间 |
| 通讯系统 | `communication` | 通讯设备 | 设备编号、设备类型、所属站点 |
| 站房维护 | `stationhouse` | 站房维护记录 | 记录编号、站点编号、维护类型 |
| 仪器检定 | `calibration` | 仪器检定记录 | 记录编号、仪器编号、仪器名称 |
| 巡检记录 | `inspection` | 巡检记录 | 记录编号、站点编号、巡检日期 |
| 测报方案 | `plan` | 测报方案 | 方案编号、方案名称、适用范围 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `hydrology-monitor-station:entries` 这一项，或调用 `resetModule(模块)`。

### 断面测量：状态单一来源（事件溯源）

断面测量记录的「提交校核 / 确认校核 / 安排重测」三个入口历史上各自直接改 `status`
字段，多处覆盖会得出不一致结论。现把状态写收拢到事件台账，任何入口都不再改字段：

- `src/data/crosssection/workflow.ts`：唯一状态机与归并规则。入口只追加不可变事件
  （`submitEvent`），当前状态由事件流按顺序在状态机上归并（fold）投影得到，
  结论只有一个；越级、重复操作一律拒绝且不落事件。
  - 流转边：`已测量→待校核→已校核`，`待校核→需重测→待校核`。
  - 历史重测归并：「需重测」是持续态，直到下一次「提交校核」才回到「待校核」，
    期间重复安排重测不改变结论；无事件历史的既有记录用其既有落库状态钉一条基线，
    归并从基线开始，兼容历史结论。
- `src/data/crosssection/event-store.ts`：事件台账的 localStorage 持久化（只追加），
  键为 `hydrology-monitor-station:crosssection-workflow`。
- 行存储（`local-store.ts`）只保存断面名称、起点距、河底高程等业务字段，
  `status/pending/abnormal` 一律在读取时由事件流投影，写入时剥离。
- 幂等与并发：一次提交带一个 `requestId` 凭据，同一凭据并发/重放只产生一次处理结果；
  同一条记录的提交按记录串行排队，不同记录互不阻塞。
- 页面核对清单由当前投影状态下的合法动作生成（`allowedActionsFor`），动作完成后
  先归并事件、再读列表，直接展示落库结果。
- 想清空事件台账：`resetModule('crosssection')` 或清掉
  `hydrology-monitor-station:crosssection-workflow`。
