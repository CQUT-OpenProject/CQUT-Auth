# UIS / CAS

登录流程由服务端完成，不依赖浏览器保存学校会话：

1. 请求 UIS CAS 登录地址，解析实际 `service`；
2. 使用 UIS 登录页的 RSA 规则加密密码，提交 `/center-auth-server/sso/doLogin`；
3. 再次请求 CAS 登录地址并停止在 `302`；
4. 从 `Location` 提取一次性 `ST-*` Service Ticket；
5. 使用签发 Ticket 时完全相同的 `service` 调用 `/center-auth-server/cas/serviceValidate`；
6. 使用带命名空间的 XML 解析器验证 `authenticationSuccess`，拒绝 DOCTYPE、超限响应、重复结果和冲突标识；
7. 比较 `user`、`uid`、`user_code` 与登录账号，确认身份一致后建立本地 Subject。

## 字段处理

UIS 实测还会返回 `user_name`、`user_user_type`、`universityId` 和 `authServerToken`。本系统只使用用户标识，不保存任何真实姓名、数字用户类型或内部令牌。

单一学生样本中 `user_user_type=3` 与办事大厅的 `STUDENT` 类型对应，但该结果不足以证明完整类型映射。

## 注意事项

`serviceValidate?format=JSON` 实测只改变响应头，响应体仍为 XML；接入实现不能依赖该参数进行 JSON 解析。
