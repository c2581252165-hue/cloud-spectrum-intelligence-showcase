// js/ai-assistant.js

// ==============================
// 纭繚 Lottie 鎾斁鍣ㄥ簱鍔犺浇
// ==============================
if (!customElements.get("lottie-player")) {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/@lottiefiles/lottie-player@latest/dist/lottie-player.js";
    document.head.appendChild(script);
}

document.addEventListener("DOMContentLoaded", () => {
    // ========== 鍒涘缓 AI 鍔╂墜鍥炬爣 ==========
    const aiIcon = document.createElement("lottie-player");
    aiIcon.id = "aiAssistantIcon";
    aiIcon.src = "Live chatbot.json";
    aiIcon.background = "transparent";
    aiIcon.speed = "1";
    aiIcon.loop = true;
    aiIcon.autoplay = true;

    aiIcon.style.cssText = `
        width: 110px;
        height: 110px;
        position: fixed;
        bottom: 20px;
        right: 30px;
        cursor: grab;
        z-index: 3000;
        transition: transform 0.2s ease;
        filter: drop-shadow(0 0 8px rgba(0, 243, 255, 0.3));
    `;
    document.body.appendChild(aiIcon);

    aiIcon.addEventListener("mouseenter", () => aiIcon.style.transform = "scale(1.15)");
    aiIcon.addEventListener("mouseleave", () => aiIcon.style.transform = "scale(1)");

    // ========== 鍒涘缓瀵硅瘽妗?==========
    const chatBox = document.createElement("div");
    chatBox.id = "aiChatBox";
    chatBox.style.display = "none";
    document.body.appendChild(chatBox);

    chatBox.innerHTML = `
        <div class="chat-header">
            <div class="chat-header-left">
                <div class="chat-avatar">AI</div>
                <div class="chat-header-info">
                    <span class="chat-title">云谱智探AI</span>
                    <span class="chat-status"><i class="status-dot"></i>在线</span>
                </div>
            </div>
            <div class="chat-header-btns">
                <button class="chat-clear" title="清空对话">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
                </button>
                <button class="chat-close" title="关闭">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
        </div>
        <div class="chat-body"></div>
        <div class="chat-input">
            <input type="text" placeholder="输入问题，按 Enter 发送..." />
            <button class="send-btn" title="发送">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
        </div>
    `;

    Object.assign(chatBox.style, {
        width: "380px",
        height: "520px",
        background: "rgba(8, 16, 32, 0.95)",
        border: "1px solid rgba(0, 243, 255, 0.3)",
        borderRadius: "16px",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6), 0 0 20px rgba(0, 243, 255, 0.15), inset 0 1px 0 rgba(255,255,255,0.05)",
        zIndex: 3100,
        display: "none",
        flexDirection: "column",
        overflow: "hidden",
        position: "fixed",
        backdropFilter: "blur(20px)"
    });

    // ========== 鏍峰紡 ==========
    const style = document.createElement("style");
    style.textContent = `
        @keyframes ai-glow-pulse {
            0%, 100% { box-shadow: 0 0 5px rgba(0,243,255,0.2); }
            50% { box-shadow: 0 0 15px rgba(0,243,255,0.4); }
        }
        @keyframes dot-blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        @keyframes typing-dots {
            0% { content: ''; }
            25% { content: '.'; }
            50% { content: '..'; }
            75% { content: '...'; }
        }
        @keyframes msg-slide-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        #aiChatBox .chat-header {
            background: linear-gradient(135deg, rgba(0, 40, 80, 0.95), rgba(0, 20, 50, 0.95));
            color: #e0f7fa;
            padding: 14px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid rgba(0, 243, 255, 0.2);
            position: relative;
        }
        #aiChatBox .chat-header::after {
            content: '';
            position: absolute;
            bottom: 0; left: 0; right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(0,243,255,0.5), transparent);
        }
        #aiChatBox .chat-header-left {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        #aiChatBox .chat-avatar {
            width: 36px; height: 36px;
            background: linear-gradient(135deg, #00f3ff, #0066ff);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 900;
            font-size: 13px;
            color: #000;
            font-family: 'Orbitron', monospace;
            box-shadow: 0 0 12px rgba(0,243,255,0.3);
        }
        #aiChatBox .chat-header-info {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        #aiChatBox .chat-title {
            font-weight: 700;
            font-size: 14px;
            letter-spacing: 0.5px;
            color: #fff;
        }
        #aiChatBox .chat-status {
            font-size: 11px;
            color: rgba(0, 243, 255, 0.7);
            display: flex;
            align-items: center;
            gap: 4px;
        }
        #aiChatBox .status-dot {
            display: inline-block;
            width: 6px; height: 6px;
            background: #00ff88;
            border-radius: 50%;
            animation: dot-blink 2s infinite;
        }
        #aiChatBox .chat-header-btns {
            display: flex;
            gap: 4px;
        }
        #aiChatBox .chat-header-btns button {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            color: rgba(255,255,255,0.6);
            width: 30px; height: 30px;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }
        #aiChatBox .chat-header-btns button:hover {
            background: rgba(0, 243, 255, 0.15);
            border-color: rgba(0, 243, 255, 0.3);
            color: #00f3ff;
        }

        #aiChatBox .chat-body {
            flex: 1;
            padding: 16px;
            overflow-y: auto;
            background: linear-gradient(180deg, rgba(5,11,20,0.6) 0%, rgba(8,16,32,0.8) 100%);
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        #aiChatBox .chat-body::-webkit-scrollbar {
            width: 4px;
        }
        #aiChatBox .chat-body::-webkit-scrollbar-track {
            background: transparent;
        }
        #aiChatBox .chat-body::-webkit-scrollbar-thumb {
            background: rgba(0, 243, 255, 0.2);
            border-radius: 2px;
        }

        #aiChatBox .chat-message {
            margin-bottom: 0;
            padding: 10px 14px;
            border-radius: 12px;
            max-width: 85%;
            word-wrap: break-word;
            font-size: 13.5px;
            line-height: 1.6;
            animation: msg-slide-in 0.3s ease;
            position: relative;
        }
        #aiChatBox .chat-message.bot {
            background: rgba(0, 50, 100, 0.4);
            border: 1px solid rgba(0, 243, 255, 0.15);
            color: #c8e6f0;
            align-self: flex-start;
            border-bottom-left-radius: 4px;
        }
        #aiChatBox .chat-message.user {
            background: linear-gradient(135deg, rgba(0, 100, 255, 0.3), rgba(0, 60, 180, 0.3));
            border: 1px solid rgba(0, 100, 255, 0.25);
            color: #e0f0ff;
            align-self: flex-end;
            border-bottom-right-radius: 4px;
        }
        #aiChatBox .chat-message.loading {
            background: rgba(0, 50, 80, 0.3);
            border: 1px solid rgba(0, 243, 255, 0.1);
            color: rgba(0, 243, 255, 0.6);
            font-style: italic;
        }

        #aiChatBox .chat-input {
            display: flex;
            border-top: 1px solid rgba(0, 243, 255, 0.15);
            background: rgba(5, 10, 20, 0.8);
            padding: 10px 12px;
            gap: 8px;
            align-items: center;
        }
        #aiChatBox .chat-input input {
            flex: 1;
            padding: 10px 14px;
            border: 1px solid rgba(0, 243, 255, 0.2);
            border-radius: 10px;
            outline: none;
            background: rgba(0, 20, 40, 0.6);
            color: #e0f7fa;
            font-size: 13px;
            font-family: 'Rajdhani', sans-serif;
            transition: border-color 0.3s, box-shadow 0.3s;
        }
        #aiChatBox .chat-input input::placeholder {
            color: rgba(0, 243, 255, 0.3);
        }
        #aiChatBox .chat-input input:focus {
            border-color: rgba(0, 243, 255, 0.5);
            box-shadow: 0 0 10px rgba(0, 243, 255, 0.1);
        }
        #aiChatBox .chat-input .send-btn {
            background: linear-gradient(135deg, #00f3ff, #0066ff);
            color: #000;
            border: none;
            width: 38px; height: 38px;
            border-radius: 10px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s;
            flex-shrink: 0;
        }
        #aiChatBox .chat-input .send-btn:hover {
            box-shadow: 0 0 15px rgba(0, 243, 255, 0.4);
            transform: scale(1.05);
        }
        #aiChatBox .chat-input .send-btn:disabled {
            opacity: 0.3;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }

        /* ======= AI 鍥炬爣姘旀场鎻愮ず鏍峰紡 ======= */
        .ai-bubble {
            position: fixed;
            background: rgba(8, 16, 32, 0.95);
            border: 1px solid rgba(0, 243, 255, 0.4);
            border-radius: 10px;
            padding: 8px 14px;
            color: #00f3ff;
            font-size: 13px;
            white-space: nowrap;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 0 10px rgba(0,243,255,0.15);
            z-index: 4000;
            opacity: 0;
            transform: translateY(-10px);
            transition: opacity 0.3s ease, transform 0.3s ease;
            backdrop-filter: blur(10px);
        }
    `;
    document.head.appendChild(style);

    const sendBtn = chatBox.querySelector(".send-btn");
    const input = chatBox.querySelector("input");
    const chatBody = chatBox.querySelector(".chat-body");

    // ========== 娑堟伅鏄剧ず閫昏緫 ==========
    function appendMessage(text, sender, save = true) {
        const msgDiv = document.createElement("div");
        const cleanSender = sender.replace(' loading', '');
        const isLoading = sender.includes('loading');
        msgDiv.className = `chat-message ${cleanSender}${isLoading ? ' loading' : ''}`;
        msgDiv.textContent = text;
        chatBody.appendChild(msgDiv);
        chatBody.scrollTop = chatBody.scrollHeight;
        if (save && !isLoading) saveChatHistory();
        return msgDiv;
    }

    // ========== 涓存椂璁板繂鍔熻兘锛坙ocalStorage锛?==========
    function loadChatHistory() {
        const saved = localStorage.getItem("aiChatHistoryV2");
        const hasMojibake = (text = "") => /[锛鈥鉂鈿鐑鍦鏅鎬]/.test(String(text));
        const hasOutdatedAssistantIntro = (text = "") => {
            const content = String(text || "");
            const looksLikeOldIntro = (content.includes("智能助手") || content.includes("当前接入的是"))
                && !content.includes("云谱智探");
            return looksLikeOldIntro;
        };

        if (!saved) {
            appendMessage("你好，我是云谱智探AI，可以为你解答监测与排放相关问题。", "bot", false);
            return;
        }

        try {
            const messages = JSON.parse(saved);
            const invalid = !Array.isArray(messages)
                || messages.some(msg =>
                    hasMojibake(msg?.text)
                    || hasMojibake(msg?.sender)
                    || (msg?.sender === "bot" && hasOutdatedAssistantIntro(msg?.text))
                );

            if (invalid) {
                localStorage.removeItem("aiChatHistoryV2");
                appendMessage("你好，我是云谱智探AI，可以为你解答监测与排放相关问题。", "bot", false);
                return;
            }

            messages.forEach(msg => appendMessage(msg.text, msg.sender, false));
        } catch {
            localStorage.removeItem("aiChatHistoryV2");
            appendMessage("你好，我是云谱智探AI，可以为你解答监测与排放相关问题。", "bot", false);
        }
    }

    function saveChatHistory() {
        const messages = [];
        chatBody.querySelectorAll(".chat-message").forEach(el => {
            messages.push({
                text: el.textContent,
                sender: el.classList.contains("user") ? "user" : "bot"
            });
        });
        localStorage.setItem("aiChatHistoryV2", JSON.stringify(messages));
    }

    // ====== 鏂板锛氭皵娉℃彁绀哄姛鑳?======
    function showBubbleMessage(text) {
        const bubble = document.createElement("div");
        bubble.className = "ai-bubble";
        bubble.textContent = text;
        document.body.appendChild(bubble);

        const rect = aiIcon.getBoundingClientRect();
        bubble.style.left = `${rect.right - 30}px`;   // 浠?+10 鏀逛负 -40 鈫?鏇撮潬宸?
        bubble.style.top = `${rect.top - 5}px`;      // 浠?-15 鏀逛负 -20 鈫?鏇撮潬涓?


        requestAnimationFrame(() => {
            bubble.style.opacity = "1";
            bubble.style.transform = "translateY(0)";
        });

        setTimeout(() => {
            bubble.style.opacity = "0";
            bubble.style.transform = "translateY(-10px)";
            setTimeout(() => bubble.remove(), 300);
        }, 2500);
    }

    // ====== 娓呯┖閫昏緫澧炲己 ======
    function clearChatHistory() {
        const saved = localStorage.getItem("aiChatHistoryV2");
        if (!saved || JSON.parse(saved).length === 0) {
            showBubbleMessage("已经是最新记录，无需清空。");
            return;
        }
        localStorage.removeItem("aiChatHistoryV2");
        chatBody.innerHTML = "";
        appendMessage("记忆已清空，请问有什么可以帮您？", "bot", false);
    }

    loadChatHistory(); // 椤甸潰鍔犺浇鏃舵仮澶嶅巻鍙?

    // ========== 鎷栨嫿閫昏緫 ==========
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    function updateChatBoxPosition() {
        const iconRect = aiIcon.getBoundingClientRect();
        chatBox.style.left = `${iconRect.left}px`;
        chatBox.style.top = `${iconRect.top - chatBox.offsetHeight - 10}px`;
        chatBox.style.right = "auto";
        chatBox.style.bottom = "auto";
    }

    aiIcon.addEventListener("mousedown", (e) => {
        isDragging = true;
        aiIcon.style.cursor = "grabbing";
        const iconRect = aiIcon.getBoundingClientRect();
        offsetX = e.clientX - iconRect.left;
        offsetY = e.clientY - iconRect.top;
    });

    document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        const newLeft = e.clientX - offsetX;
        const newTop = e.clientY - offsetY;
        aiIcon.style.left = `${newLeft}px`;
        aiIcon.style.top = `${newTop}px`;
        aiIcon.style.right = "auto";
        aiIcon.style.bottom = "auto";
        if (chatBox.style.display === "flex") {
            updateChatBoxPosition();
        }
    });

    document.addEventListener("mouseup", () => {
        isDragging = false;
        aiIcon.style.cursor = "grab";
    });

    // ========== 鏄剧ず/闅愯棌瀵硅瘽妗?==========
    aiIcon.addEventListener("click", () => {
        if (chatBox.style.display === "flex") {
            chatBox.style.display = "none";
        } else {
            chatBox.style.display = "flex";
            updateChatBoxPosition();
        }
    });

    chatBox.querySelector(".chat-close").addEventListener("click", () => {
        chatBox.style.display = "none";
    });

    chatBox.querySelector(".chat-clear").addEventListener("click", clearChatHistory);

    // ========== 娑堟伅鍙戦€佸姛鑳?==========
    function sendMessage() {
        const text = input.value.trim();
        if (!text) return;
        appendMessage(text, "user");
        input.value = "";

        const loadingMsg = appendMessage("正在思考中...", "bot loading");

        sendBtn.disabled = true;

        fetch("http://127.0.0.1:5000/chat/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text })
        })
            .then(async response => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    const msg = data.reply || data.message || `服务错误：${response.status}`;
                    throw new Error(msg);
                }
                return data;
            })
            .then(data => {
                if (loadingMsg?.parentNode) loadingMsg.remove();
                appendMessage(data.reply || "未获取到有效回复", "bot");
            })
            .catch(err => {
                if (loadingMsg?.parentNode) loadingMsg.remove();
                appendMessage(`发送失败：${err.message}`, "bot");
            })
            .finally(() => {
                sendBtn.disabled = false;
            });
    }

    sendBtn.addEventListener("click", sendMessage);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") sendMessage();
    });
});


