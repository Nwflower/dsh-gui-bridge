# dsh-desktop-bridge 设计文档

## 要解决的问题

桌面端是一个 Electron 应用：主进程管窗口与更新，宿主进程（`dsh-desktop-host`）在回环地址上提供 GUI，窗口本身是渲染进程。插件写的是浏览器半边与宿主半边，但调试时想看一眼页面里的真实结构——某个控件的矩形、某条样式最终算出来的值、某个选择器命中了几个节点——手上没有任何通道：窗口只有 F12 打开的内置 DevTools，机器上的其它程序进不去渲染进程。

这个插件给出一条窄通道：本机的调用方提交一段表达式，页面里的浏览器半边取走、就地求值、把结果送回来。

## 已核实的环境事实

- 主进程的启动参数里没有 `--remote-debugging-port`；在 `app.asar` 里检索 `appendSwitch` 没有命中，说明应用自己不追加 Chromium 开关。
- 单实例锁：`claimDesktopSingleInstance` 调用 `requestSingleInstanceLock()`，第二次启动会立刻退出并聚焦已有窗口。带调试参数再启动一次不会给正在运行的实例开出口。
- F12 由主进程的 `before-input-event` 处理，调用 `contents.openDevTools({ mode: 'detach' })`。
- 应用认 `DSH_DESKTOP_HOST_INSPECT_PORT`，但 `developmentHostInspectPort(enabled)` 只在开发模式下把它传给宿主进程；安装版用不到。
- harness 的 `packages/host/webserver/src/index.ts` 里，`register({ kind, path, handler })` 的注释写明处理器拥有完整响应生命周期、可以挂住响应（SSE 就是这么做的），另有 `registerUpgrade({ path, handler(req, socket, head) })` 可注册 HTTP 升级路由。
- 插件路由的既有栅栏是 `connection.requestRejection(req)`，做回环与同源校验。实测命令行直接请求 `http://127.0.0.1:19387/dsh-claude-style/model-descriptions.json` 返回 200，说明命令行不需要会话 cookie 就能到达插件路由。
- 客户端半边用相对路径取数（`fetch('/dsh-claude-style/prefs', { credentials: 'same-origin' })`），说明渲染进程页面来源就是宿主 HTTP 来源。

## 备选通道

**Electron CDP**：带 `--remote-debugging-port=9222` 启动应用，之后用标准 Chrome DevTools 协议驱动渲染进程。能力最全，应用侧零代码；代价是必须先完全退出应用再带参数启动，从开始菜单启动就丢了这个口。

**桥接插件**：宿主半边注册路由，客户端半边长轮询取指令并在页面里求值。安装版随时可用，不改启动方式，不引入依赖。

**开发模式 inspector**：`DSH_DESKTOP_DEV_APP` 加 `DSH_DESKTOP_HOST_INSPECT_PORT` 只给宿主进程开 Node inspector，调试的是宿主半边与 harness 服务，渲染进程仍要靠 F12 或 CDP；安装版不适用。

本插件采用第二条。第一条作为需要完整 DevTools 能力（网络面板、性能面板、截图）时的补充手段。

## 架构

宿主半边有两个出口，共用同一台状态机：五个 HTTP 路由供命令行或脚本调用，两个模型工具供 agent 直接调用。

### HTTP 路由

宿主半边注册五个精确路径的路由，全部挂在 `/dsh-desktop-bridge` 之下：

- `POST /exec`：调用方提交表达式。宿主把响应挂住，等浏览器半边把结果送回来，或者等调用方给的期限到点。
- `POST /record`：调用方提交一次录制动作（`start`、`read`、`stop`、`export`）。前三个走同一条队列，因此与表达式不会互相插队；`export` 由宿主把整段录制读出来后写文件。
- `GET /next`：浏览器半边的长轮询。队列里有命令就立刻返回，没有就挂住，默认挂 25 秒，到点回 204。
- `POST /result`：浏览器半边送回求值结果，宿主用结果结束对应的 `exec` 响应。
- `GET /state`：诊断。报浏览器半边最后一次轮询距今多久、是否已超出可用窗口、挂着的轮询数、队列长度、在途命令数、累计服务数，以及当前录制与它的归属。

宿主半边维护三样状态：等待投递的命令队列、按命令编号索引的在途调用方、挂着的长轮询。命令到达时先看有没有挂着的轮询，有就直接交给它，没有才进队列。调用方提前断开时，对应命令从在途表与队列里清掉。

