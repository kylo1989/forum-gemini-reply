// ==UserScript==
// @name         论坛 Gemini 智能回帖助手 (V2EX / NodeSeek / Discuz全系列)
// @namespace    https://github.com/kylo1989/forum-gemini-reply
// @version      3.6.1
// @description  全站支持“回层主 vs 回楼主”智能区分与@前缀保留 + 恩山等DZ小窗多点挂载 + 官方接口同步模型 + 429自动负载均衡
// @author       kylo1989
// @license      MIT
// @homepageURL  https://github.com/kylo1989/forum-gemini-reply
// @updateURL    https://raw.githubusercontent.com/kylo1989/forum-gemini-reply/main/forum-gemini-reply.user.js
// @downloadURL  https://raw.githubusercontent.com/kylo1989/forum-gemini-reply/main/forum-gemini-reply.user.js
// @match        *://*.v2ex.com/t/*
// @match        *://*.nodeseek.com/post-*
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
     * 全局监听“回复层主”按钮点击事件（适配 V2EX 和 NodeSeek 点击楼层回复按钮的瞬间抓取该层内容）
     */
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!target) return;

        // 1. V2EX 点击楼层右侧回复图标
        if (location.hostname.includes('v2ex.com')) {
            const cell = target.closest('.cell[id^="r_"]');
            const isReplyAction = target.closest('a[onclick*="replyOne"], img[alt="Reply"]');
            if (cell && isReplyAction) {
                const user = cell.querySelector('strong a.dark')?.innerText?.trim() || '';
                const floorNum = cell.querySelector('.no')?.innerText?.trim() || '';
                const content = cell.querySelector('.reply_content')?.innerText?.trim() || '';
                if (content) {
                    lastClickedFloor = { user: user, floorNum: floorNum, content: content, timestamp: Date.now() };
                    setTimeout(updateModeBarStatus, 100);
                }
            }
        }

        // 2. NodeSeek 点击某楼层的“回复 / 引用”按钮
        if (location.hostname.includes('nodeseek.com')) {
            const commentItem = target.closest('.content-item, .comment-item, li[id^="post-"], .nsk-post');
            const btnText = (target.innerText || target.title || '').trim();
            const isReplyBtn = btnText.includes('回复') || btnText.includes('引用') || target.closest('.reply-btn, .quote-btn, [title*="回复"], [title*="引用"]');
            if (commentItem && isReplyBtn) {
                const user = commentItem.querySelector('.author-name, .username, a[href*="/space/"]')?.innerText?.trim() || '';
                const floorEl = commentItem.querySelector('.floor-link, .floor, [href*="#"]');
                const floorNum = floorEl ? floorEl.innerText.replace(/[^\d]/g, '') : '';
                const content = commentItem.querySelector('article.post-content, .post-content')?.innerText?.trim() || '';
                if (content) {
                    lastClickedFloor = { user: user, floorNum: floorNum, content: content, timestamp: Date.now() };
                    setTimeout(updateModeBarStatus, 150);
                }
            }
        }
    }, true);

    function annotateModel(modelId) {
        const id = modelId.toLowerCase();
        if (id === 'gemini-2.0-flash') return { label: `⚡ ${modelId} (主力推荐·高额度秒回)`, priority: 100 };
        if (id === 'gemini-2.5-flash-lite' || id.startsWith('gemini-2.5-flash-lite-')) return { label: `🚀 ${modelId} (2.5极速轻量·高额度推荐)`, priority: 96 };
        if (id === 'gemini-2.0-flash-lite' || id.startsWith('gemini-2.0-flash-lite-')) return { label: `💨 ${modelId} (2.0超轻量·高额度极速)`, priority: 92 };
        if (id === 'gemini-1.5-flash' || id === 'gemini-1.5-flash-latest') return { label: `🛡️ ${modelId} (经典稳定·高额度备用)`, priority: 88 };
        if (id.includes('1.5-flash-8b')) return { label: `🍃 ${modelId} (8B超轻量·高频防限流)`, priority: 84 };
        if (id === 'gemini-2.5-flash') return { label: `🧠 ${modelId} (2.5标准版·免费额度严苛)`, priority: 55 };

        if (id.includes('flash-lite')) return { label: `🚀 ${modelId} (轻量Flash·高额度极速)`, priority: 90 };
        if (id.includes('flash') && !id.includes('exp') && !id.includes('preview') && !id.includes('thinking')) return { label: `⚡ ${modelId} (Flash高速版·均衡推荐)`, priority: 78 };
        if (id.includes('flash') && (id.includes('exp') || id.includes('preview') || id.includes('thinking'))) return { label: `🧪 ${modelId} (实验/思考预览版·额度较少)`, priority: 45 };
        if (id.includes('pro')) return { label: `💎 ${modelId} (Pro深度推理·免费额度极少)`, priority: 30 };

        return { label: `🤖 ${modelId} (官方可用模型)`, priority: 40 };
    }

    function isTextChatModel(rawModel) {
        const name = (rawModel.name || '').replace('models/', '');
        const methods = rawModel.supportedGenerationMethods || [];
        if (!methods.includes('generateContent')) return false;
        if (!name.startsWith('gemini-')) return false;
        const excludeKeywords = ['vision', 'image', 'audio', 'tts', 'embedding', 'aqa', 'robotics', 'computer-use', '-001', '-002'];
        if (excludeKeywords.some(kw => name.includes(kw))) return false;
        return true;
    }

    function fetchOfficialModels(force = false, showAlert = false) {
        const apiKey = GM_getValue("GEMINI_API_KEY", "");
        if (!apiKey) {
            if (showAlert) alert("请先设置 Gemini API Key 后再同步模型列表！");
            return;
        }

        const lastFetch = GM_getValue("GEMINI_MODELS_LAST_FETCH", 0);
        const cached = GM_getValue("GEMINI_MODELS_CACHE", null);
        if (!force && cached && (Date.now() - lastFetch < CACHE_TTL)) return;

        document.querySelectorAll('.gemini-model-refresh-btn').forEach(b => { b.innerText = '⏳'; });

        GM_xmlhttpRequest({
            method: "GET",
            url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${apiKey}`,
            onload: function(response) {
                document.querySelectorAll('.gemini-model-refresh-btn').forEach(b => { b.innerText = '🔄'; });
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
                        parsedMap.set(id, { id: id, label: info.label, priority: info.priority });
                    });

                    let modelList = Array.from(parsedMap.values());
                    if (modelList.length === 0) {
                        modelList = FALLBACK_MODELS;
                    } else {
                        modelList.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
                    }

                    GM_setValue("GEMINI_MODELS_CACHE", modelList);
                    GM_setValue("GEMINI_MODELS_LAST_FETCH", Date.now());
                    syncAllModelSelects();

                    if (showAlert) {
                        alert(`✅ 同步成功！已从 Google 官方接口获取到 ${modelList.length} 个可用 Gemini 模型。`);
                    }
                } catch (e) {
                    console.error("[Gemini助手] 解析模型列表失败:", e);
                    if (showAlert) alert("解析官方模型列表失败，请检查网络设置。");
                }
            },
            onerror: function() {
                document.querySelectorAll('.gemini-model-refresh-btn').forEach(b => { b.innerText = '🔄'; });
                if (showAlert) alert("网络请求失败，无法连接 generativelanguage.googleapis.com");
            }
        });
    }

    function getAvailableModels() {
        const cached = GM_getValue("GEMINI_MODELS_CACHE", null);
        return (cached && Array.isArray(cached) && cached.length > 0) ? cached : FALLBACK_MODELS;
    }

    function syncAllModelSelects() {
        const models = getAvailableModels();
        let currentSaved = GM_getValue("GEMINI_MODEL", DEFAULT_MODEL);
        if (!models.some(m => m.id === currentSaved) && models.length > 0) {
            currentSaved = models[0].id;
            GM_setValue("GEMINI_MODEL", currentSaved);
        }

        document.querySelectorAll('.gemini-model-select').forEach(selectEl => {
            selectEl.innerHTML = '';
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.innerText = m.label;
                if (m.id === currentSaved) opt.selected = true;
                selectEl.appendChild(opt);
            });
            selectEl.value = currentSaved;
        });
    }

    /**
     * 读取 NodeSeek CodeMirror 编辑器的当前文本内容
     */
    function getNodeSeekEditorText() {
        const cmEl = document.querySelector('.CodeMirror');
        if (cmEl && cmEl.CodeMirror) {
            return cmEl.CodeMirror.getValue() || '';
        }
        // 若 CodeMirror 实例未挂载到 DOM 属性，读取可视代码行文本
        const codeLines = document.querySelectorAll('.CodeMirror-code .CodeMirror-line');
        if (codeLines && codeLines.length > 0) {
            return Array.from(codeLines).map(line => line.innerText.replace(/\u200B/g, '')).join('\n');
        }
        const ta = document.querySelector('.CodeMirror textarea') || document.querySelector('textarea');
        return ta ? ta.value : '';
    }

    const siteConfigs = {
        v2ex: {
            match: () => location.hostname.includes('v2ex.com'),
            title: () => document.querySelector('.header h1')?.innerText || document.title,
            content: () => document.querySelector('.topic_content')?.innerText || '',
            replies: () => Array.from(document.querySelectorAll('.reply_content')).slice(0, 5).map(el => el.innerText.trim()).join(' | '),
            getMountTargets: () => {
                const el = document.querySelector('#reply_content');
                return el ? [el] : [];
            },
            detectFloorTarget: (targetEl) => {
                const el = targetEl || document.querySelector('#reply_content');
                const val = el ? el.value : '';
                const match = val.match(/^(@([a-zA-Z0-9_-]+)(?:\s+#(\d+))?\s*)/);
                if (!match) return null;

                const prefix = match[1].trim() + ' ';
                const username = match[2];
                const floorNo = match[3];
                let floorContent = '';

                const cells = Array.from(document.querySelectorAll('.cell[id^="r_"]'));
                if (floorNo) {
                    const targetCell = cells.find(c => c.querySelector('.no')?.innerText?.trim() === floorNo);
                    if (targetCell) floorContent = targetCell.querySelector('.reply_content')?.innerText?.trim() || '';
                }
                if (!floorContent && username) {
                    const userCells = cells.filter(c => c.querySelector('strong a.dark')?.innerText?.trim() === username);
                    if (userCells.length > 0) {
                        floorContent = userCells[userCells.length - 1].querySelector('.reply_content')?.innerText?.trim() || '';
                    }
                }
                if (!floorContent && lastClickedFloor.user === username) {
                    floorContent = lastClickedFloor.content;
                }

                return {
                    isFloorReply: true,
                    prefixToKeep: prefix,
                    targetUser: username,
                    targetFloor: floorNo || '',
                    targetContent: floorContent || `(用户 @${username} 的发言)`
                };
            },
            fillText: (text, targetEl, prefixToKeep = '') => {
                const el = targetEl || document.querySelector('#reply_content');
                if (el) {
                    el.value = prefixToKeep + text;
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
            getMountTargets: () => {
                const el = document.querySelector('.CodeMirror') || document.querySelector('#cm-editor-wrapper') || document.querySelector('.nsk-editor') || document.querySelector('.comment-box textarea');
                return el ? [el] : [];
            },
            detectFloorTarget: () => {
                const rawVal = getNodeSeekEditorText();
                if (!rawVal || !rawVal.trim()) return null;

                // 匹配 "@username #12 " 或 "[@username](/space/...) #12"
                const atMatch = rawVal.match(/^((?:@[^\s#]+|\[@[^\]]+\]\([^\)]+\))(?:\s*#(\d+))?\s*)/);
                // 匹配 Markdown 引用块 "> 某层主原话"
                const quoteLines = rawVal.match(/^((?:>[^\n]*\n?)+)\s*/);

                if (!atMatch && !quoteLines) return null;

                let prefix = '';
                let floorNo = '';
                let username = '';
                let floorContent = '';

                if (quoteLines) {
                    prefix = quoteLines[0].trim() + '\n\n';
                    floorContent = quoteLines[1].replace(/^>\s*/gm, '').trim();
                } else if (atMatch) {
                    prefix = atMatch[1].trim() + ' ';
                    floorNo = atMatch[2] || '';
                    const uMatch = atMatch[1].match(/@([^\s#\]]+)/);
                    username = uMatch ? uMatch[1] : '';
                }

                const allArticles = Array.from(document.querySelectorAll('article.post-content, .post-content'));

                if (!floorContent && floorNo) {
                    const idx = parseInt(floorNo, 10);
                    const floorLink = document.querySelector(`a[href$="#${floorNo}"], a[href*="#post-${floorNo}"]`);
                    const container = floorLink ? floorLink.closest('.content-item, .comment-item, li, .nsk-post') : null;
                    if (container) {
                        floorContent = container.querySelector('article.post-content, .post-content')?.innerText?.trim() || '';
                    }
                    if (!floorContent && idx > 0 && allArticles[idx]) {
                        floorContent = allArticles[idx].innerText.trim();
                    }
                }

                if (!floorContent && username) {
                    const items = Array.from(document.querySelectorAll('.content-item, .comment-item'));
                    const matchedItem = items.filter(item => item.innerText.includes(username)).pop();
                    if (matchedItem) {
                        floorContent = matchedItem.querySelector('article.post-content, .post-content')?.innerText?.trim() || '';
                    }
                }

                if (!floorContent && (Date.now() - lastClickedFloor.timestamp < 120000)) {
                    floorContent = lastClickedFloor.content;
                }

                return {
                    isFloorReply: true,
                    prefixToKeep: prefix,
                    targetUser: username || lastClickedFloor.user || '层主',
                    targetFloor: floorNo || lastClickedFloor.floorNum || '',
                    targetContent: floorContent || `(层主 @${username} 的发言)`
                };
            },
            fillText: (text, targetEl, prefixToKeep = '') => {
                const finalOutput = prefixToKeep + text;
                const cmEl = document.querySelector('.CodeMirror');
                if (cmEl && cmEl.CodeMirror) {
                    cmEl.CodeMirror.setValue(finalOutput);
                    cmEl.CodeMirror.focus();
                    cmEl.CodeMirror.setCursor(cmEl.CodeMirror.lineCount(), 0);
                    return;
                }
                const hiddenTa = document.querySelector('.CodeMirror textarea') || document.querySelector('textarea');
                if (hiddenTa) {
                    hiddenTa.focus();
                    document.execCommand('selectAll', false, null);
                    const dt = new DataTransfer();
                    dt.setData('text/plain', finalOutput);
                    hiddenTa.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

                    setTimeout(() => {
                        if (!hiddenTa.value && (!cmEl || !cmEl.innerText.includes(text.slice(0, 5)))) {
                            hiddenTa.value = finalOutput;
                            hiddenTa.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }, 100);
                }
            },
            persona: 'NodeSeek (MJJ/主机圈) 资深玩家，熟悉VPS线路、网络优化、建站、硬件与折腾，说话接地气，善用社区黑话（bd、好鸡、早收、富哥、溢价、灵车、分母、吃码等）'
        },
        discuz: {
            match: () => true,
            title: () => document.querySelector('#thread_subject')?.innerText || document.querySelector('h1')?.innerText || document.title,
            content: () => {
                const firstPost = document.querySelector('td[id^="postmessage_"], .t_f, .message');
                return firstPost ? firstPost.innerText : '';
            },
            replies: () => {
                return Array.from(document.querySelectorAll('td[id^="postmessage_"], .t_f')).slice(1, 6).map(el => el.innerText.trim()).join(' | ');
            },
            getMountTargets: () => {
                const selectors = [
                    '#fastpostmessage',
                    '#fwin_reply #postmessage',
                    '#postmessage',
                    '#e_textarea',
                    '#needmessage',
                    'textarea[name="message"]'
                ];
                const uniqueTargets = new Set();
                selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => uniqueTargets.add(el));
                });
                return Array.from(uniqueTargets);
            },
            detectFloorTarget: (targetEl) => {
                const inPopup = targetEl && targetEl.closest('#fwin_reply');
                const quoteBlock = (inPopup ? inPopup.querySelector('blockquote') : null) || document.querySelector('#fwin_reply blockquote, #postform blockquote, .quote blockquote');
                if (quoteBlock && targetEl && targetEl.id !== 'fastpostmessage') {
                    return {
                        isFloorReply: true,
                        prefixToKeep: '',
                        targetUser: '该层主',
                        targetFloor: '',
                        targetContent: quoteBlock.innerText.trim()
                    };
                }
                const val = targetEl ? targetEl.value : '';
                const bbcodeMatch = val.match(/^(\[quote\][\s\S]*?\[\/quote\]\s*)/i);
                if (bbcodeMatch) {
                    return {
                        isFloorReply: true,
                        prefixToKeep: bbcodeMatch[1],
                        targetUser: '该层主',
                        targetFloor: '',
                        targetContent: bbcodeMatch[1].replace(/\[\/?quote\]/gi, '').trim()
                    };
                }
                return null;
            },
            fillText: (text, targetEl, prefixToKeep = '') => {
                const finalOutput = prefixToKeep + text;
                const eIframe = document.querySelector('#e_iframe');
                if (targetEl && targetEl.id === 'e_textarea' && eIframe && eIframe.contentDocument && eIframe.contentDocument.body) {
                    eIframe.contentDocument.body.innerText = finalOutput;
                }
                if (targetEl) {
                    targetEl.value = finalOutput;
                    targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                    targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                    targetEl.focus();
                }
            },
            persona: () => {
                if (location.hostname.includes('right.com.cn')) {
                    return '恩山无线论坛(Right.com.cn)硬核数码与网络玩家，精通路由器刷机、OpenWrt、光猫改桥接、组网与固件编译，说话实在接地气，常用“思考”、“紫薯布丁”、“老哥稳”、“感谢分享”等社区用语';
                }
                return '论坛常驻老哥，语气熟稔自然，像真人坛友一样交流';
            }
        }
    };

    const replyModes = [
        {
            label: '🍗 摸鱼黑话 (2~6字)',
            type: 'short',
            maxTokens: 512,
            rulesForOP: `
1. 你正在【直接回复楼主（主楼）】，这是纯水贴拿积分/思考/鸡腿模式，字数控制在 2~8 个字！
2. 根据主楼帖子类型和【前排网友回复】的队形，直接甩出最地道的社区极简用语（例如：感谢分享、思考一下、老哥稳、帮顶、bd、好鸡早收、分母来了）。
3. 严禁加句号，严禁换行，绝不要包含 @用户名，只输出最终回复的那几个字！`,
            rulesForFloor: `
1. 你正在【直接回应某位层主】，字数控制在 2~10 个字！
2. 针对【你正在直接回应的层主发言】，用极简的一两个词附和、接梗、赞同或调侃他（例如：老哥真相了、确实如此、同感、扎心了、借您吉言、哈哈真实、+1）。
3. 严禁加句号，严禁换行，绝不要自己输出 @用户名（系统会自动加），只输出回复正文那几个字！`
        },
        {
            label: '💬 简短互动 (40字左右)',
            type: 'medium',
            maxTokens: 1024,
            rulesForOP: `
1. 你正在【直接回复楼主（主楼）】，针对主楼内容，用一两句自然的大白话发表看法、吐槽、补充经验或互动。
2. 字数控制在 25~55 个字左右（约一到两句话），必须把整句话的逻辑和意思表达完整，绝对不能话说到一半断掉！
3. 语气要像真人坛友日常敲字交流，口语化、接地气，严禁出现“总的来说”、“确实”、“希望”、“首先”等AI客套词。绝不要包含 @用户名，只输出回复正文！`,
            rulesForFloor: `
1. 你正在【直接与某位层主对话/对线】！请把注意力 100% 集中在【你正在直接回应的层主发言】上（主楼内容仅作背景参考）。
2. 顺着这位层主的话进行回应（赞同补充、解答他的疑问、反驳他的观点或顺着吐槽），字数控制在 20~50 个字左右，必须把话完整说完，绝不断句！
3. 语气要像真人坛友在楼层里直接跟人搭话，自然口语化，严禁在开头自己写 @用户名（系统已自带前缀），只输出纯回复正文！`
        },
        {
            label: '🧐 详细分析 (完整深度回复)',
            type: 'long',
            maxTokens: 2048,
            rulesForOP: `
1. 你正在【直接回复楼主（主楼）】，针对主楼的问题、方案、教程或分享，给出有深度、有干货、逻辑完整的详细分析或解答，字数控制在 120~350 字左右，务必把前因后果、排查步骤或优缺点完整讲透，严禁半途截断！
2. 保持论坛资深技术老哥的口吻：直接切入核心痛点或细节，可以自然分段，但严禁使用“首先、其次、最后、综上所述、总而言之、希望能帮到你”这种死板的AI公文套路。
3. 纯文本输出：绝对不要使用 Markdown 加粗符号（**）或标题符号（###），只输出回复正文！`,
            rulesForFloor: `
1. 你正在【深度回应/解答某位层主的观点或追问】！请重点针对【你正在直接回应的层主发言】展开深度分析、技术探讨、细节补充或有理有据的反驳，结合主楼背景把道理讲透，字数控制在 100~300 字左右，严禁半途截断！
2. 保持论坛资深技术老哥与坛友切磋交流的口吻，直接切入要点，严禁使用“首先、其次、最后、综上所述”等AI套话，也不要使用 Markdown 加粗符号（**）。
3. 严禁在开头自己输出 @用户名（系统已保留前缀），只输出纯回复正文！`
        }
    ];

    function getCurrentSite() {
        if (siteConfigs.v2ex.match()) return siteConfigs.v2ex;
        if (siteConfigs.nodeseek.match()) return siteConfigs.nodeseek;
        return siteConfigs.discuz;
    }

    /**
     * 实时更新按钮栏左侧的“当前回复模式指示器”（【📢 当前：回楼主】 vs 【🎯 当前：回层主 @xxx】）
     */
    function updateModeBarStatus() {
        const site = getCurrentSite();
        document.querySelectorAll('.gemini-target-badge').forEach(badge => {
            const targetEl = badge._boundTarget;
            const floorInfo = site.detectFloorTarget ? site.detectFloorTarget(targetEl) : null;
            if (floorInfo && floorInfo.isFloorReply) {
                const tag = floorInfo.targetFloor ? ` #${floorInfo.targetFloor}` : '';
                badge.innerText = `🎯 当前：回层主 ${floorInfo.targetUser}${tag}`;
                badge.style.background = '#1e3a2f';
                badge.style.color = '#6ee7b7';
                badge.style.borderColor = '#059669';
            } else {
                badge.innerText = '📢 当前：回楼主';
                badge.style.background = '#1e1f22';
                badge.style.color = '#949ba4';
                badge.style.borderColor = '#4e5058';
            }
        });
    }

    function initButtons() {
        const site = getCurrentSite();
        const targets = site.getMountTargets();
        if (!targets || targets.length === 0) return;

        let mountedNew = false;

        targets.forEach(target => {
            if (!target || target.dataset.geminiMounted === 'true') return;
            target.dataset.geminiMounted = 'true';
            mountedNew = true;

            // 监听输入框变化，实时更新“回楼主/回层主”状态徽章
            target.addEventListener('input', updateModeBarStatus);
            target.addEventListener('keyup', updateModeBarStatus);

            const bar = document.createElement('div');
            bar.className = 'gemini-btn-bar';
            bar.style.cssText = 'margin: 6px 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; z-index: 9999; text-align: left;';

            // 0. 创建“回楼主 / 回层主”状态指示标签
            const badge = document.createElement('span');
            badge.className = 'gemini-target-badge';
            badge._boundTarget = target;
            badge.innerText = '📢 当前：回楼主';
            badge.title = '当输入框内有 @用户名 #楼层 或在回复小窗中时，自动切换为针对层主发言生成回复';
            badge.style.cssText = 'padding: 3px 8px; background: #1e1f22; color: #949ba4; border: 1px solid #4e5058; border-radius: 4px; font-size: 12px; line-height: 1.4; user-select: none;';
            bar.appendChild(badge);

            // 1. 创建三档回复按钮
            replyModes.forEach(mode => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.innerText = mode.label;
                btn.style.cssText = 'padding: 4px 10px; background: #2b2d31; color: #e3e5e8; border: 1px solid #4e5058; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1.4; transition: 0.2s;';
                btn.onmouseover = () => { btn.style.background = '#404249'; };
                btn.onmouseout = () => { btn.style.background = '#2b2d31'; };
                btn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const selectedModel = GM_getValue("GEMINI_MODEL", DEFAULT_MODEL);
                    generateReply(site, mode, btn, target, selectedModel, new Set());
                };
                bar.appendChild(btn);
            });

            // 2. 创建实时模型选择下拉框
            const modelSelect = document.createElement('select');
            modelSelect.className = 'gemini-model-select';
            modelSelect.title = '选择 Gemini 模型（列表通过官方 API 自动更新，支持额度耗尽自动切换）';
            modelSelect.style.cssText = 'padding: 3px 6px; background: #1e1f22; color: #b5bac1; border: 1px solid #4e5058; border-radius: 4px; font-size: 12px; height: 26px; cursor: pointer; outline: none; max-width: 250px;';
            modelSelect.onchange = () => {
                GM_setValue("GEMINI_MODEL", modelSelect.value);
                syncAllModelSelects();
            };
            bar.appendChild(modelSelect);

            // 3. 创建手动刷新模型按钮
            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'gemini-model-refresh-btn';
            refreshBtn.type = 'button';
            refreshBtn.innerText = '🔄';
            refreshBtn.title = '从 Google 官方接口实时同步最新可用模型';
            refreshBtn.style.cssText = 'padding: 3px 7px; background: #1e1f22; color: #b5bac1; border: 1px solid #4e5058; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1.4;';
            refreshBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                fetchOfficialModels(true, true);
            };
            bar.appendChild(refreshBtn);

            target.parentNode.insertBefore(bar, target);
        });

        if (mountedNew) {
            syncAllModelSelects();
            fetchOfficialModels(false, false);
        }
        updateModeBarStatus();
    }

    function cleanOutput(text, type) {
        let cleaned = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
        // 防止 AI 自己又重复写了一遍 @username 开头
        cleaned = cleaned.replace(/^@[a-zA-Z0-9_\u4e00-\u9fa5-]+(?:\s+#\d+)?[,，:：\s]+/, '');
        if (type === 'short') {
            cleaned = cleaned.replace(/[。！!~～]+$/g, '').replace(/\n+/g, ' ');
        } else if (type === 'medium') {
            cleaned = cleaned.replace(/\n+/g, ' ').replace(/\*\*/g, '').replace(/[。]+$/g, '');
        } else {
            cleaned = cleaned.replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
        }
        return cleaned.trim();
    }

    function getNextAvailableModel(triedModels) {
        const allModels = getAvailableModels();
        for (const m of allModels) {
            if (!triedModels.has(m.id)) {
                return m.id;
            }
        }
        return null;
    }

    function generateReply(site, mode, btn, targetEl, modelId, triedModels) {
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
        const personaText = typeof site.persona === 'function' ? site.persona() : site.persona;

        // 核心逻辑：检测当前是“回复层主”还是“回复楼主”
        const floorInfo = site.detectFloorTarget ? site.detectFloorTarget(targetEl) : null;
        let fullPrompt = '';
        let prefixToKeep = '';

        if (floorInfo && floorInfo.isFloorReply) {
            prefixToKeep = floorInfo.prefixToKeep || '';
            fullPrompt = `你现在的身份是：${personaText}。
注意：你现在【不是在回复楼主】，而是在楼层中【直接回应层主 ${floorInfo.targetUser} ${floorInfo.targetFloor ? '(' + floorInfo.targetFloor + '楼)' : ''}】！
请严格遵守以下规则：${mode.rulesForFloor}

【你正在直接回应的层主发言（核心焦点，请直接针对这句话进行回复）】：
"${floorInfo.targetContent}"

【原帖背景参考（仅作上下文了解，切勿跑题去回楼主）】：
帖子标题：${title}
主楼摘要：${content.slice(0, 500)}`;
        } else {
            fullPrompt = `你现在的身份是：${personaText}。
你现在正在【直接回复楼主（主楼）】。请根据以下论坛帖子内容生成一条自然回帖，严格遵守以下规则：${mode.rulesForOP}

【帖子标题】：${title}
【主楼内容】：${content}
【前排网友回复队形参考】：${replies}`;
        }

        if (triedModels.size === 1) {
            btn.dataset.origText = btn.innerText;
            btn.innerText = floorInfo?.isFloorReply ? '⏳ 回层主中...' : '⏳ 思考中...';
        } else {
            btn.innerText = `🔄 负载至 ${modelId.replace('gemini-', '')}...`;
        }
        btn.disabled = true;

        const genConfig = {
            temperature: mode.type === 'long' ? 0.75 : 0.85,
            maxOutputTokens: mode.maxTokens
        };
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

                    if (data.error) {
                        const errCode = data.error.code;
                        if (errCode === 429 || errCode === 404 || errCode === 503 || errCode === 400) {
                            const nextModel = getNextAvailableModel(triedModels);
                            if (nextModel && triedModels.size <= 4) {
                                console.warn(`[Gemini负载均衡] 模型 ${modelId} 不可用 (Code ${errCode})，自动切换至备用模型: ${nextModel}`);
                                GM_setValue("GEMINI_MODEL", nextModel);
                                syncAllModelSelects();
                                generateReply(site, mode, btn, targetEl, nextModel, triedModels);
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
                    site.fillText(replyText, targetEl, prefixToKeep);
                    updateModeBarStatus();
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

    setInterval(initButtons, 800);
})();
