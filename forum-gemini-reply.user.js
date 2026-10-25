// ==UserScript==
// @name         论坛 Gemini 智能回帖助手 (V2EX / NodeSeek / Discuz)
// @namespace    https://github.com/kylo1989/forum-gemini-reply
// @version      3.4.0
// @description  官方接口实时同步可用模型 + 智能特点标注 + 额度耗尽多级负载均衡，三档回复梯度，完美适配NS站/V2EX/DZ
// @author       kylo1989
// @license      MIT
// @homepageURL  https://github.com/kylo1989/forum-gemini-reply
// @updateURL    https://raw.githubusercontent.com/kylo1989/forum-gemini-reply/main/forum-gemini-reply.user.js
// @downloadURL  https://raw.githubusercontent.com/kylo1989/forum-gemini-reply/main/forum-gemini-reply.user.js
// @match        *://*.v2ex.com/t/*
// @match        *://*.nodeseek.com/post-*
// @match        *://*/thread-*-*-*.html
// @match        *://*/forum.php?mod=viewthread*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

(function() {
    'use strict';

    const DEFAULT_MODEL = 'gemini-2.0-flash';
    const CACHE_TTL = 12 * 3600 * 1000; // 模型列表缓存 12 小时

    // 默认兜底模型列表（未配置 Key 或首次加载前使用）
    const FALLBACK_MODELS = [
        { id: 'gemini-2.0-flash', label: '⚡ gemini-2.0-flash (主力推荐·每日1500次高额度)', priority: 100 },
        { id: 'gemini-2.5-flash-lite', label: '🚀 gemini-2.5-flash-lite (新一代极速轻量·高额度)', priority: 95 },
        { id: 'gemini-2.0-flash-lite', label: '💨 gemini-2.0-flash-lite (超轻量极速·高额度)', priority: 90 },
        { id: 'gemini-1.5-flash', label: '🛡️ gemini-1.5-flash (经典稳定·高额度备用)', priority: 85 },
        { id: 'gemini-1.5-flash-8b', label: '🍃 gemini-1.5-flash-8b (高频小模型·高额度)', priority: 80 },
        { id: 'gemini-2.5-flash', label: '🧠 gemini-2.5-flash (智能思考·免费额度仅20次/天)', priority: 50 }
    ];

    // 油猴菜单：设置 API Key
    GM_registerMenuCommand("🔑 1. 设置 Gemini API Key", () => {
        const key = prompt("请输入您的 Gemini API Key:", GM_getValue("GEMINI_API_KEY", ""));
        if (key !== null) {
            GM_setValue("GEMINI_API_KEY", key.trim());
            fetchOfficialModels(true); // 更新 Key 后立即拉取最新模型列表
        }
    });

    // 油猴菜单：强制刷新官方模型列表
    GM_registerMenuCommand("🔄 2. 立即从官方接口同步最新模型", () => {
        fetchOfficialModels(true, true);
    });

    /**
     * 智能标注引擎：根据官方返回的模型 ID 自动标注特点与负载均衡优先级
     * priority 越高，在下拉框越靠前，且在额度用完自动切换时优先被选中
     */
    function annotateModel(modelId) {
        const id = modelId.toLowerCase();

        // 1. 精确匹配主流核心模型
        if (id === 'gemini-2.0-flash') {
            return { label: `⚡ ${modelId} (主力推荐·高额度秒回)`, priority: 100 };
        }
        if (id === 'gemini-2.5-flash-lite' || id.startsWith('gemini-2.5-flash-lite-')) {
            return { label: `🚀 ${modelId} (2.5极速轻量·高额度推荐)`, priority: 96 };
        }
        if (id === 'gemini-2.0-flash-lite' || id.startsWith('gemini-2.0-flash-lite-')) {
            return { label: `💨 ${modelId} (2.0超轻量·高额度极速)`, priority: 92 };
        }
        if (id === 'gemini-1.5-flash' || id === 'gemini-1.5-flash-latest') {
            return { label: `🛡️ ${modelId} (经典稳定·高额度备用)`, priority: 88 };
        }
        if (id.includes('1.5-flash-8b')) {
            return { label: `🍃 ${modelId} (8B超轻量·高频防限流)`, priority: 84 };
        }
        if (id === 'gemini-2.5-flash') {
            return { label: `🧠 ${modelId} (2.5标准版·免费额度严苛)`, priority: 55 };
        }

        // 2. 动态启发式规则（自动兼容未来发布的 Gemini 3.0 / 新系列模型）
        if (id.includes('flash-lite')) {
            return { label: `🚀 ${modelId} (轻量Flash·高额度极速)`, priority: 90 };
        }
        if (id.includes('flash') && !id.includes('exp') && !id.includes('preview') && !id.includes('thinking')) {
            return { label: `⚡ ${modelId} (Flash高速版·均衡推荐)`, priority: 78 };
        }
        if (id.includes('flash') && (id.includes('exp') || id.includes('preview') || id.includes('thinking'))) {
            return { label: `🧪 ${modelId} (实验/思考预览版·额度较少)`, priority: 45 };
        }
        if (id.includes('pro')) {
            return { label: `💎 ${modelId} (Pro深度推理·免费额度极少)`, priority: 30 };
        }

        return { label: `🤖 ${modelId} (官方可用模型)`, priority: 40 };
    }

    /**
     * 过滤掉不适合纯文本论坛回帖的专用模型（如画图、语音、TTS、视觉专用等）
     */
    function isTextChatModel(rawModel) {
        const name = (rawModel.name || '').replace('models/', '');
        const methods = rawModel.supportedGenerationMethods || [];
        if (!methods.includes('generateContent')) return false;
        if (!name.startsWith('gemini-')) return false;

        // 排除非纯文本回帖用途的特殊变体及冗余固定快照
        const excludeKeywords = ['vision', 'image', 'audio', 'tts', 'embedding', 'aqa', 'robotics', 'computer-use', '-001', '-002'];
        if (excludeKeywords.some(kw => name.includes(kw))) return false;

        return true;
    }

    /**
     * 调用 Google 官方 GET /v1beta/models 接口获取实时模型列表
     */
    function fetchOfficialModels(force = false, showAlert = false) {
        const apiKey = GM_getValue("GEMINI_API_KEY", "");
        if (!apiKey) {
            if (showAlert) alert("请先设置 Gemini API Key 后再同步模型列表！");
            return;
        }

        const lastFetch = GM_getValue("GEMINI_MODELS_LAST_FETCH", 0);
        const cached = GM_getValue("GEMINI_MODELS_CACHE", null);
        if (!force && cached && (Date.now() - lastFetch < CACHE_TTL)) {
            return;
        }

        const refreshBtn = document.querySelector('#gemini-model-refresh-btn');
        if (refreshBtn) refreshBtn.innerText = '⏳';

        GM_xmlhttpRequest({
            method: "GET",
            url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${apiKey}`,
            onload: function(response) {
                if (refreshBtn) refreshBtn.innerText = '🔄';
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.error) {
                        if (showAlert) alert(`同步模型失败: ${data.error.message}`);
                        return;
                    }

                    const rawModels = data.models || [];
                    const parsedMap = new Map();

                    rawModels.forEach(m => {
                        if (!isTextChatModel(m)) return;
                        const id = m.name.replace('models/', '');
                        const info = annotateModel(id);
                        parsedMap.set(id, {
                            id: id,
                            label: info.label,
                            priority: info.priority
                        });
                    });

                    let modelList = Array.from(parsedMap.values());
                    if (modelList.length === 0) {
                        modelList = FALLBACK_MODELS;
                    } else {
                        // 按推荐度（priority）从高到低排序，同优先级按名称排序
                        modelList.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
                    }

                    GM_setValue("GEMINI_MODELS_CACHE", modelList);
                    GM_setValue("GEMINI_MODELS_LAST_FETCH", Date.now());
                    renderModelSelectOptions();

                    if (showAlert) {
                        alert(`✅ 同步成功！已从 Google 官方接口获取到 ${modelList.length} 个可用 Gemini 模型。`);
                    }
                } catch (e) {
                    console.error("[Gemini助手] 解析模型列表失败:", e);
                    if (showAlert) alert("解析官方模型列表失败，请检查网络设置。");
                }
            },
            onerror: function() {
                if (refreshBtn) refreshBtn.innerText = '🔄';
                if (showAlert) alert("网络请求失败，无法连接 generativelanguage.googleapis.com");
            }
        });
    }

    function getAvailableModels() {
        const cached = GM_getValue("GEMINI_MODELS_CACHE", null);
        return (cached && Array.isArray(cached) && cached.length > 0) ? cached : FALLBACK_MODELS;
    }

    function renderModelSelectOptions() {
        const selectEl = document.querySelector('#gemini-model-select');
        if (!selectEl) return;

        const models = getAvailableModels();
        const currentSaved = GM_getValue("GEMINI_MODEL", DEFAULT_MODEL);
        selectEl.innerHTML = '';

        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.innerText = m.label;
            if (m.id === currentSaved) opt.selected = true;
            selectEl.appendChild(opt);
        });

        // 若当前保存的模型不在列表中，自动选中优先级最高的第一项
        if (!models.some(m => m.id === currentSaved) && models.length > 0) {
            selectEl.value = models[0].id;
            GM_setValue("GEMINI_MODEL", models[0].id);
        }
    }

    const siteConfigs = {
        v2ex: {
            match: () => location.hostname.includes('v2ex.com'),
            title: () => document.querySelector('.header h1')?.innerText || document.title,
            content: () => document.querySelector('.topic_content')?.innerText || '',
            replies: () => Array.from(document.querySelectorAll('.reply_content')).slice(0, 5).map(el => el.innerText.trim()).join(' | '),
            getMountTarget: () => document.querySelector('#reply_content'),
            fillText: (text) => {
                const el = document.querySelector('#reply_content');
                if (el) {
                    el.value = text;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.focus();
                }
            },
            persona: 'V2EX资深程序员老哥，懂技术、说话直接、有逻辑、不讲客套话'
        },
        nodeseek: {
            match: () => location.hostname.includes('nodeseek.com'),
            title: () => document.querySelector('.post-title h1, .nsk-post h1, h1')?.innerText || document.title,
            content: () => document.querySelector('article.post-content, .post-content')?.innerText || '',
            replies: () => Array.from(document.querySelectorAll('article.post-content, .post-content')).slice(1, 6).map(el => el.innerText.trim()).join(' | '),
            getMountTarget: () => document.querySelector('.CodeMirror') || document.querySelector('#cm-editor-wrapper') || document.querySelector('.nsk-editor') || document.querySelector('.comment-box textarea'),
            fillText: (text) => {
                const cmEl = document.querySelector('.CodeMirror');
                if (cmEl && cmEl.CodeMirror) {
                    cmEl.CodeMirror.setValue(text);
                    cmEl.CodeMirror.focus();
                    return;
                }
                const hiddenTa = document.querySelector('.CodeMirror textarea') || document.querySelector('textarea');
                if (hiddenTa) {
                    hiddenTa.focus();
                    hiddenTa.value = '';
                    const dt = new DataTransfer();
                    dt.setData('text/plain', text);
                    hiddenTa.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

                    setTimeout(() => {
                        if (!hiddenTa.value && (!cmEl || !cmEl.innerText.includes(text.slice(0, 5)))) {
                            hiddenTa.value = text;
                            hiddenTa.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }, 100);
                }
            },
            persona: 'NodeSeek (MJJ/主机圈) 资深玩家，熟悉VPS线路、网络优化、建站、硬件与折腾，说话接地气，善用社区黑话（bd、好鸡、早收、富哥、溢价、灵车、分母、吃码等）'
        },
        discuz: {
            match: () => true,
            title: () => document.querySelector('#thread_subject')?.innerText || document.title,
            content: () => document.querySelector('td[id^="postmessage_"]')?.innerText || '',
            replies: () => Array.from(document.querySelectorAll('td[id^="postmessage_"]')).slice(1, 6).map(el => el.innerText.trim()).join(' | '),
            getMountTarget: () => document.querySelector('#fastpostmessage'),
            fillText: (text) => {
                const el = document.querySelector('#fastpostmessage');
                if (el) {
                    el.value = text;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.focus();
                }
            },
            persona: '论坛常驻老哥，语气熟稔自然，像真人坛友一样交流'
        }
    };

    const replyModes = [
        {
            label: '🍗 摸鱼黑话 (2~6字)',
            type: 'short',
            maxTokens: 512,
            rules: `
1. 这是纯水贴拿积分/鸡腿模式，字数控制在 2~8 个字！
2. 根据帖子类型（出鸡/收鸡/抽奖/分享/水贴）和【前排网友回复】的队形，直接甩出最地道的社区极简黑话（例如：bd、绑定、好鸡早收、分母来了、感谢分享、老哥稳、富哥、帮顶）。
3. 严禁加句号，严禁换行，直接输出完整词组，只输出最终回复的那几个字！`
        },
        {
            label: '💬 简短互动 (40字左右)',
            type: 'medium',
            maxTokens: 1024,
            rules: `
1. 针对主楼内容或顺着前排评论，用一两句自然的大白话发表看法、吐槽、补充经验或互动。
2. 字数控制在 25~55 个字左右（约一到两句话），必须把整句话的逻辑和意思表达完整，绝对不能话说到一半断掉！
3. 语气要像真人坛友日常敲字交流，口语化、接地气，中间可以用逗号分隔，严禁出现“总的来说”、“确实”、“希望”、“首先”等AI客套词。只输出回复正文！`
        },
        {
            label: '🧐 详细分析 (完整深度回复)',
            type: 'long',
            maxTokens: 2048,
            rules: `
1. 针对主楼的问题、方案、测评或分享，给出有深度、有干货、逻辑完整的详细分析或解答，字数控制在 120~350 字左右，务必把前因后果、排查步骤或优缺点完整讲透，严禁半途截断！
2. 保持论坛资深技术老哥的口吻：直接切入核心痛点或细节，可以自然分段，但严禁使用“首先、其次、最后、综上所述、总而言之、希望能帮到你”这种死板的AI公文套路。
3. 纯文本输出：绝对不要使用 Markdown 加粗符号（**）或标题符号（###），如需列举可以用简单的数字 1. 2. 或直接分段叙述。只输出回复正文！`
        }
    ];

    function getCurrentSite() {
        if (siteConfigs.v2ex.match()) return siteConfigs.v2ex;
        if (siteConfigs.nodeseek.match()) return siteConfigs.nodeseek;
        return siteConfigs.discuz;
    }

    function initButton() {
        const site = getCurrentSite();
        const target = site.getMountTarget();
        if (!target || document.querySelector('#gemini-btn-bar')) return;

        const bar = document.createElement('div');
        bar.id = 'gemini-btn-bar';
        bar.style.cssText = 'margin: 6px 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; z-index: 999;';

        // 1. 创建三档回复按钮
        replyModes.forEach(mode => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.innerText = mode.label;
            btn.style.cssText = 'padding: 4px 10px; background: #2b2d31; color: #e3e5e8; border: 1px solid #4e5058; border-radius: 4px; cursor: pointer; font-size: 12px; transition: 0.2s;';
            btn.onmouseover = () => { btn.style.background = '#404249'; };
            btn.onmouseout = () => { btn.style.background = '#2b2d31'; };
            btn.onclick = () => {
                const selectedModel = GM_getValue("GEMINI_MODEL", DEFAULT_MODEL);
                // 初始化已尝试过的失败模型集合，开启自动负载均衡队列
                generateReply(site, mode, btn, selectedModel, new Set());
            };
            bar.appendChild(btn);
        });

        // 2. 创建实时模型选择下拉框
        const modelSelect = document.createElement('select');
        modelSelect.id = 'gemini-model-select';
        modelSelect.title = '选择 Gemini 模型（列表通过官方 API 自动更新，支持额度耗尽自动切换）';
        modelSelect.style.cssText = 'padding: 3px 6px; background: #1e1f22; color: #b5bac1; border: 1px solid #4e5058; border-radius: 4px; font-size: 12px; cursor: pointer; outline: none; max-width: 290px;';
        modelSelect.onchange = () => {
            GM_setValue("GEMINI_MODEL", modelSelect.value);
        };
        bar.appendChild(modelSelect);

        // 3. 创建手动刷新模型列表按钮
        const refreshBtn = document.createElement('button');
        refreshBtn.id = 'gemini-model-refresh-btn';
        refreshBtn.type = 'button';
        refreshBtn.innerText = '🔄';
        refreshBtn.title = '从 Google 官方接口实时同步最新可用模型';
        refreshBtn.style.cssText = 'padding: 3px 7px; background: #1e1f22; color: #b5bac1; border: 1px solid #4e5058; border-radius: 4px; cursor: pointer; font-size: 12px;';
        refreshBtn.onclick = () => fetchOfficialModels(true, true);
        bar.appendChild(refreshBtn);

        target.parentNode.insertBefore(bar, target);

        // 渲染下拉列表并在后台静默检查更新
        renderModelSelectOptions();
        fetchOfficialModels(false, false);
    }

    function cleanOutput(text, type) {
        let cleaned = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
        if (type === 'short') {
            cleaned = cleaned.replace(/[。！!~～]+$/g, '').replace(/\n+/g, ' ');
        } else if (type === 'medium') {
            cleaned = cleaned.replace(/\n+/g, ' ').replace(/\*\*/g, '').replace(/[。]+$/g, '');
        } else {
            cleaned = cleaned.replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
        }
        return cleaned.trim();
    }

    /**
     * 负载均衡选路器：当当前模型额度耗尽时，从可用模型池中挑出优先级最高且未尝试过的下一个模型
     */
    function getNextAvailableModel(triedModels) {
        const allModels = getAvailableModels();
        // 优先挑选 priority >= 70 的高额度 Flash 模型进行故障转移
        for (const m of allModels) {
            if (!triedModels.has(m.id)) {
                return m.id;
            }
        }
        return null;
    }

    function generateReply(site, mode, btn, modelId, triedModels) {
        const apiKey = GM_getValue("GEMINI_API_KEY", "");
        if (!apiKey) {
            alert("请先点击浏览器右上角油猴插件图标 -> 点击【🔑 1. 设置 Gemini API Key】");
            return;
        }

        triedModels.add(modelId);

        const title = site.title() || '无标题';
        const contentLimit = mode.type === 'long' ? 2500 : 1000;
        const content = (site.content() || '无正文内容').slice(0, contentLimit);
        const replies = (site.replies() || '暂无回复').slice(0, 500);

        const fullPrompt = `你现在的身份是：${site.persona}。\n请根据以下论坛帖子内容生成一条自然回帖，严格遵守以下规则：${mode.rules}\n\n【帖子标题】：${title}\n【主楼内容】：${content}\n【前排网友回复参考】：${replies}`;

        if (triedModels.size === 1) {
            btn.dataset.origText = btn.innerText;
            btn.innerText = '⏳ 思考中...';
        } else {
            btn.innerText = `🔄 负载至 ${modelId.replace('gemini-', '')}...`;
        }
        btn.disabled = true;

        const genConfig = {
            temperature: mode.type === 'long' ? 0.75 : 0.85,
            maxOutputTokens: mode.maxTokens
        };
        // 对支持思考预算控制的 2.5 标准版关闭思考消耗，避免断句与额外耗时
        if (modelId.includes('2.5-flash') && !modelId.includes('lite')) {
            genConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        GM_xmlhttpRequest({
            method: "POST",
            url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                contents: [{ parts: [{ text: fullPrompt }] }],
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                ],
                generationConfig: genConfig
            }),
            onload: function(response) {
                try {
                    const data = JSON.parse(response.responseText);

                    // 遇到 429(额度用尽/并发限制)、404(模型下架)、503(模型过载) 时触发自动负载均衡
                    if (data.error) {
                        const errCode = data.error.code;
                        if (errCode === 429 || errCode === 404 || errCode === 503 || errCode === 400) {
                            const nextModel = getNextAvailableModel(triedModels);
                            // 最多连续自动负载切换 4 个备用模型，避免 Key 本身无效时死循环
                            if (nextModel && triedModels.size <= 4) {
                                console.warn(`[Gemini负载均衡] 模型 ${modelId} 不可用 (Code ${errCode})，自动切换至备用模型: ${nextModel}`);
                                const selectEl = document.querySelector('#gemini-model-select');
                                if (selectEl) selectEl.value = nextModel;
                                GM_setValue("GEMINI_MODEL", nextModel);
                                generateReply(site, mode, btn, nextModel, triedModels);
                                return;
                            }
                        }
                        btn.innerText = btn.dataset.origText;
                        btn.disabled = false;
                        alert(`Gemini API 报错 (${data.error.code}) [已尝试模型: ${Array.from(triedModels).join(' -> ')}]:\n${data.error.message}`);
                        return;
                    }

                    btn.innerText = btn.dataset.origText;
                    btn.disabled = false;

                    if (data.promptFeedback && data.promptFeedback.blockReason) {
                        alert(`内容被 Gemini 拦截，原因: ${data.promptFeedback.blockReason}`);
                        return;
                    }

                    const candidate = data.candidates && data.candidates[0];
                    if (!candidate) {
                        alert("未生成有效内容，请检查帖子内容是否空白。");
                        return;
                    }

                    const parts = candidate.content && candidate.content.parts;
                    if (!parts || parts.length === 0) {
                        alert(`生成中止，原因: ${candidate.finishReason || 'UNKNOWN'}`);
                        return;
                    }

                    const textPart = parts.filter(p => !p.thought && p.text).pop() || parts[parts.length - 1];
                    let replyText = textPart ? textPart.text : '';

                    if (!replyText) {
                        alert("生成的回复文本为空，请重试。");
                        return;
                    }

                    replyText = cleanOutput(replyText, mode.type);
                    site.fillText(replyText);
                } catch (e) {
                    btn.innerText = btn.dataset.origText;
                    btn.disabled = false;
                    console.error("Parse Error:", e, response.responseText);
                    alert("解析响应失败，请检查网络代理是否正常。");
                }
            },
            onerror: function() {
                btn.innerText = btn.dataset.origText;
                btn.disabled = false;
                alert("请求失败，请检查代理网络是否放行了 generativelanguage.googleapis.com");
            }
        });
    }

    setInterval(initButton, 1200);
})();