没有浏览器半边在轮询时，命令不进队列：宿主立刻以 503 结束它，并在错误里报出最后一次轮询距今多久、队列与在途数。这一条是刻意与「页面收下了却没有回答」分开的：后者才是 504，前者是「通道这一头没人」。

### 模型工具

五个工具共用同一台状态机，因此与命令行不会互相抢答：

- `desktop_eval`：提交 `code` 与可选 `timeoutMs`，拿回同一份响应对象。`code` 不是必填项：`spill` 加 `offset` 用来接着读一份过大的回答。
- `desktop_inspect`：结构化只读探针，批量选择器 + 字段投影 + 可选等待；走 `kind: 'inspect'` 命令，不执行调用方代码。它声明为并发安全，因为只会读 DOM。
- `desktop_status`：`/state` 的模型工具面，只读，不下发命令。
- `desktop_wait`：按命令编号等一条超时命令的迟到结果；不重发、不取消。
- `desktop_record`：`start`、`read`、`stop`、`export`，参数与 `/record` 的请求体一致，其中 `export` 由宿主把整段录制读出来写成文件。

工具的输出模式声明了固定字段，`value`、`error`、`page`、`console` 用 author-only 的 `json` 节点覆盖任意 JSON；状态工具用一个顶层对象 schema。没有值的字段直接省略，不写 `null`（见 v0.2 一节）。工具参数都做了双重检查：`defineTool` 校验声明过的字段，插件自己再拒绝未声明的键并列出可接受的键名——`defineTool` 对未声明的键是静默放行的，一个拼错的键会看起来像漏填。

模型看到的全部提示是工具描述与参数说明，`desktop_eval` 的描述有长度上限检查（1200 字符）。工具名必须是字母、数字、下划线或连字符组成的字符串：模型接口按 `^[a-zA-Z0-9_-]+$` 校验工具名，带点的名字会让整条请求被拒绝。

只有 `desktop_inspect` 声明并发安全：表达式是不透明的，读页面与改页面在插件看来一样，而队列本来就把它们排成一条；宣称可并发会让调度器同时下发，页面上却是同一份状态。录制的 `read` 与 `stop` 也走这条队列，因此它们不会与一次求值交错。

### 过大回答的溢出文件

页面侧把序列化结果截到 40 万字符；宿主侧渲染给模型的上限是 20000 字符。超过渲染上限的回答，完整 JSON 写进 `$DSH_HOME/dsh-desktop-bridge/results/<命令编号>.json`，该目录只保留最近 20 份，回答里带 `spill`：编号、路径、总长、已展示长度与下一个偏移。模型用 `desktop_eval({ spill, offset })` 接着读，读到的片段按原文渲染，不再经过 JSON 转义。

写入发生在 `execute` 里（工具面），因此 `/exec` 的响应体仍是完整的值；命令行拿到的是整份内容，不需要溢出文件。

### 录制的归属

录制本体在页面里（见下），宿主只记「谁在录、还在不在录」。模型工具按会话归属：`read` 与 `stop` 只接受启动它的那个会话，别的会话得到一条说明归属的拒绝；命令行没有会话，视为操作者本人，不受这条限制。归属检查在宿主侧完成，页面不需要知道调用方是谁。

工具库 `@deepseek-ai/dsh-tools` 由 harness 提供。实测：插件以符号链接（`link:`）安装时，harness 的包名解析不到它，插件会以「failed to import」停用；安装成真实目录时 harness 解析自己的副本。插件目录下建一个指向 harness 同名包的目录联接可以让符号链接安装也能工作。

浏览器半边在页面里跑一个不重叠的循环：一次轮询结束才排下一次；拿到表达式就地求值，把值转成纯 JSON 后提交。传输失败退避 1.5 秒重试。

### 端点文件

桌面端每次启动都让宿主绑定一个新端口。宿主半边在监听端口已知之后（收集启动页注入表时，或第一次收到轮询时）把 `{ port, pid, at }` 写进 `$DSH_HOME/dsh-desktop-bridge/endpoints/<pid>.json`，插件卸载时删除。命令行不带 `--port` 时取进程仍然存活、`at` 最新的一份，顺手删掉死进程留下的文件；一份都没有时用 19387。

### 启动脚本

