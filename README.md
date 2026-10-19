# dsh-gui-bridge

Debug bridge into the DSH browser half: run expressions in the GUI page from a command line or a model tool.

在 DeepSeek Harness 的 GUI 页面里执行表达式的调试桥接。桌面端没有远程调试口，这个插件补上一条窄通道：本机命令行提交表达式，页面里的浏览器半边取走、求值、把结果送回来。

## 命名

发布名（npm 包名、仓库名）是 **`dsh-gui-bridge`**：`dsh-desktop-bridge` 在 npm 与 GitHub 上都已被别人的插件占用。改名只动发布名，运行时标识保持原样：

- 插件 id、路由前缀、日志前缀仍是 `dsh-desktop-bridge`；
- 数据目录仍是 `$DSH_HOME/dsh-desktop-bridge/`（端点、启动脚本、录制、结果）；
- `cordis.patch.yml` 里的 `name` 是「从 profile 目录解析的模块说明符」，它必须等于包名，因此已改成 `dsh-gui-bridge`；
- 命令行同时提供 `dsh-gui-bridge` 与 `dsh-desktop-bridge` 两个名字，指向同一个入口；下文示例沿用后者。

## 构建

源码在 `src/`，产物在 `lib/`，**`lib/` 是构建产物、不入库**（与同目录的 `dsh-perf-lens`、`dsh-widget-board` 一致）。改完源码必须构建一次，宿主半边才会加载到新代码：

```sh
npm install
npm run build      # tsdown：src/ -> lib/
npm run dev        # tsdown --watch
npm run typecheck  # tsc --noEmit
npm test           # 自带端到端测试（真实无头浏览器）
npm run verify     # typecheck + build + test
```

两个入口：

| 源码 | 产物 | 形态 |
| --- | --- | --- |
| `src/host/index.ts` | `lib/index.js` + `lib/index.d.ts` | ESM，宿主进程按 `exports["."]` 导入并调用 `apply(ctx)` |
| `src/client/index.ts` | `lib/client.js` | CJS，包在页面模块加载器的工厂包装里 |

浏览器半边的 `window.__ModuleLoader__.load({ id, factory })` 包装、`module`/`exports` 骨架与 `Symbol.toStringTag` **由构建生成**（`tsdown.config.ts` 的 `banner`/`intro`/`footer`），源码只是一个普通模块，导出 `apply`。它上报的 `CLIENT_VERSION` 由构建从 `package.json` 注入，不再手抄。

两半之间的线协议类型在 `src/shared/protocol.ts`：命令、录制与检查参数、回答信封都从这里来，改名会同时落在两侧。`bin/bridge.cjs`（命令行）与 `probes/*.js`（页面探针）保持纯 JS，不参与构建。

`npm pack` / `npm publish` 前由 `prepack` 自动构建，因此发布包始终带 `lib/`。

## 安装

在目标 profile（桌面端是 `~/.dsh/profiles/desktop`）的 `package.json` 里加依赖与 bundle：

```json
{
  "dependencies": {
    "dsh-gui-bridge": "link:D:/DSH/dsh-gui-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-gui-bridge"]
    }
  }
}
```

`link:` 指向源码目录，所以先在本仓库里 `npm install && npm run build`（`lib/` 不入库，没有产物插件会以「failed to import」停用）。然后在 profile 目录里执行 `pnpm install`，重启应用。

两处都要改：插件管理器安装本地路径时只写依赖，`dsh.profile.bundles` 仍要自己加上；只加依赖的话，页面里的客户端半边会被加载并轮询一个不存在的路由，控制台会报 404。

## 用法

```sh
# 页面里有多少个会话行
dsh-desktop-bridge "document.querySelectorAll('[class*=\"sessionRow\"]').length"

# 某个元素的矩形与最终样式
dsh-desktop-bridge "JSON.stringify(document.querySelector('.dsh-claude-effort-btn')?.getBoundingClientRect())"

# 录制 5 秒里页面做了什么：DOM 变化、网络帧、console 输出
dsh-desktop-bridge --record 5000
dsh-desktop-bridge --record 5000 --channels dom,console --selector '#composer'

# 读一段还在进行的录制，或结束它
dsh-desktop-bridge --record-read
dsh-desktop-bridge --record-stop
dsh-desktop-bridge --record-export

# 浏览器半边是否在轮询
dsh-desktop-bridge --state

# 从标准输入读一段较长的表达式
dsh-desktop-bridge --stdin < snippet.js

# 重载页面，等新页面重新轮询
dsh-desktop-bridge --reload

# 让一段脚本在下一次页面启动时、所有插件加载之前执行
dsh-desktop-bridge --boot probes/frame-attribution.js
```

