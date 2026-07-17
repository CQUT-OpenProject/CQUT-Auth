import React, { useState, useEffect } from "react";
import {
  Table,
  Button,
  Card,
  Space,
  Modal,
  Input,
  Typography,
  Alert,
  Descriptions,
  Empty,
  Tag,
  message,
} from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";
import { request } from "../../api/client";
import { RevisionDiff } from "../../components/revision/RevisionDiff";
import { useProject } from "../../contexts/project-context";
import { useBreakpoint } from "../../hooks/useBreakpoint";
import type { Client } from "../../api/types";

const { Text, Title } = Typography;

export const AdminReviews: React.FC = () => {
  const { projects } = useProject();
  const { isMobile } = useBreakpoint();
  const [pendingClients, setPendingClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  const fetchPending = async () => {
    setLoading(true);
    try {
      const res = await request<{ clients: Client[] }>("/admin/reviews");
      setPendingClients(res.clients);
    } catch (error: any) {
      message.error("获取待审核列表失败：" + error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPending();
  }, []);

  const handleApprove = async (record: Client) => {
    if (!record.proposedRevision) return;
    try {
      await request(
        `/admin/projects/${encodeURIComponent(record.projectId)}/clients/${encodeURIComponent(record.clientId)}/revisions/${record.proposedRevision.revisionId}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            revisionId: record.proposedRevision.revisionId,
            revisionVersion: record.proposedRevision.version,
          }),
        },
      );
      message.success("已批准并发布新配置。");
      setSelectedClient(null);
      await fetchPending();
    } catch (error: any) {
      message.error(error.message || "审批失败");
    }
  };

  const handleReject = async (record: Client, reason: string) => {
    if (!record.proposedRevision) return;
    try {
      await request(
        `/admin/projects/${encodeURIComponent(record.projectId)}/clients/${encodeURIComponent(record.clientId)}/revisions/${record.proposedRevision.revisionId}/reject`,
        {
          method: "POST",
          body: JSON.stringify({
            revisionId: record.proposedRevision.revisionId,
            revisionVersion: record.proposedRevision.version,
            reason,
          }),
        },
      );
      message.success("已拒绝此变更提案。");
      setSelectedClient(null);
      await fetchPending();
    } catch (error: any) {
      message.error(error.message || "拒绝失败");
    }
  };

  const columns = [
    {
      title: "项目",
      dataIndex: "projectId",
      key: "projectId",
      render: (projectId: string) => (
        <Space direction="vertical" size={0}>
          <Text strong>
            {projects.find((project) => project.projectId === projectId)
              ?.name ?? projectId}
          </Text>
          <Text code style={{ fontSize: "11px" }}>
            {projectId}
          </Text>
        </Space>
      ),
    },
    {
      title: "客户端",
      dataIndex: "displayName",
      key: "displayName",
      render: (text: string, record: Client) => (
        <Space direction="vertical" size={0}>
          <Text>{text}</Text>
          <Text code style={{ fontSize: "11px" }}>
            {record.clientId}
          </Text>
        </Space>
      ),
    },
    {
      title: "提交时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      render: (text: string) => new Date(text).toLocaleString("zh-CN"),
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: Client) => (
        <Space direction={isMobile ? "vertical" : "horizontal"} size="small">
          <Button
            type="primary"
            onClick={() => setSelectedClient(record)}
            size={isMobile ? "small" : "middle"}
          >
            {isMobile ? "审核" : "对比并审核"}
          </Button>
          <Button
            type="primary"
            ghost
            icon={<CheckOutlined />}
            onClick={() => handleApprove(record)}
            size={isMobile ? "small" : "middle"}
          >
            批准
          </Button>
          <Button
            type="primary"
            danger
            ghost
            icon={<CloseOutlined />}
            onClick={() => {
              Modal.confirm({
                title: "拒绝配置变更",
                content: (
                  <Input
                    id="global-reject-reason"
                    placeholder="请输入拒绝原因（必填）"
                    style={{ marginTop: "12px" }}
                  />
                ),
                okText: "确认拒绝",
                okType: "danger",
                onOk: () => {
                  const input = document.getElementById(
                    "global-reject-reason",
                  ) as HTMLInputElement;
                  const reason = input?.value?.trim();
                  if (!reason) {
                    message.error("必须填写拒绝原因");
                    return Promise.reject();
                  }
                  return handleReject(record, reason);
                },
              });
            }}
            size={isMobile ? "small" : "middle"}
          >
            拒绝
          </Button>
        </Space>
      ),
    },
  ].filter((col) => {
    // Hide "提交时间" column on mobile
    if (isMobile && col.key === "updatedAt") return false;
    return true;
  });

  return (
    <Card title="待审核客户端配置">
      <Space direction="vertical" style={{ width: "100%" }} size="large">
        <Table
          dataSource={pendingClients}
          columns={columns}
          rowKey="clientId"
          loading={loading}
          scroll={{ x: isMobile ? "max-content" : undefined }}
          pagination={{ pageSize: isMobile ? 5 : 10 }}
        />

        {selectedClient && selectedClient.proposedRevision && (
          <Modal
            title="配置变更审核详情"
            open={!!selectedClient}
            onCancel={() => setSelectedClient(null)}
            width={850}
            footer={[
              <Button key="close" onClick={() => setSelectedClient(null)}>
                关闭
              </Button>,
              <Button
                key="reject"
                type="primary"
                danger
                onClick={() => {
                  Modal.confirm({
                    title: "拒绝配置变更",
                    content: (
                      <Input
                        id="detail-reject-reason"
                        placeholder="请输入拒绝原因（必填）"
                        style={{ marginTop: "12px" }}
                      />
                    ),
                    okText: "确认拒绝",
                    okType: "danger",
                    onOk: () => {
                      const input = document.getElementById(
                        "detail-reject-reason",
                      ) as HTMLInputElement;
                      const reason = input?.value?.trim();
                      if (!reason) {
                        message.error("必须填写拒绝原因");
                        return Promise.reject();
                      }
                      return handleReject(selectedClient, reason);
                    },
                  });
                }}
              >
                拒绝
              </Button>,
              <Button
                key="approve"
                type="primary"
                onClick={() => handleApprove(selectedClient)}
              >
                批准上线
              </Button>,
            ]}
          >
            <Space direction="vertical" style={{ width: "100%" }} size="middle">
              <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
                <Descriptions.Item label="项目">
                  <Space direction="vertical" size={0}>
                    <Text>
                      {projects.find(
                        (project) =>
                          project.projectId === selectedClient.projectId,
                      )?.name ?? selectedClient.projectId}
                    </Text>
                    <Text code>{selectedClient.projectId}</Text>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="客户端 ID">
                  <Text code>{selectedClient.clientId}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="客户端名称">
                  {selectedClient.displayName}
                </Descriptions.Item>
                <Descriptions.Item label="客户端类型">
                  <Tag color="purple">
                    {selectedClient.clientType.toUpperCase()}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="申请描述" span={2}>
                  {selectedClient.description || (
                    <Text type="secondary">—</Text>
                  )}
                </Descriptions.Item>
              </Descriptions>
              <RevisionDiff
                active={selectedClient.activeRevision}
                proposed={selectedClient.proposedRevision}
              />
            </Space>
          </Modal>
        )}
      </Space>
    </Card>
  );
};