事后求值的表达式看不到页面启动时发生的事：插件在加载时注册的帧回调、定时器、观察器与监听都已经在包装之外。宿主的 webServer 允许插件经 `webserver/index-inject` 向启动页的注入表加行；宿主半边加一条 `head` 位置的 `script` 行，内容是一段固定的加载器。

- 已核实：桌面端的主进程从本地资源读 `index.html`，注入表由宿主进程在就绪时经 `collectIndexInjections()` 收集一次，随就绪消息交给主进程，再经 IPC 的 `boot` 调用交给页面里的解释器；解释器把 `script` 行作为内联脚本插入 `<head>`。所以加载器在宿主入口模块之后、各插件合并包（异步插入的 `script-src`）之前执行。`dsh web` 每次渲染启动页都重新收集。
- 加载器读本地存储里的 `dsh-desktop-bridge:boot`（`{ code, until }`），未过期就在全局作用域求值，把 `{ ranAt, chars, error }` 写到 `globalThis.__DSH_BRIDGE_BOOT__`；过期的由加载器删除。用本地存储而不是会话存储，读到时也不删除：实测桌面端重载页面会把整个应用重新拉起，先在退出中的应用里启动一个页面，再在新应用里启动一个；会话存储活不过进程，读到即删的脚本又只会落在第一个页面里。
- `--boot <文件>` 存入脚本后重载页面，然后每秒查询一次，直到一个启动时间晚于这次请求的页面应答，再清除存储里的脚本；每次查询都重新读端点文件，因为应用换了端口。新页面没有 `__DSH_BRIDGE_BOOT__` 时报告「这一代宿主没有加载器」，提示重启一次应用。
- 宿主的 React 调度通道与流式连接在入口模块里创建，加载器无法先于它们执行；页面的文档策略又禁用了 JS 自采样分析器（`Profiler` 抛出 `NotAllowedError`），长帧条目在 `dsh-app://` 页面里也不带脚本归属。这三条决定了帧耗时归属只能靠包装加差额推断。

### 帧耗时归属探针

`probes/frame-attribution.js` 作为启动脚本装上后，给 `requestAnimationFrame`、`setTimeout`、`setInterval`、三种观察器的回调和 `addEventListener` 的监听计时，键是注册时调用栈上第一个带地址的帧。归属到插件靠模块加载器：探针截住 `__ModuleLoader__` 对象与它的 `load` 属性（两者都可能在探针之后才被赋值或替换），合并包里每个模块都以自己的 `load` 调用开头，探针记下每个模块第一次出现时这次调用所在的行；加载器从队列里转交的同一份注册来自加载器自己的代码，不覆盖第一次的记录。报告时一个注册位置归到同一合并包里起始行不晚于它的最后一个模块。模块第一次调用 `require` 的位置不能当起始行：压缩过的模块可能在代码深处才第一次调用它，实测把皮肤的帧循环记到了前一个模块名下。监听器按「监听函数 × 事件类型」只包一次，`removeEventListener` 查回同一个包装，移除照常生效。`probes/frame-report.js` 汇总帧间隔分位数、长帧三段（渲染前任务、帧回调、样式与布局）、按模块与按注册位置的耗时。

## 协议

命令对象由宿主发给浏览器半边：`{ id, timeoutMs, expiresAt, source, code, awaitMs }` 是一条表达式，`{ id, timeoutMs, expiresAt, source, kind: 'record', args }` 是一次录制动作，`{ id, timeoutMs, expiresAt, source, kind: 'inspect', args, awaitMs }` 是一次只读检查。`expiresAt` 让页面跳过已经过期的命令；`source` 是 `since` 指纹的来源键。`awaitMs` 是页面等 promise 的窗口，宿主按调用期限减去 1.5 秒算出（下限 500 毫秒），因此页面总比宿主先放弃，卡住的表达式报成页面错误而不是桥接超时。`args` 只含声明过的字段：`action`、`channels`、`selector`、`maxMs`、`limit`、`afterSeq`。

`POST /exec` 请求体 `{ "code": "表达式", "timeoutMs": 15000, "source": "可选来源名" }`，响应体 `{ "id": "…", "ok": true, "value": …, "ms": 3, "page": { "href", "title", "visibility", "focused", "uptime" }, "since": { … } }`（没有值的字段省略，不写 `null`）；求值抛错时状态码仍为 200、`ok` 为 `false`、`error` 为 `{ __type: 'error', name, message, stack }`，这样调用方能区分「脚本失败」与「桥接不可用」；页面收下命令却在期限内没有回答时返回 504，负载里带 `timedOut` 与 `agentSeenMsAgo`；没有浏览器半边在轮询时立刻返回 503，负载里带 `unavailable` 与同一条 `agentSeenMsAgo`。

