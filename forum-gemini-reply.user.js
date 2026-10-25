// ==UserScript==
// @name         论坛 Gemini 智能回帖助手 (V2EX / NodeSeek / Discuz)
// @namespace    https://github.com/kylo1989/forum-gemini-reply
// @version      3.0.0
// @description  三档回复梯度：摸鱼黑话 / 20字短评 / 深度分析，完美适配NS站CodeMirror与V2EX/DZ
// @author       Custom
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
            persona: 'V2EX资深程序员老哥，懂技术、说话直接、不讲客套话'
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
            persona: 'NodeSeek (MJJ/主机圈) 资深玩家，熟悉VPS线路、建站、硬件与折腾，说话接地气，善用社区黑话（bd、好鸡、早收、富哥、溢价、灵车、分母、吃码等）'
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
            maxTokens: 100,
            rules: `
1. 这是纯水贴拿积分/鸡腿模式，字数严格控制在 2~6 个字！
2. 根据帖子类型（出鸡/收鸡/抽奖/分享/水贴）和【前排网友回复】的队形，直接甩出最地道的社区极简黑话（例如：bd、绑定、好鸡、早收、分母、来了、感谢分享、老哥稳、富哥、围观）。
3. 严禁加句号或感叹号，严禁换行，只输出最终那几个字！`
        },
        {
            label: '💬 简短互动 (20字内)',
            type: 'medium',
            maxTokens: 150,
            rules: `
1. 针对主楼内容或顺着前排评论，用一句简短的大白话发表看法、吐槽或互动。
2. 字数严格控制在 8~20 个字以内！单行输出，不要换行。
3. 语气要像真人用手机随手敲出来的，口语化，句尾不要加句号，绝对不要有“总的来说”、“确实”、“希望”等AI客套词。`
        },
        {
            label: '🧐 详细分析 (完整回复)',
            type: 'long',
            maxTokens: 800,
            rules: `
1. 针对主楼的问题、方案或分享，给出有深度、有干货的详细分析或解答，字数控制在 60~250 字左右（视话题复杂度而定）。
2. 保持论坛资深老哥的口吻：直接切入核心痛点或技术细节，条理清晰（可以分段），但严禁使用“首先、其次、最后、综上所述、总而言之、希望能帮到你”这种死板的AI公文套路，也不要用 Markdown 加粗符号（**）。
3. 如果主楼是技术求助，直接给排查思路或方案；如果是硬件/VPS测评，直接点评性价比、线路或配置优劣；如果是日常讨论，给出有见地的真实观点。`
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
        if (type === 'short' || type === 'medium') {
            cleaned = cleaned.replace(/[。！!~～]+$/g, '').replace(/\n+/g, ' ');
        } else {
            cleaned = cleaned.replace(/\*\*/g, '');
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
        const contentLimit = mode.type === 'long' ? 1500 : 600;
        const content = site.content().slice(0, contentLimit);
        const replies = site.replies().slice(0, 400);

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
                    temperature: mode.type === 'long' ? 0.7 : 0.85,
                    maxOutputTokens: mode.maxTokens
                }
            }),
            onload: function(response) {
                btn.innerText = originalText;
                btn.disabled = false;
                try {
                    const data = JSON.parse(response.responseText);
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
