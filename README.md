# 云谱智探

本仓库为参赛作品的公开展示与脱敏代码版本。

## 项目简介

云谱智探是面向生态环境/遥感监测场景的智能分析平台，包含前端可视化页面、后端 API、AI 问答辅助、遥感数据处理与风险分析等模块。

## 主要功能

- 前端可视化页面与业务交互
- FastAPI/Flask 后端服务接口
- AI 助手与多步骤分析流程
- 遥感数据查询、处理与结果展示
- 用户登录、管理和结果记录模块
- Google Earth Engine 相关能力的配置入口，公开版不包含私钥

## 项目结构

```text
backend/        后端服务、路由、工具函数
frontend/       前端页面、样式与脚本
requirements.txt Python 依赖
run_backend.bat 后端启动脚本
run_frontend.bat 前端启动脚本
docs/           效果图说明
```

## 效果预览

![预览图 01](docs/images/preview-01.png)

![预览图 02](docs/images/preview-02.png)

![预览图 03](docs/images/preview-03.png)

更多效果图见 [docs/preview.md](docs/preview.md)。

## 脱敏说明

- 已删除真实 `.env`。
- 已删除 Google 服务账号私钥 JSON。
- 已移除硬编码大模型 API Key、地图 token、个人联系方式。
- 已移除 `.venv`、安装包、原始 PPT/PDF、模型权重、遥感数据、日志和运行缓存。
- GEE、地图和大模型能力需通过 `backend/.env.example` 自行配置。

## 版权声明

本仓库未附带开源许可证。未经作者或参赛团队书面许可，不得复制、修改、分发、商用、二次参赛、二次申报或用于其他竞赛提交。详见 [NOTICE.md](NOTICE.md)。