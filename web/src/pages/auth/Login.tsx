import React, { useState } from "react";
import { useLogin } from "@refinedev/core";
import { Form, Input, Button, Alert, Typography, theme } from "antd";
import { useThemeMode } from "../../contexts/theme-context";
import { useBreakpoint } from "../../hooks/useBreakpoint";
import logoMonoLight from "../../assets/logo-mono-light.svg";
import logoColor from "../../assets/logo-color.svg";

const { Title, Paragraph, Text } = Typography;

export const Login: React.FC = () => {
  const [errorMsg, setErrorMsg] = useState("");
  const { mutate: login, isLoading } = useLogin();
  const { themeMode } = useThemeMode();
  const { token } = theme.useToken();
  const { isMobile } = useBreakpoint();

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
      className="management-login-page wb-paper-bg"
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: isMobile ? "24px 16px" : "32px 20px",
      }}
    >
      <div
        className="wb-card wb-card-in"
        style={{
          width: "100%",
          maxWidth: 420,
          padding: isMobile ? "24px 20px 20px" : "36px 36px 32px",
        }}
      >
        <div
          className="wb-rise-in"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            marginBottom: 20,
          }}
        >
          <img
            src={isDark ? logoMonoLight : logoColor}
            alt="CQUT-Auth Logo"
            width={isMobile ? 192 : 224}
            height={isMobile ? 48 : 56}
          />
          <div style={{ textAlign: "center" }}>
            <Title
              level={isMobile ? 4 : 3}
              className="wb-serif"
              style={{ margin: 0, letterSpacing: "0.08em" }}
            >
              登录管理台
            </Title>
            <Text
              type="secondary"
              style={{ fontSize: 11, letterSpacing: "0.32em" }}
            >
              CQUT UNIFIED AUTH
            </Text>
          </div>
        </div>
        <hr className="wb-rule" />
        <Paragraph
          type="secondary"
          style={{ textAlign: "center", marginBottom: 24 }}
        >
          使用校园统一身份认证账号登录。
        </Paragraph>
        {errorMsg && (
          <Alert
            message={errorMsg}
            type="error"
            showIcon
            style={{ marginBottom: 20 }}
          />
        )}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            label="账号"
            name="account"
            rules={[{ required: true, message: "请输入账号" }]}
          >
            <Input
              size="large"
              placeholder="学号/工号"
              autoComplete="username"
              spellCheck={false}
            />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: "请输入密码" }]}
          >
            <Input.Password
              size="large"
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
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
      <p
        className="wb-rise-in"
        style={{
          marginTop: 22,
          fontSize: 12,
          letterSpacing: "0.18em",
          textAlign: "center",
          color: token.colorTextSecondary,
        }}
      >
        密码仅用于本次认证，不会被保存
      </p>
    </main>
  );
};
