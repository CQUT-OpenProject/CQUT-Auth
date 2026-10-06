# Agent API 交互式参考

此页面根据仓库中的 `openapi/agent.json` 渲染 Agent API 接口，并支持填写参数和发送请求。规范只有一个维护来源。

默认服务地址 `/api/agent` 适用于文档站和 CQUT Auth API 同源部署。若文档站单独部署，请填写完整 API 地址，例如 `https://auth.example.com/api/agent`，并在 API 服务端配置允许的文档站来源。

生产环境默认关闭 Agent API。发送请求前，请确认实例已启用 API，并使用页面中的 **Authorize** 填入 Bearer Token。不要在公共设备上调试真实账号或令牌。

<AgentApiReference />

<script setup>
import AgentApiReference from "../components/AgentApiReference.vue";
</script>
