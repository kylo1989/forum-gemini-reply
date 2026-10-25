// ==UserScript==
// @name         论坛 Gemini 智能回帖助手 (V2EX / NodeSeek / Discuz)
// @namespace    https://github.com/kylo1989/forum-gemini-reply
// @version      3.1.0
// @description  三档回复梯度：摸鱼黑话 / 40字短评 / 深度完整分析，修复断句问题，完美适配NS站CodeMirror与V2EX/DZ
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

    GM_registerMenuCommand("⚙️ 设置 Gemini API Key", () => {
        const key = prompt("请输入您的 Gemini API Key:", GM_getValue("GEMINI_API_KEY", ""));
        if (key !== null) GM_setValue("GEMINI_API_KEY", key.trim());
    });

    const siteConfigs = {
        v2ex: {
            match: () => location.hostname.includes('v2ex.com'),
            title: () => document.querySelector('.header h1')?.innerText || '',
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
                // 方案1：直接通过 CodeMirror 实例写入
                const cmEl = document.querySelector('.CodeMirror');
                if (cmEl && cmEl.CodeMirror) {
                    cmEl.CodeMirror.setValue(text);
                    cmEl.CodeMirror.focus();
                    return;
                }
                // 方案2：针对隐藏 textarea 模拟聚焦与粘贴事件
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

    // 三档按钮独立配置（给足 maxTokens 防止 Gemini 2.5 思考过程占满额度导致断句）
    const replyModes = [
        {
            label: '🍗 摸鱼黑话 (2~6字)',
            type: 'short',
            maxTokens: 1024,
            rules: `
1. 这是纯水贴拿积分/鸡腿模式，字数控制在 2~8 个字！
2. 根据帖子类型（出鸡/收鸡/抽奖/分享/水贴）和【前排网友回复】的队形，直接甩出最地道的社区极简黑话（例如：bd、绑定、好鸡早收、分母来了、感谢分享、老哥稳、富哥、帮顶）。
3. 严禁加句号，严禁换行，直接输出完整词组，绝对不要断句！`
        },
        {
            label: '💬 简短互动 (40字左右)',
            type: 'medium',
            maxTokens: 2048,
            rules: `
1. 针对主楼内容或顺着前排评论，用一两句自然的大白话发表看法、吐槽、补充经验或互动。
2. 字数控制在 25~55 个字左右（约一到两句话），必须把整句话的逻辑和意思表达完整，绝对不能话说到一半断掉！
3. 语气要像真人坛友日常敲字交流，口语化、接地气，中间可以用逗号分隔，严禁出现“总的来说”、“确实”、“希望”、“首先”等AI客套词。`
        },
        {
            label: '🧐 详细分析 (完整深度回复)',
            type: 'long',
            maxTokens: 4096,
            rules: `
1. 针对主楼的问题、方案、测评或分享，给出有深度、有干货、逻辑完整的详细分析或解答，字数控制在 120~350 字左右，务必把前因后果、排查步骤或优缺点完整讲透，严禁半途截断！
2. 保持论坛资深技术老哥的口吻：直接切入核心痛点或细节，可以自然分段，但严禁使用“首先、其次、最后、综上所述、总而言之、希望能帮到你”这种死板的AI公文套路。
3. 纯文本输出：绝对不要使用 Markdown 加粗符号（**）或标题符号（###），如需列举可以用简单的数字 1. 2. 或直接分段叙述。`
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
        bar.style.cssText = 'margin: 6px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; z-index: 999;';

        replyModes.forEach(mode => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.innerText = mode.label;
            btn.style.cssText = 'padding: 4px 10px; background: #2b2d31; color: #e3e5e8; border: 1px solid #4e5058; border-radius: 4px; cursor: pointer; font-size: 12px; transition: 0.2s;';
            btn.onmouseover = () => { btn.style.background = '#404249'; };
            btn.onmouseout = () => { btn.style.background = '#2b2d31'; };
            btn.onclick = () => generateReply(site, mode, btn);
            bar.appendChild(btn);
        });

        target.parentNode.insertBefore(bar, target);
    }

    function cleanOutput(text, type) {
        let cleaned = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
        if (type === 'short') {
            // 摸鱼模式：单行，去除末尾句号和感叹号
            cleaned = cleaned.replace(/[。！!~～]+$/g, '').replace(/\n+/g, ' ');
        } else if (type === 'medium') {
            // 40字短评模式：合并为单段，保留中间标点，仅去掉最末尾的句号显得更自然
            cleaned = cleaned.replace(/\n+/g, ' ').replace(/\*\*/g, '').replace(/[。]+$/g, '');
        } else {
            // 详细分析模式：保留完整段落和标点，仅清除容易露馅的 Markdown 符号
            cleaned = cleaned.replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
        }
        return cleaned.trim();
    }

    function generateReply(site, mode, btn) {
        const apiKey = GM_getValue("GEMINI_API_KEY", "");
        if (!apiKey) {
            alert("请先点击浏览器右上角油猴插件图标 -> 点击【⚙️ 设置 Gemini API Key】");
            return;
        }

        const title = site.title();
        // 详细分析模式抓取 2500 字上下文，40字模式抓取 1000 字
        const contentLimit = mode.type === 'long' ? 2500 : 1000;
        const content = site.content().slice(0, contentLimit);
        const replies = site.replies().slice(0, 500);

        const systemInstruction = `你现在的身份是：${site.persona}。\n请根据帖子内容生成回帖，严格遵守以下规则：${mode.rules}`;
        const userContent = `【帖子标题】：${title}\n【主楼内容】：${content}\n【前排网友回复参考】：${replies || '暂无回复'}`;

        const originalText = btn.innerText;
        btn.innerText = '⏳ 思考中...';
        btn.disabled = true;

        GM_xmlhttpRequest({
            method: "POST",
            url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                systemInstruction: { parts: [{ text: systemInstruction }] },
                contents: [{ parts: [{ text: userContent }] }],
                generationConfig: {
                    temperature: mode.type === 'long' ? 0.75 : 0.85,
                    maxOutputTokens: mode.maxTokens
                }
            }),
            onload: function(response) {
                btn.innerText = originalText;
                btn.disabled = false;
                try {
                    const data = JSON.parse(response.responseText);
                    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
                        console.error("Gemini Unexpected Response:", data);
                        alert("返回数据异常，请按 F12 查看控制台详情。");
                        return;
                    }
                    let replyText = data.candidates[0].content.parts[0].text;
                    replyText = cleanOutput(replyText, mode.type);
                    site.fillText(replyText);
                } catch (e) {
                    console.error("Gemini Error:", response.responseText);
                    alert("生成失败，请按 F12 查看控制台报错。");
                }
            },
            onerror: function() {
                btn.innerText = originalText;
                btn.disabled = false;
                alert("请求失败，请检查代理网络是否放行了 generativelanguage.googleapis.com");
            }
        });
    }

    setInterval(initButton, 1200);
})();
