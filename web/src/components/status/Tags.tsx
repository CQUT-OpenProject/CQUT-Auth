import React from "react";
import { Tag } from "antd";
import type {
  Project,
  Client,
  ClientRevision,
  ClientSecret,
} from "../../api/types";

export const ProjectStatusTag: React.FC<{ status: Project["status"] }> = ({
  status,
}) => {
  const color = status === "active" ? "success" : "default";
  const text = status === "active" ? "活动中" : "已归档";
  return <Tag color={color}>{text}</Tag>;
};

export const ClientStatusTag: React.FC<{
  status: Client["lifecycleStatus"];
  proposedStatus?: ClientRevision["status"];
}> = ({ status, proposedStatus }) => {
  let color = "default";
  let text = "";

  switch (status) {
    case "draft":
      color = "warning";
      text = "草稿";
      break;
    case "active":
      color = "success";
      text = "已启用";
      break;
    case "disabled":
      color = "error";
      text = "已停用";
      break;
  }

  if (proposedStatus) {
    let propText = "";
    switch (proposedStatus) {
      case "draft":
        propText = "配置草稿";
        break;
      case "pending":
        propText = "待审核";
        color = "processing";
        break;
      case "approved":
        propText = "已批准";
        break;
      case "rejected":
        propText = "已拒绝";
        break;
    }
    return (
      <Tag color={color}>
        {text} · {propText}
      </Tag>
    );
  }

  return <Tag color={color}>{text}</Tag>;
};

export const RevisionStatusTag: React.FC<{
  status: ClientRevision["status"];
}> = ({ status }) => {
  let color = "default";
  let text = "";

  switch (status) {
    case "draft":
      color = "warning";
      text = "草稿";
      break;
    case "pending":
      color = "processing";
      text = "待审核";
      break;
    case "approved":
      color = "success";
      text = "已批准";
      break;
    case "rejected":
      color = "error";
      text = "已拒绝";
      break;
  }

  return <Tag color={color}>{text}</Tag>;
};

export const SecretStatusTag: React.FC<{ secret: ClientSecret }> = ({
  secret,
}) => {
  if (
    secret.status === "retiring" &&
    secret.expiresAt &&
    new Date(secret.expiresAt).getTime() <= Date.now()
  ) {
    return <Tag color="default">已过期</Tag>;
  }

  let color = "default";
  let text = "";

  switch (secret.status) {
    case "active":
      color = "success";
      text = "使用中";
      break;
    case "retiring":
      color = "warning";
      text = "宽限期";
      break;
    case "revoked":
      color = "error";
      text = "已撤销";
      break;
  }

  return <Tag color={color}>{text}</Tag>;
};
