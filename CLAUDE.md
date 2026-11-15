# dsh-fenggu-time — 项目约定

DSH 客户端插件：标题栏徽章显示 DeepSeek API 当前计费时段——高峰时段「梁文峰时间」（黄），
空闲时段「梁文谷时间」（绿，价格为高峰的一半）。本文件是维护规则，先改这里再改代码。

## 结构

```
lib/index.js     host 半（ESM，只用 node 内置模块）：节假日表 + 每年自动检查 + 一条 HTTP 路由
lib/client.js    浏览器半，直接是发布产物（window.__ModuleLoader__.load 包装）
data/holidays.json  节假日区间表，唯一数据源
test/            node 直跑，无测试框架
assets/          icon-180.png（市场卡片用）
submission/      市场投稿用 YAML + PR 正文
```

## 硬规矩

1. **没有构建步骤。** `lib/client.js` 手写即产物。不要引入打包器、不要加 JSX/TS，
   `require` 只能取模块表里的（`react`、`react-dom`）。要改就得保持 `__ModuleLoader__.load({id, factory})`
   这个形状不变，`id` 必须等于包名。
2. **slot 名不是兼容 API。** 现在只注册 `shell.overlay` 一个槽（设置行已移除），
   注册一律包 try/catch；注册失败只允许「不显示 + console.error」，不允许让页面崩。
3. **不写 session 事件。** 这个插件纯展示 + 一条本地路由，不进对话历史，不碰 KV cache。
4. **节假日数据双份，必须同步。** 改 `data/holidays.json` 时必须同时改 `lib/client.js` 里的
   `BUNDLED_VERSION` / `BUNDLED_RANGES`（那是离线兜底）。`test/client.test.mjs` 会比对两份，
   并同时 bump `version`（格式 `YYYY.M.D`，比较时按数字逐段比）。
5. **数据只写区间。** `[from, to]` 闭区间，单日就写同一天；跨度上限 60 天；只写国务院公布的
   放假日期，不写调休上班日（本项目按「周末=空闲」的字面规则）。
6. **每年检查不设按钮。** host 在每年 12-31 12:00（北京）自动查一次，首次固定在 2027-12-31
   （`FIRST_CHECK_AT`），查完自动排下一次；启动时补跑漏掉的（但不早于首次时间）。
   setTimeout 单次上限约 24.8 天，`MAX_TIMEOUT_MS` 分片续排，改这里时别把分片去掉。
   不要加回设置页按钮——用户明确要求去掉。
7. **安装说明必须带 `@latest`。** 中英 README 的安装/升级段都写 `dsh-fenggu-time@latest`：
   DSH 把已安装版本钉在锁文件里，裸包名还可能被 pnpm 的 `minimumReleaseAge` 静默降级到旧版
   （不报错）。升级路径固定为「卸载 → 带 @latest 重装 → 重启」，不要写成原地升级。
8. **发版前必跑**：`npm test` + `npm pack --dry-run` 看清单（不能把 test/、截图塞进 tarball）。

## 命令

```sh
npm test              # client + host 两套
npm pack --dry-run    # 检查发布内容
```

## 已知取舍

- 调休上班日显示为空闲（按字面规则「周末全天空闲」）。要改成算工作日，需要同时改
  `classify()` 和 README 的规则段，属于行为变更，别偷偷改。
- 不声明 `engines.dsh`：DSH 发 rc，semver 默认排除预发布，任何普通 range 都会把当前
  rc 用户判为不兼容，导致整行被 preflight 静默禁用。README 里写了实测版本。