`POST /record` 请求体 `{ "action": "start", "channels": ["dom"], "selector": "#x", "maxMs": 5000 }`，`read` 用 `afterSeq` 与 `limit` 续读，`stop` 结束。响应体与 `/exec` 同形，`value` 是录制的状态：`start` 回 `{ running, startedAt, channels, selector, maxMs, maxEntries }`，`read` 回 `{ running, entries, nextSeq, firstSeq, dropped, lost, complete, startedAt, stoppedAt }`，`stop` 回 `{ running, entryCount, firstSeq, nextSeq, dropped, startedAt, stoppedAt }`。`action` 不在三者之内回 400。

`GET /next?wait=25000` 有命令时返回该命令对象，没有时返回 204。

`POST /result` 请求体 `{ "id": "…", "ok": true, "value": …, "error": null, "ms": 3, "page": …, "console": … }`，成功回 `{ "ok": true }`；编号不认识回 404，重复回答回 409。

`GET /state` 返回 `{ "agent": { "lastPollMsAgo": 1200, "stale": false, "waiters": 1 }, "queue": 0, "pending": 0, "served": 4, "record": null }`；`lastPollMsAgo` 为 `null` 表示这一代宿主还没有见过浏览器半边，`stale` 为 `true` 表示最后一次轮询已经超出可用窗口，`record` 为 `null` 表示没有录制，否则给出它的归属、通道与开始时刻。

## 录制

页面侧维护一份录制：一个环形缓冲、一个单调递增的序号、一组在录制开始时装上的钩子。

- **dom**：`MutationObserver` 观察选择器命中的元素及其子树（默认整个文档），记录属性变化（含旧值与新值）与子节点增删。节点以「标签、id、首个类名」标识；属性原本不存在时记 `null`，与「存在但为空」区分开——一个丢掉 `data-on` 的开关与一个把它设成空串的开关是两件事。
- **network**：包装 `window.fetch`（起止、状态、耗时、错误）、`XMLHttpRequest.prototype.open/send`（同一组字段）、`WebSocket.prototype.send`（帧长度与文本前 200 字符）。收到的帧包装 `MessageEvent.prototype.data` 的读取：监听器在录制开始前就注册好的连接，事后包装不到它的回调，只有页面自己读到 `data` 的那一刻才看得见。恢复时写回原描述符。结束条目用 `pair` 指回它开始条目的 `seq`。
- **console**：五个常用等级各包一层，文本按值的描述规则生成（DOM 节点给出标签与矩形），单条上限 400 字符。

钩子的释放是逐条的，一条恢复失败不影响其余；同一时刻可以有别的 console 包装（求值期间的 console 捕获），两者按包装顺序各自还原。

条目形如 `{ seq, t, ch, … }`：`t` 是相对录制开始的毫秒数（0.1 毫秒精度），因此一次录制就是一条能直接排序的时间线，配合 `startedAt` 可以换算成墙钟时间。缓冲上限 5000 条，超出时从最旧开始丢弃并计数；读取结果里的 `dropped` 是总丢弃数，`lost` 是调用方的游标之前被丢掉的那一段，所以时间线上不会出现看不出所以然的空白。

渲染给模型时，读取结果后面另附一行覆盖说明：读到了第几号、是否还有更多（以及用哪个 `afterSeq` 续读）、丢弃了多少条。这些事实本来就在 `value` 的字段里，但读着一页条目的人不该为了决定「要不要再读一次」去解码它们。

录制到 `maxMs` 自己停下（上限 120 秒）。读取返回的是此刻已经攒下的条目，不必等录制结束；停下之后条目仍留在页面里，`read` 与 `stop` 都还能读到它们；下一次 `start` 会替换掉上一份缓冲，无论它属于谁。页面侧同一时刻只有一份录制，第二个 `start` 得到一条 `Busy` 拒绝。录制期间页面照常接受别的命令，因此「先开录、再用一次表达式触发动作、最后读」是可用的顺序，使用者自己点出来的活动同样会被记下。

