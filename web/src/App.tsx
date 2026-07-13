import { FormEvent, useEffect, useState } from "react";

type User = {
  subjectId: string;
  displayName: string;
  isAdmin: boolean;
};
type AuthContext =
  | { authenticated: false; csrfToken: string }
  | { authenticated: true; csrfToken: string; user: User };
type Client = {
  clientId: string;
  displayName: string;
  description: string;
  clientType: "web" | "spa";
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopeWhitelist: string[];
  status: "draft" | "pending" | "active" | "disabled" | "rejected";
  rejectionReason: string | null;
  updatedAt: string;
  version: number;
};
type ClientFormValue = Pick<
  Client,
  | "clientType"
  | "displayName"
  | "description"
  | "redirectUris"
  | "postLogoutRedirectUris"
  | "scopeWhitelist"
>;

const emptyClient: ClientFormValue = {
  clientType: "web",
  displayName: "",
  description: "",
  redirectUris: [],
  postLogoutRedirectUris: [],
  scopeWhitelist: ["openid", "profile"],
};

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(
  path: string,
  options: RequestInit = {},
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/api/management${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error_description?: string;
    };
    throw new ApiError(
      body.error_description ?? "请求失败，请稍后重试。",
      response.status,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

export function App() {
  const [context, setContext] = useState<AuthContext | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<AuthContext>("/auth/context")
      .then(setContext)
      .catch((reason) => setError(reason.message));
  }, []);

  if (error && !context)
    return <Message title="管理服务暂时不可用" detail={error} />;
  if (!context) return <Message title="正在加载" detail="正在读取登录状态。" />;
  if (!context.authenticated) {
    return <Login context={context} onLogin={setContext} />;
  }
  return <Dashboard context={context} />;
}

function Login({
  context,
  onLogin,
}: {
  context: AuthContext & { authenticated: false };
  onLogin: (value: AuthContext) => void;
}) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(
        await api<AuthContext>(
          "/auth/login",
          { method: "POST", body: JSON.stringify({ account, password }) },
          context.csrfToken,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-layout">
      <section className="login-card" aria-labelledby="login-title">
        <p className="eyebrow">CQUT-AUTH</p>
        <h1 id="login-title">客户端管理</h1>
        <p className="muted">
          使用校园统一身份认证账号登录。密码仅用于本次认证，不会被保存。
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
        <form onSubmit={submit} className="stack">
          <label>
            账号
            <input
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button disabled={busy}>{busy ? "正在登录…" : "登录管理台"}</button>
        </form>
      </section>
    </main>
  );
}

