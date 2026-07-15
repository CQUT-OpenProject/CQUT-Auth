import React from "react";
import { Card, Row, Col, Typography, Empty, theme } from "antd";
import type { ClientRevision } from "../../api/types";

const { Text } = Typography;

interface RevisionDiffProps {
  active: ClientRevision | null;
  proposed: ClientRevision | null;
}

export const RevisionDiff: React.FC<RevisionDiffProps> = ({
  active,
  proposed,
}) => {
  const { token } = theme.useToken();

  if (!active && !proposed) {
    return <Empty description="暂无配置版本" />;
  }

  const panelStyle: React.CSSProperties = {
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadius,
    padding: "8px 12px",
    background: token.colorFillAlter,
    minHeight: "80px",
  };

  const renderFieldDiff = (
    field: "redirectUris" | "postLogoutRedirectUris" | "scopeWhitelist",
    label: string,
  ) => {
    const activeItems = active?.[field] ?? [];
    const proposedItems = proposed?.[field] ?? [];

    const activeSet = new Set(activeItems);
    const proposedSet = new Set(proposedItems);

    const added = proposedItems.filter((x) => !activeSet.has(x));
    const removed = activeItems.filter((x) => !proposedSet.has(x));
    const unchanged = proposedItems.filter((x) => activeSet.has(x));

    return (
      <div style={{ marginBottom: "20px" }}>
        <Text strong style={{ display: "block", marginBottom: "8px" }}>
          {label}
        </Text>
        <Row gutter={16}>
          <Col span={12}>
            <div style={panelStyle}>
              <Text
                type="secondary"
                style={{
                  display: "block",
                  fontSize: "12px",
                  marginBottom: "4px",
                }}
              >
                当前生效值
              </Text>
              {activeItems.length === 0 ? (
                <Text type="secondary" style={{ fontSize: "13px" }}>
                  —
                </Text>
              ) : (
                activeItems.map((item) => (
                  <div
                    key={item}
                    style={{ fontFamily: "monospace", margin: "2px 0" }}
                  >
                    {item}
                  </div>
                ))
              )}
            </div>
          </Col>
          <Col span={12}>
            <div style={panelStyle}>
              <Text
                type="secondary"
                style={{
                  display: "block",
                  fontSize: "12px",
                  marginBottom: "4px",
                }}
              >
                提案变更值
              </Text>
              {!proposed ? (
                <Text type="secondary" style={{ fontSize: "13px" }}>
                  无提案修改
                </Text>
              ) : proposedItems.length === 0 ? (
                <Text type="secondary" style={{ fontSize: "13px" }}>
                  —
                </Text>
              ) : (
                <>
                  {unchanged.map((item) => (
                    <div
                      key={item}
                      style={{
                        fontFamily: "monospace",
                        color: token.colorText,
                        margin: "2px 0",
                      }}
                    >
                      &nbsp;&nbsp;{item}
                    </div>
                  ))}
                  {added.map((item) => (
                    <div
                      key={item}
                      style={{
                        fontFamily: "monospace",
                        color: token.colorSuccessText,
                        margin: "2px 0",
                        background: token.colorSuccessBg,
                        padding: "0 4px",
                      }}
                    >
                      + {item}
                    </div>
                  ))}
                  {removed.map((item) => (
                    <div
                      key={item}
                      style={{
                        fontFamily: "monospace",
                        color: token.colorErrorText,
                        margin: "2px 0",
                        background: token.colorErrorBg,
                        padding: "0 4px",
                        textDecoration: "line-through",
                      }}
                    >
                      - {item}
                    </div>
                  ))}
                </>
              )}
            </div>
          </Col>
        </Row>
      </div>
    );
  };

  return (
    <Card title="配置版本对比" style={{ width: "100%" }}>
      {renderFieldDiff("redirectUris", "重定向 URI (Redirect URIs)")}
      {renderFieldDiff(
        "postLogoutRedirectUris",
        "注销后重定向 URI (Post Logout Redirect URIs)",
      )}
      {renderFieldDiff("scopeWhitelist", "允许的 Scopes (Scope Whitelist)")}
    </Card>
  );
};
