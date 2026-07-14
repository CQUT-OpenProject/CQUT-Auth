import React, { useState, useEffect } from "react";
import { Modal, Button, Alert, Space, Typography, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";

const { Text, Paragraph } = Typography;

interface OneTimeSecretModalProps {
  secret: string | null;
  clientId: string | null;
  onClose: () => void;
}

export const OneTimeSecretModal: React.FC<OneTimeSecretModalProps> = ({
  secret,
  clientId,
  onClose,
}) => {
  const [localSecret, setLocalSecret] = useState<string | null>(null);

  // Sync to local state when opened, and clear immediately upon close or unmount
  useEffect(() => {
    if (secret) {
      setLocalSecret(secret);
    }
    return () => {
      setLocalSecret(null);
    };
  }, [secret]);

  const handleCopy = () => {
    if (localSecret) {
      navigator.clipboard.writeText(localSecret);
      message.success("Secret 已复制到剪贴板！");
    }
  };

  const handleClose = () => {
    setLocalSecret(null);
    onClose();
  };

  return (
    <Modal
      title="请保存您的 Client Secret"
      open={!!secret}
      onCancel={handleClose}
      footer={[
        <Button
          key="copy"
          type="dashed"
          icon={<CopyOutlined />}
          onClick={handleCopy}
        >
          复制 Secret
        </Button>,
        <Button key="close" type="primary" onClick={handleClose}>
          我已安全保存
        </Button>,
      ]}
      destroyOnClose
      maskClosable={false}
      keyboard={false}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Alert
          message="警告"
          description="该 Client Secret 仅在此处展示一次。关闭此对话框后，服务端和客户端均无法再次恢复或显示此 Secret 明文。请立即将其复制并安全保存。"
          type="warning"
          showIcon
        />
        {clientId && (
          <div>
            <Text type="secondary">客户端 ID: </Text>
            <Text code>{clientId}</Text>
          </div>
        )}
        <div
          style={{
            background: "#f5f5f5",
            padding: "12px",
            borderRadius: "4px",
            border: "1px solid #d9d9d9",
            wordBreak: "break-all",
          }}
        >
          <Paragraph
            copyable={{ text: localSecret || "", tooltips: ["复制", "已复制"] }}
          >
            <Text strong style={{ fontFamily: "monospace", fontSize: "16px" }}>
              {localSecret}
            </Text>
          </Paragraph>
        </div>
      </Space>
    </Modal>
  );
};