## 求值与序列化

表达式在页面的全局作用域里求值。返回值若是 Promise，等 `awaitMs` 毫秒（宿主按调用期限减 1.5 秒算出），超时按失败上报，错误文本里写明等的是多长。求值期间包装 console 的五个等级，把表达式自己产生的输出随回答带回（上限 200 条）。

值转 JSON 时逐类处理：DOM 节点转成标签、标识、类名、文本与矩形；函数转成名字；Error 转成名字、消息与调用栈；Date 转 ISO 字符串；Map 与 Set 转成条目列表；循环引用标成 circular；深度超过 6 层、条目超过 200 个时截断并标注。序列化后的长度超过 40 万字符时，改送截断后的文本并标注总长度。

每次回答附一段页面信息（地址、标题、可见性、是否聚焦、页面已运行毫秒数）。后台窗口的动画帧会暂停，计时类的读数在隐藏页面上没有意义，调用方要能看出这一次读数处在什么环境里。

## 安全

- **回环**：栅栏先看套接字的远端地址（127.0.0.0/8、::1 及 IPv4 映射形式），再看 Host 头是否指向回环，再看浏览器发的 `Sec-Fetch-Site` 与 `Origin`。只看 Host 头不足以拦住远程调用方，所以套接字这一层是必须的。
- **不使用宿主的会话栅栏**：`connection.requestRejection()` 要求浏览器会话 cookie，而桥接的调用方是没有浏览器会话的命令行。在 web 宿主上实测该栅栏对命令行请求回 401（桌面宿主对插件路由曾放行），因此这里改用上面那套针对浏览器跨站信号的检查：本地进程不发送这些头，浏览器又无法为回环目标伪造它们。
- **加载即同意**：这个插件不默认装在任何 profile 里，装上它就是明确要求这条通道；没有第二个开关，因为读取条目配置本身需要额外的 inject 声明（实测 `ctx.config` 在未声明的上下文里会抛错，导致整条插件无法激活）。
- **落盘范围**：端点文件只有端口、进程号与时间；过大的回答把完整内容写进 `$DSH_HOME/dsh-desktop-bridge/results/`（只保留最近 20 份），因为模型读到的那一段是被截断的，而调用方通常就在同一台机器上。除此之外表达式与结果只在内存里过一遍，不写文件、不记日志。启动脚本存在页面的本地存储里。
- **启动脚本**：存在页面的本地存储里，能写这份存储的代码本来就能在页面里执行脚本，所以它没有扩大权限；它延长的是持续时间，因此带有效期、由命令行在确认执行后清除，加载器只在插件装着时存在。
- **大小上限**：请求体 256 KB，结果体 1 MB，超过即拒绝。

## 失败模式

- 没有浏览器半边：命令在期限到点前就以 503 结束，错误文本说明从未见过轮询还是最后一次轮询已过窗口，负载里带 `agentSeenMsAgo`、队列与在途数。
- 页面收下命令却没有回答（重载、卸载、主线程卡死）：期限到点返回 504。
- 返回的 promise 一直不落定：页面在自己的窗口到点时按失败上报，状态码 200，错误里写明窗口长度。
- 表达式抛错：按失败返回，调用方退出码为 1。
- 结果不可序列化：值被替换成 `{ __type: 'unserialisable' }`。
- 过大的回答：完整内容写进溢出文件，回答里给出续读的编号与偏移；文件被清理后按「不再保留」报错。
- 录制：同一时刻只有一份，第二个 `start` 得到 `Busy`；别的会话读或停得到一条归属说明；页面里没有录制时，`read` 与 `stop` 回一份空缓冲而不是错误。
- 宿主卸载（插件停用或宿主退出）：挂着的轮询全部结束，在途命令回 503。
- 端口不是默认值：命令行用 `--port` 指定。

## 验证

已完成两轮：