选项：`--port`、`--host`（默认 127.0.0.1）、`--timeout`（默认 15000 毫秒）、`--stdin`、`--raw`、`--json`、`--quiet`、`--state`、`--record <毫秒>`、`--record-read`、`--record-stop`、`--record-export`、`--channels <列表>`、`--selector <选择器>`、`--reload`、`--boot <文件>`、`--no-reload`、`--boot-ttl <毫秒>`。

不带 `--port` 时，命令行读取 `$DSH_HOME/dsh-desktop-bridge/endpoints/` 下仍在运行的宿主半边记下的端口，取最新的一个；一个都没有时用 19387。桌面端每次启动都换一个端口，这样不必每次去查。

## 启动脚本

有些调试必须在页面启动之前开始：插件在加载时注册的帧回调、定时器、观察器和事件监听，事后包装已经抓不到。宿主半边在启动页的注入表里放了一段固定的加载器，它在宿主入口模块之后、所有插件包之前执行。`--boot <文件>` 把脚本存进页面的本地存储，重载页面，等新页面回来后报告脚本是否执行成功。

- 桌面端重载页面会把整个应用重新拉起：先在退出中的应用里启动一个页面，再在重新拉起的应用里启动一个。所以加载器读到脚本时不删除，有效期内的每次启动都会执行；命令行等到留下来的那个页面报告后再清除。
- 脚本带有效期（默认 120 秒，`--boot-ttl` 调整），过期后不再执行，由加载器删除。
- `--no-reload` 只存不重载，留给手动重启应用的场合；有效期内每次启动都会执行它。
- 桌面端只在宿主启动时收集一次注入表，所以装上这个版本之后要先重启一次应用，加载器才会出现在页面里。

## 帧耗时归属探针

`probes/` 下附带一对探针，用来回答「页面卡在谁身上」：

```sh
dsh-desktop-bridge --boot probes/frame-attribution.js   # 启动时装上
# ……在窗口里正常操作一段时间……
dsh-desktop-bridge --stdin < probes/frame-report.js      # 读报告
dsh-desktop-bridge "__bridgeFrames.mark()"               # 开始新的一段
```

探针给帧回调、定时器、三种观察器回调和事件监听计时，并按注册它们的代码归属到插件模块：合并包里的每个模块都以自己的 `__ModuleLoader__.load` 调用开头，探针记下这次调用所在的行作为模块的起始行，注册位置落在哪个模块的范围里就记在哪个模块名下。报告还给出帧间隔的分位数，以及长帧（Long Animation Frame）拆成的三段：渲染前的任务、帧回调、样式与布局。宿主自己的 React 调度和流式连接在入口模块里创建，不经过这些包装；长帧时间远高于包装到的时间时，差额主要就在这里。

返回的值按 JSON 打印；表达式抛错时错误打到标准错误，退出码为 1。

## 录制

一次表达式只给出一个瞬间的答案。`--record <毫秒>` 录下这段时间里页面做了什么，再按序号读回来：

```sh
dsh-desktop-bridge --record 5000 --channels dom,network,console --selector '#composer'
```

三个通道：`dom` 记录被观察元素及其子树里的属性变化与子节点增删（含属性旧值），`network` 记录 `fetch` 的起止与状态、`XMLHttpRequest` 的起止、WebSocket 发出的帧，`console` 记录五个常用等级的调用。每条记录带 `seq`、通道 `ch` 与相对录制开始的毫秒数 `t`，因此一次录制就是一条可以直接排序的时间线；配合开始时刻 `startedAt` 就能换算成墙钟时间。属性原本不存在时记 `null`，与「存在但为空」区分开；一次 `fetch` 的结束条目用 `pair` 指回它开始条目的 `seq`。

