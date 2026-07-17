# 联调缺陷记录

本文记录在本地联调中已稳定复现并完成修复的缺陷。测试账号、密码、Cookie、
Token、Client Secret、数据库密码及加密密钥不得写入本文。

## BUG-001：Windows 上环境变量来源检查误报

- 日期：2026-07-17
- 严重程度：中
- 类别：开发工具 / 跨平台
- 状态：已修复

### 现象

在 Windows 工作区执行 `pnpm lint` 时，`check:env-source` 将白名单中的
`src/app.ts`、`src/config.ts` 和两个 `src/scripts/*.ts` 文件误报为违规，导致
lint 退出码为 1；TypeScript 类型检查、全量测试和构建均能通过。

### 根因

`scripts/check-single-env-source.mjs` 的白名单使用 POSIX `/` 路径分隔符，而
Windows 上 `globSync("src/**/*.ts")` 返回 `\` 分隔符，导致同一相对路径无法命中
白名单。

### 修复

在执行白名单判断前，将 glob 返回路径统一规范化为 `/` 分隔符。

### 验证

- Windows：`pnpm lint`
- Linux：在 Node.js 24 容器中执行 `node scripts/check-single-env-source.mjs`
- 完整回归：`pnpm test`、`pnpm build`

## BUG-002：未登录页面提前请求项目列表

- 日期：2026-07-17
- 严重程度：低
- 类别：前端 / 认证状态
- 状态：已修复

### 现象

未登录访问管理台时，登录页仍发起 `GET /api/management/projects`。服务端返回
`401 login_required`，浏览器控制台同时输出 `Failed to fetch projects`。

### 根因

`ProjectProvider` 位于 Refine 认证边界外，应用启动后无论认证状态如何都会立即挂载并
加载项目列表。

### 修复

将 `ProjectProvider` 移入 `<Authenticated>` 保护的路由布局中，仅在认证检查成功后
加载项目数据。

### 验证

- UI 回归测试断言未登录跳转后不存在 `/projects` 请求
- 新浏览器会话访问 `/manage/login`，网络记录仅包含 `/auth/context`，控制台无 401

## BUG-003：中文管理台混用英文组件文案

- 日期：2026-07-17
- 严重程度：低
- 类别：前端 / 本地化
- 状态：已修复

### 现象

项目创建弹窗显示 `Cancel / OK`，空表格显示 `No data`，分页也使用英文提示，与管理台
中文业务文案混用。

### 根因

根 `ConfigProvider` 仅传入主题配置，没有设置 Ant Design 中文 locale。

### 修复

为根 `ConfigProvider` 配置 `antd/locale/zh_CN`。

### 验证

- 项目创建弹窗按钮显示“取 消 / 确 定”
- 表格空状态显示“暂无数据”，分页显示“上一页 / 下一页”

## BUG-004：客户端创建页图标按钮缺少业务可访问名称

- 日期：2026-07-17
- 严重程度：低
- 类别：前端 / 可访问性
- 状态：已修复

### 现象

客户端创建页和客户端详情页的返回按钮以及 Redirect URI、Logout URI 删除按钮仅暴露
`arrow-left`、`delete` 等图标名称，屏幕阅读器无法判断按钮动作。

### 根因

纯图标 Ant Design `Button` 未提供 `aria-label`。

### 修复

在创建页和详情页分别增加“返回客户端列表”“删除 Redirect URI”“删除 Logout URI”
可访问名称。

### 验证

- UI 测试通过角色和名称查询“返回客户端列表”按钮
- 浏览器可访问性树显示“返回客户端列表”和“删除 Logout URI”

## BUG-005：RP 发起注销确认后失败

- 日期：2026-07-17
- 严重程度：中
- 类别：OIDC / RP-Initiated Logout
- 状态：已修复

### 现象

使用有效 `id_token_hint` 和已登记的 `post_logout_redirect_uri` 打开退出确认页后，点击
“继续退出”进入“认证请求失败”。日志记录
`'logout' parameter must not be provided twice`。

### 根因

自定义退出页在 oidc-provider 生成的表单中补入隐藏字段 `logout=yes`，同时提交按钮又
携带同名 `name="logout" value="yes"`，浏览器会发送两个同名参数。原测试使用对象
构造表单数据，重复键被合并，因此没有覆盖真实浏览器行为。

### 修复

保留表单内唯一的隐藏 `logout=yes` 字段，提交按钮不再重复提交该参数；测试同时断言
页面只包含一个 `name="logout"`，并直接提交页面解析出的隐藏字段。

### 验证

- `test/oidc-op.test.ts` 的带回跳 URI、无回跳 URI 两种注销测试通过
- PostgreSQL 实际流程提交确认表单后返回 `303 See Other`
- `Location` 精确为已登记的 `http://localhost:3002/logout-complete`

