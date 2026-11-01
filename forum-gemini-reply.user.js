// ==UserScript==
// @name         论坛 Gemini 智能回帖助手 (V2EX / NodeSeek / Linux.do / Discuz)
// @namespace    https://github.com/kylo1989/forum-gemini-reply
// @version      3.9.0
// @description  修复NS摸鱼模式回帖不生效问题(execCommand真实输入唤醒Vue状态) + 为Linux.do摸鱼模式自动补全底部回复框与直连发帖 + 回层主/回楼主区分 + 429自动负载均衡
// @author       kylo1989
// @license      MIT
// @homepageURL  https://github.com/kylo1989/forum-gemini-reply
// @updateURL    https://raw.githubusercontent.com/kylo1989/forum-gemini-reply/main/forum-gemini-reply.user.js
// @downloadURL  https://raw.githubusercontent.com/kylo1989/forum-gemini-reply/main/forum-gemini-reply.user.js
// @match        *://*.v2ex.com/*
// @match        *://*.nodeseek.com/*
// @match        *://*.linux.do/*
// @match        *://*.right.com.cn/*
// @match        *://*/*thread-*.html*
// @match        *://*/*forum.php?mod=viewthread*
// @match        *://*/*forum.php?mod=post*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

(function() {
    'use strict';

    const DEFAULT_MODEL = 'gemini-2.0-flash';
    const CACHE_TTL = 12 * 3600 * 1000;

    // 记录用户最近一次在页面上点击“回复某层主”时捕获的层主信息
    let lastClickedFloor = { user: '', floorNum: '', content: '', timestamp: 0 };
    // 记录摸鱼模式下当前选中的帖子 ID (用于 linux.do 补全发帖框直连发帖)
    let currentMoyuTopicId = '';

    const FALLBACK_MODELS = [
        { id: 'gemini-2.0-flash', label: '⚡ gemini-2.0-flash (主力推荐·每日1500次高额度)', priority: 100 },
        { id: 'gemini-2.5-flash-lite', label: '🚀 gemini-2.5-flash-lite (新一代极速轻量·高额度)', priority: 95 },
        { id: 'gemini-2.0-flash-lite', label: '💨 gemini-2.0-flash-lite (超轻量极速·高额度)', priority: 90 },
        { id: 'gemini-1.5-flash', label: '🛡️ gemini-1.5-flash (经典稳定·高额度备用)', priority: 85 },
        { id: 'gemini-1.5-flash-8b', label: '🍃 gemini-1.5-flash-8b (高频小模型·高额度)', priority: 80 },
        { id: 'gemini-2.5-flash', label: '🧠 gemini-2.5-flash (智能思考·免费额度仅20次/天)', priority: 50 }
    ];

    GM_registerMenuCommand("🔑 1. 设置 Gemini API Key", () => {
        const key = prompt("请输入您的 Gemini API Key:", GM_getValue("GEMINI_API_KEY", ""));
        if (key !== null) {
            GM_setValue("GEMINI_API_KEY", key.trim());
            fetchOfficialModels(true);
        }
    });

    GM_registerMenuCommand("🔄 2. 立即从官方接口同步最新模型", () => {
        fetchOfficialModels(true, true);
    });

    /**
     * 轻量级右上角状态通知 Toast（用于提示摸鱼模式回帖是否真正成功或被 CD/CF 拦截）
     */
    function showToast(msg, isError = false) {
        const toast = document.createElement('div');
        toast.innerText = msg;
        toast.style.cssText = `position: fixed; top: 20px; right: 20px; padding: 10px 16px; background: ${isError ? '#dc2626' : '#059669'}; color: #fff; border-radius: 6px; font-size: 13px; font-weight: bold; z-index: 999999; box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: opacity 0.3s;`;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    /**
     * 拦截监控页面 fetch 请求：
     * 1. 捕获摸鱼模式当前加载的帖子 ID（供 linux.do 自建发帖框使用）
     * 2. 监控 NodeSeek 摸鱼模式下的发帖响应，若因 CD 冷却或 CF 验证失败而未生效，立即弹窗提醒用户
     */
    const origFetch = window.fetch;
    if (origFetch) {
        window.fetch = async function(...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            // 捕获 linux.do 摸鱼模式点击左侧列表时请求的帖子 ID (/t/xxx.json 或 /t/slug/12345.json)
            if (location.hostname.includes('linux.do')) {
                const tMatch = url.match(/\/t\/(?:[^\/]+\/)?(\d+)\.json/);
                if (tMatch) currentMoyuTopicId = tMatch[1];
            }

            const response = await origFetch.apply(this, args);

            // 监控 NodeSeek 发帖接口返回结果，排查“为什么很多回复没生效”
            if (location.hostname.includes('nodeseek.com') && (url.includes('comment') || url.includes('reply') || url.includes('/api/content/'))) {
                const method = (args[1]?.method || 'GET').toUpperCase();
                if (method === 'POST') {
                    response.clone().json().then(data => {
                        if (data && data.success === false) {
                            showToast(`⚠️ NS回帖未生效：${data.message || data.msg || '触发发帖冷却CD或权限限制'}`, true);
                        } else if (data && (data.success === true || data.id)) {
                            showToast(`✅ NS回帖已成功生效！`, false);
                        }
                    }).catch(() => {
                        if (!response.ok) {
                            showToast(`⚠️ NS回帖被拦截 (HTTP ${response.status})：可能触发了 Cloudflare 验证或发帖过快`, true);
                        }
                    });
                }
            }
            return response;
        };
    }

    /**
     * 检测页面是否处于“摸鱼模式（仿微信界面）”
     */
    function isMoyuModeActive() {
        // 检查是否存在左侧会话列表 + 右侧主面板的仿微信布局特征
        if (document.querySelector('textarea[placeholder*="发送给"], input[placeholder*="发送给"]')) return true;
        // 针对 linux.do 等没有原生渲染输入框的摸鱼界面：检查是否存在顶部带 "新回复" 搜索栏和左侧会话列表的摸鱼容器
        const allInputs = Array.from(document.querySelectorAll('input[placeholder*="搜索"]'));
        for (const inp of allInputs) {
            const parentText = inp.parentElement?.parentElement?.innerText || '';
            if (parentText.includes('新回复') || parentText.includes('最热')) {
                return true;
            }
        }
        return false;
    }

    /**
     * 获取摸鱼模式的右侧聊天主面板容器（用于提取气泡或为 linux.do 补全底部回复框）
     */
    function getMoyuRightChatPane() {
        // 寻找顶部包含 "(数字)" 楼层统计的标题栏所在的右侧主容器（如 "学生党纠结值不值得买... (27)"）
        const candidates = Array.from(document.querySelectorAll('div, header'));
        for (const el of candidates) {
            if (el.children.length <= 3 && /\(\d+\)\s*$/.test(el.innerText.trim())) {
                const rect = el.getBoundingClientRect();
                // 位于右侧主区域顶部
                if (rect.left > 200 && rect.top >= 0 && rect.top < 120 && rect.width > 300) {
                    return el.parentElement;
                }
            }
        }
        return null;
    }

    /**
     * 针对 linux.do 摸鱼模式缺失回复框的问题：自动在右侧聊天窗底部构建仿微信回复框 + 直连发帖按钮
     */
    function ensureLinuxDoMoyuReplyBox() {
        if (!location.hostname.includes('linux.do')) return null;
        const existingCustom = document.querySelector('#gemini-linuxdo-moyu-input');
        if (existingCustom && existingCustom.offsetParent !== null) return existingCustom;

        const rightPane = getMoyuRightChatPane();
        if (!rightPane) return null;

        // 检查是否已经有原生的摸鱼输入框
        const nativeMoyu = rightPane.querySelector('textarea[placeholder*="发送给"]');
        if (nativeMoyu) return nativeMoyu;

        // 创建补全的底部输入区容器
        const wrapper = document.createElement('div');
        wrapper.id = 'gemini-linuxdo-moyu-box';
        wrapper.style.cssText = 'border-top: 1px solid #e5e7eb; background: #ffffff; padding: 8px 16px 12px 16px; display: flex; flex-direction: column; flex-shrink: 0; z-index: 999;';

        const ta = document.createElement('textarea');
        ta.id = 'gemini-linuxdo-moyu-input';
        const headerText = rightPane.firstElementChild?.innerText?.replace(/\(\d+\)\s*$/, '')?.trim() || '当前话题';
        ta.placeholder = `发送给 ${headerText} (Ctrl + Enter 发送)`;
        ta.style.cssText = 'width: 100%; height: 68px; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px; font-size: 13px; color: #1f2937; background: #f9fafb; resize: none; outline: none; box-sizing: border-box; margin-top: 4px;';

        const bottomRow = document.createElement('div');
        bottomRow.style.cssText = 'display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 6px;';

        const tip = document.createElement('span');
        tip.innerText = 'Ctrl + Enter 发送';
        tip.style.cssText = 'font-size: 12px; color: #9ca3af;';

        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.innerText = '发送';
        sendBtn.style.cssText = 'padding: 5px 18px; background: #07c160; color: #fff; border: none; border-radius: 4px; font-size: 13px; font-weight: bold; cursor: pointer;';

        const doSubmitLinuxDo = async () => {
            const rawText = ta.value.trim();
            if (!rawText) {
                alert('请先生成或输入回复内容！');
                return;
            }

            // 1. 获取当前摸鱼会话对应的 Topic ID
            let topicId = currentMoyuTopicId;
            if (!topicId) {
                // 尝试从页面链接或选中项提取
                const activeLink = document.querySelector('a[href*="/t/"][class*="active"], [class*="active"] a[href*="/t/"]');
                const m = activeLink?.getAttribute('href')?.match(/\/t\/(?:[^\/]+\/)?(\d+)/);
                if (m) topicId = m[1];
            }
            if (!topicId) {
                const inputId = prompt('未能自动捕获当前话题 ID，请点击左侧话题列表刷新，或手动输入帖子数字 ID：');
                if (!inputId) return;
                topicId = inputId.trim();
            }

            // 2. 获取 Discourse CSRF Token
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
            if (!csrfToken) {
                alert('未获取到登录凭证 (CSRF Token)，请确认您已登录 linux.do！');
                return;
            }

            // 如果开头带有 "@username #floor "，提取出楼层号传给 reply_to_post_number，并清理多余前缀
            let replyToPostNumber = undefined;
            let cleanPostContent = rawText;
            const floorMatch = rawText.match(/^@([^\s#]+)(?:\s*#(\d+))?\s+/);
            if (floorMatch) {
                if (floorMatch[2] && floorMatch[2] !== '1') {
                    replyToPostNumber = parseInt(floorMatch[2], 10);
                } else if (lastClickedFloor.floorNum && lastClickedFloor.floorNum !== '1') {
                    replyToPostNumber = parseInt(lastClickedFloor.floorNum, 10);
                }
                cleanPostContent = rawText.replace(/^@([^\s#]+)(?:\s*#(\d+))?\s+/, '');
            }

            sendBtn.innerText = '发送中...';
            sendBtn.disabled = true;

            try {
                const bodyParams = new URLSearchParams();
                bodyParams.append('raw', cleanPostContent);
                bodyParams.append('topic_id', String(topicId));
                if (replyToPostNumber) {
                    bodyParams.append('reply_to_post_number', String(replyToPostNumber));
                }

                const res = await origFetch('/posts', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-CSRF-Token': csrfToken,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: bodyParams.toString()
                });

                const data = await res.json();
                sendBtn.innerText = '发送';
                sendBtn.disabled = false;

                if (res.ok && data.id) {
                    ta.value = '';
                    lastClickedFloor = { user: '', floorNum: '', content: '', timestamp: 0 };
                    updateModeBarStatus();
                    showToast(`✅ Linux.do 回帖成功！(楼层 #${data.post_number})`);
                } else {
                    const errMsg = data.errors ? data.errors.join('\n') : '发帖失败，请检查字数或发帖频率限制';
                    showToast(`⚠️ Linux.do 回帖失败：${errMsg}`, true);
