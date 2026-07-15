import React, { useState } from "react";
import {
  Card,
  Steps,
  Form,
  Input,
  Button,
  Radio,
  Checkbox,
  Space,
  Typography,
  List,
  Divider,
  message,
} from "antd";
import {
  ArrowLeftOutlined,
  PlusOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useProject } from "../../contexts/project-context";
import { useNavigate } from "react-router-dom";
import { request } from "../../api/client";
import { OneTimeSecretModal } from "../../components/secret/OneTimeSecretModal";

const { Text, Paragraph, Title } = Typography;

const clientScopes = [
  { label: "openid (必选)", value: "openid", disabled: true },
  { label: "profile (用户信息)", value: "profile" },
  { label: "email (邮箱)", value: "email" },
  { label: "student (学生身份)", value: "student" },
  { label: "offline_access (刷新令牌, SPA不可选)", value: "offline_access" },
];

export const ClientCreate: React.FC = () => {
  const { activeProject } = useProject();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(0);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  // One time secret states
  const [secretVal, setSecretVal] = useState<string | null>(null);
  const [createdClientId, setCreatedClientId] = useState<string | null>(null);

  if (!activeProject) {
    return <Card loading title="项目信息正在加载" />;
  }

  const clientType = Form.useWatch("clientType", form) || "web";

  const next = async () => {
    try {
      if (currentStep === 0) {
        await form.validateFields(["displayName", "description"]);
      } else if (currentStep === 1) {
        await form.validateFields(["clientType"]);
        // If SPA, filter out offline_access from scope selection
        const currentScopes = form.getFieldValue("scopeWhitelist") || [
          "openid",
        ];
        if (form.getFieldValue("clientType") === "spa") {
          form.setFieldValue(
            "scopeWhitelist",
            currentScopes.filter((s: string) => s !== "offline_access"),
          );
        }
      } else if (currentStep === 2) {
        await form.validateFields(["redirectUris", "postLogoutRedirectUris"]);
        const redirectUris = form.getFieldValue("redirectUris") || [];
        if (redirectUris.length === 0) {
          form.setFields([
            {
              name: "redirectUris",
              errors: ["必须填写至少一个 Redirect URI"],
            },
          ]);
          return;
        }
      } else if (currentStep === 3) {
        await form.validateFields(["scopeWhitelist"]);
      }
      setCurrentStep(currentStep + 1);
    } catch {
      // Form validation failed
    }
  };

  const prev = () => {
    setCurrentStep(currentStep - 1);
  };

  const handleFinish = async () => {
    setLoading(true);
    try {
      const values = form.getFieldsValue(true);

      // Filter empty URIs
      const cleanRedirectUris = (values.redirectUris || []).filter(
        (u: string) => u && u.trim(),
      );
      const cleanPostLogoutRedirectUris = (
        values.postLogoutRedirectUris || []
      ).filter((u: string) => u && u.trim());

      const payload = {
        clientType: values.clientType,
        displayName: values.displayName,
        description: values.description || "",
        redirectUris: cleanRedirectUris,
        postLogoutRedirectUris: cleanPostLogoutRedirectUris,
        scopeWhitelist: values.scopeWhitelist || ["openid"],
      };

      const res = await request<{ client: any; clientSecret?: string }>(
        `/projects/${encodeURIComponent(activeProject.projectId)}/clients`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );

      const draft = res.client.proposedRevision;
      if (!draft) throw new Error("创建的客户端缺少草稿配置");

      await request(
        `/projects/${encodeURIComponent(activeProject.projectId)}/clients/${encodeURIComponent(res.client.clientId)}/revision/submit`,
        {
          method: "POST",
          body: JSON.stringify({
            revisionId: draft.revisionId,
            revisionVersion: draft.version,
          }),
        },
      );

      message.success("客户端已创建并提交审核！");

      if (res.clientSecret) {
        // Trigger one-time secret display
        setCreatedClientId(res.client.clientId);
        setSecretVal(res.clientSecret);
      } else {
        // Direct redirect for SPA
        navigate(
          `/projects/${encodeURIComponent(activeProject.projectId)}/clients/${encodeURIComponent(res.client.clientId)}/overview`,
        );
      }
    } catch (error: any) {
      message.error(error.message || "创建客户端失败");
    } finally {
      setLoading(false);
    }
  };

  const handleCloseSecretModal = () => {
    setSecretVal(null);
    navigate(
      `/projects/${encodeURIComponent(activeProject.projectId)}/clients/${encodeURIComponent(createdClientId!)}/overview`,
    );
  };

  const formValues = form.getFieldsValue(true);

  return (
    <Card
      title={
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)} />
          <Title level={4} style={{ margin: 0 }}>
            创建客户端
          </Title>
        </Space>
      }
    >
      <Steps
        current={currentStep}
        items={[
          { title: "基本信息" },
          { title: "客户端类型" },
          { title: "安全域名/URI" },
          { title: "权限作用域" },
          { title: "确认并创建" },
        ]}
        style={{ marginBottom: "32px" }}
      />

      <Form
        form={form}
        layout="vertical"
        initialValues={{
          clientType: "web",
          redirectUris: [""],
          postLogoutRedirectUris: [],
          scopeWhitelist: ["openid", "profile"],
        }}
      >
        {currentStep === 0 && (
          <div>
            <Form.Item
              label="显示名称"
              name="displayName"
              rules={[{ required: true, message: "请输入客户端显示名称" }]}
            >
              <Input
                maxLength={100}
                placeholder="例如：CQUT教务管理系统"
                style={{ maxWidth: 480 }}
              />
            </Form.Item>
            <Form.Item label="描述" name="description">
              <Input.TextArea
                maxLength={1000}
                showCount
                rows={4}
                placeholder="此客户端的用途说明"
                style={{ maxWidth: 480 }}
              />
            </Form.Item>
          </div>
        )}

        {currentStep === 1 && (
          <div>
            <Form.Item
              label="客户端类型"
              name="clientType"
              rules={[{ required: true, message: "请选择客户端类型" }]}
            >
              <Radio.Group style={{ width: "100%", maxWidth: 640 }}>
                <Space
                  direction="vertical"
                  style={{ width: "100%" }}
                  size="middle"
                >
                  <Radio
                    value="web"
                    style={{
                      border: "1px solid #d9d9d9",
                      padding: "16px",
                      borderRadius: "6px",
                      width: "100%",
                    }}
                  >
                    <Space direction="vertical">
                      <Text strong>Web（服务端保密客户端）</Text>
                      <Text type="secondary">
                        适用于包含后端服务的传统 Web
                        网站。该类型会生成高度安全的 Client Secret。Secret
                        必须保存在服务端，不可暴露给前端。
                      </Text>
                    </Space>
                  </Radio>
                  <Radio
                    value="spa"
                    style={{
                      border: "1px solid #d9d9d9",
                      padding: "16px",
                      borderRadius: "6px",
                      width: "100%",
                    }}
                  >
                    <Space direction="vertical">
                      <Text strong>SPA（前端公开客户端）</Text>
                      <Text type="secondary">
                        适用于单页应用 (React/Vue)、移动 App
                        或小程序。该类型不生成 Client Secret，认证过程必须使用
                        PKCE 安全增强，禁止使用 `offline_access`。
                      </Text>
                    </Space>
                  </Radio>
                </Space>
              </Radio.Group>
            </Form.Item>
          </div>
        )}

        {currentStep === 2 && (
          <div>
            <Text
              type="secondary"
              style={{ display: "block", marginBottom: "16px" }}
            >
              请输入该客户端允许重定向的安全域名和具体 URI。
            </Text>

            <Form.List name="redirectUris">
              {(fields, { add, remove }) => (
                <div style={{ marginBottom: "24px" }}>
                  <Text
                    strong
                    style={{ display: "block", marginBottom: "8px" }}
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
                          validateTrigger={["onChange", "onBlur"]}
                          rules={[
                            {
                              required: true,
                              whitespace: true,
                              message: "请输入 Redirect URI 或删除此栏",
                            },
                          ]}
                          noStyle
                        >
                          <Input
                            placeholder="https://example.com/callback"
                            style={{ width: 400 }}
                          />
                        </Form.Item>
                        {fields.length > 1 ? (
                          <Button
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => remove(field.name)}
                          />
                        ) : null}
                      </Space>
                    </Form.Item>
                  ))}
                  <Form.Item style={{ marginTop: "12px" }}>
                    <Button
                      type="dashed"
                      onClick={() => add()}
                      icon={<PlusOutlined />}
                      style={{ width: 400 }}
                    >
                      添加 Redirect URI
                    </Button>
                  </Form.Item>
                </div>
              )}
            </Form.List>

            <Divider />

            <Form.List name="postLogoutRedirectUris">
              {(fields, { add, remove }) => (
                <div style={{ marginBottom: "24px" }}>
                  <Text
                    strong
                    style={{ display: "block", marginBottom: "8px" }}
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
                          validateTrigger={["onChange", "onBlur"]}
                          rules={[
                            {
                              required: true,
                              whitespace: true,
                              message: "请输入 Logout URI 或删除此栏",
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
                  <Form.Item style={{ marginTop: "12px" }}>
                    <Button
                      type="dashed"
                      onClick={() => add()}
                      icon={<PlusOutlined />}
                      style={{ width: 400 }}
                    >
                      添加 Logout URI
                    </Button>
                  </Form.Item>
                </div>
              )}
            </Form.List>
          </div>
        )}

        {currentStep === 3 && (
          <div>
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
                        (clientType === "spa" &&
                          scope.value === "offline_access")
                      }
                    >
                      {scope.label}
                    </Checkbox>
                  ))}
                </Space>
              </Checkbox.Group>
            </Form.Item>
          </div>
        )}

        {currentStep === 4 && (
          <div>
            <Title level={5} style={{ marginBottom: "16px" }}>
              请确认以下客户端配置：
            </Title>
            <List bordered>
              <List.Item>
                <Space direction="vertical" size={2}>
                  <Text type="secondary">项目 ID</Text>
                  <Text>
                    {activeProject.name} ({activeProject.projectId})
                  </Text>
                </Space>
              </List.Item>
              <List.Item>
                <Space direction="vertical" size={2}>
                  <Text type="secondary">客户端显示名称</Text>
                  <Text>{formValues.displayName}</Text>
                </Space>
              </List.Item>
              <List.Item>
                <Space direction="vertical" size={2}>
                  <Text type="secondary">描述</Text>
                  <Text>{formValues.description || "—"}</Text>
                </Space>
              </List.Item>
              <List.Item>
                <Space direction="vertical" size={2}>
                  <Text type="secondary">客户端类型</Text>
                  <Text>
                    {formValues.clientType === "web"
                      ? "Web (保密客户端)"
                      : "SPA (公开客户端)"}
                  </Text>
                </Space>
              </List.Item>
              <List.Item>
                <Space direction="vertical" size={2}>
                  <Text type="secondary">Redirect URIs</Text>
                  {(formValues.redirectUris || [])
                    .filter((u: string) => u)
                    .map((uri: string) => (
                      <Text key={uri} code>
                        {uri}
                      </Text>
                    ))}
                </Space>
              </List.Item>
              <List.Item>
                <Space direction="vertical" size={2}>
                  <Text type="secondary">Post Logout Redirect URIs</Text>
                  {(formValues.postLogoutRedirectUris || []).filter(
                    (u: string) => u,
                  ).length === 0 ? (
                    <Text>—</Text>
                  ) : (
                    (formValues.postLogoutRedirectUris || [])
                      .filter((u: string) => u)
                      .map((uri: string) => (
                        <Text key={uri} code>
                          {uri}
                        </Text>
                      ))
                  )}
                </Space>
              </List.Item>
              <List.Item>
                <Space direction="vertical" size={2}>
                  <Text type="secondary">Scopes</Text>
                  <Space wrap>
                    {(formValues.scopeWhitelist || []).map((scope: string) => (
                      <Checkbox checked disabled key={scope}>
                        {scope}
                      </Checkbox>
                    ))}
                  </Space>
                </Space>
              </List.Item>
            </List>
          </div>
        )}

        <div style={{ marginTop: "24px" }}>
          <Space>
            {currentStep > 0 && <Button onClick={prev}>上一步</Button>}
            {currentStep < 4 ? (
              <Button type="primary" onClick={next}>
                下一步
              </Button>
            ) : (
              <Button type="primary" onClick={handleFinish} loading={loading}>
                创建并提交草稿
              </Button>
            )}
          </Space>
        </div>
      </Form>

      <OneTimeSecretModal
        secret={secretVal}
        clientId={createdClientId}
        onClose={handleCloseSecretModal}
      />
    </Card>
  );
};
