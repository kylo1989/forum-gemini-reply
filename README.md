# 论坛 Gemini 智能回帖助手 (V2EX / NodeSeek / Discuz)

基于 Google Gemini API (`gemini-2.5-flash`) 的油猴（Tampermonkey）智能回帖脚本。专为 **NodeSeek**、**V2EX** 以及各类 **Discuz!** 论坛打造，自动读取主楼内容与前排楼层队形，告别浓重的“AI 客服味”。

## ✨ 核心特性

- **三档梯度自由切换**：
  - `🍗 摸鱼黑话 (2~6字)`：自动识别出鸡、抽奖、分享帖及前排队形，一键输出 `bd 好鸡`、`分母`、`老哥稳` 等地道黑话。
  - `💬 简短互动 (20字内)`：模拟真人手机单手打字习惯，单行无句号，随手吐槽或插话。
  - `🧐 详细分析 (完整回复)`：针对技术求助或测评帖输出深度干货，自动过滤 Markdown 加粗符号与“首先/其次/综上所述”等 AI 套话。
- **深度编辑器适配**：完美攻克 NodeSeek 的 `CodeMirror` 富文本编辑器注入难题，同时兼容 V2EX 与主流 DZ 论坛快速回复框。
- **前排队形感知**：自动抓取前 5 楼网友的真实回复作为上下文参考，保持跟风队形不突兀。

## 🚀 一键安装

1. 确保浏览器已安装 **Tampermonkey (篡改猴)** 或 **Violentmonkey (暴力猴)** 扩展。
2. 点击下方链接即可直接触发油猴安装界面：
   👉 **[点击此处一键安装脚本](https://raw.githubusercontent.com/你的GitHub用户名/forum-gemini-reply/main/forum-gemini-reply.user.js)**

## ⚙️ 使用方法

1. 前往 [Google AI Studio](https://aistudio.google.com/) 申请免费的 Gemini API Key。
2. 打开任意支持的论坛帖子页面，点击浏览器右上角的油猴扩展图标 -> 点击脚本菜单中的 **【⚙️ 设置 Gemini API Key】** 并填入保存。
3. 在帖子底部的回复框上方，点击对应的档位按钮即可自动生成并填入回复内容。# forum-gemini-reply
