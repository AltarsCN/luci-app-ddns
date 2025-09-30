# luci-app-ddns

<details>
<summary><strong>English</strong></summary>

## Overview
`luci-app-ddns` is the LuCI front-end for managing OpenWrt Dynamic DNS services. It builds on top of `ddns-scripts`, offering a modern web interface to configure providers, monitor update status, and trigger maintenance actions without touching the command line.

## Key Features
- Full LuCI integration with grid/table views, modal editors, and live polling.
- Helper widgets for IPv6 neighbour discovery, network/interface selection, and provider validation.
- Service installation workflow that fetches missing provider scripts directly from package feeds.
- Rich status dashboard highlighting last update, next verification, registered IPs, and log access.
- Extensive i18n coverage with up-to-date Simplified and Traditional Chinese translations.

## Requirements
- OpenWrt firmware with LuCI installed (tested on 21.02+).
- `ddns-scripts` package (core backend) and any provider-specific sub-packages required.
- Browser with modern JavaScript support for the dynamic form widgets.

## Installation
```sh
opkg update
opkg install luci-app-ddns ddns-scripts
```

For development or testing, copy the contents of `htdocs/` and `root/` into the router filesystem:
```sh
# On your workstation
scp -r htdocs root@<router>:/www/
scp -r root/* root@<router>:/
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

## Usage
1. Visit **Services → Dynamic DNS** in LuCI.
2. Review existing services or click **Add new services…** to create a section.
3. Choose your provider, set the hostname, credentials, and desired IP source.
4. Use the IPv6 neighbour picker or network selector helpers to fill dependent fields.
5. Save & Apply, then monitor status, logs, or trigger manual updates from the overview table.

### Tips
- The status table refreshes automatically every five seconds; use the manual **Reload** button for immediate updates.
- Enable the log viewer tab to read per-service logs directly in the browser.
- Use the **Switch service** action to apply provider template changes after installing new packages.

## Development Notes
- UI logic is implemented in `htdocs/luci-static/resources/view/ddns/overview.js`.
- RPC backends sit in `root/usr/share/rpcd/ucode/ddns.uc` and call helper scripts from `ddns-scripts`.
- Translations reside in `po/`—run `make package/luci-app-ddns/compile` to refresh `.lmo` files.
- Follow LuCI coding guidelines: ES5-compatible JavaScript, `L.bind`, `form.Map`, and `ui` module patterns.

## Contributing
1. Fork and branch from `main`.
2. Add UI features or provider integrations with accessible fallbacks for older browsers.
3. Update translation files (`po/`) and the string template (`po/templates/ddns.pot`).
4. Run `npm test` is not required; rely on LuCI syntax checks (`./scripts/konfsyntax.pl`).
5. Submit a pull request including screenshots or detailed testing notes.

## License
The LuCI application follows the OpenWrt contribution guidelines and is distributed under the same licenses as upstream (commonly GPL-2.0). Consult individual source headers for definitive terms.

## Differences from ImmortalWrt
- Deepened IPv6 neighbour support: helper widgets only populate MACs when selected, while allowing manual entry, improving mixed SLAAC environments.
- Device-source workflow auto-syncs interfaces/networks and triggers IPv6 neighbour rescans when underlying selections change, reducing stale data.
- Status dashboard exposes "Next Verify" timestamps and human-readable neighbour labels, leveraging enhanced IPv6 metadata from the scripts.
- Event network selector styling tuned for readability; translations refreshed to cover the new IPv6-focused UX copy.

</details>

<details>
<summary><strong>中文</strong></summary>

## 项目简介
`luci-app-ddns` 是 OpenWrt 动态 DNS 服务的 LuCI 前端。它基于 `ddns-scripts`，提供图形化界面来完成服务配置、状态监控与维护操作，让您无需命令行即可管理动态 DNS。

## 功能亮点
- 深度整合 LuCI：表格概览、弹窗编辑器、实时轮询状态一应俱全。
- 提供 IPv6 邻居选择器、网络/接口联动选择、服务可用性校验等辅助控件。
- 内置服务安装流程，可直接从软件源获取缺失的提供商脚本。
- 概览页展示上次更新、下次验证、当前注册 IP 以及日志入口。
- 覆盖简体与繁体中文翻译，持续与代码同步。

## 环境要求
- 已安装 LuCI 的 OpenWrt 固件（建议 21.02 及以上）。
- `ddns-scripts` 软件包及所需的动态 DNS 提供商子包。
- 支持现代 JavaScript 的浏览器，以保证动态表单控件正常工作。

## 安装方式
```sh
opkg update
opkg install luci-app-ddns ddns-scripts
```

若需本地开发调试，可将 `htdocs/` 与 `root/` 目录内容同步到路由器后重启服务：
```sh
scp -r htdocs root@<router>:/www/
scp -r root/* root@<router>:/
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

## 使用指南
1. 打开 LuCI -> **服务 → 动态 DNS**。
2. 查看现有服务，或点击 **新增服务…** 创建新条目。
3. 选择服务提供商，填写主机名、凭据以及 IP 来源。
4. 借助 IPv6 邻居选择器或网络联动控件快速填写关联选项。
5. 保存并应用配置，随后可在概览表中查看状态、日志或手动触发更新。

### 小提示
- 状态表每 5 秒自动刷新，必要时可使用 **重新载入** 按钮即时更新。
- 在日志页签中可直接查看每个服务的实时日志输出。
- 安装新服务脚本后，使用 **切换服务** 按钮可以快速套用最新模板。

## 开发者须知
- 前端主要代码位于 `htdocs/luci-static/resources/view/ddns/overview.js`。
- RPC 后端实现存放在 `root/usr/share/rpcd/ucode/ddns.uc`，并调用 `ddns-scripts` 中的辅助脚本。
- 翻译文件在 `po/` 目录，可通过 `make package/luci-app-ddns/compile` 重新生成 `.lmo`。
- 请遵循 LuCI 的编码规范：兼容 ES5 的 JavaScript、`L.bind`、`form.Map` 与 `ui` 模块写法等。

## 参与贡献
1. Fork 仓库并从 `main` 分支创建开发分支。
2. 新增或改进界面功能时，请考虑较老浏览器的兼容性与可访问性。
3. 记得同步更新翻译文件与模板（`po/` 目录）。
4. Ready 提交前自查 LuCI 语法，可运行 `./scripts/konfsyntax.pl`。
5. 提交 Pull Request 时附上变更截图或详细测试说明。

## 许可协议
本 LuCI 应用遵循 OpenWrt 的贡献准则，通常以 GPL-2.0 等开源协议发布。具体授权请参考源码开头的版权声明。

## 与 ImmortalWrt 原版的差异
- IPv6 邻居支持更完善：下拉框负责辅助选择，真实 MAC 仍由文本框保存，便于 SLAAC 场景下的手工录入。
- 设备来源会自动同步接口/网络字段，并在相关选项变动时重新扫描 IPv6 邻居，避免信息过期。
- 状态面板新增“下次验证”以及友好的主机 / MAC 标签，依赖脚本层扩展的 IPv6 元数据。
- 调整事件网络下拉框的样式，并同步更新中繁文案，确保 IPv6 场景的提示完整。

</details>