## BUG-006：认证页面品牌图片未进入生产构建

- 日期：2026-07-17
- 严重程度：低
- 类别：构建 / 静态资源
- 状态：已修复

### 现象

登录、授权和退出页面的两张品牌图片返回 404，页面显示破图和 alt 文本；服务端日志
持续记录 `dist/management/logo-auth-*.svg` 的 `ENOENT`。

### 根因

服务端按固定根文件名从 `dist/management` 提供资源，但两个 SVG 位于
`web/src/assets` 且未被前端代码导入，Vite 不会将它们复制到输出根目录。

### 修复

将两张仅供服务端品牌页使用的 SVG 移到 `web/public`，由 Vite 原名复制到
`dist/management`。

### 验证

- `pnpm build` 后两个文件均存在于 `dist/management`
- 实际登录与授权页请求两个 SVG 均返回 200，页面显示完整品牌标志

## BUG-007：“系统客户端”菜单跳转到项目概览

- 日期：2026-07-17
- 严重程度：中
- 类别：前端 / 导航
- 状态：已修复

### 现象

系统管理员点击侧栏“系统客户端”后进入
`/manage/projects/system/overview`，而不是系统客户端列表。

### 根因

该菜单项虽然名为“系统客户端”，其点击处理器却硬编码跳转到系统项目概览路径。

### 修复

将目标路径改为 `/projects/system/clients`，同时保留系统项目上下文选择。

### 验证

- UI 测试断言点击菜单后路径为 `/manage/projects/system/clients`
- 浏览器复测可直接显示系统客户端列表

## BUG-008：项目慢加载时客户端创建页违反 Hooks 调用顺序

- 日期：2026-07-17
- 严重程度：中
- 类别：前端 / React 稳定性
- 状态：已修复

### 现象

认证边界调整后，直接打开客户端创建页时会先渲染“项目信息正在加载”，项目返回后
React 抛出 `Rendered more hooks than during the previous render`，页面卸载为空白。

### 根因

`Form.useWatch` 位于 `if (!activeProject) return ...` 之后，首次无项目和后续有项目两次
渲染调用了不同数量的 Hook。

### 修复

将 `Form.useWatch` 移到条件返回之前，保证每次渲染 Hook 顺序一致。

### 验证

- 从直达 URL 渲染客户端创建页的 UI 测试通过
- 创建 Web 客户端完整五步流程测试通过，无 Hook 顺序错误

## BUG-009：审计日志前端使用过期字段结构

- 日期：2026-07-17
- 严重程度：中
- 类别：前端 / 审计接口契约
- 状态：已修复

### 现象

项目审计日志中，所有管理操作都显示操作人“系统”、来源 IP“未知”，变更细节列为空；
但审计接口原始 JSON 中包含真实 Subject、IP 和变更字段。

### 根因

后端当前契约使用 `actorSubjectId`、`sourceIp`、`changedFields` 及状态变更等扁平字段，
前端 `AuditLog` 类型和表格仍读取旧的 `subjectId`、`details.ip`、`details` 结构。

### 修复

同步前端 `AuditLog` 类型到当前管理 API 契约；表格直接显示 `actorSubjectId` 和
`sourceIp`，并从变更字段、修订信息、Secret 标识、前后状态和原因组成结构化细节。

### 验证

- UI 契约测试断言操作人、来源 IP 和 `changedFields` 正确显示
- PostgreSQL 联调数据复测显示真实 Subject 与 `::ffff:127.0.0.1`

## BUG-010：移动端断点未切换到抽屉导航

- 日期：2026-07-17
- 严重程度：中
- 类别：前端 / 响应式布局
- 状态：已修复

### 现象

390px 宽度下桌面侧栏仍占约 200px，主内容被压到逐字换行，项目表格和操作区域大部分
超出可见范围。

### 根因

`Sider` 使用受控 `collapsed` 状态，但 `onBreakpoint` 回调为空，没有在 `lg` 断点下
收起桌面侧栏。虽然页面已有移动 Drawer，Header 按钮仍同时切换桌面折叠和 Drawer，
移动状态没有形成独立逻辑。

### 修复

记录 `isMobile` 断点状态；进入移动宽度时收起 Sider，菜单按钮只打开 Drawer；选择菜单
后关闭 Drawer。Header 同时缩小项目选择器、隐藏冗长身份信息，并为退出和菜单按钮补充
可访问名称；内容边距在移动端缩小为 12px。管理台各数据表在窄屏下使用横向滚动，
避免列宽被压缩到逐字换行。

### 验证

- 390×844 浏览器视口下桌面 Sider 隐藏，内容区使用完整宽度
- 菜单按钮可打开 Drawer，选择菜单后 Drawer 自动关闭
- 桌面视口仍可正常折叠和展开 Sider
