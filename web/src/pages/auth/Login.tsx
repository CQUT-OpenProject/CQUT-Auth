import React, { useState } from "react";
import { useLogin } from "@refinedev/core";
import { Form, Input, Button, Alert, Typography, theme } from "antd";
import { useThemeMode } from "../../contexts/theme-context";
import logoMonoLight from "../../assets/logo-mono-light.svg";
import logoColor from "../../assets/logo-color.svg";

const { Title, Paragraph } = Typography;

export const Login: React.FC = () => {
  const [errorMsg, setErrorMsg] = useState("");
  const { mutate: login, isLoading } = useLogin();
  const { themeMode } = useThemeMode();
  const { token } = theme.useToken();

  const isDark = themeMode === "dark";

  const onFinish = (values: any) => {
    setErrorMsg("");
    login(
      { account: values.account, password: values.password },
      {
        onError: (err: any) => {
          setErrorMsg(err?.message || "登录失败，请检查账号和密码。");
        },
      },
    );
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateColumns: "1.5fr 1px 1fr",
        background: token.colorBgLayout,
      }}
      className="login-split-layout"
    >
      <section
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "48px",
          background: isDark
            ? `radial-gradient(circle at 30% 30%, #15293d, transparent 60%), ${token.colorBgLayout}`
            : `radial-gradient(circle at 30% 30%, #dceef5, transparent 60%), ${token.colorBgLayout}`,
          position: "relative",
          overflow: "hidden",
        }}
        className="login-hero-pane"
      >
        <div style={{ maxWidth: "600px" }} className="login-hero-content">
          <img
            src={isDark ? logoMonoLight : logoColor}
            alt="CQUT-AUTH Logo"
            style={{ height: "80px", width: "auto" }}
          />
        </div>
      </section>
      <div
        style={{ backgroundColor: token.colorBorderSecondary }}
        className="login-divider"
      ></div>
      <section
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "48px 36px",
          background: token.colorBgContainer,
        }}
        className="login-form-pane"
      >
        <div
          style={{ width: "100%", maxWidth: "320px" }}
          className="login-form-content"
        >
          <Title level={2} style={{ margin: "0 0 8px 0", fontWeight: 750 }}>
            登录管理台
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: "24px" }}>
            使用校园统一身份认证账号登录。密码仅用于本次认证，不会被保存。
          </Paragraph>
          {errorMsg && (
            <Alert
              message={errorMsg}
              type="error"
              showIcon
              style={{ marginBottom: "20px" }}
            />
          )}
          <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
            <Form.Item
              label="账号"
              name="account"
              rules={[{ required: true, message: "请输入账号" }]}
            >
              <Input size="large" placeholder="学号/工号" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password size="large" placeholder="密码" />
            </Form.Item>
            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                size="large"
                block
                loading={isLoading}
              >
                登录管理台
              </Button>
            </Form.Item>
          </Form>
        </div>
      </section>
    </main>
  );
};