function Dashboard({
  context,
}: {
  context: AuthContext & { authenticated: true };
}) {
  const [tab, setTab] = useState<"mine" | "all" | "reviews">("mine");
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{
    clientId: string;
    value: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const endpoint =
    tab === "reviews"
      ? "/admin/reviews"
      : `/clients${tab === "all" ? "?view=all" : ""}`;
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ clients: Client[] }>(endpoint);
      setClients(result.clients);
      if (selected)
        setSelected(
          result.clients.find(
            (client) => client.clientId === selected.clientId,
          ) ?? null,
        );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "客户端列表加载失败。",
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [endpoint]);

  async function mutate(path: string, body: object, success: string) {
    setError("");
    try {
      await api(
        path,
        { method: "POST", body: JSON.stringify(body) },
        context.csrfToken,
      );
      setNotice(success);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败。");
    }
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" }, context.csrfToken);
    window.location.assign("/manage");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">CQUT-AUTH</p>
          <strong>客户端管理</strong>
        </div>
        <div className="user-actions">
          <span>
            {context.user.displayName}
            {context.user.isAdmin && <small className="badge">管理员</small>}
          </span>
          <button className="secondary" onClick={logout}>
            退出登录
          </button>
        </div>
      </header>
      <main className="workspace">
        <nav className="tabs" aria-label="客户端视图">
          <button
            className={tab === "mine" ? "active" : ""}
            onClick={() => {
              setTab("mine");
              setSelected(null);
            }}
          >
            我的客户端
          </button>
          {context.user.isAdmin && (
            <button
              className={tab === "all" ? "active" : ""}
              onClick={() => {
                setTab("all");
                setSelected(null);
              }}
            >
              全部客户端
            </button>
          )}
          {context.user.isAdmin && (
            <button
              className={tab === "reviews" ? "active" : ""}
              onClick={() => {
                setTab("reviews");
                setSelected(null);
              }}
            >
              待审核
            </button>
          )}
        </nav>
        <section className="page-heading">
          <div>
            <h1>{tab === "reviews" ? "审核客户端" : "OIDC 客户端"}</h1>
            <p className="muted">
              Subject ID：<code>{context.user.subjectId}</code>
            </p>
          </div>
          {tab !== "reviews" && (
            <button
              onClick={() => {
                setCreating(true);
                setSelected(null);
              }}
            >
              创建客户端
            </button>
          )}
        </section>
        {notice && <Notice tone="success">{notice}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
        {secret && (
          <SecretPanel secret={secret} onClose={() => setSecret(null)} />
        )}
        {creating && (
          <ClientEditor
            title="创建客户端"
            initial={emptyClient}
            submitLabel="提交审核"
            allowTypeChange
            onCancel={() => setCreating(false)}
            onSubmit={async (value) => {
              const result = await api<{
                client: Client;
                clientSecret?: string;
              }>(
                "/clients",
                { method: "POST", body: JSON.stringify(value) },
                context.csrfToken,
              );
              setCreating(false);
              setNotice("客户端已创建并进入待审核状态。");
              if (result.clientSecret)
                setSecret({
                  clientId: result.client.clientId,
                  value: result.clientSecret,
                });
              await refresh();
            }}
          />
        )}
        {selected && !creating && (
          <ClientEditor
            title="编辑客户端"
            initial={selected}
            submitLabel="保存设置"
            disabled={selected.status === "disabled"}
            configurationDisabled={selected.status === "active"}
            rejectionReason={selected.rejectionReason}
            onCancel={() => setSelected(null)}
            onSubmit={async (value) => {
              try {
                const result = await api<{ client: Client }>(
                  `/clients/${encodeURIComponent(selected.clientId)}`,
                  {
                    method: "PATCH",
                    body: JSON.stringify({
                      displayName: value.displayName,
                      description: value.description,
                      redirectUris: value.redirectUris,
                      postLogoutRedirectUris: value.postLogoutRedirectUris,
                      scopeWhitelist: value.scopeWhitelist,
                      version: selected.version,
                    }),
                  },
                  context.csrfToken,
                );
                setSelected(result.client);
                setNotice("客户端设置已保存。");
                await refresh();
              } catch (reason) {
                if (reason instanceof ApiError && reason.status === 409)
                  throw new Error(
                    "客户端已被其他操作更新，请关闭编辑器并重新加载。",
                  );
                throw reason;
              }
            }}
            extraActions={
              <>
                {selected.status === "draft" && (
                  <button
                    type="button"
                    onClick={() =>
                      void mutate(
                        `/clients/${encodeURIComponent(selected.clientId)}/submit`,
                        { version: selected.version },
                        "客户端已重新提交审核。",
                      )
                    }
                  >
                    重新提交审核
                  </button>
                )}
                {selected.status !== "disabled" && (
                  <button
                    className="danger"
                    type="button"
                    onClick={() =>
                      window.confirm("停用后第一轮无法恢复，确定继续吗？") &&
                      void mutate(
                        `/clients/${encodeURIComponent(selected.clientId)}/disable`,
                        { version: selected.version },
                        "客户端已停用。",
                      )
                    }
                  >
                    停用客户端
                  </button>
                )}
                {context.user.isAdmin && selected.status === "pending" && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        void mutate(
                          `/admin/reviews/${encodeURIComponent(selected.clientId)}/approve`,
                          { version: selected.version },
                          "客户端已批准。",
                        )
                      }
                    >
                      批准客户端
                    </button>
                    <button
                      className="danger"
                      type="button"
                      onClick={() => {
                        const reason =
                          window.prompt("可选：填写拒绝原因") ?? undefined;
                        void mutate(
                          `/admin/reviews/${encodeURIComponent(selected.clientId)}/reject`,
                          {
                            version: selected.version,
                            ...(reason ? { reason } : {}),
                          },
                          "客户端已拒绝。",
                        );
                      }}
                    >
                      拒绝客户端
                    </button>
                  </>
                )}
              </>
            }
          />
        )}
        {!creating && !selected && (
          <ClientTable
            clients={clients}
            loading={loading}
            onSelect={setSelected}
          />
        )}
      </main>
    </div>
  );
}

