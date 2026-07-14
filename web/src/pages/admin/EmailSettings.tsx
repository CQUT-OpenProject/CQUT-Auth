import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
  message,
} from "antd";
import { MailOutlined, SaveOutlined } from "@ant-design/icons";
import { request } from "../../api/client";

const { Text, Paragraph } = Typography;

type EmailProviderKind = "resend" | "smtp" | "disabled";

type EmailSettingsView = {
  provider: EmailProviderKind;
  resend: {
    from: string;
    apiKeyConfigured: boolean;
  };
  smtp: {
    host: string;
    port: number | null;
    secure: boolean;
    user: string;
    from: string;
    passwordConfigured: boolean;
  };
  updatedAt: string | null;
};

const SECRET_PLACEHOLDER = "已配置（留空则保持不变）";

export const EmailSettings: React.FC = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [view, setView] = useState<EmailSettingsView | null>(null);
  const provider = Form.useWatch("provider", form) as
    | EmailProviderKind
    | undefined;

  const applyView = (next: EmailSettingsView) => {
    setView(next);
    form.setFieldsValue({
      provider: next.provider,
      resendFrom: next.resend.from,
      resendApiKey: "",
      smtpHost: next.smtp.host,
      smtpPort: next.smtp.port ?? undefined,
      smtpSecure: next.smtp.secure,
      smtpUser: next.smtp.user,
      smtpFrom: next.smtp.from,
      smtpPassword: "",
    });
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await request<{ settings: EmailSettingsView }>(
        "/settings/email",
      );
      applyView(res.settings);
    } catch (error: any) {
      if (error?.status === 403) {
        setForbidden(true);
      } else {
        message.error("获取邮件设置失败：" + (error?.message ?? "未知错误"));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const res = await request<{ settings: EmailSettingsView }>(
        "/settings/email",
        {
          method: "PUT",
          body: JSON.stringify({
            provider: values.provider,
            resend: {
              from: values.resendFrom ?? "",
              // Blank secret keeps the currently stored key.
              apiKey: values.resendApiKey ?? "",
            },
            smtp: {
              host: values.smtpHost ?? "",
              port: values.smtpPort ?? null,
              secure: Boolean(values.smtpSecure),
              user: values.smtpUser ?? "",
              from: values.smtpFrom ?? "",
              password: values.smtpPassword ?? "",
            },
          }),
        },
      );
      applyView(res.settings);
      message.success("邮件设置已保存。");
    } catch (error: any) {
      message.error(error?.message ?? "保存邮件设置失败");
    } finally {
      setSaving(false);
    }
  };

  if (forbidden) {
    return (
      <Card title="邮件设置">
        <Alert
          type="error"
          showIcon
          message="需要管理员权限"
          description="仅系统管理员可以查看和修改邮件发送设置。"
        />
      </Card>
    );
  }

  return (
    <Card
      title={
        <Space>
          <MailOutlined />
          邮件发送设置
        </Space>
      }
      loading={loading}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="large">
        <Alert
          type="info"
          showIcon
          message="发送通道用于投递登录邮箱验证码。API 密钥/SMTP 密码以加密形式存储，页面不会回显明文。"
        />
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSave}
          style={{ maxWidth: 560 }}
        >
          <Form.Item
            name="provider"
            label="发送通道"
            rules={[{ required: true, message: "请选择发送通道" }]}
          >
            <Select
              options={[
                { value: "resend", label: "Resend" },
                { value: "smtp", label: "SMTP" },
                { value: "disabled", label: "停用（不发送邮件）" },
              ]}
            />
          </Form.Item>

          {provider === "resend" && (
            <>
              <Form.Item
                name="resendApiKey"
                label="Resend API Key"
                extra={
                  view?.resend.apiKeyConfigured
                    ? "已配置密钥，留空则保持不变。"
                    : "尚未配置密钥。"
                }
              >
                <Input.Password
                  autoComplete="new-password"
                  placeholder={
                    view?.resend.apiKeyConfigured
                      ? SECRET_PLACEHOLDER
                      : "re_..."
                  }
                />
              </Form.Item>
              <Form.Item
                name="resendFrom"
                label="发件人地址"
                rules={[{ required: true, message: "请输入发件人地址" }]}
              >
                <Input placeholder="CQUT Auth <noreply@example.edu.cn>" />
              </Form.Item>
            </>
          )}

          {provider === "smtp" && (
            <>
              <Form.Item
                name="smtpHost"
                label="SMTP 主机"
                rules={[{ required: true, message: "请输入 SMTP 主机" }]}
              >
                <Input placeholder="smtp.example.edu.cn" />
              </Form.Item>
              <Form.Item
                name="smtpPort"
                label="端口"
                rules={[{ required: true, message: "请输入端口" }]}
              >
                <InputNumber min={1} max={65535} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item
                name="smtpSecure"
                label="使用 TLS（端口 465 直连 TLS）"
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item name="smtpUser" label="用户名（可选）">
                <Input autoComplete="off" placeholder="登录用户名" />
              </Form.Item>
              <Form.Item
                name="smtpPassword"
                label="密码（可选）"
                extra={
                  view?.smtp.passwordConfigured
                    ? "已配置密码，留空则保持不变。"
                    : undefined
                }
              >
                <Input.Password
                  autoComplete="new-password"
                  placeholder={
                    view?.smtp.passwordConfigured ? SECRET_PLACEHOLDER : ""
                  }
                />
              </Form.Item>
              <Form.Item
                name="smtpFrom"
                label="发件人地址"
                rules={[{ required: true, message: "请输入发件人地址" }]}
              >
                <Input placeholder="CQUT Auth <noreply@example.edu.cn>" />
              </Form.Item>
            </>
          )}

          {provider === "disabled" && (
            <Paragraph type="secondary">
              选择「停用」后系统将不发送邮箱验证码。
            </Paragraph>
          )}

          <Form.Item>
            <Space direction="vertical">
              <Button
                type="primary"
                htmlType="submit"
                icon={<SaveOutlined />}
                loading={saving}
              >
                保存设置
              </Button>
              {view?.updatedAt && (
                <Text type="secondary">
                  上次更新：{new Date(view.updatedAt).toLocaleString("zh-CN")}
                </Text>
              )}
            </Space>
          </Form.Item>
        </Form>
      </Space>
    </Card>
  );
};
