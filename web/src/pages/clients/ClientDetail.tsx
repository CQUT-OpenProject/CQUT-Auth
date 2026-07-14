import React, { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import {
  Card,
  Tabs,
  Button,
  Form,
  Input,
  Checkbox,
  Space,
  Table,
  Modal,
  Typography,
  Row,
  Col,
  Alert,
  Badge,
  Descriptions,
  List,
  Tag,
  Spin,
  InputNumber,
  Divider,
  message,
} from "antd";
import {
  ArrowLeftOutlined,
  ExclamationCircleOutlined,
  SaveOutlined,
  SendOutlined,
  RetweetOutlined,
  PoweroffOutlined,
  CopyOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useProject } from "../../contexts/project-context";
import { useOne, useUpdate } from "@refinedev/core";
import { ClientStatusTag, SecretStatusTag } from "../../components/status/Tags";
import { request } from "../../api/client";
import { RevisionDiff } from "../../components/revision/RevisionDiff";
import { ConfirmActionModal } from "../../components/confirmations/ConfirmActionModal";
import { OneTimeSecretModal } from "../../components/secret/OneTimeSecretModal";
import type { Client, ClientRevision, AuditLog } from "../../api/types";

const { Text, Title, Paragraph } = Typography;

const clientScopes = [
  { label: "openid", value: "openid", disabled: true },
  { label: "profile", value: "profile" },
  { label: "email", value: "email" },
  { label: "student", value: "student" },
  { label: "offline_access", value: "offline_access" },
];

export const ClientDetail: React.FC = () => {
  const { projectId, clientId } = useParams<{
    projectId: string;
    clientId: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeProject } = useProject();

  // Determine active tab based on route
  const getActiveTab = () => {
    const path = location.pathname;
    if (path.endsWith("/configuration")) return "configuration";
    if (path.endsWith("/secrets")) return "secrets";
    if (path.endsWith("/audit")) return "audit";
    return "overview";
  };

  const handleTabChange = (key: string) => {
    navigate(
      `/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/${key}`,
    );
  };

  // Fetch client details using Refine useOne hook
  const { data, isLoading, refetch } = useOne<Client>({
    resource: "clients",
    id: clientId,
    config: {
      meta: { projectId },
    },
    queryOptions: {
      enabled: !!projectId && !!clientId,
    },
  });

  const client = data?.data;

  // Forms
  const [metaForm] = Form.useForm();
  const [configForm] = Form.useForm();

  // One time secret modal
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [rotationGraceHours, setRotationGraceHours] = useState(24);

  // Danger modal confirmations
  const [confirmDisableVisible, setConfirmDisableVisible] = useState(false);
  const [confirmRevokeAuthsVisible, setConfirmRevokeAuthsVisible] =
    useState(false);

  // Configuration edit mode state
  const [isEditingConfig, setIsEditingConfig] = useState(false);

  // Audits state
  const [audits, setAudits] = useState<AuditLog[]>([]);
  const [auditsLoading, setAuditsLoading] = useState(false);
  const [beforeId, setBeforeId] = useState<number | undefined>(undefined);
  const [hasMoreAudits, setHasMoreAudits] = useState(true);

  // Sync client metadata to form
  useEffect(() => {
    if (client) {
      metaForm.setFieldsValue({
        displayName: client.displayName,
        description: client.description,
      });

      // Prepare configuration form values
      const revision = client.proposedRevision ?? client.activeRevision;
      configForm.setFieldsValue({
        redirectUris: revision?.redirectUris || [""],
        postLogoutRedirectUris: revision?.postLogoutRedirectUris || [],
        scopeWhitelist: revision?.scopeWhitelist || ["openid"],
      });
    }
  }, [client]);

  // Load audit logs
  const loadAudits = async (loadMore = false) => {
    if (!projectId || !clientId) return;
    setAuditsLoading(true);
    try {
      const currentBeforeId = loadMore ? beforeId : undefined;
      const query = new URLSearchParams({ limit: "20" });
      if (currentBeforeId) query.set("beforeId", String(currentBeforeId));

      const res = await request<{ auditLogs: AuditLog[] }>(
        `/projects/${encodeURIComponent(projectId)}/audit-logs?${query.toString()}`,
      );

      // Filter audits specific to this client in case the project log returns all
      const clientAudits = res.auditLogs.filter(
        (log) => log.clientId === clientId,
      );

      if (loadMore) {
        setAudits((prev) => [...prev, ...clientAudits]);
      } else {
        setAudits(clientAudits);
      }

      if (res.auditLogs.length > 0) {
        const lastLog = res.auditLogs[res.auditLogs.length - 1];
        setBeforeId(lastLog?.id);
        setHasMoreAudits(res.auditLogs.length === 20);
      } else {
        setHasMoreAudits(false);
      }
    } catch (error: any) {
      message.error("加载审计日志失败：" + error.message);
    } finally {
      setAuditsLoading(false);
    }
  };

  useEffect(() => {
    if (getActiveTab() === "audit") {
      setBeforeId(undefined);
      setHasMoreAudits(true);
      loadAudits(false);
    }
  }, [getActiveTab(), clientId]);

  if (isLoading || !client || !activeProject) {
    return (
      <Card style={{ textAlign: "center", padding: "50px" }}>
        <Spin size="large" />
      </Card>
    );
  }

  const isArchived = activeProject.status === "archived";
  const isClientDisabled = client.lifecycleStatus === "disabled";
  const canWrite =
    activeProject.capabilities.includes("write_client") &&
    !isArchived &&
    !isClientDisabled;

  // Metadata update handler
  const handleSaveMeta = async (values: any) => {
    try {
      await request(
        `/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            displayName: values.displayName,
            description: values.description || "",
            clientVersion: client.clientVersion,
          }),
        },
      );
      message.success("基本信息更新成功！");
      refetch();
    } catch (error: any) {
      message.error(error.message || "更新基本信息失败");
    }
  };

  // OIDC Revision configuration update handler
  const handleSaveConfig = async (values: any) => {
    try {
      const cleanRedirectUris = (values.redirectUris || []).filter(
        (u: string) => u && u.trim(),
      );
      const cleanPostLogoutRedirectUris = (
        values.postLogoutRedirectUris || []
      ).filter((u: string) => u && u.trim());

      const payload: any = {
        redirectUris: cleanRedirectUris,
        postLogoutRedirectUris: cleanPostLogoutRedirectUris,
        scopeWhitelist: values.scopeWhitelist || ["openid"],
      };

      // If there is an existing draft, pass its credentials
      if (client.proposedRevision?.status === "draft") {
        payload.revisionId = client.proposedRevision.revisionId;
        payload.revisionVersion = client.proposedRevision.version;
      }

      await request(
        `/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/revision`,
        {
          method: "PUT",
          body: JSON.stringify(payload),
        },
      );

      message.success("OIDC 配置保存成功！");
      setIsEditingConfig(false);
      refetch();
    } catch (error: any) {
      message.error(error.message || "保存配置失败");
    }
  };

  // Revision submit review
  const handleSubmitReview = async () => {
    if (!client.proposedRevision) return;
    try {
      await request(
        `/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/revision/submit`,
        {
          method: "POST",
          body: JSON.stringify({
            revisionId: client.proposedRevision.revisionId,
            revisionVersion: client.proposedRevision.version,
          }),
        },
      );
      message.success("配置变更已提交审核。");
      refetch();
    } catch (error: any) {
      message.error(error.message || "提交审核失败");
    }
  };

  // Revision withdraw review
  const handleWithdrawReview = async () => {
    if (!client.proposedRevision) return;
    try {
      await request(
        `/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/revision/withdraw`,
        {
          method: "POST",
          body: JSON.stringify({
            revisionId: client.proposedRevision.revisionId,
            revisionVersion: client.proposedRevision.version,
          }),
        },
      );
      message.success("配置变更已撤回为草稿。");
      refetch();
    } catch (error: any) {
      message.error(error.message || "撤回失败");
    }
  };

  // Admin Approve
  const handleApprove = async () => {
    if (!client.proposedRevision) return;
    try {
      await request(
        `/admin/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/revisions/${client.proposedRevision.revisionId}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            revisionId: client.proposedRevision.revisionId,
            revisionVersion: client.proposedRevision.version,
          }),
        },
      );
      message.success("审核已批准，配置立即生效。");
      refetch();
    } catch (error: any) {
      message.error(error.message || "批准失败");
    }
  };

  // Admin Reject
  const handleReject = async (reason: string) => {
    if (!client.proposedRevision) return;
    try {
      await request(
        `/admin/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/revisions/${client.proposedRevision.revisionId}/reject`,
        {
          method: "POST",
          body: JSON.stringify({
            revisionId: client.proposedRevision.revisionId,
            revisionVersion: client.proposedRevision.version,
            reason,
          }),
        },
      );
      message.success("已拒绝此配置变更。");
      refetch();
    } catch (error: any) {
      message.error(error.message || "拒绝失败");
    }
  };

  // Rotate Secret
  const handleRotateSecret = async () => {
    try {
      const res = await request<{ secret: { value: string } }>(
        `/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/secrets/rotate`,
        {
          method: "POST",
          body: JSON.stringify({
            clientVersion: client.clientVersion,
            gracePeriodSeconds: rotationGraceHours * 3600,
          }),
        },
      );
      setOneTimeSecret(res.secret.value);
      message.success("Secret 轮换完成，新凭据已生成。");
      refetch();
    } catch (error: any) {
      message.error(error.message || "Secret 轮换失败");
    }
  };

  // Revoke Secret
  const handleRevokeSecret = (secretId: string, secretVersion: number) => {
    Modal.confirm({
      title: "确定撤销此 Secret 吗？",
      icon: <ExclamationCircleOutlined />,
      content: "撤销操作立即生效，使用该凭据的连接将即刻断开。此操作不可恢复！",
      okText: "确认撤销",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await request(
            `/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/secrets/${encodeURIComponent(secretId)}/revoke`,
            {
              method: "POST",
              body: JSON.stringify({
                clientVersion: client.clientVersion,
                secretVersion: secretVersion,
              }),
            },
          );
          message.success("Secret 撤销成功。");
          refetch();
        } catch (error: any) {
          message.error(error.message || "撤销 Secret 失败");
        }
      },
    });
  };

  // Revoke all authorizations
  const handleRevokeAllAuths = async () => {
    try {
      await request(
        `/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/authorizations/revoke`,
        {
          method: "POST",
          body: JSON.stringify({
            clientVersion: client.clientVersion,
          }),
        },
      );
      message.success("该客户端的所有已签发授权 (Tokens) 已成功撤销。");
      setConfirmRevokeAuthsVisible(false);
      refetch();
    } catch (error: any) {
      message.error(error.message || "撤销全部授权失败");
    }
  };

  // Emergency disable client
  const handleEmergencyDisable = async () => {
    try {
      await request(
        `/projects/${encodeURIComponent(projectId!)}/clients/${encodeURIComponent(clientId!)}/disable`,
        {
          method: "POST",
          body: JSON.stringify({
            clientVersion: client.clientVersion,
          }),
        },
      );
      message.success("该客户端已被紧急永久停用，所有凭据和会话已撤销。");
      setConfirmDisableVisible(false);
      refetch();
    } catch (error: any) {
      message.error(error.message || "紧急停用失败");
    }
  };

  // Client scopes whitelist display values
  const currentProposedOrActive =
    client.proposedRevision ?? client.activeRevision;

  return (
    <Card
      title={
        <Space>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() =>
              navigate(`/projects/${encodeURIComponent(projectId!)}/clients`)
            }
          />
          <Space direction="vertical" size={0}>
            <Title level={4} style={{ margin: 0 }}>
              {client.displayName}
            </Title>
            <Text type="secondary" style={{ fontSize: "12px" }}>
              ID: <Text code>{client.clientId}</Text>
            </Text>
          </Space>
        </Space>
      }
      extra={
        <Space>
          <ClientStatusTag
            status={client.lifecycleStatus}
            proposedStatus={client.proposedRevision?.status}
          />
        </Space>
      }
    >
      <Tabs
        activeKey={getActiveTab()}
        onChange={handleTabChange}
        items={[
          {
            key: "overview",
            label: "概览",
            children: (
              <Row gutter={24}>
                <Col xs={24} md={16}>
                  <Space
                    direction="vertical"
                    style={{ width: "100%" }}
                    size="large"
                  >
                    <Card type="inner" title="基本元数据">
                      <Form
                        form={metaForm}
                        layout="vertical"
                        onFinish={handleSaveMeta}
                        disabled={!canWrite}
                      >
                        <Form.Item
                          label="显示名称"
                          name="displayName"
                          rules={[
                            { required: true, message: "请输入客户端显示名称" },
                          ]}
                        >
                          <Input maxLength={100} />
                        </Form.Item>
                        <Form.Item label="描述" name="description">
                          <Input.TextArea maxLength={1000} showCount rows={3} />
                        </Form.Item>
                        {canWrite && (
                          <Form.Item>
                            <Button
                              type="primary"
                              htmlType="submit"
                              icon={<SaveOutlined />}
                            >
                              保存基本信息
                            </Button>
                          </Form.Item>
                        )}
                      </Form>
                    </Card>
                  </Space>
                </Col>
                <Col xs={24} md={8}>
                  <Card type="inner" title="系统信息">
                    <Descriptions column={1} size="small">
                      <Descriptions.Item label="客户端类型">
                        <Tag color="purple">
                          {client.clientType.toUpperCase()}
                        </Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="乐观锁版本">
                        <Text code>{client.clientVersion}</Text>
                      </Descriptions.Item>
                      <Descriptions.Item label="最后更新">
                        {new Date(client.updatedAt).toLocaleString("zh-CN")}
                      </Descriptions.Item>
                    </Descriptions>
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: "configuration",
            label: "OIDC 配置 & 版本",
            children: (
              <Space
                direction="vertical"
                style={{ width: "100%" }}
                size="large"
              >
                {client.proposedRevision?.rejectionReason && (
                  <Alert
                    message="最近一次变更提案被驳回"
                    description={`驳回原因：${client.proposedRevision.rejectionReason}`}
                    type="error"
                    showIcon
                  />
                )}

                {client.proposedRevision?.status === "pending" && (
                  <Alert
                    message="配置变更审核中"
                    description="该客户端存在一个正在审核的配置变更提案。审核通过前，OIDC 运行期将继续采用当前生效配置。审核期间禁止修改配置。"
                    type="info"
                    showIcon
                    action={
                      canWrite ? (
                        <Button
                          size="small"
                          type="primary"
                          onClick={handleWithdrawReview}
                        >
                          撤回审核
                        </Button>
                      ) : undefined
                    }
                  />
                )}

                <RevisionDiff
                  active={client.activeRevision}
                  proposed={client.proposedRevision}
                />

                {/* Edit Form for configuration */}
                {canWrite && (
                  <>
                    {client.proposedRevision?.status !== "pending" &&
                      !isEditingConfig && (
                        <Button
                          type="primary"
                          onClick={() => setIsEditingConfig(true)}
                        >
                          修改 OIDC 配置
                        </Button>
                      )}

                    {isEditingConfig && (
                      <Card title="编辑 OIDC 变更配置" type="inner">
                        <Form
                          form={configForm}
                          layout="vertical"
                          onFinish={handleSaveConfig}
                        >
                          <Form.List name="redirectUris">
                            {(fields, { add, remove }) => (
                              <div style={{ marginBottom: "20px" }}>
                                <Text
                                  strong
                                  style={{
                                    display: "block",
                                    marginBottom: "8px",
                                  }}
                                >
                                  重定向 URI (Redirect URIs){" "}
                                  <span style={{ color: "#ff4d4f" }}>*</span>
                                </Text>
                                {fields.map((field) => (
                                  <Form.Item
                                    required={false}
                                    key={field.key}
                                    style={{ marginBottom: "8px" }}
                                  >
                                    <Space align="baseline">
                                      <Form.Item
                                        {...field}
                                        rules={[
                                          {
                                            required: true,
                                            whitespace: true,
                                            message:
                                              "请输入 Redirect URI 或删除",
                                          },
                                        ]}
                                        noStyle
                                      >
                                        <Input
                                          placeholder="https://example.com/callback"
                                          style={{ width: 400 }}
                                        />
                                      </Form.Item>
                                      {fields.length > 1 && (
                                        <Button
                                          type="text"
                                          danger
                                          icon={<DeleteOutlined />}
                                          onClick={() => remove(field.name)}
                                        />
                                      )}
                                    </Space>
                                  </Form.Item>
                                ))}
                                <Button
                                  type="dashed"
                                  onClick={() => add()}
                                  icon={<PlusOutlined />}
                                  style={{ width: 400 }}
                                >
                                  添加 Redirect URI
                                </Button>
                              </div>
                            )}
                          </Form.List>

                          <Form.List name="postLogoutRedirectUris">
                            {(fields, { add, remove }) => (
                              <div style={{ marginBottom: "20px" }}>
                                <Text
                                  strong
                                  style={{
                                    display: "block",
                                    marginBottom: "8px",
                                  }}
                                >
                                  注销后重定向 URI (Post Logout Redirect URIs)
                                </Text>
                                {fields.map((field) => (
                                  <Form.Item
                                    required={false}
                                    key={field.key}
                                    style={{ marginBottom: "8px" }}
                                  >
                                    <Space align="baseline">
                                      <Form.Item
                                        {...field}
                                        rules={[
                                          {
                                            required: true,
                                            whitespace: true,
                                            message: "请输入 Logout URI 或删除",
                                          },
                                        ]}
                                        noStyle
                                      >
                                        <Input
                                          placeholder="https://example.com/logged-out"
                                          style={{ width: 400 }}
                                        />
                                      </Form.Item>
                                      <Button
                                        type="text"
                                        danger
                                        icon={<DeleteOutlined />}
                                        onClick={() => remove(field.name)}
                                      />
                                    </Space>
                                  </Form.Item>
                                ))}
                                <Button
                                  type="dashed"
                                  onClick={() => add()}
                                  icon={<PlusOutlined />}
                                  style={{ width: 400 }}
                                >
                                  添加 Logout URI
                                </Button>
                              </div>
                            )}
                          </Form.List>

                          <Form.Item
                            label="允许的作用域 (Scope Whitelist)"
                            name="scopeWhitelist"
                          >
                            <Checkbox.Group style={{ width: "100%" }}>
                              <Space direction="vertical">
                                {clientScopes.map((scope) => (
                                  <Checkbox
                                    key={scope.value}
                                    value={scope.value}
                                    disabled={
                                      scope.disabled ||
                                      (client.clientType === "spa" &&
                                        scope.value === "offline_access")
                                    }
                                  >
                                    {scope.label}
                                  </Checkbox>
                                ))}
                              </Space>
                            </Checkbox.Group>
                          </Form.Item>

                          <Form.Item>
                            <Space>
                              <Button
                                type="primary"
                                htmlType="submit"
                                icon={<SaveOutlined />}
                              >
                                保存为草稿
                              </Button>
                              <Button onClick={() => setIsEditingConfig(false)}>
                                取消
                              </Button>
                            </Space>
                          </Form.Item>
                        </Form>
                      </Card>
                    )}

                    {client.proposedRevision?.status === "draft" &&
                      !isEditingConfig && (
                        <Button
                          type="primary"
                          icon={<SendOutlined />}
                          onClick={handleSubmitReview}
                        >
                          提交配置审核
                        </Button>
                      )}
                  </>
                )}

                {/* Admin review buttons */}
                {activeProject.capabilities.includes("review") &&
                  client.proposedRevision?.status === "pending" &&
                  !isClientDisabled && (
                    <Card
                      title="管理员审核入口"
                      type="inner"
                      style={{ border: "1px solid #1890ff" }}
                    >
                      <Alert
                        message="审核提示"
                        description="您当前正在以管理员身份审核此项目的客户端配置变更。"
                        type="info"
                        showIcon
                        style={{ marginBottom: "16px" }}
                      />
                      <Space>
                        <Button type="primary" onClick={handleApprove}>
                          批准变更并上线
                        </Button>
                        <Button
                          type="primary"
                          danger
                          onClick={() => {
                            Modal.confirm({
                              title: "拒绝配置变更",
                              content: (
                                <Input
                                  id="reject-reason-input"
                                  placeholder="请输入拒绝原因（必填）"
                                  style={{ marginTop: "12px" }}
                                />
                              ),
                              okText: "确认拒绝",
                              okType: "danger",
                              onOk: () => {
                                const input = document.getElementById(
                                  "reject-reason-input",
                                ) as HTMLInputElement;
                                const reason = input?.value?.trim();
                                if (!reason) {
                                  message.error("必须填写拒绝原因");
                                  return Promise.reject();
                                }
                                return handleReject(reason);
                              },
                            });
                          }}
                        >
                          拒绝变更
                        </Button>
                      </Space>
                    </Card>
                  )}
              </Space>
            ),
          },
          {
            key: "secrets",
            label: "凭据管理",
            disabled: client.clientType === "spa",
            children: (
              <Space
                direction="vertical"
                style={{ width: "100%" }}
                size="large"
              >
                <Alert
                  message="安全指示"
                  description="客户端凭据明文只会在初次创建或手动轮换生成时显示一次，关闭展示框后没有任何手段可以恢复或查询明文值。"
                  type="info"
                  showIcon
                />

                <Table
                  dataSource={client.secrets}
                  rowKey="secretId"
                  pagination={{ pageSize: 5 }}
                  columns={[
                    {
                      title: "Secret ID (标识前缀)",
                      dataIndex: "secretId",
                      key: "secretId",
                      render: (text: string) => <Text code>{text}</Text>,
                    },
                    {
                      title: "状态",
                      key: "status",
                      render: (_: any, record: any) => (
                        <SecretStatusTag secret={record} />
                      ),
                    },
                    {
                      title: "创建时间",
                      dataIndex: "createdAt",
                      key: "createdAt",
                      render: (text: string) =>
                        new Date(text).toLocaleString("zh-CN"),
                    },
                    {
                      title: "到期时间",
                      dataIndex: "expiresAt",
                      key: "expiresAt",
                      render: (text: string) =>
                        text
                          ? new Date(text).toLocaleString("zh-CN")
                          : "永久生效",
                    },
                    {
                      title: "操作",
                      key: "action",
                      render: (_: any, record: any) => {
                        const canRevokeSecret =
                          activeProject.capabilities.includes(
                            "revoke_secret",
                          ) &&
                          !isArchived &&
                          !isClientDisabled;
                        if (record.status === "revoked" || !canRevokeSecret)
                          return null;
                        return (
                          <Button
                            type="primary"
                            danger
                            size="small"
                            onClick={() =>
                              handleRevokeSecret(
                                record.secretId,
                                record.version,
                              )
                            }
                          >
                            撤销 Secret
                          </Button>
                        );
                      },
                    },
                  ]}
                />

                {activeProject.capabilities.includes("rotate_secret") &&
                  !isArchived &&
                  !isClientDisabled && (
                    <Card title="轮换 Client Secret" type="inner">
                      <Space
                        direction="vertical"
                        size="middle"
                        style={{ width: "100%" }}
                      >
                        <div>
                          <Text style={{ marginRight: "12px" }}>
                            旧 Secret 宽限保留期 (小时):{" "}
                          </Text>
                          <InputNumber
                            min={0}
                            max={168} // Up to 7 days
                            value={rotationGraceHours}
                            onChange={(val) => setRotationGraceHours(val || 0)}
                          />
                          <Text
                            type="secondary"
                            style={{ marginLeft: "12px", fontSize: "13px" }}
                          >
                            轮换生成新 Secret 后，原旧 Secret
                            将在此时间内保持可用（平滑过渡）。
                          </Text>
                        </div>
                        <Button
                          type="primary"
                          icon={<RetweetOutlined />}
                          onClick={handleRotateSecret}
                        >
                          轮换 Client Secret
                        </Button>
                      </Space>
                    </Card>
                  )}
              </Space>
            ),
          },
          {
            key: "safety",
            label: "安全操作 (Danger Zone)",
            children: (
              <Card
                title="危险操作区"
                type="inner"
                headStyle={{ borderBottom: "1px solid #ff4d4f" }}
                style={{ border: "1px solid #ff4d4f" }}
              >
                <Space
                  direction="vertical"
                  style={{ width: "100%" }}
                  size="large"
                >
                  <div>
                    <Title level={5} danger>
                      撤销客户端全部授权
                    </Title>
                    <Paragraph type="secondary">
                      立即废弃该客户端已签发的所有访问令牌 (Access
                      Tokens)、刷新令牌 (Refresh Tokens)、授权码 (Authorization
                      Codes) 和用户 Grants。此操作不会影响 Secret
                      凭据，已登录的用户会被立即踢出。
                    </Paragraph>
                    <Button
                      type="primary"
                      danger
                      disabled={
                        !activeProject.capabilities.includes(
                          "revoke_authorizations",
                        ) ||
                        isArchived ||
                        isClientDisabled
                      }
                      onClick={() => setConfirmRevokeAuthsVisible(true)}
                    >
                      立即撤销全部授权
                    </Button>
                  </div>

                  <Divider />

                  <div>
                    <Title level={5} danger>
                      紧急停用客户端
                    </Title>
                    <Paragraph type="secondary">
                      紧急停用该客户端，此操作为
                      <strong>永久性、不可恢复</strong>
                      操作。停用后该客户端所有凭据立即作废，所有活跃授权全部清空，项目待审配额立即释放。
                    </Paragraph>
                    <Button
                      type="primary"
                      danger
                      icon={<PoweroffOutlined />}
                      disabled={
                        !activeProject.capabilities.includes(
                          "disable_client",
                        ) ||
                        isArchived ||
                        isClientDisabled
                      }
                      onClick={() => setConfirmDisableVisible(true)}
                    >
                      紧急停用客户端
                    </Button>
                  </div>
                </Space>
              </Card>
            ),
          },
          {
            key: "audit",
            label: "审计日志",
            children: (
              <Space
                direction="vertical"
                style={{ width: "100%" }}
                size="middle"
              >
                <Table
                  dataSource={audits}
                  rowKey="id"
                  loading={auditsLoading}
                  pagination={false}
                  columns={[
                    {
                      title: "时间",
                      dataIndex: "createdAt",
                      key: "createdAt",
                      render: (text: string) =>
                        new Date(text).toLocaleString("zh-CN"),
                    },
                    {
                      title: "操作人",
                      dataIndex: "subjectId",
                      key: "subjectId",
                      render: (text: string) => (
                        <Text code>{text || "系统"}</Text>
                      ),
                    },
                    {
                      title: "操作行为",
                      dataIndex: "action",
                      key: "action",
                    },
                    {
                      title: "来源 IP",
                      dataIndex: "details",
                      key: "ip",
                      render: (details: any) => details?.ip || "未知",
                    },
                    {
                      title: "变更细节",
                      dataIndex: "details",
                      key: "details",
                      render: (details: any) => (
                        <pre
                          style={{
                            margin: 0,
                            fontSize: "11px",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-all",
                          }}
                        >
                          {JSON.stringify(details, null, 2)}
                        </pre>
                      ),
                    },
                  ]}
                />
                {hasMoreAudits && (
                  <div style={{ textAlign: "center", marginTop: "16px" }}>
                    <Button
                      onClick={() => loadAudits(true)}
                      loading={auditsLoading}
                    >
                      加载更多日志
                    </Button>
                  </div>
                )}
              </Space>
            ),
          },
        ]}
      />

      {/* Popups */}
      <OneTimeSecretModal
        secret={oneTimeSecret}
        clientId={clientId!}
        onClose={() => setOneTimeSecret(null)}
      />

      <ConfirmActionModal
        title="确认紧急停用客户端"
        visible={confirmDisableVisible}
        content="警告：此操作不可撤销！这会永久销毁该客户端的所有 Client Secret、撤销全部已签发 Token 并使其立即下线。"
        expectedValue={clientId!}
        confirmPlaceholder="请输入客户端 ID 以确认停用"
        onConfirm={handleEmergencyDisable}
        onCancel={() => setConfirmDisableVisible(false)}
      />

      <ConfirmActionModal
        title="确认撤销全部授权"
        visible={confirmRevokeAuthsVisible}
        content="这会立即作废该客户端所有已签发 Access Token, Refresh Token 和 Grant，使用此客户端登录的所有用户会被立即强制注销下线。"
        expectedValue={clientId!}
        confirmPlaceholder="请输入客户端 ID 以确认撤销"
        onConfirm={handleRevokeAllAuths}
        onCancel={() => setConfirmRevokeAuthsVisible(false)}
      />
    </Card>
  );
};
