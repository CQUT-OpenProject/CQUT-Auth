<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, type Component } from "vue";
import agentOpenApi from "../../openapi/agent.json";
import "@scalar/api-reference/style.css";

const ApiReference = shallowRef<Component>();
const serverDraft = ref("/api/agent");
const activeServer = ref("/api/agent");
const serverError = ref("");

const configuration = computed(() => ({
  content: agentOpenApi,
  servers: [{ url: activeServer.value, description: "Agent API" }],
  agent: { disabled: true },
  persistAuth: false,
  telemetry: false,
  withDefaultFonts: false,
}));

function applyServer() {
  const value = serverDraft.value.trim();
  if (value.startsWith("/") && !value.startsWith("//")) {
    activeServer.value = value;
    serverError.value = "";
    return;
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid URL");
    }
    activeServer.value = value.replace(/\/$/, "");
    serverError.value = "";
  } catch {
    serverError.value = "请输入 /api/agent 路径或完整的 HTTP(S) API 地址。";
  }
}

onMounted(async () => {
  const scalar = await import("@scalar/api-reference");
  ApiReference.value = scalar.ApiReference;
});
</script>

<template>
  <section class="agent-api-explorer">
    <div class="agent-api-server">
      <label for="agent-api-server-url">Agent API 地址</label>
      <div class="agent-api-server-controls">
        <input
          id="agent-api-server-url"
          v-model="serverDraft"
          type="url"
          autocomplete="url"
          placeholder="/api/agent 或 https://auth.example.com/api/agent"
          @keydown.enter.prevent="applyServer"
        />
        <button type="button" @click="applyServer">应用地址</button>
      </div>
      <p v-if="serverError" class="agent-api-server-error" role="alert">
        {{ serverError }}
      </p>
      <p>
        文档站与 API 不同源时，请使用完整 API 地址，并在服务端将文档站来源加入
        <code>OIDC_AGENT_API_CORS_ORIGINS</code
        >。接口认证信息仅保存在当前页面内存中。
      </p>
    </div>
    <ClientOnly>
      <component
        :is="ApiReference"
        v-if="ApiReference"
        :configuration="configuration"
      />
      <div v-else class="agent-api-loading" aria-live="polite">
        正在加载 API 参考…
      </div>
      <template #fallback>
        <div class="agent-api-loading">正在加载 API 参考…</div>
      </template>
    </ClientOnly>
  </section>
</template>

<style scoped>
.agent-api-explorer {
  margin-top: 1.5rem;
}

.agent-api-server {
  margin-bottom: 1rem;
  padding: 1rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}

.agent-api-server label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
}

.agent-api-server-controls {
  display: flex;
  gap: 0.5rem;
}

.agent-api-server-controls input {
  min-width: 0;
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 6px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
}

.agent-api-server-controls button {
  padding: 0.5rem 0.75rem;
  border: 0;
  border-radius: 6px;
  color: var(--vp-c-white);
  background: var(--vp-c-brand-1);
  cursor: pointer;
}

.agent-api-server p {
  margin: 0.75rem 0 0;
  color: var(--vp-c-text-2);
  font-size: 0.875rem;
}

.agent-api-server .agent-api-server-error {
  color: var(--vp-c-danger-1);
}

.agent-api-loading {
  padding: 2rem 1rem;
  color: var(--vp-c-text-2);
  text-align: center;
}

@media (max-width: 640px) {
  .agent-api-server-controls {
    flex-direction: column;
  }
}
</style>
