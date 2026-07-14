import type { NotificationProvider } from "@refinedev/core";
import { notification } from "antd";

export const notificationProvider: NotificationProvider = {
  open: ({ message, key, type, description }) => {
    notification[type]({
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