- 一次只跑一份录制，它属于启动它的那一方：模型工具只能读、停和导出自己启动的录制，命令行不受此限。
- 录制期间页面照常接受别的调用，所以顺序是「先开录，再触发动作（用一次表达式，或让使用者自己点），最后读」。
- 页面保留最近 5000 条，超出的从最旧开始丢弃；读取结果里的 `dropped` 与 `lost` 说明丢了什么，所以时间线上不会出现看不出所以然的空白。模型读到的文本末尾另有一行说明读到了第几号、是否还有更多（以及用哪个 `afterSeq` 续读）、丢弃了多少条。
- 读取返回的是此刻已经攒下的条目，不必等录制结束；录制到 `--record` 给的毫秒数就自己停下（上限 120 秒），停下之后条目仍在页面里，`--record-read` 与 `--record-stop` 还能读到最后一段。
- WebSocket 的**收到**帧只有页面自己读到时才看得见：监听器若在录制开始前就注册好了，事后包装不到。因此这一路记录的是 `MessageEvent` 的 `data` 属性被读取的那一刻，未读到的帧不出现；帧预览截到 200 字符。
- 启动脚本（`--boot`）仍是录制插件加载之前的活动的唯一办法。

## 模型工具

装上插件后，模型会多出五个工具，它们与命令行共用同一条队列：

- **`desktop_status`**：只读诊断。报浏览器半边是否在轮询、最后一次轮询距今多久、队列与在途数量、最近一次回答来自哪个页面、宿主与客户端半边的版本、当前录制与各项上限。超时或失败之后先看它，再决定要不要重试。
- **`desktop_inspect`**：结构化只读探针。一次提交多个 CSS 选择器，可选等待首个选择器出现，按 `count` / `rect` / `text` / `attrs` / `styles` / `html` 返回有界的匹配结果。选择器没命中是数据（`matched: 0`），非法选择器只影响那一条；`coverage` 说明是否因 `budget` 被裁剪、等待了多久、页面是否隐藏。它不执行任意代码，读 DOM 之外不动页面。
- **`desktop_eval`**：提交一段 JavaScript 表达式，拿回页面里的值。除了值本身，每次回答还带一段 `page:` 行（地址、标题、可见性、是否聚焦、页面已运行多久）、表达式产生的 console 输出（上限 200 条）、以及抛出错误的调用记录。需要计算或修改页面时用它；纯读取优先用 `desktop_inspect`。
- **`desktop_wait`**：等一条已经超时的命令的迟到结果。传之前回答里的命令编号；等待不会重发、也不会取消原命令，`NotReady` 表示页面仍在跑。超时后**先等，再考虑重试**，因为表达式可能已经点击、缩放或改过页面。
- **`desktop_record`**：`start`、`read`、`stop`、`export` 四个动作。`start` 接受 `channels`、`selector`（最多等 500ms；没等到就退化为整份文档并把 `selectorMatched` 报成 `false`）、`maxMs`；`read` 按 `afterSeq` 续读并给出 `coverage`；`export` 把整段录制写成 `$DSH_HOME/dsh-desktop-bridge/recordings/<runId>.json`（保留最近 20 份）。一次录制属于启动它的那个会话，并带一个稳定的 `runId`。

工具回答遵守一条硬约定：**没有值的字段直接省略，不写 `null`**。成功回答有 `value` 与 `ms`；表达式抛错有 `error`；宿主超时有 `timedOut`；没有页面有 `unavailable`；等待未果有 `waiting`。这样每种结局都能通过 harness 的真实输出 schema 校验，失败原因不会被“invalid output”盖掉。

### 上次调用以来的页面变化（`since`）

每个会下发页面命令的工具（`desktop_eval`、`desktop_inspect`、`desktop_record`）回答里都可能带一个 `since` 块，说明**同一来源**上一次调用之后页面动了什么：

