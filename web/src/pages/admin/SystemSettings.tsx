import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Typography,
  Modal,
} from "antd";
import {
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { request } from "../../api/client";
import type { EmailProviderKind, RuntimePolicyView } from "../../api/types";

const { Text } = Typography;
const SECRET_PLACEHOLDER = "已配置（留空则保持不变）";

const groups = [
  [
    "时效策略",
    [
      ["csrfTokenTtlSeconds", "CSRF Token 有效期"],
      ["sessionTtlSeconds", "会话绝对有效期"],
      ["sessionIdleTtlSeconds", "会话空闲有效期"],
      ["interactionTtlSeconds", "交互有效期"],
      ["authorizationCodeTtlSeconds", "授权码有效期"],
      ["accessTokenTtlSeconds", "Access Token 有效期"],
      ["idTokenTtlSeconds", "ID Token 有效期"],
      ["refreshTokenTtlSeconds", "Refresh Token 有效期"],
      ["grantTtlSeconds", "Grant 有效期"],
      ["emailVerifyCodeTtlSeconds", "验证码有效期"],
      ["emailVerifyResendCooldownSeconds", "验证码重发冷却"],
      ["emailVerifyMaxAttempts", "验证码最大尝试次数"],
    ],
  ],
  [
    "业务限流",
    [
      ["loginRateLimitMax", "登录请求上限"],
      ["loginRateLimitWindowSeconds", "登录限流窗口"],
      ["loginFailureLimit", "登录失败上限"],
      ["loginFailureWindowSeconds", "登录失败窗口"],
      ["tokenRateLimitMax", "Token 请求上限"],
      ["tokenRateLimitWindowSeconds", "Token 限流窗口"],
      ["emailVerifyRateLimitSubjectMax", "验证码 Subject 上限"],
      ["emailVerifyRateLimitSubjectWindowSeconds", "验证码 Subject 窗口"],
      ["emailVerifyRateLimitEmailMax", "验证码邮箱上限"],
      ["emailVerifyRateLimitEmailWindowSeconds", "验证码邮箱窗口"],
      ["emailVerifyRateLimitDomainMax", "验证码域名上限"],
      ["emailVerifyRateLimitDomainWindowSeconds", "验证码域名窗口"],
      ["emailVerifyRateLimitIpMax", "验证码 IP 上限"],
      ["emailVerifyRateLimitIpWindowSeconds", "验证码 IP 窗口"],
      ["managementProjectCreateRateLimitSubjectMax", "项目创建 Subject 上限"],
      ["managementProjectCreateRateLimitIpMax", "项目创建 IP 上限"],
      ["managementProjectCreateRateLimitWindowSeconds", "项目创建窗口"],
      ["managementClientCreateRateLimitSubjectMax", "客户端创建 Subject 上限"],
      ["managementClientCreateRateLimitIpMax", "客户端创建 IP 上限"],
      ["managementClientCreateRateLimitWindowSeconds", "客户端创建窗口"],
      ["clientSecretRotateRateLimitSubjectMax", "密钥轮换 Subject 上限"],
      ["clientSecretRotateRateLimitClientMax", "密钥轮换客户端上限"],
      ["clientSecretRotateRateLimitIpMax", "密钥轮换 IP 上限"],
      ["clientSecretRotateRateLimitWindowSeconds", "密钥轮换窗口"],
      ["clientSecretRotateMinimumIntervalSeconds", "密钥轮换最短间隔"],
    ],
  ],
  [
    "项目与客户端配额",
    [
      ["managementProjectMaxActivePerSubject", "每个 Subject 的活动项目上限"],
      ["managementClientMaxPerProject", "每项目客户端上限"],
      ["managementClientMaxPendingPerProject", "每项目待审核客户端上限"],
      ["managementClientMaxPerSubject", "每 Subject 客户端上限"],
      ["managementClientMaxPendingPerSubject", "每 Subject 待审核客户端上限"],
      ["clientSecretDefaultGraceSeconds", "密钥默认宽限期"],
      ["clientSecretMaxGraceSeconds", "密钥最大宽限期"],
    ],
  ],
] as const;

export const SystemSettings: React.FC = () => {
  const [form] = Form.useForm();
  const [view, setView] = useState<RuntimePolicyView>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const provider = Form.useWatch(["email", "provider"], form) as
    | EmailProviderKind
    | undefined;

  const load = useCallback(async () => {
    try {
      const result = await request<{ settings: RuntimePolicyView }>(
        "/settings/runtime-policy",
      );
      setView(result.settings);
      form.setFieldsValue({
        policy: result.settings.policy,
        email: {
          provider: result.settings.email.provider,
          resend: { from: result.settings.email.resend.from, apiKey: "" },
          smtp: { ...result.settings.email.smtp, password: "" },
        },
      });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    }
  }, [form]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (values: any) => {
    if (!view) return;
    setSaving(true);
    try {
      const result = await request<{ settings: RuntimePolicyView }>(
        "/settings/runtime-policy",
        {
          method: "PUT",
          body: JSON.stringify({
            expectedVersion: view.version,
            policy: values.policy,
            email: values.email,
          }),
        },
      );
      setView(result.settings);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (!view) return;
    try {
      const recipient = form.getFieldValue("testRecipient");
      await request("/settings/runtime-policy/email/test", {
        method: "POST",
        body: JSON.stringify({ expectedVersion: view.version, recipient }),
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "测试发送失败");
    }
  };

  const restart = () => {
    Modal.confirm({
      title: "确认重启服务？",
      content: "服务会短暂不可用，保存的系统设置将在重启后生效。",
      okText: "重启",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        setRestarting(true);
        try {
          await request("/settings/runtime-policy/restart", { method: "POST" });
        } catch (reason) {
          setRestarting(false);
          setError(reason instanceof Error ? reason.message : "重启失败");
        }
      },
    });
  };

  if (!view && !error) return <Spin />;
  return (
    <Card
      title={
        <Space>
          <SettingOutlined />
          系统设置
        </Space>
      }
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {error && <Alert type="error" showIcon message={error} />}
        {view?.restartRequired && (
          <Alert
            type="warning"
            showIcon
            message="配置已保存，重启服务后生效"
            description={`当前进程版本 ${view.loadedVersion}，数据库版本 ${view.version}`}
          />
        )}
        <Alert
          type="info"
          showIcon
          message="所有配置保存后，重启生效；密钥只加密存储且不会回显。"
        />
        <Form form={form} layout="vertical" onFinish={save}>
          <Collapse
            defaultActiveKey={["email"]}
            items={[
              {
                key: "email",
                label: "邮件发送",
                children: (
                  <>
                    <Form.Item
                      name={["email", "provider"]}
                      label="发送通道"
                      rules={[{ required: true }]}
                    >
                      <Select
                        options={[
                          { value: "resend", label: "Resend" },
                          { value: "smtp", label: "SMTP" },
                          { value: "disabled", label: "停用" },
                        ]}
                      />
                    </Form.Item>
                    {provider === "resend" && (
                      <>
                        <Form.Item
                          name={["email", "resend", "apiKey"]}
                          label="Resend API Key"
                          extra={
                            view?.email.resend.apiKeyConfigured
                              ? SECRET_PLACEHOLDER
                              : "尚未配置"
                          }
                        >
                          <Input.Password />
                        </Form.Item>
                        <Form.Item
                          name={["email", "resend", "from"]}
                          label="发件人"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </>
                    )}
                    {provider === "smtp" && (
                      <>
                        <Form.Item
                          name={["email", "smtp", "host"]}
                          label="SMTP 主机"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                        <Form.Item
                          name={["email", "smtp", "port"]}
                          label="端口"
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} max={65535} />
                        </Form.Item>
                        <Form.Item
                          name={["email", "smtp", "secure"]}
                          label="TLS"
                          valuePropName="checked"
                        >
                          <Switch />
                        </Form.Item>
                        <Form.Item
                          name={["email", "smtp", "user"]}
                          label="用户名"
                        >
                          <Input />
                        </Form.Item>
                        <Form.Item
                          name={["email", "smtp", "password"]}
                          label="密码"
                          extra={
                            view?.email.smtp.passwordConfigured
                              ? SECRET_PLACEHOLDER
                              : undefined
                          }
                        >
                          <Input.Password />
                        </Form.Item>
                        <Form.Item
                          name={["email", "smtp", "from"]}
                          label="发件人"
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      </>
                    )}
                    {provider !== "disabled" && (
                      <Space align="end">
                        <Form.Item name="testRecipient" label="测试收件人">
                          <Input />
                        </Form.Item>
                        <Button icon={<SendOutlined />} onClick={sendTest}>
                          测试待生效配置
                        </Button>
                      </Space>
                    )}
                  </>
                ),
              },
              ...groups.map(([title, fields]) => ({
                key: title,
                label: title,
                children: (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
                      gap: "0 20px",
                    }}
                  >
                    {fields.map(([key, label]) => (
                      <Form.Item
                        key={key}
                        name={["policy", key]}
                        label={`${label}（秒/次）`}
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          min={
                            key === "clientSecretDefaultGraceSeconds" ||
                            key === "clientSecretRotateMinimumIntervalSeconds"
                              ? 0
                              : 1
                          }
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    ))}
                  </div>
                ),
              })),
              {
                key: "exempt",
                label: "管理员豁免",
                children: (
                  <Space direction="vertical">
                    <Form.Item
                      name={["policy", "managementProjectQuotaAdminExempt"]}
                      valuePropName="checked"
                    >
                      <Switch /> <Text>管理员豁免项目配额</Text>
                    </Form.Item>
                    <Form.Item
                      name={["policy", "managementClientQuotaAdminExempt"]}
                      valuePropName="checked"
                    >
                      <Switch /> <Text>管理员豁免客户端配额</Text>
                    </Form.Item>
                  </Space>
                ),
              },
            ]}
          />
          <Space style={{ marginTop: 16 }}>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={saving}
            >
              保存系统设置
            </Button>
            <Button
              danger
              icon={<ReloadOutlined />}
              loading={restarting}
              disabled={!view?.restartRequired}
              onClick={restart}
            >
              重启服务
            </Button>
          </Space>
        </Form>
      </Space>
    </Card>
  );
};
