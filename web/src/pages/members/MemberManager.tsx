import React, { useState, useEffect } from "react";
import {
  Table,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Modal,
  Typography,
  message,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  SwapOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";
import { useProject } from "../../contexts/project-context";
import { request } from "../../api/client";
import type { ProjectMember } from "../../api/types";
import { PermissionGuard } from "../../components/layout/PermissionGuard";

const { Text } = Typography;

export const MemberManager: React.FC = () => {
  const { activeProject, refreshProjects } = useProject();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [addForm] = Form.useForm();
  const [transferVisible, setTransferVisible] = useState(false);
  const [selectedMember, setSelectedMember] = useState<ProjectMember | null>(
    null,
  );

  const fetchMembers = async () => {
    if (!activeProject) return;
    setLoading(true);
    try {
      const data = await request<{ members: ProjectMember[] }>(
        `/projects/${encodeURIComponent(activeProject.projectId)}/members`,
      );
      setMembers(data.members);
    } catch (error: any) {
      message.error(error.message || "获取成员列表失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMembers();
  }, [activeProject]);

  if (!activeProject) {
    return <Card loading title="项目信息正在加载" />;
  }

  const handleAdd = async (values: any) => {
    try {
      await request(
        `/projects/${encodeURIComponent(activeProject.projectId)}/members`,
        {
          method: "POST",
          body: JSON.stringify({
            subjectId: values.subjectId,
            role: values.role,
            expectedProjectVersion: activeProject.version,
          }),
        },
      );
      message.success("成员添加成功！");
      addForm.resetFields();
      await refreshProjects();
      await fetchMembers();
    } catch (error: any) {
      message.error(error.message || "添加成员失败");
    }
  };

  const handleRoleChange = async (subjectId: string, role: string) => {
    try {
      await request(
        `/projects/${encodeURIComponent(activeProject.projectId)}/members/${encodeURIComponent(subjectId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            role,
            expectedProjectVersion: activeProject.version,
          }),
        },
      );
      message.success("角色修改成功！");
      await refreshProjects();
      await fetchMembers();
    } catch (error: any) {
      message.error(error.message || "修改角色失败");
    }
  };

  const handleDelete = (subjectId: string) => {
    Modal.confirm({
      title: "确认删除成员吗？",
      icon: <ExclamationCircleOutlined />,
      content: "被删除的成员将失去该项目的所有访问权限。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await request(
            `/projects/${encodeURIComponent(activeProject.projectId)}/members/${encodeURIComponent(subjectId)}`,
            {
              method: "DELETE",
              body: JSON.stringify({
                expectedProjectVersion: activeProject.version,
              }),
            },
          );
          message.success("成员已成功移除。");
          await refreshProjects();
          await fetchMembers();
        } catch (error: any) {
          message.error(error.message || "移除成员失败");
        }
      },
    });
  };

  const handleTransfer = async () => {
    if (!selectedMember) return;
    try {
      await request(
        `/projects/${encodeURIComponent(activeProject.projectId)}/ownership/transfer`,
        {
          method: "POST",
          body: JSON.stringify({
            fromSubjectId:
              activeProject.role === "owner"
                ? undefined
                : activeProject.projectId, // from current owner, handled by server
            toSubjectId: selectedMember.subjectId,
            expectedProjectVersion: activeProject.version,
          }),
        },
      );
      message.success("项目所有权已成功转移！您的角色将变更为 maintainer。");
      setTransferVisible(false);
      setSelectedMember(null);
      await refreshProjects();
      await fetchMembers();
    } catch (error: any) {
      message.error(error.message || "所有权转移失败");
    }
  };

  const canManageMembers =
    activeProject.capabilities.includes("manage_members");
  const isArchived = activeProject.status === "archived";

  const columns = [
    {
      title: "Subject ID",
      dataIndex: "subjectId",
      key: "subjectId",
      render: (text: string) => <Text code>{text}</Text>,
    },
    {
      title: "角色",
      dataIndex: "role",
      key: "role",
      render: (role: string, record: ProjectMember) => {
        if (!canManageMembers || isArchived) {
          return role;
        }
        return (
          <Select
            aria-label={`${record.subjectId} 角色`}
            defaultValue={role}
            onChange={(val) => handleRoleChange(record.subjectId, val)}
            style={{ width: 130 }}
          >
            <Select.Option value="owner">owner</Select.Option>
            <Select.Option value="maintainer">maintainer</Select.Option>
            <Select.Option value="viewer">viewer</Select.Option>
          </Select>
        );
      },
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: ProjectMember) => {
        if (!canManageMembers || isArchived) return null;

        const isCurrentProjectOwner = activeProject.role === "owner";
        const isTargetOwner = record.role === "owner";

        return (
          <Space>
            {isCurrentProjectOwner && !isTargetOwner && (
              <Button
                type="default"
                icon={<SwapOutlined />}
                onClick={() => {
                  setSelectedMember(record);
                  setTransferVisible(true);
                }}
              >
                转移所有权
              </Button>
            )}
            <Button
              type="primary"
              danger
              icon={<DeleteOutlined />}
              onClick={() => handleDelete(record.subjectId)}
            >
              删除
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <Card title="项目成员管理">
      <Space direction="vertical" style={{ width: "100%" }} size="large">
        {canManageMembers && !isArchived && (
          <Card type="inner" title="添加项目成员">
            <Form form={addForm} layout="inline" onFinish={handleAdd}>
              <Form.Item
                label="Subject ID"
                name="subjectId"
                rules={[{ required: true, message: "请输入成员 Subject ID" }]}
              >
                <Input
                  placeholder="成员账号的 Subject ID"
                  style={{ width: 240 }}
                />
              </Form.Item>
              <Form.Item label="角色" name="role" initialValue="viewer">
                <Select style={{ width: 130 }}>
                  <Select.Option value="owner">owner</Select.Option>
                  <Select.Option value="maintainer">maintainer</Select.Option>
                  <Select.Option value="viewer">viewer</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  icon={<PlusOutlined />}
                >
                  添加成员
                </Button>
              </Form.Item>
            </Form>
          </Card>
        )}

        <Table
          dataSource={members}
          columns={columns}
          rowKey="subjectId"
          loading={loading}
          pagination={false}
        />
      </Space>

      <Modal
        title="转移项目所有权"
        open={transferVisible}
        onCancel={() => {
          setTransferVisible(false);
          setSelectedMember(null);
        }}
        onOk={handleTransfer}
        okText="确认转移"
        okButtonProps={{ danger: true }}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Alert
            message="警告：此操作不可逆"
            description={
              <>
                您确定要将该项目的所有权转移给成员{" "}
                <Text code strong>
                  {selectedMember?.subjectId}
                </Text>{" "}
                吗？转移后，您的角色将立即自动降级为{" "}
                <Text strong>maintainer</Text>，并失去成员管理和所有权转移权限。
              </>
            }
            type="warning"
            showIcon
          />
        </Space>
      </Modal>
    </Card>
  );
};
import { Alert } from "antd";
