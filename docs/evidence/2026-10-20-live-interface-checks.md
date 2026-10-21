# 当前登录态的真实 Runtime 接口检测

日期：2026-10-20（America/Los_Angeles）。用户授权使用已登录客户端检测接口，扫码及重新登录不在本次范围内。仅使用当前 access token 发送固定的最小测试请求；凭证仅驻留探针进程内存，不打印、不导出、不刷新、不写回缓存或账户管理器数据。

## 检测结果

| 检查 | 实际结果 |
| --- | --- |
| 官方 IDE 基线 | 返回 `KIRO_REQUEST_OK`，见[客户端记录](2026-10-20-official-client-smoke.md) |
| 候选实现首次请求 | HTTP 400，`ValidationException`，受控错误为 `profileArn is required for this request.`；未输出文本 |
| 修正 profile 选择后 | HTTP 200，事件流完整解析，返回固定标记 `KIRO_ADAPTER_OK` |
| 功能配置查询 | `KiroRuntimeService.GetFeatureConfiguration` 返回 HTTP 200 和 configuration；直接检查未返回 `create_response_api` 字段，不据此宣称实际启用了 Responses SSE |

成功请求的 method 为 `POST`，端点 `https://runtime.us-east-1.kiro.dev/`，Content-Type 为 `application/x-amz-json-1.0`，操作 target 为 `KiroRuntimeService.GenerateAssistantResponse`。成功响应 Content-Type 为 `application/vnd.amazon.eventstream`，实收 `initial-response`、`assistantResponseEvent`、`metadataEvent`、`contextUsageEvent` 和 `meteringEvent`。严格分帧与 CRC 校验通过，完成回调一次，收到预期固定响应；没有自动换账户、换端点或重放。

## 发现并修复的实际差异

首次适配错误地把当前官方仍在使用的 Builder ID 与 Social 固定 profile 统一当作无效占位值过滤，造成缺少 profileArn。官方 1.4.5 扩展同一摘要的字符偏移 `13859302` 定义当前 provider 映射；`13860602` 附近优先使用 Social token 自带 profile，缺省才使用对应默认值。身份解析将所选 profile 传入 Runtime 请求。

修复后保留服务或缓存明确提供的有效 profile，并按已取证的官方规则处理 Builder ID、Google、GitHub 默认 profile；不凭旧代码制造 Enterprise 默认 ARN，也不从任意请求 payload 偷用另一个 profile。区域优先来自所选 profile，其次账户区域。回归测试覆盖默认值和显式区域 profile，避免再次通过删字段“修复”格式。

## 仍未验收

本次实测只覆盖当前已登录 Social 会话的 Runtime JSON-RPC 主链路和功能配置读取；没有证明所有账户、区域和模型均可用。未执行登录授权、扫码、Token 刷新/轮换、跨 Windows 用户 GUI、候选版安装或自动更新。未把真实凭证加入测试或 Git，也未记录邮箱、用户文件路径、请求头中的 Authorization、完整 profile 值或服务器原始响应。
