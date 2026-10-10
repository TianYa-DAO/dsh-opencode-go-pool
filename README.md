# dsh-opencode-go-pool

[English](README.en.md) | 中文

> **反馈 / Feedback**：遇到 bug 或有改进建议，请到 [Issues](https://github.com/TianYa-DAO/dsh-opencode-go-pool/issues) 提；也可以直接发邮件到 [2842425998@qq.com](mailto:2842425998@qq.com)。

把多个 **OpenCode Go** 订阅（每把 key 一个订阅）放在同一条 provider 路由后面：请求前选额度最健康的那把，被网关拒绝时按重置时间冷却并换下一把，全程不用你手动切换模型。

## 为什么是「换凭据」而不是「换路由」

DSH 的 agent loop 发出的模型请求是深冻结的（`options` 不可改，改了就抛错），所以 waterfall 监听器只能读 `options.provider`，不能改。真正每次请求都会重新解析的是 provider 的 `apiKeyEnv` 凭据引用 —— 于是本插件让路由指向一个由自己托管的 `activeRef`，在每次请求前把当前健康的订阅 key 写进去。

## 工作原理

1. 每个订阅 key 存在标准凭据存储里（`$DSH_HOME/.credentials.yaml`，可用设置页管理），插件只按引用名读取。
2. 路由的 `apiKeyEnv` 指向 `activeRef`（例如 `OPENCODE_GO_ACTIVE_KEY`），这个引用由插件独占写入。
3. 插件调用网关官方用量接口 `GET https://opencode.ai/zen/go/v1/usage`（纯 API key，无需 org token），读取 5 小时 / 周 / 月三个窗口的 `percent` 与 `status`；`status: "rate-limited"` 或 `percent >= 100` 即视为该窗口已用尽。
4. 每次请求前：读数缺失时**先查一次**（不知道就可能把满额 key 发上线）；读数只是过期时**后台刷新**，不阻塞请求；当前 key 已用尽则立刻换成余量最健康的一把。
5. 网关以 `HTTP 429` + `{"error":{"type":"GoUsageLimitError"}}` + `Retry-After` 拒绝时（Harness 归类为 `QUOTA`，**不在默认重试码里**，所以插件自己负责重发）：按 `Retry-After` 与窗口重置时刻冷却该 key，换上另一把，并在**本次请求尚未产出任何 token** 的前提下原样重发一次。已经有输出则如实报错，绝不重复生成。

多个决策（激活预热与并发请求）会串行执行，避免两份状态快照互相交叉。

## 配置

插件本体只有一行 `insert`（见 `cordis.patch.yml`），真正的配置写在你的 profile patch 层：

```yaml
- insert:
    - id: opencode-go-pool
      name: 'dsh-opencode-go-pool'
- id: opencode-go-pool
  config:
    route: opencode-go                 # 要接管的 provider 路由名
    activeRef: OPENCODE_GO_ACTIVE_KEY  # 插件独占写入的凭据引用
    keys:
      - { ref: OPENCODE_GO_API_KEY, label: 订阅A }
      - { ref: OPENCODE_GO_API_KEY_B, label: 订阅B }
```

同时把该路由的 `apiKeyEnv` 改成 `activeRef`：

```yaml
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_ACTIVE_KEY
        api: openai-completions
        baseURL: https://opencode.ai/zen/go/v1
```

可选字段与默认值：`usageUrl`（默认上文的网关用量接口）、`usageTtlMs`（60000）、`cooldownMs`（60000，网关未给出窗口时的冷却下限）、`maxFailovers`（1，一次调用最多切换几次）。

`keys[].ref` 不能与 `activeRef` 相同，配置错误会在插件激活时直接报错并指出字段名。

## 可观察行为

日志（前缀 `opencode-go-pool:`，走 Host logger）：

1. `pooling 订阅A, 订阅B behind route "opencode-go" through OPENCODE_GO_ACTIVE_KEY` —— 装载成功。
2. `installed 订阅B as the active key` —— 首次装填或首次换 key。
3. `switched away from 订阅A (quota spent, resets …) to 订阅B` —— 请求前主动避开已用尽的 key。
4. `failover 订阅A (quota spent, resets …) -> 订阅B (until …) — Go usage limit exceeded` —— 被拒绝后切换并重发。

## 本机接入现状（desktop profile）

1. 插件源码在 `~/.dsh/plugins/dsh-opencode-go-pool`，profile 通过 `file:../../plugins/dsh-opencode-go-pool` 依赖 + `cordis.patch.yml` 里的 `insert` 行接入。
2. 凭据：`OPENCODE_GO_API_KEY`（订阅 A）、`OPENCODE_GO_API_KEY_B`（订阅 B）、`OPENCODE_GO_ACTIVE_KEY`（插件独占写入的生效 key）。
3. `llm-pi-ai` 的 `opencode-go` 与 `opencode-go-responses` 两条路由都指向 `OPENCODE_GO_ACTIVE_KEY`。
4. profile 用 `nodeLinker: hoisted`，`file:` 依赖以**硬链接**落盘：改 `index.js` 立即对 profile 生效；若编辑器用「替换文件」的方式写（inode 变了），要在 profile 目录 `pnpm install` 重建链接。改动生效仍需重启桌面端。
5. 真实链路回归 overlay：`tests/e2e-overlay.yml`（用量驱动切换）、`tests/e2e-overlay-failover.yml`（429 驱动切换，把 `usageUrl` 指到不可达端口）。

## 测试

```sh
node tests/selfcheck.mjs
```

用假 context 与假用量端点跑真实插件代码，覆盖 8 组行为：满额 key 不上线、已装填健康 key 不重复写凭据、被拒绝后接管并重发、已有输出时不重发、全满额时按预算收敛、非本路由请求原样透传、配置错误报警、被拒绝那次的记账块不外泄。

## 限制

1. 只在请求发出前与**被拒绝后**判断健康度，不预测额度耗尽。
2. 只对 `route` 指定的那一条路由做逐请求决策；其它路由若也指向同一个 `activeRef`，只能继承当前生效的 key。
3. 切换属于传输层路由，不写会话事件；判定依据在 Host 日志里，不在会话记录里。

## 许可

[MIT](LICENSE)
