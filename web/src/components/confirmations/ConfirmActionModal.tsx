import React, { useState, useEffect } from "react";
import { Modal, Input, Typography, Space, Alert } from "antd";

const { Text } = Typography;

interface ConfirmActionModalProps {
  title: string;
  visible: boolean;
  content: string;
  expectedValue: string; // e.g. clientId or client displayName
  confirmPlaceholder?: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  confirmDanger?: boolean;
}

export const ConfirmActionModal: React.FC<ConfirmActionModalProps> = ({
  title,
  visible,
  content,
  expectedValue,
  confirmPlaceholder = "请输入对应的标识以确认",
  onConfirm,
  onCancel,
  confirmDanger = true,
}) => {
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (visible) {
      setInputValue("");
    }
  }, [visible]);

  const handleOk = async () => {
    if (inputValue !== expectedValue) return;
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={title}
      open={visible}
      onOk={handleOk}
      onCancel={onCancel}
      okButtonProps={{
        danger: confirmDanger,
        disabled: inputValue !== expectedValue,
        loading: loading,
      }}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Alert
          message="危险操作提示"
          description={content}
          type="error"
          showIcon
        />
        <div>
          <Text>请输入 </Text>
          <Text strong code>
            {expectedValue}
          </Text>
          <Text> 以确认此操作：</Text>
        </div>
        <Input
          placeholder={confirmPlaceholder}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          status={
            inputValue && inputValue !== expectedValue ? "error" : undefined
          }
        />
      </Space>
    </Modal>
  );
};
