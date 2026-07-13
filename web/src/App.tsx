import { FormEvent, useEffect, useState } from "react";
import useSWR, { SWRConfig } from "swr";

type User = {
  subjectId: string;
  displayName: string;
  isAdmin: boolean;
};
type AuthContext =
  | { authenticated: false; csrfToken: string }
  | {
      authenticated: true;
      csrfToken: string;
      user: User;
      clientSecretPolicy: {
        defaultGraceSeconds: number;
        maxGraceSeconds: number;
      };
    };
type Client = {
  clientId: string;
  displayName: string;
  description: string;
  clientType: "web" | "spa";
  lifecycleStatus: "draft" | "active" | "disabled";
  activeRevision: ClientRevision | null;
  proposedRevision: ClientRevision | null;
  updatedAt: string;
  clientVersion: number;
  secrets: ClientSecret[];
};
type ClientSecret = {
  secretId: string;
  status: "active" | "retiring" | "revoked";
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  version: number;
};
type ClientRevision = {
  revisionId: number;
  revisionNumber: number;
  status: "draft" | "pending" | "approved" | "rejected";
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopeWhitelist: string[];
  rejectionReason: string | null;
  version: number;
};
type ClientFormValue = Pick<
  Client,
  "clientType" | "displayName" | "description"
> &
  Pick<
    ClientRevision,
    "redirectUris" | "postLogoutRedirectUris" | "scopeWhitelist"
  >;

const emptyClient: ClientFormValue = {
  clientType: "web",
  displayName: "",
  description: "",
  redirectUris: [],
  postLogoutRedirectUris: [],
  scopeWhitelist: ["openid", "profile"],
};
const emptyClients: Client[] = [];
const clientScopes = [
  "openid",
  "profile",
  "email",
  "student",
  "offline_access",
];

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

const swrConfiguration = {
  provider: () => new Map(),
};

export function App() {
  return (
    <SWRConfig value={swrConfiguration}>
      <ManagementApp />
    </SWRConfig>
  );
}

