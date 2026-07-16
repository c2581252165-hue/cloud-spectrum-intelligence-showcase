(function initAgentWorkbench() {
    const API_BASE = "http://127.0.0.1:5000";
    const STAGE_LABELS = {
        detected: "已检测",
        assessed: "已评估",
        assigned: "已派单",
        handling: "处理中",
        verified: "待复核",
        closed: "已闭环"
    };

    const state = {
        running: false,
        stopRequested: false,
        selectedEventId: "",
        events: [],
        activeTab: "chat"
    };
    const PANEL_SIZE_STORAGE_KEY = "aiChatPanelSizeV1";
    const PANEL_MIN_WIDTH = 720;
    const PANEL_MAX_RATIO = 0.92;

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function getPanelWidthBounds() {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
        const maxWidth = Math.max(PANEL_MIN_WIDTH + 40, Math.floor(viewportWidth * PANEL_MAX_RATIO));
        return {
            min: PANEL_MIN_WIDTH,
            max: maxWidth
        };
    }

    function savePanelWidth(width) {
        try {
            if (!Number.isFinite(width)) return;
            localStorage.setItem(PANEL_SIZE_STORAGE_KEY, JSON.stringify({ width: Math.round(width) }));
        } catch (e) {
            // ignore storage errors
        }
    }

    function loadPanelWidth() {
        try {
            const raw = localStorage.getItem(PANEL_SIZE_STORAGE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const width = Number(parsed && parsed.width);
            return Number.isFinite(width) ? width : null;
        } catch (e) {
            return null;
        }
    }

    function applyPanelWidth(chatBox, width) {
        if (!chatBox || !Number.isFinite(width)) return;
        chatBox.style.setProperty("--ai-panel-width", `${Math.round(width)}px`);
    }

    function keepChatBoxInViewport(chatBox) {
        if (!chatBox) return;
        const margin = 8;
        const rect = chatBox.getBoundingClientRect();
        let left = rect.left;
        let top = rect.top;
        let changed = false;

        if (rect.right > window.innerWidth - margin) {
            left -= rect.right - (window.innerWidth - margin);
            changed = true;
        }
        if (left < margin) {
            left = margin;
            changed = true;
        }
        if (rect.bottom > window.innerHeight - margin) {
            top -= rect.bottom - (window.innerHeight - margin);
            changed = true;
        }
        if (top < margin) {
            top = margin;
            changed = true;
        }

        if (changed) {
            chatBox.style.left = `${Math.round(left)}px`;
            chatBox.style.top = `${Math.round(top)}px`;
            chatBox.style.right = "auto";
            chatBox.style.bottom = "auto";
        }
    }

    function ensureResizeHandle(chatBox) {
        let handle = chatBox.querySelector("#agentResizeHandle");
        if (handle) return handle;

        handle = document.createElement("div");
        handle.id = "agentResizeHandle";
        handle.className = "ai-resize-handle-right";
        handle.title = "拖拽调整宽度";
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-label", "拖拽调整宽度");
        chatBox.appendChild(handle);
        return handle;
    }

    async function waitForElement(selector, maxAttempts, intervalMs) {
        for (let i = 0; i < maxAttempts; i += 1) {
            const el = document.querySelector(selector);
            if (el) return el;
            await sleep(intervalMs);
        }
        return null;
    }

    function hideLegacyPanel() {
        const panel = document.getElementById("agentOpsPanel");
        if (panel) panel.style.display = "none";
    }

    function stageLabel(stage) {
        return STAGE_LABELS[stage] || stage || "未知";
    }

    function riskClass(riskLevel) {
        const risk = String(riskLevel || "low").toLowerCase();
        if (risk === "critical") return "ai-risk-critical";
        if (risk === "high") return "ai-risk-high";
        if (risk === "medium") return "ai-risk-medium";
        return "ai-risk-low";
    }

    function createLine(text, level) {
        const div = document.createElement("div");
        div.className = `ai-log-line ${level || ""}`.trim();
        div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
        return div;
    }

    function getOperator() {
        const raw = localStorage.getItem("sky_user");
        if (!raw) return "agent-ui";
        try {
            const user = JSON.parse(raw);
            return user.username || "agent-ui";
        } catch (e) {
            return "agent-ui";
        }
    }

    function appendChatNotice(chatBody, text) {
        if (!chatBody) return;
        const msgDiv = document.createElement("div");
        msgDiv.className = "chat-message bot";
        msgDiv.textContent = text;
        chatBody.appendChild(msgDiv);
        chatBody.scrollTop = chatBody.scrollHeight;
    }

    function ensureLayout(chatBox) {
        if (chatBox.dataset.agentWorkbenchReady === "1") {
            const resizeHandle = ensureResizeHandle(chatBox);
            const savedWidth = loadPanelWidth();
            if (savedWidth && !chatBox.style.getPropertyValue("--ai-panel-width")) {
                const bounds = getPanelWidthBounds();
                applyPanelWidth(chatBox, clamp(savedWidth, bounds.min, bounds.max));
            }
            return {
                chatBody: chatBox.querySelector(".chat-body"),
                execInput: chatBox.querySelector("#agentExecInput"),
                execLog: chatBox.querySelector("#agentExecLog"),
                eventList: chatBox.querySelector("#agentEventList"),
                eventDetail: chatBox.querySelector("#agentEventDetail"),
                metricsText: chatBox.querySelector("#agentMetricsText"),
                sideNav: chatBox.querySelector("#agentSideNav"),
                resizeHandle,
                navButtons: Array.from(chatBox.querySelectorAll(".ai-nav-btn")),
                panels: {
                    chat: chatBox.querySelector('.ai-tab-panel[data-panel="chat"]'),
                    console: chatBox.querySelector('.ai-tab-panel[data-panel="console"]'),
                    events: chatBox.querySelector('.ai-tab-panel[data-panel="events"]')
                }
            };
        }

        const chatBody = chatBox.querySelector(".chat-body");
        const chatInput = chatBox.querySelector(".chat-input");
        if (!chatBody || !chatInput) {
            return null;
        }

        chatBox.classList.add("agent-integrated");
        const savedWidth = loadPanelWidth();
        if (savedWidth) {
            const bounds = getPanelWidthBounds();
            applyPanelWidth(chatBox, clamp(savedWidth, bounds.min, bounds.max));
        }

        const workbench = document.createElement("div");
        workbench.className = "ai-chat-workbench";

        const sideNav = document.createElement("aside");
        sideNav.id = "agentSideNav";
        sideNav.className = "ai-side-nav";
        sideNav.innerHTML = `
            <button type="button" class="ai-nav-btn active" data-tab="chat" title="对话">
                <span class="ai-nav-glyph">💬</span>
                <span class="ai-nav-label">对话</span>
            </button>
            <button type="button" class="ai-nav-btn" data-tab="console" title="执行台">
                <span class="ai-nav-glyph">⚙</span>
                <span class="ai-nav-label">执行</span>
            </button>
            <button type="button" class="ai-nav-btn" data-tab="events" title="事件流">
                <span class="ai-nav-glyph">📋</span>
                <span class="ai-nav-label">事件</span>
            </button>
        `;

        const mainStage = document.createElement("div");
        mainStage.className = "ai-main-stage";

        const chatPanel = document.createElement("section");
        chatPanel.className = "ai-tab-panel ai-chat-panel active";
        chatPanel.dataset.panel = "chat";
        chatPanel.innerHTML = `
            <div class="ai-panel-head">
                <span class="ai-panel-title">智能对话</span>
                <span class="ai-panel-sub">轻量问答与任务下达</span>
            </div>
        `;

        const consolePanel = document.createElement("section");
        consolePanel.className = "ai-tab-panel ai-console-panel";
        consolePanel.dataset.panel = "console";
        consolePanel.innerHTML = `
            <div class="ai-panel-head">
                <span class="ai-panel-title">执行控制台</span>
                <span class="ai-panel-sub">自然语言到界面动作</span>
            </div>
            <div class="ai-exec-dock">
                <div class="ai-exec-title">智能体一体化执行台</div>
                <textarea id="agentExecInput" class="ai-exec-input" placeholder="输入指令，例如：切换到首页并定位到中国"></textarea>
                <div class="ai-exec-row">
                    <button type="button" id="agentExecRun">执行指令</button>
                    <button type="button" id="agentExecStop" class="ai-stop">停止</button>
                </div>
                <div id="agentQuickList" class="ai-quick-list">
                    <button type="button" data-cmd="切换到首页并定位到中国">回首页并定位中国</button>
                    <button type="button" data-cmd="切换到风场数据">查看风场</button>
                    <button type="button" data-cmd="切换到排放率">进入排放率</button>
                    <button type="button" data-cmd="切换到关于我们">打开关于我们</button>
                    <button type="button" data-cmd="刷新闭环事件">刷新闭环</button>
                </div>
                <div id="agentExecLog" class="ai-exec-log"></div>
            </div>
        `;

        const eventsPanel = document.createElement("section");
        eventsPanel.className = "ai-tab-panel ai-events-panel";
        eventsPanel.dataset.panel = "events";
        eventsPanel.innerHTML = `
            <div class="ai-panel-head">
                <span class="ai-panel-title">闭环事件流</span>
                <span class="ai-panel-sub">检测-处置-复核-闭环</span>
            </div>
            <div class="ai-right-head">
                <span class="ai-right-title">闭环事件联动区</span>
                <button type="button" id="agentRefreshEvents">刷新</button>
            </div>
            <div id="agentMetricsText" class="ai-right-metrics">正在同步闭环指标...</div>
            <div id="agentEventList" class="ai-event-list"></div>
            <div id="agentEventDetail" class="ai-event-detail">点击事件卡片后，这里会展示对应详情与可执行动作。</div>
        `;

        chatBody.parentNode.removeChild(chatBody);
        chatInput.parentNode.removeChild(chatInput);
        chatPanel.appendChild(chatBody);
        chatPanel.appendChild(chatInput);

        mainStage.appendChild(chatPanel);
        mainStage.appendChild(consolePanel);
        mainStage.appendChild(eventsPanel);

        workbench.appendChild(sideNav);
        workbench.appendChild(mainStage);
        chatBox.appendChild(workbench);
        const resizeHandle = ensureResizeHandle(chatBox);

        chatBox.dataset.agentWorkbenchReady = "1";

        return {
            chatBody,
            execInput: chatBox.querySelector("#agentExecInput"),
            execLog: chatBox.querySelector("#agentExecLog"),
            eventList: chatBox.querySelector("#agentEventList"),
            eventDetail: chatBox.querySelector("#agentEventDetail"),
            metricsText: chatBox.querySelector("#agentMetricsText"),
            sideNav: chatBox.querySelector("#agentSideNav"),
            resizeHandle,
            navButtons: Array.from(chatBox.querySelectorAll(".ai-nav-btn")),
            panels: {
                chat: chatBox.querySelector('.ai-tab-panel[data-panel="chat"]'),
                console: chatBox.querySelector('.ai-tab-panel[data-panel="console"]'),
                events: chatBox.querySelector('.ai-tab-panel[data-panel="events"]')
            }
        };
    }

    function activateTab(refs, tabName) {
        if (!refs || !refs.panels) return;
        const nextTab = refs.panels[tabName] ? tabName : "chat";
        state.activeTab = nextTab;

        Object.keys(refs.panels).forEach((key) => {
            const panel = refs.panels[key];
            if (!panel) return;
            panel.classList.toggle("active", key === nextTab);
        });

        (refs.navButtons || []).forEach((btn) => {
            const isActive = btn.getAttribute("data-tab") === nextTab;
            btn.classList.toggle("active", isActive);
        });
    }

    function mountResize(chatBox, refs) {
        const handle = refs && refs.resizeHandle;
        if (!chatBox || !handle || handle.dataset.bound === "1") return;
        handle.dataset.bound = "1";

        let resizing = false;
        let startX = 0;
        let startWidth = 0;

        function onMouseMove(e) {
            if (!resizing) return;
            const delta = e.clientX - startX;
            const bounds = getPanelWidthBounds();
            const nextWidth = clamp(startWidth + delta, bounds.min, bounds.max);
            applyPanelWidth(chatBox, nextWidth);
            keepChatBoxInViewport(chatBox);
        }

        function stopResize() {
            if (!resizing) return;
            resizing = false;
            chatBox.classList.remove("resizing");
            document.body.style.userSelect = "";
            document.body.style.cursor = "";
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", stopResize);
            savePanelWidth(chatBox.getBoundingClientRect().width);
        }

        handle.addEventListener("mousedown", (e) => {
            if (window.matchMedia("(max-width: 1000px)").matches) return;
            e.preventDefault();
            e.stopPropagation();
            resizing = true;
            startX = e.clientX;
            startWidth = chatBox.getBoundingClientRect().width;
            chatBox.classList.add("resizing");
            document.body.style.userSelect = "none";
            document.body.style.cursor = "ew-resize";
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", stopResize);
        });

        if (chatBox.dataset.resizeViewportBound !== "1") {
            window.addEventListener("resize", () => {
                if (!chatBox.classList.contains("agent-integrated")) return;
                const bounds = getPanelWidthBounds();
                const currentWidth = chatBox.getBoundingClientRect().width;
                if (currentWidth > bounds.max) {
                    applyPanelWidth(chatBox, bounds.max);
                }
                keepChatBoxInViewport(chatBox);
            });
            chatBox.dataset.resizeViewportBound = "1";
        }
    }

    function addLog(refs, text, level) {
        if (!refs || !refs.execLog) return;
        refs.execLog.appendChild(createLine(text, level));
        while (refs.execLog.childNodes.length > 150) {
            refs.execLog.removeChild(refs.execLog.firstChild);
        }
        refs.execLog.scrollTop = refs.execLog.scrollHeight;
    }

    function setValue(selector, value) {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    function clickEl(selector) {
        const el = document.querySelector(selector);
        if (!el || typeof el.click !== "function") return false;
        el.click();
        return true;
    }

    function switchView(viewId) {
        if (window.viewManager && typeof window.viewManager.showView === "function") {
            window.viewManager.showView(viewId);
            return true;
        }
        return clickEl(`.nav-btn[data-target="${viewId}"]`);
    }

    function normalizeLocationKeyword(text) {
        return String(text || "")
            .trim()
            .replace(/\s+/g, "")
            .replace(/[，。、“”‘’!！?？]/g, "");
    }

    function extractLocationKeyword(command) {
        const text = String(command || "");
        if (!text) return "";
        const trimmed = text.trim();
        const nonLocationTerms = ["首页", "主界面", "模型", "模型输出", "可视化", "数据可视化", "风场", "风场数据", "分析", "排放率", "关于我们"];
        if (nonLocationTerms.includes(trimmed)) return "";

        const knownKeywords = [
            "黄骅市",
            "黄骅",
            "任丘",
            "南阳",
            "大港油田",
            "中海石油中捷石化有限公司",
            "河南油田分公司第二采油厂"
        ];

        for (let i = 0; i < knownKeywords.length; i += 1) {
            if (text.includes(knownKeywords[i])) return knownKeywords[i];
        }

        const locateMatch = text.match(/(?:定位|飞到|前往|查看|聚焦|锁定)\s*(?:到)?\s*([\u4e00-\u9fa5A-Za-z0-9\-]{2,20})/);
        if (locateMatch && locateMatch[1]) {
            return normalizeLocationKeyword(locateMatch[1]);
        }

        if (/^[\u4e00-\u9fa5]{2,10}(?:市)?$/.test(trimmed)) {
            return normalizeLocationKeyword(trimmed);
        }

        return "";
    }

    function actionKey(action) {
        if (!action || !action.type) return "";
        return [
            action.type,
            action.target || "",
            action.selector || "",
            action.value || "",
            action.keyword || "",
            action.ms || ""
        ].join("|");
    }

    function mergeActions(primary, secondary) {
        const result = [];
        const seen = new Set();

        const pushUnique = (action) => {
            const key = actionKey(action);
            if (!key || seen.has(key)) return;
            seen.add(key);
            result.push(action);
        };

        (Array.isArray(primary) ? primary : []).forEach(pushUnique);
        (Array.isArray(secondary) ? secondary : []).forEach(pushUnique);
        return result;
    }

    function focusLocationByKeyword(keyword) {
        const key = normalizeLocationKeyword(keyword);
        if (!key) return false;

        if (window.LocationNavigator && typeof window.LocationNavigator.focusByKeyword === "function") {
            return !!window.LocationNavigator.focusByKeyword(key, { source: "agent-console" });
        }

        const cityInput = document.querySelector("#city");
        const confirmBtn = document.querySelector("#confirmBtn");
        if (cityInput && confirmBtn) {
            cityInput.value = key;
            confirmBtn.click();
            return true;
        }
        return false;
    }

    function parseLocalCommand(text) {
        const command = String(text || "").trim();
        if (!command) return [];

        const actions = [];
        const viewMap = {
            "首页": "main-view",
            "主界面": "main-view",
            "模型": "model-view",
            "模型输出": "model-view",
            "可视化": "visualization-view",
            "数据可视化": "visualization-view",
            "风场": "satellite-view",
            "风场数据": "satellite-view",
            "分析": "analysis-view",
            "排放率": "flux-view",
            "关于我们": "about-view"
        };

        Object.keys(viewMap).some((k) => {
            if (command.includes(k)) {
                actions.push({ type: "switch_view", target: viewMap[k], label: `切换到${k}` });
                return true;
            }
            return false;
        });

        if (command.includes("定位到中国") || command.includes("回到中国")) {
            actions.push({ type: "click", selector: "#btnFlyToChina", label: "定位到中国" });
        }
        if (command.includes("切换影像")) {
            actions.push({ type: "click", selector: "#btnToggleImagery", label: "切换影像图层" });
        }
        if (command.includes("显示地名") || command.includes("隐藏地名") || command.includes("切换地名")) {
            actions.push({ type: "click", selector: "#btnToggleNames", label: "切换地名" });
        }
        if (command.includes("添加标记") || command.includes("加标记")) {
            actions.push({ type: "click", selector: "#btnAddMarker", label: "开启标记模式" });
        }
        if (command.includes("清除标记")) {
            actions.push({ type: "click", selector: "#btnClearMarkers", label: "清除全部标记" });
        }
        if (command.includes("加载") && command.includes("甲烷")) {
            actions.push({ type: "click", selector: "#btnLoadSentinel5PCH4", label: "加载甲烷图层" });
        }
        if ((command.includes("移除") || command.includes("关闭")) && command.includes("甲烷")) {
            actions.push({ type: "click", selector: "#btnRemoveSentinel5PCH4", label: "移除甲烷图层" });
        }

        const lonMatch = command.match(/经度\s*([\-]?\d+(?:\.\d+)?)/i);
        const latMatch = command.match(/纬度\s*([\-]?\d+(?:\.\d+)?)/i);
        if (lonMatch) actions.push({ type: "set_value", selector: "#customLongitude", value: lonMatch[1], label: "设置经度" });
        if (latMatch) actions.push({ type: "set_value", selector: "#customLatitude", value: latMatch[1], label: "设置纬度" });
        if ((lonMatch || latMatch) && /定位|飞到|前往|查看/.test(command)) {
            actions.push({ type: "click", selector: "#customLocateBtn", label: "执行定位" });
        }

        const threshold = command.match(/阈值\s*([0-9]+(?:\.[0-9]+)?)/i);
        if (threshold) {
            actions.push({ type: "set_value", selector: "#thresholdSlider", value: threshold[1], label: "设置阈值" });
        }

        const intensity = command.match(/颜色强度\s*([0-9]+(?:\.[0-9]+)?)/i);
        if (intensity) {
            actions.push({ type: "set_value", selector: "#intensitySlider", value: intensity[1], label: "设置颜色强度" });
        }

        const opacity = command.match(/透明度\s*([0-9]+(?:\.[0-9]+)?)/i);
        if (opacity) {
            actions.push({ type: "set_value", selector: "#opacitySlider", value: opacity[1], label: "设置透明度" });
        }

        const dates = command.match(/(\d{4}-\d{2}-\d{2})/g);
        if (dates && dates.length >= 2) {
            actions.push({ type: "set_value", selector: "#startTime", value: dates[0], label: "设置开始时间" });
            actions.push({ type: "set_value", selector: "#endTime", value: dates[1], label: "设置结束时间" });
            if (/查询|检索|执行/.test(command)) {
                actions.push({ type: "click", selector: "#timeSearchBtn", label: "执行时间查询" });
            }
        }

        if (command.includes("刷新闭环") || command.includes("刷新事件")) {
            actions.push({ type: "refresh_events", label: "刷新闭环事件" });
        }

        const locationKeyword = extractLocationKeyword(command);
        if (locationKeyword) {
            actions.push({
                type: "focus_location",
                keyword: locationKeyword,
                label: `定位到${locationKeyword}`
            });
        }

        return actions;
    }

    async function parseCommand(command, refs) {
        const localActions = parseLocalCommand(command);
        let backendActions = [];

        try {
            const res = await fetch(`${API_BASE}/chat/ui-command`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ command })
            });
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.actions) && data.actions.length > 0) {
                    backendActions = data.actions;
                    addLog(refs, `后端解析成功，动作 ${data.actions.length} 条`);
                }
            }
        } catch (e) {
            addLog(refs, "后端动作解析不可用，切换本地解析", "warn");
        }

        return mergeActions(backendActions, localActions);
    }

    async function executeAction(action, refs) {
        if (!action || !action.type) return false;
        switch (action.type) {
            case "switch_view":
                return switchView(action.target);
            case "click":
                return clickEl(action.selector);
            case "set_value":
                return setValue(action.selector, action.value);
            case "focus_location":
                return focusLocationByKeyword(action.keyword || action.value || action.label || "");
            case "refresh_events":
                await fetchEvents(refs);
                return true;
            case "wait":
                await sleep(Number(action.ms) || 300);
                return true;
            default:
                return false;
        }
    }

    function renderEventDetail(refs, eventItem) {
        if (!refs || !refs.eventDetail) return;
        if (!eventItem) {
            refs.eventDetail.textContent = "点击右侧事件卡片后，这里会展示对应详情与可执行动作。";
            return;
        }

        const actions = Array.isArray(eventItem.actions) ? eventItem.actions : [];
        const actionsHtml = actions.length
            ? actions
                  .slice(-6)
                  .map((a) => `<div>• [${a.stage || "-"}] ${a.action_text || "-"}</div>`)
                  .join("")
            : "<div>• 暂无动作日志</div>";

        refs.eventDetail.innerHTML = `
            <div><strong>${eventItem.location_name || "未知站点"}</strong></div>
            <div>阶段：${stageLabel(eventItem.stage)} | 风险：${String(eventItem.risk_level || "low").toUpperCase()}</div>
            <div>气体：${eventItem.gas_type || "--"} | 事件ID：${eventItem.id || "--"}</div>
            <div style="margin-top:4px;">${eventItem.summary || "无摘要"}</div>
            <div style="margin-top:6px;">最近动作：</div>
            ${actionsHtml}
            <div class="ai-event-actions">
                <button type="button" id="agentEventPromote" ${eventItem.stage === "closed" ? "disabled" : ""}>推进下一阶段</button>
                <button type="button" id="agentEventReload">重新加载详情</button>
            </div>
        `;

        const promoteBtn = refs.eventDetail.querySelector("#agentEventPromote");
        const reloadBtn = refs.eventDetail.querySelector("#agentEventReload");

        if (promoteBtn) {
            promoteBtn.addEventListener("click", () => {
                promoteEventStage(eventItem.id, refs);
            });
        }
        if (reloadBtn) {
            reloadBtn.addEventListener("click", () => {
                openEventDetail(eventItem.id, refs);
            });
        }
    }

    function renderEvents(refs, events) {
        if (!refs || !refs.eventList) return;
        refs.eventList.innerHTML = "";
        if (!Array.isArray(events) || events.length === 0) {
            const empty = document.createElement("div");
            empty.className = "ai-event-item ai-event-empty";
            empty.textContent = "暂无闭环事件";
            refs.eventList.appendChild(empty);
            renderEventDetail(refs, null);
            return;
        }

        events.forEach((ev) => {
            const item = document.createElement("div");
            item.className = `ai-event-item ${state.selectedEventId === ev.id ? "active" : ""}`;
            item.dataset.eventId = ev.id || "";
            item.innerHTML = `
                <div class="ai-event-top">
                    <span class="ai-event-name">${ev.location_name || "未知站点"}</span>
                    <span class="ai-event-stage ${riskClass(ev.risk_level)}">${stageLabel(ev.stage)}</span>
                </div>
                <div class="ai-event-meta">气体: ${ev.gas_type || "--"} | 风险: ${String(ev.risk_level || "low").toUpperCase()}</div>
                <div class="ai-event-meta">${(ev.summary || "").slice(0, 48)}</div>
            `;
            item.addEventListener("click", () => {
                state.selectedEventId = ev.id || "";
                refs.eventList.querySelectorAll(".ai-event-item").forEach((node) => node.classList.remove("active"));
                item.classList.add("active");
                openEventDetail(ev.id, refs);
            });
            refs.eventList.appendChild(item);
        });
    }

    async function updateMetrics(refs) {
        if (!refs || !refs.metricsText) return;
        try {
            const res = await fetch(`${API_BASE}/closed-loop/metrics`, { method: "GET" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const m = data.metrics || {};
            refs.metricsText.textContent = `事件总数 ${m.total_events || 0} | 已闭环 ${m.closed_events || 0} | 闭环率 ${m.close_rate || 0}%`;
        } catch (e) {
            refs.metricsText.textContent = "闭环指标获取失败，请稍后刷新";
        }
    }

    async function openEventDetail(eventId, refs) {
        if (!eventId) return;
        try {
            const res = await fetch(`${API_BASE}/closed-loop/events/${eventId}`, { method: "GET" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.message || `HTTP ${res.status}`);
            }
            renderEventDetail(refs, data.event || {});
        } catch (e) {
            addLog(refs, `读取事件详情失败：${e.message}`, "error");
        }
    }

    async function promoteEventStage(eventId, refs) {
        if (!eventId) return;
        try {
            const res = await fetch(`${API_BASE}/closed-loop/events/${eventId}/transition`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ actor: getOperator(), detail: "chat-workbench promote" })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.message || `HTTP ${res.status}`);
            }
            addLog(refs, `事件 ${eventId} 已推进到 ${stageLabel(data.stage)}`);
            await fetchEvents(refs);
            await openEventDetail(eventId, refs);
            appendChatNotice(refs.chatBody, `闭环事件 ${eventId} 已推进到 ${stageLabel(data.stage)}`);
        } catch (e) {
            addLog(refs, `推进阶段失败：${e.message}`, "error");
        }
    }

    async function fetchEvents(refs) {
        try {
            const res = await fetch(`${API_BASE}/closed-loop/events?limit=8`, { method: "GET" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            state.events = Array.isArray(data.events) ? data.events : [];
            renderEvents(refs, state.events);
            await updateMetrics(refs);

            if (!state.selectedEventId && state.events.length > 0) {
                state.selectedEventId = state.events[0].id || "";
            }
            if (state.selectedEventId) {
                await openEventDetail(state.selectedEventId, refs);
            }
        } catch (e) {
            addLog(refs, `获取闭环事件失败：${e.message}`, "error");
        }
    }

    async function runCommand(command, refs) {
        if (state.running) {
            addLog(refs, "已有任务执行中，请稍后", "warn");
            return;
        }
        const text = String(command || "").trim();
        if (!text) {
            addLog(refs, "请输入执行指令", "warn");
            return;
        }

        const actions = await parseCommand(text, refs);
        if (!Array.isArray(actions) || actions.length === 0) {
            addLog(refs, "未解析到可执行动作，请补充更具体描述", "warn");
            appendChatNotice(refs.chatBody, "我没有识别到可执行动作，请再说具体一点，比如“切换到首页并定位到中国”。");
            return;
        }

        state.running = true;
        state.stopRequested = false;
        addLog(refs, `开始执行：${text}`);
        appendChatNotice(refs.chatBody, `收到执行任务：${text}`);

        for (let i = 0; i < actions.length; i += 1) {
            if (state.stopRequested) {
                addLog(refs, "已停止当前任务", "warn");
                appendChatNotice(refs.chatBody, "执行已停止。你可以继续下达新指令。");
                break;
            }

            const action = actions[i];
            const ok = await executeAction(action, refs);
            const label = action.label || action.type;
            if (ok) {
                addLog(refs, `步骤 ${i + 1}/${actions.length} 成功：${label}`);
            } else {
                addLog(refs, `步骤 ${i + 1}/${actions.length} 失败：${label}`, "error");
            }
            await sleep(260);
        }

        state.running = false;
        await fetchEvents(refs);
    }

    function mountInteractions(chatBox, refs) {
        const runBtn = chatBox.querySelector("#agentExecRun");
        const stopBtn = chatBox.querySelector("#agentExecStop");
        const quickList = chatBox.querySelector("#agentQuickList");
        const refreshBtn = chatBox.querySelector("#agentRefreshEvents");
        const sideNav = refs.sideNav;

        if (sideNav) {
            sideNav.addEventListener("click", (e) => {
                const btn = e.target.closest("button[data-tab]");
                if (!btn) return;
                const tab = btn.getAttribute("data-tab") || "chat";
                activateTab(refs, tab);
                if (tab === "events") {
                    fetchEvents(refs);
                }
            });
        }

        if (runBtn) {
            runBtn.addEventListener("click", () => {
                activateTab(refs, "console");
                runCommand(refs.execInput.value, refs);
            });
        }
        if (stopBtn) {
            stopBtn.addEventListener("click", () => {
                state.stopRequested = true;
            });
        }
        if (refreshBtn) {
            refreshBtn.addEventListener("click", () => fetchEvents(refs));
        }
        if (quickList) {
            quickList.addEventListener("click", (e) => {
                const btn = e.target.closest("button[data-cmd]");
                if (!btn) return;
                const cmd = btn.getAttribute("data-cmd") || "";
                refs.execInput.value = cmd;
                activateTab(refs, "console");
                runCommand(cmd, refs);
            });
        }

        if (refs.execInput) {
            refs.execInput.addEventListener("keydown", (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    activateTab(refs, "console");
                    runCommand(refs.execInput.value, refs);
                }
            });
        }

        mountResize(chatBox, refs);
        const aiIcon = document.getElementById("aiAssistantIcon");
        if (aiIcon && aiIcon.dataset.resizeHooked !== "1") {
            aiIcon.addEventListener("click", () => {
                setTimeout(() => keepChatBoxInViewport(chatBox), 0);
            });
            aiIcon.dataset.resizeHooked = "1";
        }
        activateTab(refs, "chat");
        addLog(refs, "已切换为侧边栏导航：左侧按钮，右侧动态内容。");
        addLog(refs, "执行/事件不再堆在同一屏，切换更轻量。", "warn");
        addLog(refs, "支持右侧边缘拖拽缩放，鼠标变为左右箭头。");
    }

    async function bootstrap() {
        hideLegacyPanel();
        const chatBox = await waitForElement("#aiChatBox", 60, 200);
        if (!chatBox) return;

        const refs = ensureLayout(chatBox);
        if (!refs) return;

        mountInteractions(chatBox, refs);
        await fetchEvents(refs);
        setInterval(() => fetchEvents(refs), 30000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bootstrap);
    } else {
        bootstrap();
    }
})();