1. **自带端到端测试**（`node test/bridge.test.cjs`）：假宿主提供真实的 `webServer.register`、`tools.register`、`effect`、`inject` 契约，无头 Chrome 从同一个服务器加载页面与客户端半边。128 项检查通过，覆盖五个路由、方法与空表达式等错误路径、未知编号、没有浏览器半边时的 503 与它不等待期限、算术与 DOM 查询、节点描述与矩形、循环引用、抛错、Promise、每次回答带的页面信息块、求值期间的 console 捕获、错误里的调用记录、由期限换算出的等待窗口、页面收下却不回答时的 504、过大回答的溢出文件与续读、工具对未声明参数与两种调用形状的拒绝、录制的三个动作与三个通道（属性变化、console 输出、fetch 的起止两端）、按序号续读、会话归属的读与停、停止后仍可读、命令行 `--record` 与 `--record-stop`、启动页的注入行与端点文件、不带端口时的端点发现、`--reload`，启动脚本先于页面自身脚本执行、命令行确认后不再执行、有效期内每次启动都执行、过期不执行，以及帧探针经各模块的 `load` 调用认出模块、把定时器耗时记到设置它的模块名下、记录帧间隔、包装后的监听仍能移除。v0.2 另加：用 harness 自己的 `assertSupportedJsonSchema` / `validateJsonSchemaValue` 校验五个工具的输出 schema 与成功、抛错、超时、无页面、spill 续读、`NotReady`、inspect 预算、录制与导出信封；超时命令从队列移除后不再执行；`desktop_wait` 取回迟到结果；`desktop_inspect` 的批量选择器、缺失选择器与非法选择器；`desktop_status` 的版本与状态；录制的 `runId`、选择器退化与 `export`；`since` 的同 source 基线、跨 source 隔离、变化检测与无变化回答。
2. **真实 harness 实例**（隔离的 `DSH_HOME` 下运行 `dsh web`，profile 的 bundles 里列出本插件，无头 Chrome 打开它的 GUI）：宿主路由注册成功，命令行读到 state，`state.tool` 为 `true` 说明这一代表里的工具都注册进了真实工具注册表（其中一个被拒会让这一位保持 `false`）；页面打开后 `agent.lastPollMsAgo` 有值、`waiters` 为 1；命令行取到页面标题、页面来源与矩形，回答里带 `page` 块；求值期间 `console.warn` 出现在回答的 `console` 里；一次 `--record` 在真实页面上同时记下 DOM 属性变化（含旧值）、console 输出与 `fetch` 的起止两端，序号与相对时间连续；同一轮里 start、eval、read、stop 的墙钟耗时各在数十毫秒内，说明命令是即时投递的；关掉页面并等过可用窗口后，`exec` 在 160 毫秒内以 503 与 `Unavailable` 结束（改前是等满期限回 504），`state.agent.stale` 同时为 `true`。

   可用窗口那一条在自带测试里只覆盖了「从未见过轮询」的一半：另一半需要真的让页面消失并等过窗口，跑一遍要 35 秒以上，因此留在这一轮手工验证。

实测得到三条约束，都已写进上面的设计与安装说明：读取 `ctx.config` 需要 inject 声明，否则整条插件不激活；宿主的 `requestRejection()` 对无 cookie 的命令行请求回 401；`@deepseek-ai/dsh-tools` 在符号链接安装下解析不到，插件会以 `failed to import` 停用。另外输出模式里的对象节点必须显式写出 `additionalProperties`，漏写会让 `defineTool` 在注册时抛错。

桌面端实测：把插件装进桌面 profile 的依赖与 bundles 后重启应用，重复第 2 轮的命令行查询。只加依赖、不列进 bundles 时，客户端半边会被加载并轮询一个不存在的路由（实测到 404 刷屏），因此安装必须同时改这两处。

## v0.2：失败路径与生命周期（已落地）

第一轮使用日志暴露的两处结构性问题，已在 v0.2 修掉，并补上三个只读/等待工具。

### 输出契约：absent, not null

宿主与页面之间传的每个回答只带自己有的字段：成功有 `value` 与 `ms`，表达式抛错有 `error`，宿主超时有 `timedOut`，没有浏览器半边有 `unavailable`，等待未果有 `waiting`。没有值的字段**省略**，不写 `null`。原因是 harness 的输出 schema 只接受单类型，`ms: null` 会让整条工具结果在校验阶段被拒，调用方看到的是 `returned invalid output`，真正的拒绝原因反而看不见。`spill.nextOffset` 读到末尾时也省略。

测试直接引入 harness 自己的 `@deepseek-ai/dsh-tools`，用 `assertSupportedJsonSchema` 检查每个工具的输出 schema，用 `validateJsonSchemaValue` 检查成功、抛错、超时、无页面、spill 续读、等待、录制、导出与 inspect 的每一种信封。

### 超时不是取消

