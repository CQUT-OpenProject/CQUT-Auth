import React, { useState, useEffect } from "react";
import {
  Card,
  Descriptions,
  Button,
  Modal,
  Form,
  Input,
  Space,
  Typography,
  message,
} from "antd";
import {
  EditOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";
import { useProject } from "../../contexts/project-context";
import { ProjectStatusTag } from "../../components/status/Tags";
import { request } from "../../api/client";
import { PermissionGuard } from "../../components/layout/PermissionGuard";
import { useBreakpoint } from "../../hooks/useBreakpoint";

const { Text, Paragraph } = Typography;

export const ProjectOverview: React.FC = () => {
  const { activeProject, refreshProjects } = useProject();
  const [editVisible, setEditVisible] = useState(false);
  const [form] = Form.useForm();
  const { isMobile } = useBreakpoint();

  useEffect(() => {
    if (activeProject) {
      form.setFieldsValue({
        name: activeProject.name,
        description: activeProject.description,
      });
    }
  }, [activeProject]);

  if (!activeProject) {
    return <Card loading title="项目信息正在加载" />;
  }

  const handleEdit = async (values: any) => {
    try {
      await request(
        `/projects/${encodeURIComponent(activeProject.projectId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: values.name,
            description: values.description || "",
            expectedProjectVersion: activeProject.version,
          }),
        },
      );
      message.success("项目修改成功！");
      setEditVisible(false);
      await refreshProjects();
    } catch (error: any) {
      message.error(error.message || "修改项目失败");
    }
  };

  const handleArchive = () => {
    Modal.confirm({
      title: "确认归档此项目吗？",
      icon: <ExclamationCircleOutlined />,
      content: "归档后项目不可恢复，项目内客户端将进入只读状态，确定继续？",
      okText: "确认归档",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await request(
            `/projects/${encodeURIComponent(activeProject.projectId)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                status: "archived",
                expectedProjectVersion: activeProject.version,
              }),
            },
          );
          message.success("项目已归档。");
          await refreshProjects();
        } catch (error: any) {
          message.error(error.message || "归档项目失败");
        }
      },
    });
  };

  const canManage =
    activeProject.projectId !== "system" &&
    activeProject.capabilities.includes("manage_project");
  const isArchived = activeProject.status === "archived";

  return (
    <Card
      title="项目概览"
      extra={
        <Space size={isMobile ? "small" : "middle"}>
          {canManage && !isArchived && (
            <>
              <Button
                type="primary"
                icon={<EditOutlined />}
                onClick={() => setEditVisible(true)}
                size={isMobile ? "small" : "middle"}
              >
                {isMobile ? "编辑" : "编辑项目"}
              </Button>
              <Button
                type="primary"
                danger
                icon={<DeleteOutlined />}
                onClick={handleArchive}
                size={isMobile ? "small" : "middle"}
              >
                {isMobile ? "归档" : "归档项目"}
              </Button>
            </>
          )}
        </Space>
      }
    >
      <Descriptions
        bordered
        column={1}
        size={isMobile ? "small" : "default"}
        labelStyle={{ width: isMobile ? "100px" : "150px" }}
      >
        <Descriptions.Item label="项目名称">
          {activeProject.name}
        </Descriptions.Item>
        <Descriptions.Item label="项目 ID">
          <Text code>{activeProject.projectId}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="项目描述">
          {activeProject.description || <Text type="secondary">暂无描述</Text>}
        </Descriptions.Item>
        <Descriptions.Item label="当前角色">
          {activeProject.role ?? "管理员"}
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          <ProjectStatusTag status={activeProject.status} />
        </Descriptions.Item>
        <Descriptions.Item label={isMobile ? "版本" : "项目版本 (乐观锁)"}>
          <Text code>{activeProject.version}</Text>
        </Descriptions.Item>
      </Descriptions>

      <Modal
        title="编辑项目信息"
        open={editVisible}
        onCancel={() => setEditVisible(false)}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleEdit}>
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
