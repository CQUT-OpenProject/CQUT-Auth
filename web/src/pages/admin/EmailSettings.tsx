import React, { useCallback, useEffect } from "react";
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
} from "antd";
import { MailOutlined, SaveOutlined, SendOutlined } from "@ant-design/icons";
import {
  useCustomMutation,
  useInvalidate,
  useNotification,
  useOne,
  useUpdate,
} from "@refinedev/core";
import { ApiError } from "../../api/errors";
import type {
  EmailProviderKind,
  EmailSettingsTestInput,
  EmailSettingsUpdate,
  EmailSettingsView,
} from "../../api/types";

const { Text, Paragraph } = Typography;
const SECRET_PLACEHOLDER = "已配置（留空则保持不变）";

type EmailSettingsFormValues = {
  provider: EmailProviderKind;
  resendFrom?: string;
  resendApiKey?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpFrom?: string;
  smtpPassword?: string;
  testRecipient?: string;
};

export const EmailSettings: React.FC = () => {
  const [form] = Form.useForm<EmailSettingsFormValues>();
  const { open } = useNotification();
  const invalidate = useInvalidate();
  const { query, result: view } = useOne<EmailSettingsView, ApiError>({
    resource: "emailSettings",
    id: "email",
    errorNotification: false,
  });
  const saveMutation = useUpdate<
    EmailSettingsView,
    ApiError,
    EmailSettingsUpdate
  >();
  const testMutation = useCustomMutation<
    EmailSettingsView,
    ApiError,
    EmailSettingsTestInput
  >();
  const provider = Form.useWatch("provider", form) as
    | EmailProviderKind
    | undefined;

  const applyView = useCallback(
    (next: EmailSettingsView) => {
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
    },
    [form],
  );

  useEffect(() => {
    if (view) applyView(view);
  }, [applyView, view]);

  const notifyError = useCallback(
    (message: string, error: unknown) => {
      open?.({
        type: "error",
        message,
        description:
          error instanceof Error ? error.message : "请求失败，请稍后重试。",
      });
    },
    [open],
  );

  const handleSave = async (values: EmailSettingsFormValues) => {
    if (!view) return;
    try {
      const response = await saveMutation.mutateAsync({
        resource: "emailSettings",
        id: "email",
        values: {
          expectedVersion: view.version,
          provider: values.provider,
          resend: {
            from: values.resendFrom ?? "",
            apiKey: values.resendApiKey ?? "",
          },
          smtp: {
            host: values.smtpHost ?? "",
            port: values.smtpPort ?? null,
            secure: values.smtpSecure === true,
            user: values.smtpUser ?? "",
            from: values.smtpFrom ?? "",
            password: values.smtpPassword ?? "",
          },
        },
        invalidates: ["detail"],
        successNotification: false,
        errorNotification: false,
      });
      applyView(response.data);
      open?.({
        type: "success",
        message: "邮件设置已保存",
        description:
          response.data.provider === "disabled"
            ? "邮件发送已停用。"
            : "新配置已立即生效；建议现在发送测试邮件。",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await query.refetch();
      }
      notifyError("保存邮件设置失败", error);
    }
  };

  const handleTest = async () => {
    if (!view) return;
    try {
      const { testRecipient } = await form.validateFields(["testRecipient"]);
      const response = await testMutation.mutateAsync({
        url: "/settings/email/test",
        method: "post",
        values: {
          expectedVersion: view.version,
          recipient: testRecipient ?? "",
        },
        successNotification: false,
        errorNotification: false,
      });
      applyView(response.data);
      await invalidate({
        resource: "emailSettings",
        id: "email",
        invalidates: ["detail"],
      });
      open?.({
        type: "success",
        message: "测试邮件已发送",
        description: "当前邮件配置已标记为验证成功。",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await query.refetch();
      }
      notifyError("测试邮件发送失败", error);
    }
  };

  if (query.error) {
    return (
      <Card title="邮件设置">
        <Alert
          type="error"
          showIcon
          message="获取邮件设置失败"
          description={query.error.message}
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
      loading={query.isLoading}
    >
      {view && (
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <Alert
            type="info"
            showIcon
            message="保存后配置会立即用于邮箱验证码投递。API 密钥和 SMTP 密码只会加密存储，不会回显明文。"
          />

          {view.source === "environment" && (
            <Alert
              type="info"
              showIcon
              message="当前 Resend 配置来自环境变量"
              description="首次保存时，留空的 API Key 会继承环境变量中的值并加密转存到数据库。"
            />
          )}

          {view.verification.status === "unverified" && (
            <Alert
              type="warning"
              showIcon
              message="当前配置尚未验证"
              description="保存成功只代表配置已写入。请发送测试邮件确认连接、凭据、TLS 模式和发件人状态。"
            />
          )}

          {view.verification.status === "verified" && (
            <Alert
              type="success"
              showIcon
              message="当前配置已通过测试发送"
              description={`最后验证：${new Date(
                view.verification.verifiedAt!,
              ).toLocaleString("zh-CN")}`}
            />
          )}

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
                    view.resend.apiKeyConfigured
                      ? "已配置密钥，留空则保持不变。"
                      : "尚未配置密钥。"
                  }
                >
                  <Input.Password
                    autoComplete="new-password"
                    placeholder={
                      view.resend.apiKeyConfigured
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
                    view.smtp.passwordConfigured
                      ? "已配置密码，留空则保持不变。"
                      : undefined
                  }
                >
                  <Input.Password
                    autoComplete="new-password"
                    placeholder={
                      view.smtp.passwordConfigured ? SECRET_PLACEHOLDER : ""
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

            {provider !== "disabled" && (
              <Form.Item
                name="testRecipient"
                label="测试收件人"
                rules={[
                  { required: true, message: "请输入测试收件邮箱" },
                  { type: "email", message: "请输入有效的邮箱地址" },
                ]}
              >
                <Input autoComplete="email" placeholder="admin@example.edu.cn" />
              </Form.Item>
            )}

            <Form.Item>
              <Space wrap>
                <Button
                  type="primary"
                  htmlType="submit"
                  icon={<SaveOutlined />}
                  loading={saveMutation.isPending}
                >
                  保存设置
                </Button>
                {provider !== "disabled" && (
                  <Button
                    htmlType="button"
                    icon={<SendOutlined />}
                    loading={testMutation.mutation.isPending}
                    disabled={saveMutation.isPending}
                    onClick={handleTest}
                  >
                    发送测试邮件
                  </Button>
                )}
              </Space>
            </Form.Item>

            <Space direction="vertical" size={0}>
              <Text type="secondary">配置版本：{view.version}</Text>
              {view.updatedAt && (
                <Text type="secondary">
                  上次更新：{new Date(view.updatedAt).toLocaleString("zh-CN")}
                </Text>
              )}
            </Space>
          </Form>
        </Space>
      )}
    </Card>
  );
};