- `begin` 给命令带 `expiresAt`。宿主超时后，命令若还没交给页面，会从 `queue` 移除；页面拿到命令时会先比对 `expiresAt`，已过期就返回 `Expired`，不执行。
- 已经交给页面的同步表达式无法中断。页面完成后的迟到结果不再丢弃：宿主把它存进一个 60 秒、最多 50 条的 `recent` 表，`desktop_wait({ commandId, waitMs })` 可以取回。
- 超时回答的渲染里直接给出 `command: <id>` 和 `desktop_wait` 的调用示例，减少模型在超时后盲目重试有副作用的表达式。

### 只读 inspect 与任意 eval 分层

`desktop_inspect` 走独立的 `kind: 'inspect'` 命令，在页面里只做选择器查询、`getBoundingClientRect`、`getComputedStyle`、属性与文本读取，不执行调用方提供的代码。它支持批量选择器、`waitMs`（受页面等待窗口约束）、`limit` 与 `budget`；返回 `coverage`（是否完整、裁剪了多少、等了多久、页面是否隐藏）。选择器没命中返回 `matched: 0`，非法选择器是那一条的 `error`，不会变成 TypeError。它标记为并发安全，可以和其他读取并行。`desktop_eval` 保留给需要计算或修改页面的场合。

### 诊断、版本与重连

`desktop_status` 把原来的 `/state` 提升为模型工具（`/state` 保持不变，多出 `state`、`record.runId` 等字段）。它报告 agent 状态（`never` / `live` / `stale`）、队列与在途、最近页面、当前录制、各项上限，以及宿主/客户端/协议版本。客户端半边每次轮询都带 `client` 与 `protocol`，所以插件更新后页面没重载时能一眼看出。

客户端轮询失败从固定 1.5 秒改为有上限的指数退避（1.5s → 30s）；一次成功响应会把退避重置。

### 录制

`start` 带宿主生成的稳定 `runId`；选择器最多等 500ms，等不到就退化为整份文档并标 `selectorMatched: false`，不再让一次录制因为选择器时序整次失败。`read` 与 `stop` 的回答带 `coverage`（通道、选择器是否命中、丢弃与空洞计数）。新增 `export` 动作：宿主把整段录制多次 `read` 后写成 `$DSH_HOME/dsh-desktop-bridge/recordings/<runId>.json`，保留最近 20 份；录制归属规则与 `read` / `stop` 相同。

## v0.3：`since`，上次调用以来的页面变化

模型经常会“点一下，然后下一次调用确认”，而两次调用之间页面发生了什么，桥原先不告诉它。v0.3 用一个轻量指纹补上这一条，不引入推送、不常驻观察者、不新增事件通道。

- 宿主在每条页面命令上带一个 `source` 键：模型工具用 `session:<会话 id>`，HTTP 调用方可以在 `/exec`、`/record` 的请求体里自带 `source`，缺省是 `operator`。
- 页面半边按 source 保存上一次调用的指纹：`document.title`、`location.href`、`visibilityState`、`hasFocus`、`body` 上的 `data-*` 属性、`document.querySelectorAll('*').length`。
- 下一次同 source 的页面命令到达时，页面先算差异，作为 `since` 附在回答里，再更新该 source 的指纹。同 source 距上次调用超过 60 秒、或这是第一次调用，则只给 `baseline: true`；没有变化给 `changed: false`。
- `since` 形状：`{ baseline, windowMs, changed, counts, page?, bodyAttrs?, nodes? }`。它只描述页面级信号，不是逐节点 DOM diff；要逐条变化仍然用 `desktop_record`。
- 渲染成一行 `since your previous call (12.3s ago): …`，接在过去回答的 `page:` 行之后。模型因此能区分“点击没生效”和“桥接/表达式失败”。
- 边界：不唤醒空闲模型；不记录点击目标；`desktop_status` 与 `desktop_wait` 不下发页面命令，因此不带 `since`。

## 后续可选项

- 换成 WebSocket：用 `webServer.registerUpgrade` 注册升级路由，降低一次往返的延迟；代价是自己实现协议或引入 `ws`。
- 需要完整 DevTools 能力时走 CDP：完全退出应用，再带 `--remote-debugging-port=9222` 启动。
- 录制看不见启动时就装好的回调，那是启动脚本（`--boot`）的领域；把两者的结果按同一份时间线对齐，是下一步可以做的事。
