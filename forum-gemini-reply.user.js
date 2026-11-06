// ==UserScript==
// @name         论坛 Gemini 智能回帖助手 (V2EX / NodeSeek / Linux.do / 草榴 / Discuz)
// @namespace    https://github.com/kylo1989/forum-gemini-reply
// @version      4.0.0
// @description  新增草榴社区(t66y)深度适配与1024老司机人设 + 全面适配 V2EX/Linux.do/NodeSeek 摸鱼与原生模式 + 恩山等DZ论坛 + 回层主/回楼主区分 + 429自动负载均衡
// @author       kylo1989
// @license      MIT
// @homepageURL  https://github.com/kylo1989/forum-gemini-reply
// @updateURL    https://raw.githubusercontent.com/kylo1989/forum-gemini-reply/main/forum-gemini-reply.user.js
// @downloadURL  https://raw.githubusercontent.com/kylo1989/forum-gemini-reply/main/forum-gemini-reply.user.js
// @match        *://*.v2ex.com/*
// @match        *://*.nodeseek.com/*
// @match        *://*.linux.do/*
// @match        *://*.t66y.com/*
// @match        *://*/*htm_data/*.html*
// @match        *://*/read.php*
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

    var DEFAULT_MODEL = 'gemini-2.0-flash';
    var CACHE_TTL = 12 * 3600 * 1000;

    var lastClickedFloor = { user: '', floorNum: '', content: '', timestamp: 0 };
    var currentMoyuTopicId = '';

    var FALLBACK_MODELS = [
        { id: 'gemini-2.0-flash', label: '⚡ gemini-2.0-flash (主力推荐·每日1500次高额度)', priority: 100 },
        { id: 'gemini-2.5-flash-lite', label: '🚀 gemini-2.5-flash-lite (新一代极速轻量·高额度)', priority: 95 },
        { id: 'gemini-2.0-flash-lite', label: '💨 gemini-2.0-flash-lite (超轻量极速·高额度)', priority: 90 },
        { id: 'gemini-1.5-flash', label: '🛡️ gemini-1.5-flash (经典稳定·高额度备用)', priority: 85 },
        { id: 'gemini-1.5-flash-8b', label: '🍃 gemini-1.5-flash-8b (高频小模型·高额度)', priority: 80 },
        { id: 'gemini-2.5-flash', label: '🧠 gemini-2.5-flash (智能思考·免费额度仅20次/天)', priority: 50 }
    ];

    GM_registerMenuCommand('🔑 1. 设置 Gemini API Key', function() {
        var key = prompt('请输入您的 Gemini API Key:', GM_getValue('GEMINI_API_KEY', ''));
        if (key !== null) {
            GM_setValue('GEMINI_API_KEY', key.trim());
            fetchOfficialModels(true, false);
        }
    });

    GM_registerMenuCommand('🔄 2. 立即从官方接口同步最新模型', function() {
        fetchOfficialModels(true, true);
    });

    function showToast(msg, isError) {
        var toast = document.createElement('div');
        toast.innerText = msg;
        toast.style.cssText = 'position:fixed;top:20px;right:20px;padding:10px 16px;background:' + (isError ? '#dc2626' : '#059669') + ';color:#fff;border-radius:6px;font-size:13px;font-weight:bold;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;';
        document.body.appendChild(toast);
        setTimeout(function() {
            toast.style.opacity = '0';
            setTimeout(function() {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }, 3500);
    }

    function isMoyuModeActive() {
        if (document.querySelector('textarea[placeholder*="发送给"], input[placeholder*="发送给"]')) {
            return true;
        }
        var allInputs = document.querySelectorAll('input[placeholder*="搜索"]');
        for (var i = 0; i < allInputs.length; i++) {
            var inp = allInputs[i];
            var p1 = inp.parentElement;
            var p2 = p1 ? p1.parentElement : null;
            var txt = p2 ? (p2.innerText || '') : '';
            if (txt.indexOf('新回复') !== -1 || txt.indexOf('最热') !== -1) {
                return true;
            }
        }
        return false;
    }

    function getMoyuRightChatPane() {
        var candidates = document.querySelectorAll('div, header');
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (el.children.length <= 3 && /\(\d+\)\s*$/.test((el.innerText || '').trim())) {
                var rect = el.getBoundingClientRect();
                if (rect.left > 200 && rect.top >= 0 && rect.top < 120 && rect.width > 300) {
                    return el.parentElement;
                }
            }
        }
        return null;
    }

    function extractLinuxDoTopicIdFromDOM() {
        if (currentMoyuTopicId) return currentMoyuTopicId;
        var links = document.querySelectorAll('a[href*="/t/"]');
        for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href') || '';
            var m = href.match(/\/t\/(?:[^\/]+\/)?(\d+)/);
            if (m && m[1]) {
                var item = links[i].closest('[class*="active"], [class*="selected"], [style*="background"]');
                if (item) return m[1];
            }
        }
        var rightPane = getMoyuRightChatPane();
        var headerTitle = rightPane && rightPane.firstElementChild ? (rightPane.firstElementChild.innerText || '').replace(/\(\d+\)\s*$/, '').trim() : '';
        if (headerTitle) {
            for (var j = 0; j < links.length; j++) {
                var lTxt = (links[j].innerText || '').trim();
                if (lTxt && headerTitle.indexOf(lTxt.slice(0, 8)) !== -1) {
                    var hm = (links[j].getAttribute('href') || '').match(/\/t\/(?:[^\/]+\/)?(\d+)/);
                    if (hm && hm[1]) return hm[1];
                }
            }
        }
        return '';
    }

    function ensureLinuxDoMoyuReplyBox() {
        if (location.hostname.indexOf('linux.do') === -1) return null;
        var existingCustom = document.querySelector('#gemini-linuxdo-moyu-input');
        if (existingCustom && existingCustom.offsetParent !== null) return existingCustom;

        var rightPane = getMoyuRightChatPane();
        if (!rightPane) return null;

        var nativeMoyu = rightPane.querySelector('textarea[placeholder*="发送给"]');
        if (nativeMoyu) return nativeMoyu;

        var wrapper = document.createElement('div');
        wrapper.id = 'gemini-linuxdo-moyu-box';
        wrapper.style.cssText = 'border-top:1px solid #e5e7eb;background:#ffffff;padding:8px 16px 12px 16px;display:flex;flex-direction:column;flex-shrink:0;z-index:999;';

        var ta = document.createElement('textarea');
        ta.id = 'gemini-linuxdo-moyu-input';
        var firstChild = rightPane.firstElementChild;
        var headerText = firstChild ? (firstChild.innerText || '').replace(/\(\d+\)\s*$/, '').trim() : '当前话题';
        ta.placeholder = '发送给 ' + headerText + ' (Ctrl + Enter 发送)';
        ta.style.cssText = 'width:100%;height:68px;border:1px solid #d1d5db;border-radius:6px;padding:8px;font-size:13px;color:#1f2937;background:#f9fafb;resize:none;outline:none;box-sizing:border-box;margin-top:4px;';

        var bottomRow = document.createElement('div');
        bottomRow.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:6px;';

        var tip = document.createElement('span');
        tip.innerText = 'Ctrl + Enter 发送';
        tip.style.cssText = 'font-size:12px;color:#9ca3af;';

        var sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.innerText = '发送';
        sendBtn.style.cssText = 'padding:5px 18px;background:#07c160;color:#fff;border:none;border-radius:4px;font-size:13px;font-weight:bold;cursor:pointer;';

        var doSubmitLinuxDo = function() {
            var rawText = ta.value.trim();
            if (!rawText) {
                alert('请先生成或输入回复内容！');
                return;
            }

            var topicId = extractLinuxDoTopicIdFromDOM();
            if (!topicId) {
                var inputId = prompt('未能自动捕获当前话题数字 ID，请手动输入该帖子的数字 ID（或切换到原生模式回帖）：');
                if (!inputId) return;
                topicId = inputId.trim();
            }

            var csrfMeta = document.querySelector('meta[name="csrf-token"]');
            var csrfToken = csrfMeta ? csrfMeta.content : '';
            if (!csrfToken) {
                alert('未获取到登录凭证 (CSRF Token)，请确认您已登录 linux.do！');
                return;
            }

            var replyToPostNumber = '';
            var cleanPostContent = rawText;
            var floorMatch = rawText.match(/^@([^\s#]+)(?:\s*#(\d+))?\s+/);
            if (floorMatch) {
                if (floorMatch[2] && floorMatch[2] !== '1') {
                    replyToPostNumber = floorMatch[2];
                } else if (lastClickedFloor.floorNum && lastClickedFloor.floorNum !== '1') {
                    replyToPostNumber = lastClickedFloor.floorNum;
                }
                cleanPostContent = rawText.replace(/^@([^\s#]+)(?:\s*#(\d+))?\s+/, '');
            }

            sendBtn.innerText = '发送中...';
            sendBtn.disabled = true;

            var bodyStr = 'raw=' + encodeURIComponent(cleanPostContent) + '&topic_id=' + encodeURIComponent(topicId);
            if (replyToPostNumber) {
                bodyStr += '&reply_to_post_number=' + encodeURIComponent(replyToPostNumber);
            }

            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/posts', true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
            xhr.setRequestHeader('X-CSRF-Token', csrfToken);
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            xhr.onload = function() {
                sendBtn.innerText = '发送';
                sendBtn.disabled = false;
                try {
                    var data = JSON.parse(xhr.responseText);
                    if (xhr.status >= 200 && xhr.status < 300 && data.id) {
                        ta.value = '';
                        lastClickedFloor = { user: '', floorNum: '', content: '', timestamp: 0 };
                        updateModeBarStatus();
                        showToast('✅ Linux.do 回帖成功！(楼层 #' + data.post_number + ')', false);
                    } else {
                        var errMsg = (data.errors && data.errors.length) ? data.errors.join('; ') : '请检查字数要求或发帖冷却时间';
                        showToast('⚠️ 回帖未成功：' + errMsg, true);
                    }
                } catch (e) {
                    showToast('⚠️ 回帖失败 (HTTP ' + xhr.status + ')', true);
                }
            };
            xhr.onerror = function() {
                sendBtn.innerText = '发送';
                sendBtn.disabled = false;
                showToast('⚠️ 网络错误，回帖请求未送达', true);
            };
            xhr.send(bodyStr);
        };

        sendBtn.onclick = doSubmitLinuxDo;
        ta.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                doSubmitLinuxDo();
            }
        });

        bottomRow.appendChild(tip);
        bottomRow.appendChild(sendBtn);
        wrapper.appendChild(ta);
        wrapper.appendChild(bottomRow);

        rightPane.appendChild(wrapper);
        return ta;
    }

    function getMoyuInputBox() {
        var selectors = [
            'textarea[placeholder*="发送给"]',
            'input[placeholder*="发送给"]',
            '[contenteditable="true"][placeholder*="发送给"]',
            '[data-placeholder*="发送给"]',
            '#gemini-linuxdo-moyu-input',
            '.moyu-editor textarea',
            '.wechat-editor textarea'
        ];
        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.offsetParent !== null) return el;
        }
        if (location.hostname.indexOf('linux.do') !== -1 && isMoyuModeActive()) {
            return ensureLinuxDoMoyuReplyBox();
        }
        return null;
    }

    /**
     * 判断当前是否为草榴社区 (t66y / PHPWind 架构)
     */
    function isT66ySite() {
        if (location.hostname.indexOf('t66y.com') !== -1) return true;
        if (document.querySelector('div.tpc_content') && document.querySelector('textarea[name="atc_content"]')) return true;
        return false;
    }

    document.addEventListener('click', function(e) {
        var target = e.target;
        if (!target || !target.closest) return;

        // 0. 摸鱼模式点击事件处理
        if (isMoyuModeActive()) {
            var leftItem = target.closest('[class*="session"], [class*="chat-item"], [class*="topic-item"], [class*="conv-item"], [class*="list-item"]');
            if (leftItem) {
                lastClickedFloor = { user: '', floorNum: '', content: '', timestamp: 0 };
                var aTag = leftItem.querySelector('a[href*="/t/"]');
                var href = aTag ? (aTag.getAttribute('href') || '') : '';
                var m = href.match(/\/t\/(?:[^\/]+\/)?(\d+)/);
                var tid = leftItem.getAttribute('data-id') || leftItem.getAttribute('data-topic-id') || (m ? m[1] : '');
                if (tid) currentMoyuTopicId = tid;

                setTimeout(function() {
                    var customTa = document.querySelector('#gemini-linuxdo-moyu-input');
                    var rightPane = getMoyuRightChatPane();
                    if (customTa && rightPane && rightPane.firstElementChild) {
                        var newHeader = (rightPane.firstElementChild.innerText || '').replace(/\(\d+\)\s*$/, '').trim() || '当前话题';
                        customTa.placeholder = '发送给 ' + newHeader + ' (Ctrl + Enter 发送)';
                    }
                    updateModeBarStatus();
                }, 250);
                return;
            }

            var moyuMsgItem = target.closest('[class*="message-item"], [class*="msg-item"], [class*="chat-msg"], [class*="comment-item"], .content-item');
            var btnText = (target.innerText || target.title || '').trim();
            var isMoyuReplyBtn = btnText.indexOf('回复') !== -1 || btnText.indexOf('引用') !== -1 || /^#\d+$/.test(btnText) || target.closest('.reply-btn, .quote-btn, [title*="回复"], [title*="引用"], [class*="reply"], [class*="quote"]');
            if (moyuMsgItem && isMoyuReplyBtn) {
                var userEl = moyuMsgItem.querySelector('[class*="nickname"], [class*="author"], [class*="user-name"], .author-name, .username');
                var user = userEl ? userEl.innerText.trim() : '';
                var floorEl = moyuMsgItem.querySelector('[class*="floor"], .floor-link, .floor');
                var floorNum = floorEl ? floorEl.innerText.replace(/[^\d]/g, '') : btnText.replace(/[^\d]/g, '');
                var contentEl = moyuMsgItem.querySelector('[class*="bubble"], [class*="msg-content"], [class*="message-content"], article.post-content, .post-content, [class*="text"]');
                var content = contentEl ? contentEl.innerText.trim() : '';
                if (content && floorNum !== '1') {
                    lastClickedFloor = { user: user, floorNum: floorNum, content: content, timestamp: Date.now() };
                    var customTa = document.querySelector('#gemini-linuxdo-moyu-input');
                    if (customTa && user) {
                        fillControlledInput(customTa, '@' + user + (floorNum ? ' #' + floorNum + ' ' : ' '));
                    }
                    setTimeout(updateModeBarStatus, 150);
                    return;
                }
            }
        }

        // 1. V2EX 原生页面
        if (location.hostname.indexOf('v2ex.com') !== -1) {
            var cell = target.closest('.cell[id^="r_"]');
            var isReplyAction = target.closest('a[onclick*="replyOne"], img[alt="Reply"]');
            if (cell && isReplyAction) {
                var uEl = cell.querySelector('strong a.dark');
                var fEl = cell.querySelector('.no');
                var cEl = cell.querySelector('.reply_content');
                var vUser = uEl ? uEl.innerText.trim() : '';
                var vFloor = fEl ? fEl.innerText.trim() : '';
                var vContent = cEl ? cEl.innerText.trim() : '';
                if (vContent) {
                    lastClickedFloor = { user: vUser, floorNum: vFloor, content: vContent, timestamp: Date.now() };
                    setTimeout(updateModeBarStatus, 100);
                }
            }
        }

        // 2. NodeSeek 原生页面
        if (location.hostname.indexOf('nodeseek.com') !== -1) {
            var commentItem = target.closest('.content-item, .comment-item, li[id^="post-"], .nsk-post');
            var nsBtnText = (target.innerText || target.title || '').trim();
            var isNsReply = nsBtnText.indexOf('回复') !== -1 || nsBtnText.indexOf('引用') !== -1 || target.closest('.reply-btn, .quote-btn, [title*="回复"], [title*="引用"]');
            if (commentItem && isNsReply) {
                var nsUserEl = commentItem.querySelector('.author-name, .username, a[href*="/space/"]');
                var nsFloorEl = commentItem.querySelector('.floor-link, .floor, [href*="#"]');
                var nsContentEl = commentItem.querySelector('article.post-content, .post-content');
                var nsUser = nsUserEl ? nsUserEl.innerText.trim() : '';
                var nsFloor = nsFloorEl ? nsFloorEl.innerText.replace(/[^\d]/g, '') : '';
                var nsContent = nsContentEl ? nsContentEl.innerText.trim() : '';
                if (nsContent) {
                    lastClickedFloor = { user: nsUser, floorNum: nsFloor, content: nsContent, timestamp: Date.now() };
                    setTimeout(updateModeBarStatus, 150);
                }
            }
        }

        // 3. Linux.do 原生页面
        if (location.hostname.indexOf('linux.do') !== -1) {
            var article = target.closest('article[id^="post_"], .topic-post');
            var isLdoReply = target.closest('button.reply, .post-controls .reply, [title*="回复"]');
            if (article && isLdoReply) {
                var postNum = (article.getAttribute('id') || '').replace('post_', '');
                if (postNum && postNum !== '1') {
                    var ldoUserEl = article.querySelector('.username a, .names .first a');
                    var ldoContentEl = article.querySelector('.cooked');
                    var ldoUser = ldoUserEl ? ldoUserEl.innerText.trim() : '';
                    var ldoContent = ldoContentEl ? ldoContentEl.innerText.trim() : '';
                    if (ldoContent) {
                        lastClickedFloor = { user: ldoUser, floorNum: postNum, content: ldoContent, timestamp: Date.now() };
                        setTimeout(updateModeBarStatus, 250);
                    }
                } else {
                    lastClickedFloor = { user: '', floorNum: '', content: '', timestamp: 0 };
                    setTimeout(updateModeBarStatus, 250);
                }
            }
        }

        // 4. 草榴社区 (t66y) 点击楼层上方“引用 / 回复”按钮
        if (isT66ySite()) {
            var t66yRow = target.closest('div.t.t2, table.t2, tr.tr1');
            var t66yLink = target.closest('a[href*="post.php?action=quote"], a[onclick*="reply"], a[title*="引用"], a[title*="回復"], a[title*="回复"]');
            if (t66yRow && t66yLink) {
                var tUserEl = t66yRow.querySelector('b, .r_two b, th b');
                var tContentEl = t66yRow.querySelector('.tpc_content');
                var tUser = tUserEl ? tUserEl.innerText.trim() : '层主';
                var tContent = tContentEl ? tContentEl.innerText.trim() : '';
                if (tContent) {
                    lastClickedFloor = { user: tUser, floorNum: '', content: tContent, timestamp: Date.now() };
                    setTimeout(updateModeBarStatus, 200);
                }
            }
        }
    }, true);

    function annotateModel(modelId) {
        var id = modelId.toLowerCase();
        if (id === 'gemini-2.0-flash') return { label: '⚡ ' + modelId + ' (主力推荐·高额度秒回)', priority: 100 };
        if (id === 'gemini-2.5-flash-lite' || id.indexOf('gemini-2.5-flash-lite-') === 0) return { label: '🚀 ' + modelId + ' (2.5极速轻量·高额度推荐)', priority: 96 };
        if (id === 'gemini-2.0-flash-lite' || id.indexOf('gemini-2.0-flash-lite-') === 0) return { label: '💨 ' + modelId + ' (2.0超轻量·高额度极速)', priority: 92 };
        if (id === 'gemini-1.5-flash' || id === 'gemini-1.5-flash-latest') return { label: '🛡️ ' + modelId + ' (经典稳定·高额度备用)', priority: 88 };
        if (id.indexOf('1.5-flash-8b') !== -1) return { label: '🍃 ' + modelId + ' (8B超轻量·高频防限流)', priority: 84 };
        if (id === 'gemini-2.5-flash') return { label: '🧠 ' + modelId + ' (2.5标准版·免费额度严苛)', priority: 55 };

        if (id.indexOf('flash-lite') !== -1) return { label: '🚀 ' + modelId + ' (轻量Flash·高额度极速)', priority: 90 };
        if (id.indexOf('flash') !== -1 && id.indexOf('exp') === -1 && id.indexOf('preview') === -1 && id.indexOf('thinking') === -1) {
            return { label: '⚡ ' + modelId + ' (Flash高速版·均衡推荐)', priority: 78 };
        }
        if (id.indexOf('flash') !== -1) return { label: '🧪 ' + modelId + ' (实验/思考预览版·额度较少)', priority: 45 };
        if (id.indexOf('pro') !== -1) return { label: '💎 ' + modelId + ' (Pro深度推理·免费额度极少)', priority: 30 };

        return { label: '🤖 ' + modelId + ' (官方可用模型)', priority: 40 };
    }

    function isTextChatModel(rawModel) {
        var name = (rawModel.name || '').replace('models/', '');
        var methods = rawModel.supportedGenerationMethods || [];
        if (methods.indexOf('generateContent') === -1) return false;
        if (name.indexOf('gemini-') !== 0) return false;
        var excludeKeywords = ['vision', 'image', 'audio', 'tts', 'embedding', 'aqa', 'robotics', 'computer-use', '-001', '-002'];
        for (var i = 0; i < excludeKeywords.length; i++) {
            if (name.indexOf(excludeKeywords[i]) !== -1) return false;
        }
        return true;
    }

    function fetchOfficialModels(force, showAlert) {
        var apiKey = GM_getValue('GEMINI_API_KEY', '');
        if (!apiKey) {
            if (showAlert) alert('请先设置 Gemini API Key 后再同步模型列表！');
            return;
        }

        var lastFetch = GM_getValue('GEMINI_MODELS_LAST_FETCH', 0);
        var cached = GM_getValue('GEMINI_MODELS_CACHE', null);
        if (!force && cached && (Date.now() - lastFetch < CACHE_TTL)) return;

        var btns = document.querySelectorAll('.gemini-model-refresh-btn');
        for (var i = 0; i < btns.length; i++) btns[i].innerText = '⏳';

        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=' + apiKey,
            onload: function(response) {
                var rBtns = document.querySelectorAll('.gemini-model-refresh-btn');
                for (var j = 0; j < rBtns.length; j++) rBtns[j].innerText = '🔄';
                try {
                    var data = JSON.parse(response.responseText);
                    if (data.error) {
                        if (showAlert) alert('同步模型失败: ' + data.error.message);
                        return;
                    }

                    var rawModels = data.models || [];
                    var modelList = [];
                    var seen = {};

                    for (var k = 0; k < rawModels.length; k++) {
                        var m = rawModels[k];
                        if (!isTextChatModel(m)) continue;
                        var id = m.name.replace('models/', '');
                        if (seen[id]) continue;
                        seen[id] = true;
                        var info = annotateModel(id);
                        modelList.push({ id: id, label: info.label, priority: info.priority });
                    }

                    if (modelList.length === 0) {
                        modelList = FALLBACK_MODELS;
                    } else {
                        modelList.sort(function(a, b) {
                            return (b.priority - a.priority) || a.id.localeCompare(b.id);
                        });
                    }

                    GM_setValue('GEMINI_MODELS_CACHE', modelList);
                    GM_setValue('GEMINI_MODELS_LAST_FETCH', Date.now());
                    syncAllModelSelects();

                    if (showAlert) {
                        alert('✅ 同步成功！已从 Google 官方接口获取到 ' + modelList.length + ' 个可用 Gemini 模型。');
                    }
                } catch (e) {
                    console.error('[Gemini助手] 解析模型列表失败:', e);
                    if (showAlert) alert('解析官方模型列表失败，请检查网络设置。');
                }
            },
            onerror: function() {
                var rBtns = document.querySelectorAll('.gemini-model-refresh-btn');
                for (var j = 0; j < rBtns.length; j++) rBtns[j].innerText = '🔄';
                if (showAlert) alert('网络请求失败，无法连接 generativelanguage.googleapis.com');
            }
        });
    }

    function getAvailableModels() {
        var cached = GM_getValue('GEMINI_MODELS_CACHE', null);
        return (cached && Array.isArray(cached) && cached.length > 0) ? cached : FALLBACK_MODELS;
    }

    function syncAllModelSelects() {
        var models = getAvailableModels();
        var currentSaved = GM_getValue('GEMINI_MODEL', DEFAULT_MODEL);
        var exists = false;
        for (var i = 0; i < models.length; i++) {
            if (models[i].id === currentSaved) {
                exists = true;
                break;
            }
        }
        if (!exists && models.length > 0) {
            currentSaved = models[0].id;
            GM_setValue('GEMINI_MODEL', currentSaved);
        }

        var selects = document.querySelectorAll('.gemini-model-select');
        for (var s = 0; s < selects.length; s++) {
            var selectEl = selects[s];
            selectEl.innerHTML = '';
            for (var m = 0; m < models.length; m++) {
                var opt = document.createElement('option');
                opt.value = models[m].id;
                opt.innerText = models[m].label;
                if (models[m].id === currentSaved) opt.selected = true;
                selectEl.appendChild(opt);
            }
            selectEl.value = currentSaved;
        }
    }

    function getMoyuContext() {
        var moyuInput = getMoyuInputBox();
        var rightPane = getMoyuRightChatPane() || (moyuInput ? (moyuInput.closest('[class*="chat"], [class*="main"], [class*="right"], [class*="panel"]') || document.body) : document.body);
        var title = '';

        if (rightPane && rightPane.firstElementChild) {
            var headerTxt = (rightPane.firstElementChild.innerText || '').trim();
            if (/\(\d+\)/.test(headerTxt)) {
                title = headerTxt.replace(/\(\d+\)\s*$/, '').trim();
            }
        }

        if (!title && moyuInput) {
            var ph = moyuInput.getAttribute('placeholder') || moyuInput.getAttribute('data-placeholder') || '';
            if (ph.indexOf('发送给') !== -1) {
                title = ph.replace(/^.*发送给\s*/, '').replace(/\(Ctrl.*$/, '').trim();
            }
        }

        var bubbles = [];
        var bubbleSelectors = [
            '[class*="bubble-content"]',
            '[class*="msg-content"]',
            '[class*="message-content"]',
            '[class*="chat-content"]',
            '[class*="msg-text"]',
            '.markdown-body',
            'article.post-content',
            '.post-content',
            '.cooked'
        ];

        for (var i = 0; i < bubbleSelectors.length; i++) {
            var nodelist = rightPane.querySelectorAll(bubbleSelectors[i]);
            var validTexts = [];
            for (var j = 0; j < nodelist.length; j++) {
                var el = nodelist[j];
                if (el.offsetParent !== null && (!moyuInput || !el.contains(moyuInput))) {
                    var t = (el.innerText || '').trim();
                    if (t.length > 0) validTexts.push(t);
                }
            }
            if (validTexts.length > 0) {
                bubbles = validTexts;
                break;
            }
        }

        if (bubbles.length === 0 && rightPane) {
            var msgItems = rightPane.querySelectorAll('[class*="msg"], [class*="message"], [class*="bubble"], [class*="item"]');
            for (var k = 0; k < msgItems.length; k++) {
                var item = msgItems[k];
                if (moyuInput && item.contains(moyuInput)) continue;
                if (item.id === 'gemini-linuxdo-moyu-box' || item.classList.contains('gemini-btn-bar')) continue;
                var txt = (item.innerText || '').trim().replace(/\n+/g, ' ');
                if (txt && txt.length > 2) bubbles.push(txt);
            }
        }

        return {
            title: title || document.title,
            content: bubbles[0] || title || '无正文内容',
            replies: bubbles.slice(1, 7).join(' | ')
        };
    }

    function detectMoyuFloorTarget(targetEl) {
        var moyuInput = targetEl || getMoyuInputBox();
        if (!moyuInput) return null;

        var rawVal = moyuInput.value !== undefined ? moyuInput.value : (moyuInput.innerText || '');
        if (!rawVal || !rawVal.trim()) {
            if (lastClickedFloor.content && (Date.now() - lastClickedFloor.timestamp < 15000)) {
                return {
                    isFloorReply: true,
                    prefixToKeep: lastClickedFloor.user ? '@' + lastClickedFloor.user + ' ' : '',
                    targetUser: lastClickedFloor.user || '层主',
                    targetFloor: lastClickedFloor.floorNum || '',
                    targetContent: lastClickedFloor.content
                };
            }
            return null;
        }

        var atMatch = rawVal.match(/^((?:@[^\s#]+|\[@[^\]]+\]\([^\)]+\))(?:\s*#(\d+))?\s*)/);
        var quoteLines = rawVal.match(/^((?:>[^\n]*\n?)+)\s*/);

        if (!atMatch && !quoteLines) return null;

        var prefix = '';
        var floorNo = '';
        var username = '';
        var floorContent = '';

        if (quoteLines) {
            prefix = quoteLines[0].trim() + '\n\n';
            floorContent = quoteLines[1].replace(/^>\s*/gm, '').trim();
        } else if (atMatch) {
            prefix = atMatch[1].trim() + ' ';
            floorNo = atMatch[2] || '';
            var uMatch = atMatch[1].match(/@([^\s#\]]+)/);
            username = uMatch ? uMatch[1] : '';
        }

        if (!floorContent && username) {
            var items = document.querySelectorAll('[class*="message-item"], [class*="msg-item"], [class*="chat-msg"], .content-item, .comment-item');
            for (var i = items.length - 1; i >= 0; i--) {
                if ((items[i].innerText || '').indexOf(username) !== -1) {
                    var bEl = items[i].querySelector('[class*="bubble"], [class*="content"], .post-content, .cooked');
                    floorContent = bEl ? bEl.innerText.trim() : items[i].innerText.trim();
                    break;
                }
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
            targetContent: floorContent || '(层主 @' + username + ' 的发言)'
        };
    }

    function fillControlledInput(el, finalOutput) {
        if (!el) return;
        el.focus();

        var execSuccess = false;
        try {
            if (typeof el.select === 'function') {
                el.select();
            } else {
                document.execCommand('selectAll', false, null);
            }
            execSuccess = document.execCommand('insertText', false, finalOutput);
        } catch (e) {
            execSuccess = false;
        }

        var currentVal = el.value !== undefined ? el.value : el.innerText;
        if (!execSuccess || currentVal !== finalOutput) {
            if (el.value !== undefined) {
                var proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
                if (descriptor && descriptor.set) {
                    descriptor.set.call(el, finalOutput);
                } else {
                    el.value = finalOutput;
                }
            } else {
                el.innerText = finalOutput;
            }
        }

        try {
            el.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: finalOutput
            }));
        } catch (e) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    }

    function getNodeSeekEditorText(targetEl) {
        var moyuInput = getMoyuInputBox();
        if (moyuInput && (targetEl === moyuInput || !targetEl)) {
            return moyuInput.value !== undefined ? moyuInput.value : (moyuInput.innerText || '');
        }
        if (targetEl && targetEl.tagName === 'TEXTAREA') {
            return targetEl.value || '';
        }
        var cmEl = document.querySelector('.CodeMirror');
        if (cmEl && cmEl.CodeMirror) {
            return cmEl.CodeMirror.getValue() || '';
        }
        var codeLines = document.querySelectorAll('.CodeMirror-code .CodeMirror-line');
        if (codeLines && codeLines.length > 0) {
            var arr = [];
            for (var i = 0; i < codeLines.length; i++) {
                arr.push((codeLines[i].innerText || '').replace(/\u200B/g, ''));
            }
            return arr.join('\n');
        }
        var ta = document.querySelector('.CodeMirror textarea') || document.querySelector('textarea');
        return ta ? ta.value : '';
    }

    var siteConfigs = {
        v2ex: {
            match: function() { return location.hostname.indexOf('v2ex.com') !== -1; },
            title: function() {
                if (getMoyuInputBox()) return getMoyuContext().title;
                var h1 = document.querySelector('.header h1');
                return h1 ? h1.innerText : document.title;
            },
            content: function() {
                if (getMoyuInputBox()) return getMoyuContext().content;
                var tc = document.querySelector('.topic_content');
                return tc ? tc.innerText : '';
            },
            replies: function() {
                if (getMoyuInputBox()) return getMoyuContext().replies;
                var nodes = document.querySelectorAll('.reply_content');
                var arr = [];
                for (var i = 0; i < Math.min(5, nodes.length); i++) {
                    arr.push(nodes[i].innerText.trim());
                }
                return arr.join(' | ');
            },
            getMountTargets: function() {
                var targets = [];
                var moyuInput = getMoyuInputBox();
                if (moyuInput) targets.push(moyuInput);
                var nativeEl = document.querySelector('#reply_content');
                if (nativeEl && nativeEl.offsetParent !== null && targets.indexOf(nativeEl) === -1) {
                    targets.push(nativeEl);
                }
                return targets;
            },
            detectFloorTarget: function(targetEl) {
                if (getMoyuInputBox() && targetEl === getMoyuInputBox()) {
                    return detectMoyuFloorTarget(targetEl);
                }
                var el = targetEl || document.querySelector('#reply_content');
                var val = el ? el.value : '';
                var match = val.match(/^(@([a-zA-Z0-9_-]+)(?:\s+#(\d+))?\s*)/);
                if (!match) return null;

                var prefix = match[1].trim() + ' ';
                var username = match[2];
                var floorNo = match[3];
                var floorContent = '';

                var cells = document.querySelectorAll('.cell[id^="r_"]');
                if (floorNo) {
                    for (var i = 0; i < cells.length; i++) {
                        var noEl = cells[i].querySelector('.no');
                        if (noEl && noEl.innerText.trim() === floorNo) {
                            var rc = cells[i].querySelector('.reply_content');
                            floorContent = rc ? rc.innerText.trim() : '';
                            break;
                        }
                    }
                }
                if (!floorContent && username) {
                    for (var j = cells.length - 1; j >= 0; j--) {
                        var uEl = cells[j].querySelector('strong a.dark');
                        if (uEl && uEl.innerText.trim() === username) {
                            var rc2 = cells[j].querySelector('.reply_content');
                            floorContent = rc2 ? rc2.innerText.trim() : '';
                            break;
                        }
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
                    targetContent: floorContent || '(用户 @' + username + ' 的发言)'
                };
            },
            fillText: function(text, targetEl, prefixToKeep) {
                var el = targetEl || getMoyuInputBox() || document.querySelector('#reply_content');
                fillControlledInput(el, (prefixToKeep || '') + text);
            },
            persona: 'V2EX资深程序员老哥，懂技术、说话直接、有逻辑、不讲客套话'
        },
        linuxdo: {
            match: function() { return location.hostname.indexOf('linux.do') !== -1; },
            title: function() {
                if (getMoyuInputBox()) return getMoyuContext().title;
                var tEl = document.querySelector('.fancy-title, #topic-title h1');
                return tEl ? tEl.innerText.trim() : document.title;
            },
            content: function() {
                if (getMoyuInputBox()) return getMoyuContext().content;
                var cEl = document.querySelector('article#post_1 .cooked, .topic-post:first-child .cooked');
                return cEl ? cEl.innerText.trim() : '';
            },
            replies: function() {
                if (getMoyuInputBox()) return getMoyuContext().replies;
                var nodes = document.querySelectorAll('article .cooked');
                var arr = [];
                for (var i = 1; i < Math.min(6, nodes.length); i++) {
                    arr.push(nodes[i].innerText.trim());
                }
                return arr.join(' | ');
            },
            getMountTargets: function() {
                var targets = [];
                var moyuInput = getMoyuInputBox();
                if (moyuInput) targets.push(moyuInput);
                var discourseInput = document.querySelector('textarea.d-editor-input');
                if (discourseInput && discourseInput.offsetParent !== null && targets.indexOf(discourseInput) === -1) {
                    targets.push(discourseInput);
                }
                return targets;
            },
            detectFloorTarget: function(targetEl) {
                if (getMoyuInputBox() && targetEl === getMoyuInputBox()) {
                    return detectMoyuFloorTarget(targetEl);
                }
                var val = targetEl ? targetEl.value : '';
                var quoteMatch = val.match(/^(\[quote="([^,"]+)[^"]*?"\][\s\S]*?\[\/quote\]\s*)/i);
                if (quoteMatch) {
                    return {
                        isFloorReply: true,
                        prefixToKeep: quoteMatch[1],
                        targetUser: quoteMatch[2],
                        targetFloor: '',
                        targetContent: quoteMatch[1].replace(/\[\/?quote[^\]]*\]/gi, '').trim()
                    };
                }
                var replyToUserEl = document.querySelector('#reply-control .reply-details .user-link, #reply-control .composer-action-title .user-link');
                if (replyToUserEl) {
                    var username = replyToUserEl.innerText.trim();
                    var floorContent = lastClickedFloor.user === username ? lastClickedFloor.content : '';
                    if (!floorContent) {
                        var posts = document.querySelectorAll('article.topic-post');
                        for (var i = posts.length - 1; i >= 0; i--) {
                            if ((posts[i].innerText || '').indexOf(username) !== -1) {
                                var ck = posts[i].querySelector('.cooked');
                                floorContent = ck ? ck.innerText.trim() : '';
                                break;
                            }
                        }
                    }
                    return {
                        isFloorReply: true,
                        prefixToKeep: '',
                        targetUser: username,
                        targetFloor: lastClickedFloor.floorNum || '',
                        targetContent: floorContent || '(佬友 @' + username + ' 的发言)'
                    };
                }
                return null;
            },
            fillText: function(text, targetEl, prefixToKeep) {
                var el = targetEl || getMoyuInputBox() || document.querySelector('textarea.d-editor-input');
                fillControlledInput(el, (prefixToKeep || '') + text);
            },
            persona: 'Linux.do (L站) 资深开源与AI技术社区佬友，懂AI大模型、Docker、自建服务、数码硬件与开发，称呼坛友为“佬”或“佬友”，说话真诚接地气，常用“感谢大佬分享”、“太强了佬”、“前排支持”等社区用语'
        },
        nodeseek: {
            match: function() { return location.hostname.indexOf('nodeseek.com') !== -1; },
            title: function() {
                if (getMoyuInputBox()) return getMoyuContext().title;
                var hEl = document.querySelector('.post-title h1, .nsk-post h1, h1');
                return hEl ? hEl.innerText : document.title;
            },
            content: function() {
                if (getMoyuInputBox()) return getMoyuContext().content;
                var cEl = document.querySelector('article.post-content, .post-content');
                return cEl ? cEl.innerText : '';
            },
            replies: function() {
                if (getMoyuInputBox()) return getMoyuContext().replies;
                var nodes = document.querySelectorAll('article.post-content, .post-content');
                var arr = [];
                for (var i = 1; i < Math.min(6, nodes.length); i++) {
                    arr.push(nodes[i].innerText.trim());
                }
                return arr.join(' | ');
            },
            getMountTargets: function() {
                var targets = [];
                var moyuInput = getMoyuInputBox();
                if (moyuInput) targets.push(moyuInput);

                var nativeEl = document.querySelector('.CodeMirror') || document.querySelector('#cm-editor-wrapper') || document.querySelector('.nsk-editor') || document.querySelector('.comment-box textarea');
                if (nativeEl && nativeEl.offsetParent !== null && targets.indexOf(nativeEl) === -1) {
                    targets.push(nativeEl);
                }
                return targets;
            },
            detectFloorTarget: function(targetEl) {
                if (getMoyuInputBox() && targetEl === getMoyuInputBox()) {
                    return detectMoyuFloorTarget(targetEl);
                }
                var rawVal = getNodeSeekEditorText(targetEl);
                if (!rawVal || !rawVal.trim()) return null;

                var atMatch = rawVal.match(/^((?:@[^\s#]+|\[@[^\]]+\]\([^\)]+\))(?:\s*#(\d+))?\s*)/);
                var quoteLines = rawVal.match(/^((?:>[^\n]*\n?)+)\s*/);

                if (!atMatch && !quoteLines) return null;

                var prefix = '';
                var floorNo = '';
                var username = '';
                var floorContent = '';

                if (quoteLines) {
                    prefix = quoteLines[0].trim() + '\n\n';
                    floorContent = quoteLines[1].replace(/^>\s*/gm, '').trim();
                } else if (atMatch) {
                    prefix = atMatch[1].trim() + ' ';
                    floorNo = atMatch[2] || '';
                    var uMatch = atMatch[1].match(/@([^\s#\]]+)/);
                    username = uMatch ? uMatch[1] : '';
                }

                var allArticles = document.querySelectorAll('article.post-content, .post-content');

                if (!floorContent && floorNo) {
                    var idx = parseInt(floorNo, 10);
                    var floorLink = document.querySelector('a[href$="#' + floorNo + '"], a[href*="#post-' + floorNo + '"]');
                    var container = floorLink ? floorLink.closest('.content-item, .comment-item, li, .nsk-post') : null;
                    if (container) {
                        var pc = container.querySelector('article.post-content, .post-content');
                        floorContent = pc ? pc.innerText.trim() : '';
                    }
                    if (!floorContent && idx > 0 && allArticles[idx]) {
                        floorContent = allArticles[idx].innerText.trim();
                    }
                }

                if (!floorContent && username) {
                    var items = document.querySelectorAll('.content-item, .comment-item');
                    for (var i = items.length - 1; i >= 0; i--) {
                        if ((items[i].innerText || '').indexOf(username) !== -1) {
                            var pc2 = items[i].querySelector('article.post-content, .post-content');
                            floorContent = pc2 ? pc2.innerText.trim() : '';
                            break;
                        }
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
                    targetContent: floorContent || '(层主 @' + username + ' 的发言)'
                };
            },
            fillText: function(text, targetEl, prefixToKeep) {
                var finalOutput = (prefixToKeep || '') + text;
                var moyuInput = getMoyuInputBox();

                if (moyuInput && (targetEl === moyuInput || !(targetEl && targetEl.classList && targetEl.classList.contains('CodeMirror')))) {
                    fillControlledInput(moyuInput, finalOutput);
                    return;
                }

                var cmEl = (targetEl && targetEl.classList && targetEl.classList.contains('CodeMirror')) ? targetEl : document.querySelector('.CodeMirror');
                if (cmEl && cmEl.CodeMirror) {
                    cmEl.CodeMirror.setValue(finalOutput);
                    cmEl.CodeMirror.focus();
                    cmEl.CodeMirror.setCursor(cmEl.CodeMirror.lineCount(), 0);
                    return;
                }

                var hiddenTa = document.querySelector('.CodeMirror textarea') || document.querySelector('textarea');
                if (hiddenTa) {
                    fillControlledInput(hiddenTa, finalOutput);
                }
            },
            persona: 'NodeSeek (MJJ/主机圈) 资深玩家，熟悉VPS线路、网络优化、建站、硬件与折腾，说话接地气，善用社区常用词（如：bd、绑定、好鸡、早收、溢价、灵车、分母、吃码等，注意严禁使用“富哥”一词）'
        },
        t66y: {
            match: function() { return isT66ySite(); },
            title: function() {
                var h4 = document.querySelector('h4.f16') || document.querySelector('.tpc_content')?.closest('td')?.querySelector('h4');
                if (h4 && h4.innerText.trim()) return h4.innerText.trim();
                // 清理草榴网页 title 后缀（如 " - 達蓋爾的旗幟 - 草榴社區 - t66y.com"）
                return document.title.replace(/\s*-\s*[^-]+-\s*草榴.*$/i, '').replace(/\s*\|\s*草榴.*$/i, '').trim();
            },
            content: function() {
                var firstPost = document.querySelector('div.tpc_content');
                if (!firstPost) return '';
                var text = (firstPost.innerText || '').trim();
                var imgCount = firstPost.querySelectorAll('img').length;
                var linkCount = firstPost.querySelectorAll('a').length;
                var mediaDesc = [];
                if (imgCount > 0) mediaDesc.push('包含 ' + imgCount + ' 张图片/写真');
                if (linkCount > 0) mediaDesc.push('包含 ' + linkCount + ' 个链接/种子特征码');
                var prefix = mediaDesc.length > 0 ? '【主楼媒体信息：' + mediaDesc.join('，') + '】\n' : '';
                return prefix + (text || '(主楼为纯图片/资源分享帖，请结合帖子标题与前排老哥评论进行回复)');
            },
            replies: function() {
                var nodes = document.querySelectorAll('div.tpc_content');
                var arr = [];
                for (var i = 1; i < Math.min(8, nodes.length); i++) {
                    var txt = (nodes[i].innerText || '').trim().replace(/\n+/g, ' ');
                    if (txt && txt !== '1024') arr.push(txt);
                }
                return arr.join(' | ');
            },
            getMountTargets: function() {
                var selectors = [
                    'textarea[name="atc_content"]',
                    '#atc_content'
                ];
                var targets = [];
                for (var i = 0; i < selectors.length; i++) {
                    var els = document.querySelectorAll(selectors[i]);
                    for (var j = 0; j < els.length; j++) {
                        if (els[j].offsetParent !== null && targets.indexOf(els[j]) === -1) {
                            targets.push(els[j]);
                        }
                    }
                }
                return targets;
            },
            detectFloorTarget: function(targetEl) {
                var val = targetEl ? targetEl.value : '';
                // 1. 检测 PHPWind 标准 [quote]...[/quote] 引用块
                var quoteMatch = val.match(/^(\[quote\][\s\S]*?\[\/quote\]\s*)/i);
                if (quoteMatch) {
                    return {
                        isFloorReply: true,
                        prefixToKeep: quoteMatch[1],
                        targetUser: lastClickedFloor.user || '该层老哥',
                        targetFloor: '',
                        targetContent: quoteMatch[1].replace(/\[\/?quote\]/gi, '').trim()
                    };
                }
                // 2. 检测草榴点击楼层“回复”自动填入的 "回 X 楼(xxx) 的帖子"
                var replyFloorMatch = val.match(/^((?:回|Re:)\s*\d+\s*樓?\s*\(([^)]+)\)\s*的帖子\s*)/i);
                if (replyFloorMatch) {
                    return {
                        isFloorReply: true,
                        prefixToKeep: replyFloorMatch[1].trim() + '\n',
                        targetUser: replyFloorMatch[2],
                        targetFloor: '',
                        targetContent: lastClickedFloor.content || ('层主 ' + replyFloorMatch[2] + ' 的发言')
                    };
                }
                if (lastClickedFloor.content && (Date.now() - lastClickedFloor.timestamp < 20000)) {
                    return {
                        isFloorReply: true,
                        prefixToKeep: '',
                        targetUser: lastClickedFloor.user || '该层老哥',
                        targetFloor: '',
                        targetContent: lastClickedFloor.content
                    };
                }
                return null;
            },
            fillText: function(text, targetEl, prefixToKeep) {
                var el = targetEl || document.querySelector('textarea[name="atc_content"]');
                if (el) {
                    fillControlledInput(el, (prefixToKeep || '') + text);
                }
            },
            persona: '草榴社区(1024/t66y)资深老司机与常驻老哥，混迹于技术讨论区、达盖尔的旗帜、新时代的我们及影视资源区。说话豪爽、幽默、接地气、懂行，称呼发帖人为“楼主”或“老哥”，善用社区地道表达（如：1024、感谢老哥无私分享、好人一生平安、这身材顶不住、大作必须支持、老哥稳、经典永不过时等）。注意：草榴版规严禁纯发表情或单发一个“1024”灌水，回复必须结合帖子主题（看图夸身材/颜值/拍摄质感，看片夸画质/题材，看技术文学帖谈具体感受）写出自然真实的互动内容！'
        },
        discuz: {
            match: function() { return true; },
            title: function() {
                var ts = document.querySelector('#thread_subject') || document.querySelector('h1');
                return ts ? ts.innerText : document.title;
            },
            content: function() {
                var firstPost = document.querySelector('td[id^="postmessage_"], .t_f, .message');
                return firstPost ? firstPost.innerText : '';
            },
            replies: function() {
                var nodes = document.querySelectorAll('td[id^="postmessage_"], .t_f');
                var arr = [];
                for (var i = 1; i < Math.min(6, nodes.length); i++) {
                    arr.push(nodes[i].innerText.trim());
                }
                return arr.join(' | ');
            },
            getMountTargets: function() {
                var selectors = [
                    '#fastpostmessage',
                    '#fwin_reply #postmessage',
                    '#postmessage',
                    '#e_textarea',
                    '#needmessage',
                    'textarea[name="message"]'
                ];
                var targets = [];
                for (var i = 0; i < selectors.length; i++) {
                    var els = document.querySelectorAll(selectors[i]);
                    for (var j = 0; j < els.length; j++) {
                        if (targets.indexOf(els[j]) === -1) targets.push(els[j]);
                    }
                }
                return targets;
            },
            detectFloorTarget: function(targetEl) {
                var inPopup = targetEl && targetEl.closest ? targetEl.closest('#fwin_reply') : null;
                var quoteBlock = (inPopup ? inPopup.querySelector('blockquote') : null) || document.querySelector('#fwin_reply blockquote, #postform blockquote, .quote blockquote');
                if (quoteBlock && targetEl && targetEl.id !== 'fastpostmessage') {
                    return {
                        isFloorReply: true,
                        prefixToKeep: '',
                        targetUser: '该层主',
                        targetFloor: '',
                        targetContent: quoteBlock.innerText.trim()
                    };
                }
                var val = targetEl ? targetEl.value : '';
                var bbcodeMatch = val.match(/^(\[quote\][\s\S]*?\[\/quote\]\s*)/i);
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
            fillText: function(text, targetEl, prefixToKeep) {
                var finalOutput = (prefixToKeep || '') + text;
                var eIframe = document.querySelector('#e_iframe');
                if (targetEl && targetEl.id === 'e_textarea' && eIframe && eIframe.contentDocument && eIframe.contentDocument.body) {
                    eIframe.contentDocument.body.innerText = finalOutput;
                }
                if (targetEl) {
                    fillControlledInput(targetEl, finalOutput);
                }
            },
            persona: function() {
                if (location.hostname.indexOf('right.com.cn') !== -1) {
                    return '恩山无线论坛(Right.com.cn)硬核数码与网络玩家，精通路由器刷机、OpenWrt、光猫改桥接、组网与固件编译，说话实在接地气，常用“思考”、“紫薯布丁”、“老哥稳”、“感谢分享”等社区用语';
                }
                return '论坛常驻老哥，语气熟稔自然，像真人坛友一样交流';
            }
        }
    };

    var replyModes = [
        {
            label: '🍗 摸鱼黑话 (2~6字)',
            type: 'short',
            maxTokens: 512,
            rulesForOP: [
                '1. 你正在【直接回复楼主（主楼）】，这是简短水贴模式，字数控制在 4~10 个字（若在草榴社区，切勿只发纯数字1024，需带简短夸赞或感谢防封，如“1024 感谢老哥分享”、“极品好帖必须顶”）！',
                '2. 根据主楼帖子类型和【前排网友回复】的队形，直接甩出最地道的社区极简用语（例如：感谢分享、1024老哥稳、太强了佬、思考一下、帮顶、bd、好鸡早收、分母来了）。',
                '3. 严禁出现“富哥”二字，严禁加句号，严禁换行，绝不要包含 @用户名，只输出最终回复的那几个字！'
            ].join('\n'),
            rulesForFloor: [
                '1. 你正在【直接回应某位层主】，字数控制在 2~10 个字！',
                '2. 针对【你正在直接回应的层主发言】，用极简的一两个词附和、接梗、赞同或调侃他（例如：老哥真相了、确实如此、同感、扎心了、借您吉言、哈哈真实、老司机懂行）。',
                '3. 严禁出现“富哥”二字，严禁加句号，严禁换行，绝不要自己输出 @用户名（系统会自动加），只输出回复正文那几个字！'
            ].join('\n')
        },
        {
            label: '💬 简短互动 (40字左右)',
            type: 'medium',
            maxTokens: 1024,
            rulesForOP: [
                '1. 你正在【直接回复楼主（主楼）】，针对主楼标题、内容及前排评论氛围，用一两句自然的大白话发表看法、夸赞、吐槽或互动。',
                '2. 字数控制在 25~55 个字左右（约一到两句话），必须把整句话的逻辑和意思表达完整，绝对不能话说到一半断掉！',
                '3. 语气要像真人老哥日常敲字交流，口语化、接地气，严禁出现“富哥”、“总的来说”、“确实”、“希望”、“首先”等词。绝不要包含 @用户名，只输出回复正文！'
            ].join('\n'),
            rulesForFloor: [
                '1. 你正在【直接与某位层主对话/对线】！请把注意力 100% 集中在【你正在直接回应的层主发言】上（主楼内容仅作背景参考）。',
                '2. 顺着这位层主的话进行回应（赞同补充、解答他的疑问、反驳他的观点或顺着接梗），字数控制在 20~50 个字左右，必须把话完整说完，绝不断句！',
                '3. 语气要像真人坛友在楼层里直接跟人搭话，自然口语化，严禁出现“富哥”二字，严禁在开头自己写 @用户名（系统已自带前缀），只输出纯回复正文！'
            ].join('\n')
        },
        {
            label: '🧐 详细分析 (完整深度回复)',
            type: 'long',
            maxTokens: 2048,
            rulesForOP: [
                '1. 你正在【直接回复楼主（主楼）】，针对主楼的主题、分享、故事或技术讨论，给出有细节、走心、逻辑完整的详细点评或解答，字数控制在 100~300 字左右，务必把话完整讲透，严禁半途截断！',
                '2. 保持论坛资深老哥的口吻：直接切入核心看点或细节，可以自然分段，但严禁使用“富哥”、“首先、其次、最后、综上所述、总而言之、希望能帮到你”这种死板套话。',
                '3. 纯文本输出：绝对不要使用 Markdown 加粗符号（**）或标题符号（###），只输出回复正文！'
            ].join('\n'),
            rulesForFloor: [
                '1. 你正在【深度回应/探讨某位层主的观点】！请重点针对【你正在直接回应的层主发言】展开走心交流、细节补充或探讨，结合主楼背景把话讲透，字数控制在 100~280 字左右，严禁半途截断！',
                '2. 保持论坛资深老哥与坛友切磋交流的口吻，直接切入要点，严禁使用“富哥”、“首先、其次、最后、综上所述”等套话，也不要使用 Markdown 加粗符号（**）。',
                '3. 严禁在开头自己输出 @用户名（系统已保留前缀），只输出纯回复正文！'
            ].join('\n')
        }
    ];

    function getCurrentSite() {
        if (siteConfigs.v2ex.match()) return siteConfigs.v2ex;
        if (siteConfigs.linuxdo.match()) return siteConfigs.linuxdo;
        if (siteConfigs.nodeseek.match()) return siteConfigs.nodeseek;
        if (siteConfigs.t66y.match()) return siteConfigs.t66y;
        return siteConfigs.discuz;
    }

    function updateModeBarStatus() {
        var site = getCurrentSite();
        var badges = document.querySelectorAll('.gemini-target-badge');
        for (var i = 0; i < badges.length; i++) {
            var badge = badges[i];
            var targetEl = badge._boundTarget;
            var floorInfo = site.detectFloorTarget ? site.detectFloorTarget(targetEl) : null;
            if (floorInfo && floorInfo.isFloorReply) {
                var tag = floorInfo.targetFloor ? ' #' + floorInfo.targetFloor : '';
                badge.innerText = '🎯 当前：回层主 ' + floorInfo.targetUser + tag;
                badge.style.background = '#1e3a2f';
                badge.style.color = '#6ee7b7';
                badge.style.borderColor = '#059669';
            } else {
                badge.innerText = '📢 当前：回楼主';
                badge.style.background = '#1e1f22';
                badge.style.color = '#949ba4';
                badge.style.borderColor = '#4e5058';
            }
        }
    }

    function initButtons() {
        var site = getCurrentSite();
        var targets = site.getMountTargets();
        if (!targets || targets.length === 0) return;

        var mountedNew = false;

        for (var t = 0; t < targets.length; t++) {
            (function(target) {
                if (!target || target.dataset.geminiMounted === 'true') return;
                target.dataset.geminiMounted = 'true';
                mountedNew = true;

                target.addEventListener('input', updateModeBarStatus);
                target.addEventListener('keyup', updateModeBarStatus);

                var bar = document.createElement('div');
                bar.className = 'gemini-btn-bar';
                bar.style.cssText = 'width:100%;box-sizing:border-box;margin:4px 0 6px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap;z-index:9999;text-align:left;flex-shrink:0;';

                var badge = document.createElement('span');
                badge.className = 'gemini-target-badge';
                badge._boundTarget = target;
                badge.innerText = '📢 当前：回楼主';
                badge.title = '当输入框内有 @用户名 #楼层 或引用块时，自动切换为针对层主发言生成回复';
                badge.style.cssText = 'padding:3px 8px;background:#1e1f22;color:#949ba4;border:1px solid #4e5058;border-radius:4px;font-size:12px;line-height:1.4;user-select:none;';
                bar.appendChild(badge);

                for (var m = 0; m < replyModes.length; m++) {
                    (function(mode) {
                        var btn = document.createElement('button');
                        btn.type = 'button';
                        btn.innerText = mode.label;
                        btn.style.cssText = 'padding:4px 10px;background:#2b2d31;color:#e3e5e8;border:1px solid #4e5058;border-radius:4px;cursor:pointer;font-size:12px;line-height:1.4;transition:0.2s;';
                        btn.onmouseover = function() { btn.style.background = '#404249'; };
                        btn.onmouseout = function() { btn.style.background = '#2b2d31'; };
                        btn.onclick = function(e) {
                            e.preventDefault();
                            e.stopPropagation();
                            var selectedModel = GM_getValue('GEMINI_MODEL', DEFAULT_MODEL);
                            generateReply(site, mode, btn, target, selectedModel, []);
                        };
                        bar.appendChild(btn);
                    })(replyModes[m]);
                }

                var modelSelect = document.createElement('select');
                modelSelect.className = 'gemini-model-select';
                modelSelect.title = '选择 Gemini 模型（列表通过官方 API 自动更新，支持额度耗尽自动切换）';
                modelSelect.style.cssText = 'padding:3px 6px;background:#1e1f22;color:#b5bac1;border:1px solid #4e5058;border-radius:4px;font-size:12px;height:26px;cursor:pointer;outline:none;max-width:250px;';
                modelSelect.onchange = function() {
                    GM_setValue('GEMINI_MODEL', modelSelect.value);
                    syncAllModelSelects();
                };
                bar.appendChild(modelSelect);

                var refreshBtn = document.createElement('button');
                refreshBtn.className = 'gemini-model-refresh-btn';
                refreshBtn.type = 'button';
                refreshBtn.innerText = '🔄';
                refreshBtn.title = '从 Google 官方接口实时同步最新可用模型';
                refreshBtn.style.cssText = 'padding:3px 7px;background:#1e1f22;color:#b5bac1;border:1px solid #4e5058;border-radius:4px;cursor:pointer;font-size:12px;line-height:1.4;';
                refreshBtn.onclick = function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    fetchOfficialModels(true, true);
                };
                bar.appendChild(refreshBtn);

                var parent = target.parentNode;
                if (parent) {
                    var parentStyle = window.getComputedStyle(parent);
                    var isMoyu = (target === getMoyuInputBox());
                    var isDiscourse = target.classList && target.classList.contains('d-editor-input');

                    if (isMoyu || isDiscourse || (parentStyle.display.indexOf('flex') !== -1 && parentStyle.flexDirection === 'row')) {
                        parent.style.display = 'flex';
                        parent.style.flexDirection = 'column';
                        parent.style.alignItems = 'stretch';
                        target.style.width = '100%';
                        target.style.boxSizing = 'border-box';
                    }
                    parent.insertBefore(bar, target);
                }
            })(targets[t]);
        }

        if (mountedNew) {
            syncAllModelSelects();
            fetchOfficialModels(false, false);
        }
        updateModeBarStatus();
    }

    function cleanOutput(text, type) {
        var cleaned = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
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
        var allModels = getAvailableModels();
        for (var i = 0; i < allModels.length; i++) {
            if (triedModels.indexOf(allModels[i].id) === -1) {
                return allModels[i].id;
            }
        }
        return null;
    }

    function generateReply(site, mode, btn, targetEl, modelId, triedModels) {
        var apiKey = GM_getValue('GEMINI_API_KEY', '');
        if (!apiKey) {
            alert('请先点击浏览器右上角油猴插件图标 -> 点击【🔑 1. 设置 Gemini API Key】');
            return;
        }

        triedModels.push(modelId);

        var title = site.title() || '无标题';
        var contentLimit = mode.type === 'long' ? 2500 : 1000;
        var content = (site.content() || '无正文内容').slice(0, contentLimit);
        var replies = (site.replies() || '暂无回复').slice(0, 600);
        var personaText = typeof site.persona === 'function' ? site.persona() : site.persona;

        var floorInfo = site.detectFloorTarget ? site.detectFloorTarget(targetEl) : null;
        var fullPrompt = '';
        var prefixToKeep = '';

        if (floorInfo && floorInfo.isFloorReply) {
            prefixToKeep = floorInfo.prefixToKeep || '';
            fullPrompt = [
                '你现在的身份是：' + personaText + '。',
                '注意：你现在【不是在回复楼主】，而是在楼层中【直接回应层主 ' + floorInfo.targetUser + (floorInfo.targetFloor ? ' (' + floorInfo.targetFloor + '楼)' : '') + '】！',
                '请严格遵守以下规则：',
                mode.rulesForFloor,
                '',
                '【你正在直接回应的层主发言（核心焦点，请直接针对这句话进行回复）】：',
                '"' + floorInfo.targetContent + '"',
                '',
                '【原帖背景参考（仅作上下文了解，切勿跑题去回楼主）】：',
                '帖子标题：' + title,
                '主楼摘要：' + content.slice(0, 500)
            ].join('\n');
        } else {
            fullPrompt = [
                '你现在的身份是：' + personaText + '。',
                '你现在正在【直接回复楼主（主楼）】。请根据以下论坛帖子内容生成一条自然回帖，严格遵守以下规则：',
                mode.rulesForOP,
                '',
                '【帖子标题】：' + title,
                '【主楼内容】：' + content,
                '【前排网友回复队形参考】：' + replies
            ].join('\n');
        }

        if (triedModels.length === 1) {
            btn.dataset.origText = btn.innerText;
            btn.innerText = (floorInfo && floorInfo.isFloorReply) ? '⏳ 回层主中...' : '⏳ 思考中...';
        } else {
            btn.innerText = '🔄 负载至 ' + modelId.replace('gemini-', '') + '...';
        }
        btn.disabled = true;

        var genConfig = {
            temperature: mode.type === 'long' ? 0.75 : 0.85,
            maxOutputTokens: mode.maxTokens
        };
        if (modelId.indexOf('2.5-flash') !== -1 && modelId.indexOf('lite') === -1) {
            genConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://generativelanguage.googleapis.com/v1beta/models/' + modelId + ':generateContent?key=' + apiKey,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                contents: [{ parts: [{ text: fullPrompt }] }],
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                ],
                generationConfig: genConfig
            }),
            onload: function(response) {
                try {
                    var data = JSON.parse(response.responseText);

                    if (data.error) {
                        var errCode = data.error.code;
                        if (errCode === 429 || errCode === 404 || errCode === 503 || errCode === 400) {
                            var nextModel = getNextAvailableModel(triedModels);
                            if (nextModel && triedModels.length <= 4) {
                                console.warn('[Gemini负载均衡] 模型 ' + modelId + ' 不可用 (Code ' + errCode + ')，自动切换至备用模型: ' + nextModel);
                                GM_setValue('GEMINI_MODEL', nextModel);
                                syncAllModelSelects();
                                generateReply(site, mode, btn, targetEl, nextModel, triedModels);
                                return;
                            }
                        }
                        btn.innerText = btn.dataset.origText;
                        btn.disabled = false;
                        alert('Gemini API 报错 (' + data.error.code + ') [已尝试模型: ' + triedModels.join(' -> ') + ']:\n' + data.error.message);
                        return;
                    }

                    btn.innerText = btn.dataset.origText;
                    btn.disabled = false;

                    if (data.promptFeedback && data.promptFeedback.blockReason) {
                        alert('内容被 Gemini 拦截，原因: ' + data.promptFeedback.blockReason);
                        return;
                    }

                    var candidate = data.candidates && data.candidates[0];
                    if (!candidate) {
                        alert('未生成有效内容，请检查帖子内容是否空白。');
                        return;
                    }

                    var parts = candidate.content && candidate.content.parts;
                    if (!parts || parts.length === 0) {
                        alert('生成中止，原因: ' + (candidate.finishReason || 'UNKNOWN'));
                        return;
                    }

                    var replyText = '';
                    for (var i = parts.length - 1; i >= 0; i--) {
                        if (!parts[i].thought && parts[i].text) {
                            replyText = parts[i].text;
                            break;
                        }
                    }
                    if (!replyText && parts[parts.length - 1]) {
                        replyText = parts[parts.length - 1].text || '';
                    }

                    if (!replyText) {
                        alert('生成的回复文本为空，请重试。');
                        return;
                    }

                    replyText = cleanOutput(replyText, mode.type);
                    site.fillText(replyText, targetEl, prefixToKeep);
                    updateModeBarStatus();
                } catch (e) {
                    btn.innerText = btn.dataset.origText;
                    btn.disabled = false;
                    console.error('Parse Error:', e, response.responseText);
                    alert('解析响应失败，请检查网络代理是否正常。');
                }
            },
            onerror: function() {
                btn.innerText = btn.dataset.origText;
                btn.disabled = false;
                alert('请求失败，请检查代理网络是否放行了 generativelanguage.googleapis.com');
            }
        });
    }

    setInterval(initButtons, 800);
})();
