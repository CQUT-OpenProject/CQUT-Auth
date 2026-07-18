import type { NotificationProvider } from "@refinedev/core";
import { notification } from "antd";

export const notificationProvider: NotificationProvider = {
  open: ({ message, key, type, description }) => {
    // antd 的 notification 没有 progress 方法，映射到 info
    const method = type === "progress" ? "info" : type;
    notification[method]({
      key,
      message,
      description,
      placement: "topRight",
    });
  },
  close: (key) => {
    notification.destroy(key);
  },
};