function ClientEditor({
  title,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  disabled,
  allowTypeChange,
  configurationDisabled,
  rejectionReason,
  extraActions,
}: {
  title: string;
  initial: ClientFormValue;
  submitLabel: string;
  onSubmit: (value: ClientFormValue) => Promise<void>;
  onCancel: () => void;
  disabled?: boolean;
  allowTypeChange?: boolean;
  configurationDisabled?: boolean;
  rejectionReason?: string | null;
  extraActions?: React.ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const [redirects, setRedirects] = useState(initial.redirectUris.join("\n"));
  const [logoutRedirects, setLogoutRedirects] = useState(
    initial.postLogoutRedirectUris.join("\n"),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scopes = ["openid", "profile", "email", "student", "offline_access"];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        ...value,
        redirectUris: lines(redirects),
        postLogoutRedirectUris: lines(logoutRedirects),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>{title}</h2>
        <button className="secondary" onClick={onCancel}>
          关闭
        </button>
      </div>
      {rejectionReason && (
        <Notice tone="danger">最近一次拒绝原因：{rejectionReason}</Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <form onSubmit={submit} className="form-grid">
        <label>
          客户端类型
          <select
            disabled={disabled || !allowTypeChange}
            value={value.clientType}
            onChange={(event) => {
              const clientType = event.target.value as "web" | "spa";
              setValue({
                ...value,
                clientType,
                scopeWhitelist:
                  clientType === "spa"
                    ? value.scopeWhitelist.filter(
                        (scope) => scope !== "offline_access",
                      )
                    : value.scopeWhitelist,
              });
            }}
          >
            <option value="web">Web（服务端保密）</option>
            <option value="spa">SPA（公开客户端）</option>
          </select>
        </label>
        <label>
          显示名称
          <input
            disabled={disabled}
            maxLength={100}
            value={value.displayName}
            onChange={(event) =>
              setValue({ ...value, displayName: event.target.value })
            }
            required
          />
        </label>
        <label className="full">
          描述
          <textarea
            disabled={disabled}
            maxLength={1000}
            value={value.description}
            onChange={(event) =>
              setValue({ ...value, description: event.target.value })
            }
          />
        </label>
        <label className="full">
          Redirect URI（每行一个）
          <textarea
            disabled={disabled || configurationDisabled}
            value={redirects}
            onChange={(event) => setRedirects(event.target.value)}
            required
          />
        </label>
        <label className="full">
          Post Logout Redirect URI（每行一个，可选）
          <textarea
            disabled={disabled || configurationDisabled}
            value={logoutRedirects}
            onChange={(event) => setLogoutRedirects(event.target.value)}
          />
        </label>
        <fieldset className="full" disabled={disabled || configurationDisabled}>
          <legend>允许的 scopes</legend>
          <div className="checks">
            {scopes.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={value.scopeWhitelist.includes(scope)}
                  disabled={
                    scope === "openid" ||
                    (value.clientType === "spa" && scope === "offline_access")
                  }
                  onChange={(event) =>
                    setValue({
                      ...value,
                      scopeWhitelist: event.target.checked
                        ? [...value.scopeWhitelist, scope]
                        : value.scopeWhitelist.filter((item) => item !== scope),
                    })
                  }
                />
                {scope}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="actions full">
          {!disabled && (
            <button disabled={busy}>{busy ? "正在保存…" : submitLabel}</button>
          )}
          {extraActions}
        </div>
      </form>
    </section>
  );
}

function ClientTable({
  clients,
  loading,
  onSelect,
}: {
  clients: Client[];
  loading: boolean;
  onSelect: (client: Client) => void;
}) {
  if (loading)
    return <Message title="正在加载" detail="正在读取客户端列表。" />;
  if (clients.length === 0)
    return (
      <Message title="暂无客户端" detail="这里还没有符合当前视图的客户端。" />
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>客户端</th>
            <th>类型</th>
            <th>状态</th>
            <th>更新时间</th>
            <th>
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => (
            <tr key={client.clientId}>
              <td>
                <strong>{client.displayName}</strong>
                <code>{client.clientId}</code>
              </td>
              <td>{client.clientType.toUpperCase()}</td>
              <td>
                <span className={`status ${client.status}`}>
                  {statusLabel(client.status)}
                </span>
              </td>
              <td>
                {new Date(client.updatedAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </td>
              <td>
                <button className="secondary" onClick={() => onSelect(client)}>
                  查看详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SecretPanel({
  secret,
  onClose,
}: {
  secret: { clientId: string; value: string };
  onClose: () => void;
}) {
  return (
    <section className="secret-panel" aria-live="polite">
      <div>
        <h2>立即保存 Client Secret</h2>
        <p>这是唯一一次显示机会。关闭后服务端无法恢复明文。</p>
        <code>{secret.value}</code>
        <small>{secret.clientId}</small>
      </div>
      <div className="actions">
        <button
          onClick={() => void navigator.clipboard.writeText(secret.value)}
        >
          复制 Secret
        </button>
        <button className="secondary" onClick={onClose}>
          我已安全保存
        </button>
      </div>
    </section>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "success" | "danger";
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
function Message({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="message">
      <h1>{title}</h1>
      <p>{detail}</p>
    </main>
  );
}
function lines(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
function statusLabel(status: Client["status"]) {
  return {
    draft: "草稿",
    pending: "待审核",
    active: "已启用",
    rejected: "已拒绝",
    disabled: "已停用",
  }[status];
}