function ManagementApp() {
  const {
    data: context,
    error,
    mutate: updateContext,
  } = useSWR<AuthContext>("/auth/context", api);

  if (error && !context)
    return (
      <Message
        title="管理服务暂时不可用"
        detail={
          error instanceof Error ? error.message : "请求失败，请稍后重试。"
        }
      />
    );
  if (!context) return <Message title="正在加载" detail="正在读取登录状态。" />;
  if (!context.authenticated) {
    return (
      <Login
        context={context}
        onLogin={(value) => void updateContext(value, { revalidate: false })}
      />
    );
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
          <button type="submit" disabled={busy}>
            {busy ? "正在登录…" : "登录管理台"}
          </button>
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
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{
    clientId: string;
    value: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");

  const endpoint =
    tab === "reviews"
      ? "/admin/reviews"
      : `/clients${tab === "all" ? "?view=all" : ""}`;
  const {
    data,
    error: clientsError,
    isLoading,
    mutate: refreshClients,
  } = useSWR<{ clients: Client[] }>(endpoint, api);
  const clients = data?.clients ?? emptyClients;
  const selected =
    clients.find((client) => client.clientId === selectedClientId) ?? null;
  const error =
    actionError ||
    (clientsError instanceof Error
      ? clientsError.message
      : clientsError
        ? "客户端列表加载失败。"
        : "");

  async function mutateClient(path: string, body: object, success: string) {
    setActionError("");
    try {
      await api(
        path,
        { method: "POST", body: JSON.stringify(body) },
        context.csrfToken,
      );
      setNotice(success);
      await refreshClients();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "操作失败。");
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
          <button type="button" className="secondary" onClick={logout}>
            退出登录
          </button>
        </div>
      </header>
      <main className="workspace">
        <nav className="tabs" aria-label="客户端视图">
          <button
            type="button"
            className={tab === "mine" ? "active" : ""}
            onClick={() => {
              setTab("mine");
              setSelectedClientId(null);
            }}
          >
            我的客户端
          </button>
          {context.user.isAdmin && (
            <button
              type="button"
              className={tab === "all" ? "active" : ""}
              onClick={() => {
                setTab("all");
                setSelectedClientId(null);
              }}
            >
              全部客户端
            </button>
          )}
          {context.user.isAdmin && (
            <button
              type="button"
              className={tab === "reviews" ? "active" : ""}
              onClick={() => {
                setTab("reviews");
                setSelectedClientId(null);
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
              type="button"
              onClick={() => {
                setCreating(true);
                setSelectedClientId(null);
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
            submitLabel="创建草稿"
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
              setNotice("客户端草稿已创建，请确认配置后提交审核。");
              if (result.clientSecret)
                setSecret({
                  clientId: result.client.clientId,
                  value: result.clientSecret,
                });
              await refreshClients();
            }}
          />
        )}
        {selected && !creating && (
          <>
            <RevisionComparison client={selected} />
            <ClientSecurity
              client={selected}
              csrfToken={context.csrfToken}
              defaultGraceSeconds={
                context.clientSecretPolicy.defaultGraceSeconds
              }
              maxGraceSeconds={context.clientSecretPolicy.maxGraceSeconds}
              onChanged={async (message) => {
                setNotice(message);
                await refreshClients();
              }}
              onRotated={async (value) => {
                setSecret({ clientId: selected.clientId, value });
                setNotice("Client Secret 已轮换，请立即安全保存新 Secret。");
                await refreshClients();
              }}
            />
            <ClientEditor
              title="基本信息"
              initial={formValue(selected)}
              submitLabel="保存基本信息"
              section="metadata"
              disabled={selected.lifecycleStatus === "disabled"}
              onCancel={() => setSelectedClientId(null)}
              onSubmit={async (value) => {
                try {
                  if (
                    value.displayName === selected.displayName &&
                    value.description === selected.description
                  )
                    throw new Error("至少修改一项基本信息。");
                  await api(
                    `/clients/${encodeURIComponent(selected.clientId)}`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({
                        displayName: value.displayName,
                        description: value.description,
                        clientVersion: selected.clientVersion,
                      }),
                    },
                    context.csrfToken,
                  );
                  setNotice("客户端基本信息已保存。");
                  await refreshClients();
                } catch (reason) {
                  if (reason instanceof ApiError && reason.status === 409)
                    throw new Error(
                      "客户端已被其他操作更新，请关闭编辑器并重新加载。",
                    );
                  throw reason;
                }
              }}
            />
            <ClientEditor
              title="OIDC 配置"
              initial={formValue(selected)}
              submitLabel={
                selected.lifecycleStatus === "active"
                  ? "保存并提交敏感修改"
                  : "保存配置"
              }
              section="configuration"
              disabled={selected.lifecycleStatus === "disabled"}
              configurationDisabled={
                selected.proposedRevision?.status === "pending"
              }
              sensitiveNotice={selected.lifecycleStatus === "active"}
              rejectionReason={selected.proposedRevision?.rejectionReason}
              onCancel={() => setSelectedClientId(null)}
              onSubmit={async (value) => {
                try {
                  const baseRevision =
                    selected.proposedRevision ?? selected.activeRevision;
                  if (
                    !baseRevision ||
                    !configurationChanged(value, baseRevision)
                  )
                    throw new Error("至少修改一项 OIDC 配置。");
                  await api(
                    `/clients/${encodeURIComponent(selected.clientId)}/revision`,
                    {
                      method: "PUT",
                      body: JSON.stringify({
                        redirectUris: value.redirectUris,
                        postLogoutRedirectUris: value.postLogoutRedirectUris,
                        scopeWhitelist: value.scopeWhitelist,
                        ...(selected.proposedRevision?.status === "draft"
                          ? {
                              revisionId: selected.proposedRevision.revisionId,
                              revisionVersion:
                                selected.proposedRevision.version,
                            }
                          : {}),
                      }),
                    },
                    context.csrfToken,
                  );
                  setNotice("OIDC 配置已保存。");
                  await refreshClients();
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
                  {selected.proposedRevision?.status === "draft" && (
                    <button
                      type="button"
                      onClick={() =>
                        void mutateClient(
                          `/clients/${encodeURIComponent(selected.clientId)}/revision/submit`,
                          {
                            revisionId: selected.proposedRevision!.revisionId,
                            revisionVersion: selected.proposedRevision!.version,
                          },
                          "客户端配置已提交审核。",
                        )
                      }
                    >
                      提交审核
                    </button>
                  )}
                  {selected.proposedRevision?.status === "pending" && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void mutateClient(
                          `/clients/${encodeURIComponent(selected.clientId)}/revision/withdraw`,
                          {
                            revisionId: selected.proposedRevision!.revisionId,
                            revisionVersion: selected.proposedRevision!.version,
                          },
                          "待审核配置已撤回为草稿。",
                        )
                      }
                    >
                      撤回审核
                    </button>
                  )}
                  {selected.lifecycleStatus !== "disabled" && (
                    <button
                      className="danger"
                      type="button"
                      onClick={() =>
                        window.confirm(
                          "紧急停用不可恢复，并会立即撤销全部 Secret、Authorization Code、Access Token、Refresh Token 和 Grant。确定继续吗？",
                        ) &&
                        void mutateClient(
                          `/clients/${encodeURIComponent(selected.clientId)}/disable`,
                          { clientVersion: selected.clientVersion },
                          "客户端已紧急停用，全部 Secret 与授权已撤销。",
                        )
                      }
                    >
                      紧急停用客户端
                    </button>
                  )}
                  {context.user.isAdmin &&
                    selected.proposedRevision?.status === "pending" &&
                    selected.lifecycleStatus !== "disabled" && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            void mutateClient(
                              `/admin/reviews/${encodeURIComponent(selected.clientId)}/approve`,
                              {
                                revisionId:
                                  selected.proposedRevision!.revisionId,
                                revisionVersion:
                                  selected.proposedRevision!.version,
                              },
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
                            const reason = window
                              .prompt("请填写拒绝原因（必填）")
                              ?.trim();
                            if (!reason) return;
                            void mutateClient(
                              `/admin/reviews/${encodeURIComponent(selected.clientId)}/reject`,
                              {
                                revisionId:
                                  selected.proposedRevision!.revisionId,
                                revisionVersion:
                                  selected.proposedRevision!.version,
                                reason,
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
          </>
        )}
        {!creating && !selected && (
          <ClientTable
            clients={clients}
            loading={isLoading}
            onSelect={(client) => setSelectedClientId(client.clientId)}
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
  section = "all",
  configurationDisabled,
  sensitiveNotice,
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
  section?: "all" | "metadata" | "configuration";
  configurationDisabled?: boolean;
  sensitiveNotice?: boolean;
  rejectionReason?: string | null;
  extraActions?: React.ReactNode;
}) {
  const showMetadata = section !== "configuration";
  const showConfiguration = section !== "metadata";
  const [value, setValue] = useState(initial);
  const [redirects, setRedirects] = useState(() =>
    initial.redirectUris.join("\n"),
  );
  const [logoutRedirects, setLogoutRedirects] = useState(() =>
    initial.postLogoutRedirectUris.join("\n"),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
        <button type="button" className="secondary" onClick={onCancel}>
          关闭
        </button>
      </div>
      {rejectionReason && (
        <Notice tone="danger">最近一次拒绝原因：{rejectionReason}</Notice>
      )}
      {sensitiveNotice && (
        <Notice tone="success">
          Redirect URI、Logout URI 和 Scope
          的修改审核通过后生效；审核期间继续使用当前生效配置。
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <form onSubmit={submit} className="form-grid">
        {showMetadata && (
          <>
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
          </>
        )}
        {showConfiguration && (
          <>
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
            <fieldset
              className="full"
              disabled={disabled || configurationDisabled}
            >
              <legend>允许的 scopes</legend>
              <div className="checks">
                {clientScopes.map((scope) => (
                  <label key={scope}>
                    <input
                      type="checkbox"
                      checked={value.scopeWhitelist.includes(scope)}
                      disabled={
                        scope === "openid" ||
                        (value.clientType === "spa" &&
                          scope === "offline_access")
                      }
                      onChange={(event) =>
                        setValue({
                          ...value,
                          scopeWhitelist: event.target.checked
                            ? [...value.scopeWhitelist, scope]
                            : value.scopeWhitelist.filter(
                                (item) => item !== scope,
                              ),
                        })
                      }
                    />
                    {scope}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}
        <div className="actions full">
          {!disabled && (
            <button type="submit" disabled={busy}>
              {busy ? "正在保存…" : submitLabel}
            </button>
          )}
          {extraActions}
        </div>
      </form>
    </section>
  );
}

function ClientSecurity({
  client,
  csrfToken,
  defaultGraceSeconds,
  maxGraceSeconds,
  onChanged,
  onRotated,
}: {
  client: Client;
  csrfToken: string;
  defaultGraceSeconds: number;
  maxGraceSeconds: number;
  onChanged: (message: string) => Promise<void>;
  onRotated: (value: string) => Promise<void>;
}) {
  const [graceHours, setGraceHours] = useState(defaultGraceSeconds / 3600);
  const maxGraceHours = maxGraceSeconds / 3600;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [secretPage, setSecretPage] = useState(0);
  const secretPageSize = 10;
  const secretPageCount = Math.max(
    1,
    Math.ceil(client.secrets.length / secretPageSize),
  );
  const visibleSecrets = client.secrets.slice(
    secretPage * secretPageSize,
    (secretPage + 1) * secretPageSize,
  );
  const disabled = client.lifecycleStatus === "disabled" || busy;

  useEffect(() => setSecretPage(0), [client.clientId, client.secrets.length]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "安全操作失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel stack" aria-labelledby="client-security-title">
      <div>
        <h2 id="client-security-title">凭据与授权</h2>
        <p className="muted">
          Secret 明文仅在生成响应中显示一次；历史 Secret 无法恢复。
        </p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {client.clientType === "web" && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Secret</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>到期时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleSecrets.map((secret) => (
                  <tr key={secret.secretId}>
                    <td>
                      <code>{secret.secretId}</code>
                    </td>
                    <td>{secretStatusLabel(secret)}</td>
                    <td>{formatDate(secret.createdAt)}</td>
                    <td>
                      {secret.expiresAt ? formatDate(secret.expiresAt) : "—"}
                    </td>
                    <td>
                      {secret.status !== "revoked" && (
                        <button
                          type="button"
                          className="danger"
                          disabled={disabled}
                          onClick={() =>
                            window.confirm(
                              `立即撤销 Secret ${secret.secretId}？此操作不可恢复。`,
                            ) &&
                            void run(async () => {
                              await api(
                                `/clients/${encodeURIComponent(client.clientId)}/secrets/${encodeURIComponent(secret.secretId)}/revoke`,
                                {
                                  method: "POST",
                                  body: JSON.stringify({
                                    clientVersion: client.clientVersion,
                                    secretVersion: secret.version,
                                  }),
                                },
                                csrfToken,
                              );
                              await onChanged(
                                "指定 Client Secret 已立即撤销。",
                              );
                            })
                          }
                        >
                          撤销 Secret
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {secretPageCount > 1 && (
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={secretPage === 0}
                onClick={() => setSecretPage((page) => page - 1)}
              >
                上一页
              </button>
              <span>
                {secretPage + 1} / {secretPageCount}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={secretPage + 1 >= secretPageCount}
                onClick={() => setSecretPage((page) => page + 1)}
              >
                下一页
              </button>
            </div>
          )}
          <label>
            旧 Secret 宽限期（小时）
            <input
              type="number"
              min="0"
              max={maxGraceHours}
              step="1"
              value={graceHours}
              disabled={disabled}
              onChange={(event) => setGraceHours(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              window.confirm(
                `轮换 Client Secret，并保留旧 Secret ${graceHours} 小时？`,
              ) &&
              void run(async () => {
                const result = await api<{ secret: { value: string } }>(
                  `/clients/${encodeURIComponent(client.clientId)}/secrets/rotate`,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      clientVersion: client.clientVersion,
                      gracePeriodSeconds: graceHours * 3600,
                    }),
                  },
                  csrfToken,
                );
                await onRotated(result.secret.value);
              })
            }
          >
            轮换 Secret
          </button>
        </>
      )}
      <button
        type="button"
        className="danger"
        disabled={disabled}
        onClick={() =>
          window.confirm(
            "撤销该客户端全部 Authorization Code、Access Token、Refresh Token 和 Grant？其他客户端会话不受影响。",
          ) &&
          void run(async () => {
            await api(
              `/clients/${encodeURIComponent(client.clientId)}/authorizations/revoke`,
              {
                method: "POST",
                body: JSON.stringify({ clientVersion: client.clientVersion }),
              },
              csrfToken,
            );
            await onChanged("该客户端全部授权已撤销。");
          })
        }
      >
        撤销全部授权
      </button>
    </section>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
}

function secretStatusLabel(secret: ClientSecret) {
  if (
    secret.status === "retiring" &&
    secret.expiresAt &&
    new Date(secret.expiresAt).getTime() <= Date.now()
  ) {
    return "宽限期已到期";
  }
  return {
    active: "当前生效",
    retiring: "宽限期中",
    revoked: "已撤销",
  }[secret.status];
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
                <span
                  className={`status ${client.proposedRevision?.status ?? client.lifecycleStatus}`}
                >
                  {client.proposedRevision
                    ? `${statusLabel(client.lifecycleStatus)} · ${revisionStatusLabel(client.proposedRevision.status)}`
                    : statusLabel(client.lifecycleStatus)}
                </span>
              </td>
              <td>
                {new Date(client.updatedAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </td>
              <td>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onSelect(client)}
                >
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
          type="button"
          onClick={() => void navigator.clipboard.writeText(secret.value)}
        >
          复制 Secret
        </button>
        <button type="button" className="secondary" onClick={onClose}>
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
function statusLabel(status: Client["lifecycleStatus"]) {
  return {
    draft: "草稿",
    active: "已启用",
    disabled: "已停用",
  }[status];
}

function revisionStatusLabel(status: ClientRevision["status"]) {
  return {
    draft: "配置草稿",
    pending: "待审核",
    approved: "已批准",
    rejected: "已拒绝",
  }[status];
}

function formValue(client: Client): ClientFormValue {
  const revision = client.proposedRevision ?? client.activeRevision;
  return {
    clientType: client.clientType,
    displayName: client.displayName,
    description: client.description,
    redirectUris: revision?.redirectUris ?? [],
    postLogoutRedirectUris: revision?.postLogoutRedirectUris ?? [],
    scopeWhitelist: revision?.scopeWhitelist ?? ["openid"],
  };
}

function configurationChanged(
  value: ClientFormValue,
  revision: ClientRevision,
) {
  return (
    JSON.stringify(value.redirectUris) !==
      JSON.stringify(revision.redirectUris) ||
    JSON.stringify(value.postLogoutRedirectUris) !==
      JSON.stringify(revision.postLogoutRedirectUris) ||
    JSON.stringify(value.scopeWhitelist) !==
      JSON.stringify(revision.scopeWhitelist)
  );
}

function RevisionComparison({ client }: { client: Client }) {
  const active = client.activeRevision;
  const proposed = client.proposedRevision;
  if (!active && !proposed) return null;
  return (
    <section className="panel revision-comparison">
      <div className="panel-title">
        <h2>配置版本</h2>
      </div>
      <div className="revision-grid">
        <RevisionSnapshot title="当前生效配置" revision={active} />
        <RevisionSnapshot
          title={
            proposed
              ? `待处理配置 · ${revisionStatusLabel(proposed.status)}`
              : "待处理配置"
          }
          revision={proposed}
          compare={active}
        />
      </div>
    </section>
  );
}

function RevisionSnapshot({
  title,
  revision,
  compare,
}: {
  title: string;
  revision: ClientRevision | null;
  compare?: ClientRevision | null;
}) {
  if (!revision)
    return (
      <div>
        <h3>{title}</h3>
        <p className="muted">暂无配置</p>
      </div>
    );
  return (
    <div>
      <h3>{title}</h3>
      {revision.rejectionReason && (
        <Notice tone="danger">拒绝原因：{revision.rejectionReason}</Notice>
      )}
      {(
        ["redirectUris", "postLogoutRedirectUris", "scopeWhitelist"] as const
      ).map((field) => {
        const before = new Set(compare?.[field] ?? []);
        return (
          <div key={field} className="diff-field">
            <strong>{field}</strong>
            {revision[field].map((item) => (
              <code
                className={compare && !before.has(item) ? "diff-added" : ""}
                key={item}
              >
                {compare && !before.has(item) ? "+ " : ""}
                {item}
              </code>
            ))}
            {compare?.[field]
              .filter((item) => !revision[field].includes(item))
              .map((item) => (
                <code className="diff-removed" key={item}>
                  - {item}
                </code>
              ))}
          </div>
        );
      })}
    </div>
  );
}
