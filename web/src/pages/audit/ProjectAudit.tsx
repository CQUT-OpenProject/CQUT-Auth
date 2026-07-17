import React, { useState, useEffect } from "react";
import { Table, Button, Card, Typography, Space, Spin, message } from "antd";
import { useProject } from "../../contexts/project-context";
import { request } from "../../api/client";
import type { AuditLog } from "../../api/types";

const { Text } = Typography;

function auditDetails(audit: AuditLog) {
  return Object.fromEntries(
    Object.entries({
      changedFields: audit.changedFields,
      revisionId: audit.revisionId,
      revisionNumber: audit.revisionNumber,
      secretId: audit.secretId,
      previousClientStatus: audit.previousClientStatus,
      newClientStatus: audit.newClientStatus,
      previousRevisionStatus: audit.previousRevisionStatus,
      newRevisionStatus: audit.newRevisionStatus,
      reason: audit.reason,
    }).filter(([, value]) => value !== undefined),
  );
}

export const ProjectAudit: React.FC = () => {
  const { activeProject } = useProject();
  const [audits, setAudits] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [beforeId, setBeforeId] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);

  const loadAudits = async (loadMore = false) => {
    if (!activeProject) return;
    setLoading(true);
    try {
      const currentBeforeId = loadMore ? beforeId : undefined;
      const query = new URLSearchParams({ limit: "20" });
      if (currentBeforeId) query.set("beforeId", String(currentBeforeId));

      const res = await request<{ auditLogs: AuditLog[] }>(
        `/projects/${encodeURIComponent(activeProject.projectId)}/audit-logs?${query.toString()}`,
      );

      if (loadMore) {
        setAudits((prev) => [...prev, ...res.auditLogs]);
      } else {
        setAudits(res.auditLogs);
      }

      if (res.auditLogs.length > 0) {
        const lastLog = res.auditLogs[res.auditLogs.length - 1];
        setBeforeId(lastLog?.id);
        setHasMore(res.auditLogs.length === 20);
      } else {
        setHasMore(false);
      }
    } catch (error: any) {
      message.error("加载审计日志失败：" + error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setBeforeId(undefined);
    setHasMore(true);
    loadAudits(false);
  }, [activeProject]);

  if (!activeProject) {
    return <Card loading title="项目信息正在加载" />;
  }

  return (
    <Card title="项目审计日志">
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Table
          dataSource={audits}
          rowKey="id"
          loading={loading && audits.length === 0}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            {
              title: "时间",
              dataIndex: "createdAt",
              key: "createdAt",
              render: (text: string) => new Date(text).toLocaleString("zh-CN"),
            },
            {
              title: "操作人",
              dataIndex: "actorSubjectId",
              key: "actorSubjectId",
              render: (text: string) => <Text code>{text || "系统"}</Text>,
            },
            {
              title: "客户端 ID",
              dataIndex: "clientId",
              key: "clientId",
              render: (text: string) => (text ? <Text code>{text}</Text> : "—"),
            },
            {
              title: "操作行为",
              dataIndex: "action",
              key: "action",
            },
            {
              title: "来源 IP",
              dataIndex: "sourceIp",
              key: "ip",
              render: (sourceIp: string | undefined) => sourceIp || "未知",
            },
            {
              title: "变更细节",
              key: "details",
              render: (_: unknown, audit: AuditLog) => (
                <pre
                  style={{
                    margin: 0,
                    fontSize: "11px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {JSON.stringify(auditDetails(audit), null, 2)}
                </pre>
              ),
            },
          ]}
        />
        {hasMore && (
          <div style={{ textAlign: "center", marginTop: "16px" }}>
            <Button onClick={() => loadAudits(true)} loading={loading}>
              加载更多日志
            </Button>
          </div>
        )}
      </Space>
    </Card>
  );
};
