import React, { useState, useMemo } from "react";
import {
  Table,
  Button,
  Card,
  Input,
  Select,
  Space,
  Typography,
  Skeleton,
  Tag,
} from "antd";
import { PlusOutlined, EyeOutlined, SearchOutlined } from "@ant-design/icons";
import { useProject } from "../../contexts/project-context";
import { useList } from "@refinedev/core";
import { ClientStatusTag } from "../../components/status/Tags";
import { useNavigate } from "react-router-dom";
import { useBreakpoint } from "../../hooks/useBreakpoint";
import type { Client } from "../../api/types";

const { Text } = Typography;

export const ClientList: React.FC = () => {
  const { activeProject } = useProject();
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();

  // Search & Filter State
  const [searchText, setSearchText] = useState("");
  const [clientTypeFilter, setClientTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const projectId = activeProject?.projectId;

  const { query, result } = useList<Client>({
    resource: "clients",
    meta: { projectId },
    queryOptions: {
      enabled: !!projectId,
    },
  });

  const clients = result.data;
  const isLoading = query.isLoading;

  // Filter logic on client-side
  const filteredClients = useMemo(() => {
    return clients.filter((client) => {
      const matchSearch =
        client.displayName.toLowerCase().includes(searchText.toLowerCase()) ||
        client.clientId.toLowerCase().includes(searchText.toLowerCase());

      const matchType =
        clientTypeFilter === "all" || client.clientType === clientTypeFilter;

      let matchStatus = true;
      if (statusFilter !== "all") {
        if (statusFilter === "draft") {
          matchStatus = client.lifecycleStatus === "draft";
        } else if (statusFilter === "active") {
          matchStatus = client.lifecycleStatus === "active";
        } else if (statusFilter === "disabled") {
          matchStatus = client.lifecycleStatus === "disabled";
        } else if (statusFilter === "pending") {
          matchStatus = client.proposedRevision?.status === "pending";
        }
      }

      return matchSearch && matchType && matchStatus;
    });
  }, [clients, searchText, clientTypeFilter, statusFilter]);

  if (!activeProject) {
    return <Card loading title="项目信息正在加载" />;
  }

  const columns = [
    {
      title: "客户端",
      dataIndex: "displayName",
      key: "displayName",
      render: (text: string, record: Client) => (
        <Space direction="vertical" size={0}>
          <Typography.Link
            onClick={() =>
              navigate(
                `/projects/${encodeURIComponent(activeProject.projectId)}/clients/${encodeURIComponent(record.clientId)}/overview`,
              )
            }
            strong
          >
            {text}
          </Typography.Link>
          <Text code style={{ fontSize: "12px" }}>
            {record.clientId}
          </Text>
        </Space>
      ),
    },
    {
      title: "类型",
      dataIndex: "clientType",
      key: "clientType",
      render: (type: string) => <Tag color="blue">{type.toUpperCase()}</Tag>,
    },
    {
      title: "生命周期与审核状态",
      key: "status",
      render: (_: any, record: Client) => (
        <ClientStatusTag
          status={record.lifecycleStatus}
          proposedStatus={record.proposedRevision?.status}
        />
      ),
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      render: (text: string) =>
        new Date(text).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
        }),
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: Client) => (
        <Button
          type="primary"
          ghost
          icon={<EyeOutlined />}
          onClick={() =>
            navigate(
              `/projects/${encodeURIComponent(activeProject.projectId)}/clients/${encodeURIComponent(record.clientId)}/overview`,
            )
          }
          size={isMobile ? "small" : "middle"}
        >
          {isMobile ? "查看" : "查看详情"}
        </Button>
      ),
    },
  ].filter((col) => {
    // Hide non-essential columns on mobile
    if (isMobile && col.key === "clientType") return false;
    if (isMobile && col.key === "updatedAt") return false;
    return true;
  });

  const canWriteClient = activeProject.capabilities.includes("write_client");
  const isArchived = activeProject.status === "archived";

  return (
    <Card
      title="OIDC 客户端"
      extra={
        canWriteClient &&
        activeProject.projectId !== "system" &&
        !isArchived && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() =>
              navigate(
                `/projects/${encodeURIComponent(activeProject.projectId)}/clients/new`,
              )
            }
          >
            创建客户端
          </Button>
        )
      }
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Space wrap style={{ width: "100%" }}>
          <Input
            placeholder={isMobile ? "搜索" : "搜索客户端名称或 ID"}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            prefix={<SearchOutlined />}
            style={{ width: isMobile ? "100%" : 220, minWidth: isMobile ? "100%" : "auto" }}
            allowClear
          />
          <Select
            value={clientTypeFilter}
            onChange={setClientTypeFilter}
            style={{ width: isMobile ? "48%" : 130 }}
          >
            <Select.Option value="all">所有类型</Select.Option>
            <Select.Option value="web">Web{!isMobile && " (服务端保密)"}</Select.Option>
            <Select.Option value="spa">SPA{!isMobile && " (公开客户端)"}</Select.Option>
          </Select>
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: isMobile ? "48%" : 130 }}
          >
            <Select.Option value="all">所有状态</Select.Option>
            <Select.Option value="draft">草稿</Select.Option>
            <Select.Option value="active">已启用</Select.Option>
            <Select.Option value="disabled">已停用</Select.Option>
            <Select.Option value="pending">待审核变更</Select.Option>
          </Select>
        </Space>

        {isLoading ? (
          <Skeleton active paragraph={{ rows: 5 }} />
        ) : (
          <Table
            dataSource={filteredClients}
            columns={columns}
            rowKey="clientId"
            pagination={{ pageSize: isMobile ? 5 : 10 }}
            scroll={{ x: isMobile ? 600 : undefined }}
            locale={{
              emptyText: "暂无符合筛选条件的客户端",
            }}
          />
        )}
      </Space>
    </Card>
  );
};
