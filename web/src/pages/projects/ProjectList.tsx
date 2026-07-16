import React, { useState } from "react";
import {
  Table,
  Button,
  Card,
  Modal,
  Form,
  Input,
  Space,
  Typography,
  message,
} from "antd";
import {
  PlusOutlined,
  LoginOutlined,
  EditOutlined,
  FolderAddOutlined,
} from "@ant-design/icons";
import { useProject } from "../../contexts/project-context";
import { ProjectStatusTag } from "../../components/status/Tags";
import { useNavigate } from "react-router-dom";
import { useBreakpoint } from "../../hooks/useBreakpoint";
import { request } from "../../api/client";

const { Paragraph } = Typography;

export const ProjectList: React.FC = () => {
  const { projects, loading, refreshProjects, selectProject } = useProject();
  const [createVisible, setCreateVisible] = useState(false);
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();
  const visibleProjects = projects.filter(
    (project) => project.projectId !== "system",
  );

  const handleCreate = async (values: any) => {
    try {
      await request("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: values.name,
          description: values.description || "",
        }),
      });
      message.success("项目创建成功！");
      setCreateVisible(false);
      form.resetFields();
      await refreshProjects();
    } catch (error: any) {
      message.error(error.message || "创建项目失败");
    }
  };

  const handleEnter = (projectId: string) => {
    selectProject(projectId);
    navigate(`/projects/${encodeURIComponent(projectId)}/overview`);
  };

  const columns = [
    {
      title: "项目名称",
      dataIndex: "name",
      key: "name",
      render: (text: string, record: any) => (
        <Space direction="vertical" size={0}>
          <Typography.Link onClick={() => handleEnter(record.projectId)} strong>
            {text}
          </Typography.Link>
          {record.projectId === "system" && (
            <Typography.Text type="danger" style={{ fontSize: "12px" }}>
              [系统项目]
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: "当前角色",
      dataIndex: "role",
      key: "role",
      render: (role: string | null) => role ?? "管理员 (全局)",
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (status: any) => <ProjectStatusTag status={status} />,
    },
    {
      title: "描述",
      dataIndex: "description",
      key: "description",
      render: (desc: string) =>
        desc || <Typography.Text type="secondary">暂无描述</Typography.Text>,
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: any) => (
        <Button
          type="primary"
          ghost
          icon={<LoginOutlined />}
          onClick={() => handleEnter(record.projectId)}
          size={isMobile ? "small" : "middle"}
        >
          {isMobile ? "进入" : "进入项目"}
        </Button>
      ),
    },
  ].filter((col) => {
    // Hide description column on mobile
    if (isMobile && col.key === "description") return false;
    return true;
  });

  return (
    <Card
      title="我的项目"
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateVisible(true)}
        >
          创建项目
        </Button>
      }
    >
      <Table
        dataSource={visibleProjects}
        columns={columns}
        rowKey="projectId"
        loading={loading}
        pagination={{ pageSize: isMobile ? 5 : 10 }}
        scroll={{ x: isMobile ? 600 : undefined }}
      />

      <Modal
        title="创建新项目"
        open={createVisible}
        onCancel={() => setCreateVisible(false)}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item
            label="项目名称"
            name="name"
            rules={[{ required: true, message: "请输入项目名称" }]}
          >
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea maxLength={1000} showCount rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