- 同一个模型会话是一个来源；HTTP `/exec` / `/record` 可以在请求体里传 `source` 自命名，不传就是 `operator`。
- 同一来源距上次调用不超过 60 秒时，页面比较两次调用的轻量指纹：`document.title`、`location.href`、可见性、聚焦、`body` 上的 `data-*` 属性和元素总数。变化以 `since` 附在回答里；没有变化就写“no page change”。
- 第一次调用或超过 60 秒没有调用，只给 `baseline`，不假装知道这期间发生了什么。
- 它不常驻观察者、不唤醒空闲模型，也不记录“用户点了哪个控件”；它只是让模型在“点击后下一次确认”时不用猜页面到底动没动。要逐条 DOM/console/网络变化仍然用 `desktop_record`。

```
since your previous call (12.3s ago): title "设置页" → "看板"; data-dsh-claude-page-zoom null → "1.5"; nodes 13046 → 13102
```

值太大时（渲染上限 20000 字符）完整内容写到 `$DSH_HOME/dsh-desktop-bridge/results/<命令编号>.json`，回答里给出 `spill`（编号、路径、总长、下一个偏移；读完时省略 `nextOffset`），模型用 `desktop_eval({ spill, offset })` 接着读；该目录只保留最近 20 份。

工具库 `@deepseek-ai/dsh-tools` 由 harness 提供。插件以符号链接（`link:`）安装时，harness 的包名解析不到这个库，需要在插件目录下建一个指向 harness 同名包的目录联接：

```sh
New-Item -ItemType Junction -Path D:\DSH\dsh-gui-bridge\node_modules\@deepseek-ai\dsh-tools `
  -Target <harness>\node_modules\@deepseek-ai\dsh-tools
```

注意：本仓库的 `npm install` 会把这个目录联接当作多余的包删掉（peer 依赖由 harness 在运行时提供，npm 不认）。装完依赖后确认它还在，不在就重建一次。

安装成真实目录（把插件复制进 profile 的 `node_modules`）时，harness 会解析自己的副本，不需要这一步。

## 安全

桥接路由只接受来自回环接口的请求，并检查浏览器发出的跨站标记与 `Origin`；表达式与结果只在内存里过一遍。落盘的只有端点文件（端口与进程号）、启动脚本（存在页面的本地存储里，带有效期，命令行确认执行后清除），以及过大的回答：完整内容写进 `$DSH_HOME/dsh-desktop-bridge/results/`，该目录只保留最近 20 份。装上这个插件就等于打开这条通道，因此不要把它放进日常使用的 profile 里长期启用。

## 限制

- 一次一个往返：命令行的延迟是本机一次长轮询往返。
- 模型工具与命令行排队执行，同一条队列不会同时服务两个请求。
- 表达式在页面全局作用域里求值，插件闭包内部的变量读不到。
- 返回值要能转成 JSON；DOM 节点会转成标签、标识、类名、文本与矩形，深度超过 6 层、条目超过 200 个时截断并标注，序列化超过 40 万字符时改送截断文本并标注总长。
- 返回 promise 的表达式最多等到调用期限之前 1.5 秒：期限 15000 毫秒时页面等 13500 毫秒。页面先放弃，所以「promise 一直不落定」会以页面错误报出，而不是桥接超时。
- 没有浏览器半边在轮询时立刻失败（503），报出最后一次轮询距今多久；页面收下了表达式却没有回答才是 504。
- 超时不是取消：命令若还没交给页面，超时时会从队列里移除；已经交给页面的同步表达式无法中断，页面完成后的迟到结果由 `desktop_wait` 取回。页面在超时后不会再执行排在它后面的过期命令。
- `since` 只在同一来源 60 秒内的相邻调用之间成立；换会话、换 `source` 或隔得太久，都会退回 `baseline`。它比较的是页面级指纹，不是逐节点 diff。
- 页面主线程被同步表达式卡住时，后续调用会排队或超时；`desktop_status` 能看到这一状态。后台窗口的定时器可能被节流，依赖 `setTimeout` 的探针要给足期限。
- 录制看不见监听器早于录制注册的 WebSocket 收到帧，也看不见启动时就已经装好的回调。
- 客户端半边的轮询失败按 1.5s 起的指数退避重试，最长 30s；`desktop_status` 里的 `versions.client` 是实际在轮询的客户端版本，插件更新后若页面没重载，这里能看出不一致。

## 设计文档

通道对比、协议、安全模型与验证步骤见 [DESIGN.md](DESIGN.md)。
