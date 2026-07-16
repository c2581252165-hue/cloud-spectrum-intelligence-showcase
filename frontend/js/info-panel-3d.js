// ============================================================
//  info-panel-3d.js — 科技感3D信息标牌
//  功能：CSS3D渲染的悬浮信息窗，展开动画 + 滚动数字
//  "唰"的由线变面展开效果
// ============================================================
(function () {
    'use strict';

    // ===== 配置 =====
    const CONFIG = {
        // 动画时长
        animation: {
            expandDuration: 600,      // 展开动画时长 (ms)
            numberRollDuration: 1200, // 数字滚动时长 (ms)
            updateInterval: 50,       // 数字更新间隔 (ms)
            pulseInterval: 2000       // 脉冲动画周期 (ms)
        },
        // 面板尺寸
        panel: {
            width: 320,
            height: 200,
            offsetY: 150    // 距离地面高度 (米)
        },
        // 预警阈值
        thresholds: {
            CH4: { warning: 2000, critical: 2500 },   // ppb
            CO: { warning: 500, critical: 800 },      // ppb
            N2O: { warning: 330, critical: 350 }      // ppb
        },
        // 默认值
        defaults: {
            CH4: 1856,
            CO: 420,
            N2O: 324
        }
    };

    // ===== 状态 =====
    let panelEntity = null;
    let panelElement = null;
    let isVisible = false;
    let currentPosition = null;
    let animationFrameId = null;
    let numberAnimations = {};

    // Cesium相关
    let viewer = null;

    // ============================================================
    //  公共 API
    // ============================================================
    window.InfoPanel3D = window.InfoPanel3D || {};

    /**
     * 初始化3D信息标牌
     * @param {Cesium.Viewer} cesiumViewer
     */
    InfoPanel3D.init = function (cesiumViewer) {
        viewer = cesiumViewer || window.viewer;
        if (!viewer) {
            console.error('[InfoPanel3D] Cesium viewer未初始化');
            return false;
        }

        // 创建面板容器
        createPanelElement();

        console.log('[InfoPanel3D] 科技感信息标牌初始化完成');
        return true;
    };

    /**
     * 在指定位置展开信息标牌
     * @param {Object} options
     * @param {number} options.lon - 经度
     * @param {number} options.lat - 纬度  
     * @param {Object} [options.data] - 浓度数据 {CH4, CO, N2O}
     * @param {boolean} [options.animated=true] - 是否播放展开动画
     */
    InfoPanel3D.show = function (options) {
        const { lon, lat, data = {}, animated = true } = options;

        if (!viewer) {
            if (!InfoPanel3D.init()) return;
        }

        currentPosition = { lon, lat };

        // 合并默认数据
        const displayData = {
            CH4: data.CH4 ?? CONFIG.defaults.CH4,
            CO: data.CO ?? CONFIG.defaults.CO,
            N2O: data.N2O ?? CONFIG.defaults.N2O
        };

        // 更新面板内容
        updatePanelContent(displayData);

        // 定位面板
        positionPanel(lon, lat);

        // 播放展开动画
        if (animated) {
            playExpandAnimation(displayData);
        } else {
            showPanelImmediate(displayData);
        }

        isVisible = true;
        startTrackingLoop();
    };

    /**
     * 更新面板数据 (带滚动动画)
     * @param {Object} data - {CH4, CO, N2O}
     */
    InfoPanel3D.update = function (data) {
        if (!isVisible || !panelElement) return;

        Object.keys(data).forEach(key => {
            if (data[key] !== undefined) {
                animateNumber(key, data[key]);
            }
        });
    };

    /**
     * 隐藏并收起面板
     * @param {boolean} [animated=true]
     */
    InfoPanel3D.hide = function (animated = true) {
        if (!panelElement) return;

        if (animated) {
            playCollapseAnimation();
        } else {
            panelElement.style.display = 'none';
        }

        isVisible = false;
        stopTrackingLoop();
    };

    /**
     * 销毁面板
     */
    InfoPanel3D.destroy = function () {
        InfoPanel3D.hide(false);
        if (panelElement && panelElement.parentNode) {
            panelElement.parentNode.removeChild(panelElement);
        }
        panelElement = null;
        panelEntity = null;
    };

    // ============================================================
    //  面板创建
    // ============================================================

    function createPanelElement() {
        // 移除已存在的面板
        const existing = document.getElementById('info-panel-3d');
        if (existing) existing.remove();

        // 创建面板DOM
        panelElement = document.createElement('div');
        panelElement.id = 'info-panel-3d';
        panelElement.className = 'info-panel-3d';
        panelElement.innerHTML = `
            <div class="panel-container">
                <!-- 展开线条动画层 -->
                <div class="expand-line"></div>
                
                <!-- 主面板 -->
                <div class="panel-main">
                    <!-- 顶部装饰条 -->
                    <div class="panel-header">
                        <div class="header-line left"></div>
                        <div class="header-icon">◆</div>
                        <div class="header-line right"></div>
                    </div>
                    
                    <!-- 标题 -->
                    <div class="panel-title">
                        <span class="title-text">实时气体浓度监测</span>
                        <span class="title-badge">LIVE</span>
                    </div>
                    
                    <!-- 数据行 -->
                    <div class="data-rows">
                        <div class="data-row" data-gas="CH4">
                            <div class="gas-label">
                                <span class="gas-icon">⬡</span>
                                <span class="gas-name">CH₄</span>
                            </div>
                            <div class="gas-value">
                                <span class="value-number" id="value-CH4">----</span>
                                <span class="value-unit">ppb</span>
                            </div>
                            <div class="status-indicator" id="status-CH4"></div>
                        </div>
                        
                        <div class="data-row" data-gas="CO">
                            <div class="gas-label">
                                <span class="gas-icon">⬡</span>
                                <span class="gas-name">CO</span>
                            </div>
                            <div class="gas-value">
                                <span class="value-number" id="value-CO">----</span>
                                <span class="value-unit">ppb</span>
                            </div>
                            <div class="status-indicator" id="status-CO"></div>
                        </div>
                        
                        <div class="data-row" data-gas="N2O">
                            <div class="gas-label">
                                <span class="gas-icon">⬡</span>
                                <span class="gas-name">N₂O</span>
                            </div>
                            <div class="gas-value">
                                <span class="value-number" id="value-N2O">----</span>
                                <span class="value-unit">ppb</span>
                            </div>
                            <div class="status-indicator" id="status-N2O"></div>
                        </div>
                    </div>
                    
                    <!-- 底部信息 -->
                    <div class="panel-footer">
                        <span class="footer-time" id="panel-time">--:--:--</span>
                        <span class="footer-coord" id="panel-coord">---, ---</span>
                    </div>
                </div>
                
                <!-- 连接线 -->
                <div class="connector-line">
                    <svg width="40" height="60" viewBox="0 0 40 60">
                        <path class="connector-path" d="M20,0 L20,45 L20,60" 
                              stroke="url(#connectorGradient)" stroke-width="2" fill="none"/>
                        <defs>
                            <linearGradient id="connectorGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stop-color="#00f3ff" stop-opacity="0.8"/>
                                <stop offset="100%" stop-color="#00f3ff" stop-opacity="0.2"/>
                            </linearGradient>
                        </defs>
                    </svg>
                    <div class="connector-dot"></div>
                </div>
            </div>
        `;

        // 添加样式
        injectStyles();

        // 添加到页面
        document.body.appendChild(panelElement);

        // 初始隐藏
        panelElement.style.display = 'none';
    }

    function injectStyles() {
        if (document.getElementById('info-panel-3d-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'info-panel-3d-styles';
        styles.textContent = `
            .info-panel-3d {
                position: fixed;
                z-index: 10000;
                pointer-events: none;
                transform-style: preserve-3d;
                perspective: 1000px;
            }

            .panel-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                transform-origin: center bottom;
            }

            /* ===== 展开线条 ===== */
            .expand-line {
                position: absolute;
                top: 50%;
                left: 50%;
                width: 2px;
                height: 100%;
                background: linear-gradient(180deg, 
                    transparent 0%, 
                    #00f3ff 20%, 
                    #00f3ff 80%, 
                    transparent 100%);
                transform: translate(-50%, -50%) scaleY(0);
                opacity: 0;
                box-shadow: 0 0 10px #00f3ff, 0 0 20px #00f3ff;
            }

            .expand-line.animate {
                animation: lineExpand 0.3s ease-out forwards;
            }

            @keyframes lineExpand {
                0% { transform: translate(-50%, -50%) scaleY(0); opacity: 0; }
                50% { transform: translate(-50%, -50%) scaleY(1); opacity: 1; }
                100% { transform: translate(-50%, -50%) scaleY(0); opacity: 0; }
            }

            /* ===== 主面板 ===== */
            .panel-main {
                width: ${CONFIG.panel.width}px;
                background: linear-gradient(135deg, 
                    rgba(0, 20, 40, 0.95) 0%, 
                    rgba(0, 40, 60, 0.9) 100%);
                border: 1px solid rgba(0, 243, 255, 0.4);
                border-radius: 8px;
                padding: 12px 16px;
                box-shadow: 
                    0 0 20px rgba(0, 243, 255, 0.3),
                    inset 0 0 30px rgba(0, 243, 255, 0.05);
                backdrop-filter: blur(10px);
                transform: scaleY(0) scaleX(0.1);
                transform-origin: center bottom;
                opacity: 0;
                transition: none;
            }

            .panel-main.show {
                animation: panelExpand 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
                animation-delay: 0.15s;
            }

            .panel-main.hide {
                animation: panelCollapse 0.3s ease-in forwards;
            }

            @keyframes panelExpand {
                0% { 
                    transform: scaleY(0) scaleX(0.1); 
                    opacity: 0; 
                }
                40% { 
                    transform: scaleY(0.1) scaleX(1); 
                    opacity: 0.8; 
                }
                100% { 
                    transform: scaleY(1) scaleX(1); 
                    opacity: 1; 
                }
            }

            @keyframes panelCollapse {
                0% { transform: scaleY(1) scaleX(1); opacity: 1; }
                60% { transform: scaleY(0.1) scaleX(1); opacity: 0.8; }
                100% { transform: scaleY(0) scaleX(0.1); opacity: 0; }
            }

            /* ===== 顶部装饰 ===== */
            .panel-header {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 8px;
            }

            .header-line {
                flex: 1;
                height: 1px;
                background: linear-gradient(90deg, 
                    transparent, 
                    rgba(0, 243, 255, 0.6), 
                    transparent);
            }

            .header-icon {
                color: #00f3ff;
                font-size: 10px;
                margin: 0 8px;
                animation: iconPulse 2s ease-in-out infinite;
            }

            @keyframes iconPulse {
                0%, 100% { opacity: 0.6; transform: scale(1); }
                50% { opacity: 1; transform: scale(1.2); }
            }

            /* ===== 标题 ===== */
            .panel-title {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
                padding-bottom: 8px;
                border-bottom: 1px solid rgba(0, 243, 255, 0.2);
            }

            .title-text {
                color: #fff;
                font-size: 13px;
                font-weight: 500;
                letter-spacing: 1px;
                text-shadow: 0 0 10px rgba(0, 243, 255, 0.5);
            }

            .title-badge {
                background: linear-gradient(90deg, #ff3366, #ff6633);
                color: #fff;
                font-size: 9px;
                font-weight: bold;
                padding: 2px 6px;
                border-radius: 3px;
                animation: badgePulse 1s ease-in-out infinite;
            }

            @keyframes badgePulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.6; }
            }

            /* ===== 数据行 ===== */
            .data-rows {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .data-row {
                display: flex;
                align-items: center;
                padding: 6px 8px;
                background: rgba(0, 243, 255, 0.05);
                border-radius: 4px;
                border-left: 3px solid rgba(0, 243, 255, 0.3);
                transition: all 0.3s ease;
            }

            .data-row:hover {
                background: rgba(0, 243, 255, 0.1);
            }

            .data-row.warning {
                border-left-color: #ffcc00;
                background: rgba(255, 204, 0, 0.1);
            }

            .data-row.critical {
                border-left-color: #ff3366;
                background: rgba(255, 51, 102, 0.1);
                animation: criticalPulse 1s ease-in-out infinite;
            }

            @keyframes criticalPulse {
                0%, 100% { background: rgba(255, 51, 102, 0.1); }
                50% { background: rgba(255, 51, 102, 0.2); }
            }

            .gas-label {
                display: flex;
                align-items: center;
                width: 70px;
            }

            .gas-icon {
                color: #00f3ff;
                font-size: 12px;
                margin-right: 6px;
            }

            .gas-name {
                color: #8cf;
                font-size: 13px;
                font-weight: 500;
            }

            .gas-value {
                flex: 1;
                text-align: right;
                padding-right: 12px;
            }

            .value-number {
                color: #fff;
                font-size: 18px;
                font-weight: bold;
                font-family: 'Consolas', 'Monaco', monospace;
                text-shadow: 0 0 8px rgba(0, 243, 255, 0.6);
                letter-spacing: 1px;
            }

            .value-unit {
                color: #6cf;
                font-size: 11px;
                margin-left: 4px;
                opacity: 0.8;
            }

            .status-indicator {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #00ff88;
                box-shadow: 0 0 6px #00ff88;
            }

            .status-indicator.warning {
                background: #ffcc00;
                box-shadow: 0 0 6px #ffcc00;
            }

            .status-indicator.critical {
                background: #ff3366;
                box-shadow: 0 0 6px #ff3366;
                animation: statusBlink 0.5s ease-in-out infinite;
            }

            @keyframes statusBlink {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.3; }
            }

            /* ===== 底部信息 ===== */
            .panel-footer {
                display: flex;
                justify-content: space-between;
                margin-top: 10px;
                padding-top: 8px;
                border-top: 1px solid rgba(0, 243, 255, 0.15);
                font-size: 10px;
                color: #6cf;
                opacity: 0.8;
            }

            .footer-time {
                font-family: 'Consolas', monospace;
            }

            /* ===== 连接线 ===== */
            .connector-line {
                display: flex;
                flex-direction: column;
                align-items: center;
                margin-top: -2px;
                opacity: 0;
                transform: scaleY(0);
                transform-origin: top center;
            }

            .connector-line.show {
                animation: connectorGrow 0.3s ease-out forwards;
                animation-delay: 0.5s;
            }

            @keyframes connectorGrow {
                0% { transform: scaleY(0); opacity: 0; }
                100% { transform: scaleY(1); opacity: 1; }
            }

            .connector-path {
                stroke-dasharray: 60;
                stroke-dashoffset: 60;
            }

            .connector-line.show .connector-path {
                animation: drawLine 0.4s ease-out forwards;
                animation-delay: 0.55s;
            }

            @keyframes drawLine {
                to { stroke-dashoffset: 0; }
            }

            .connector-dot {
                width: 8px;
                height: 8px;
                background: #00f3ff;
                border-radius: 50%;
                box-shadow: 0 0 10px #00f3ff, 0 0 20px #00f3ff;
                margin-top: -4px;
                opacity: 0;
            }

            .connector-line.show .connector-dot {
                animation: dotAppear 0.3s ease-out forwards;
                animation-delay: 0.8s;
            }

            @keyframes dotAppear {
                0% { opacity: 0; transform: scale(0); }
                50% { transform: scale(1.5); }
                100% { opacity: 1; transform: scale(1); }
            }

            /* ===== 扫描线效果 ===== */
            .panel-main::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 2px;
                background: linear-gradient(90deg, 
                    transparent 0%, 
                    rgba(0, 243, 255, 0.8) 50%, 
                    transparent 100%);
                opacity: 0;
            }

            .panel-main.show::before {
                animation: scanLine 2s ease-in-out infinite;
                animation-delay: 1s;
            }

            @keyframes scanLine {
                0% { top: 0; opacity: 0; }
                10% { opacity: 0.8; }
                90% { opacity: 0.8; }
                100% { top: 100%; opacity: 0; }
            }

            /* ===== 数字滚动效果 ===== */
            .value-number.rolling {
                animation: numberRoll 0.1s ease-out;
            }

            @keyframes numberRoll {
                0% { transform: translateY(-2px); opacity: 0.7; }
                100% { transform: translateY(0); opacity: 1; }
            }
        `;

        document.head.appendChild(styles);
    }

    // ============================================================
    //  位置追踪
    // ============================================================

    function positionPanel(lon, lat) {
        if (!panelElement || !viewer) return;

        const position = Cesium.Cartesian3.fromDegrees(
            lon, lat, CONFIG.panel.offsetY
        );

        // 转换为屏幕坐标
        const screenPos = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
            viewer.scene, position
        );

        if (screenPos) {
            panelElement.style.left = `${screenPos.x - CONFIG.panel.width / 2}px`;
            panelElement.style.top = `${screenPos.y - CONFIG.panel.height - 60}px`;
        }
    }

    function startTrackingLoop() {
        stopTrackingLoop();

        const track = () => {
            if (!isVisible || !currentPosition) return;

            positionPanel(currentPosition.lon, currentPosition.lat);
            updateTime();

            animationFrameId = requestAnimationFrame(track);
        };

        animationFrameId = requestAnimationFrame(track);
    }

    function stopTrackingLoop() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
    }

    // ============================================================
    //  动画效果
    // ============================================================

    function playExpandAnimation(data) {
        if (!panelElement) return;

        panelElement.style.display = 'block';

        // 获取动画元素
        const expandLine = panelElement.querySelector('.expand-line');
        const panelMain = panelElement.querySelector('.panel-main');
        const connectorLine = panelElement.querySelector('.connector-line');

        // 重置状态
        expandLine.classList.remove('animate');
        panelMain.classList.remove('show', 'hide');
        connectorLine.classList.remove('show');

        // 强制重绘
        void expandLine.offsetWidth;

        // 1. 播放线条展开
        expandLine.classList.add('animate');

        // 2. 播放面板展开
        setTimeout(() => {
            panelMain.classList.add('show');
            connectorLine.classList.add('show');
        }, 100);

        // 3. 播放数字滚动
        setTimeout(() => {
            Object.keys(data).forEach(key => {
                animateNumber(key, data[key]);
            });
        }, 400);

        // 更新坐标显示
        if (currentPosition) {
            const coordEl = panelElement.querySelector('#panel-coord');
            if (coordEl) {
                coordEl.textContent = `${currentPosition.lon.toFixed(4)}°, ${currentPosition.lat.toFixed(4)}°`;
            }
        }
    }

    function playCollapseAnimation() {
        if (!panelElement) return;

        const panelMain = panelElement.querySelector('.panel-main');
        const connectorLine = panelElement.querySelector('.connector-line');

        panelMain.classList.remove('show');
        panelMain.classList.add('hide');
        connectorLine.classList.remove('show');

        setTimeout(() => {
            panelElement.style.display = 'none';
            panelMain.classList.remove('hide');
        }, 350);
    }

    function showPanelImmediate(data) {
        if (!panelElement) return;

        panelElement.style.display = 'block';

        const panelMain = panelElement.querySelector('.panel-main');
        const connectorLine = panelElement.querySelector('.connector-line');

        panelMain.style.transform = 'scaleY(1) scaleX(1)';
        panelMain.style.opacity = '1';
        connectorLine.style.transform = 'scaleY(1)';
        connectorLine.style.opacity = '1';

        Object.keys(data).forEach(key => {
            setNumberValue(key, data[key]);
        });
    }

    // ============================================================
    //  数字滚动动画
    // ============================================================

    function animateNumber(gasType, targetValue) {
        const valueEl = document.getElementById(`value-${gasType}`);
        if (!valueEl) return;

        // 取消之前的动画
        if (numberAnimations[gasType]) {
            clearInterval(numberAnimations[gasType]);
        }

        const startValue = parseFloat(valueEl.textContent) || 0;
        const diff = targetValue - startValue;
        const steps = Math.ceil(CONFIG.animation.numberRollDuration / CONFIG.animation.updateInterval);
        let currentStep = 0;

        numberAnimations[gasType] = setInterval(() => {
            currentStep++;
            const progress = easeOutCubic(currentStep / steps);
            const currentValue = startValue + diff * progress;

            setNumberValue(gasType, Math.round(currentValue));
            valueEl.classList.add('rolling');
            setTimeout(() => valueEl.classList.remove('rolling'), 80);

            if (currentStep >= steps) {
                clearInterval(numberAnimations[gasType]);
                setNumberValue(gasType, targetValue);
                updateStatusIndicator(gasType, targetValue);
            }
        }, CONFIG.animation.updateInterval);
    }

    function setNumberValue(gasType, value) {
        const valueEl = document.getElementById(`value-${gasType}`);
        if (valueEl) {
            valueEl.textContent = Math.round(value).toLocaleString();
        }
        updateStatusIndicator(gasType, value);
    }

    function updateStatusIndicator(gasType, value) {
        const row = panelElement?.querySelector(`.data-row[data-gas="${gasType}"]`);
        const indicator = document.getElementById(`status-${gasType}`);
        if (!row || !indicator) return;

        const thresholds = CONFIG.thresholds[gasType];
        if (!thresholds) return;

        // 移除之前的状态类
        row.classList.remove('warning', 'critical');
        indicator.classList.remove('warning', 'critical');

        if (value >= thresholds.critical) {
            row.classList.add('critical');
            indicator.classList.add('critical');
        } else if (value >= thresholds.warning) {
            row.classList.add('warning');
            indicator.classList.add('warning');
        }
    }

    // ============================================================
    //  内容更新
    // ============================================================

    function updatePanelContent(data) {
        // 数据将通过animateNumber更新
    }

    function updateTime() {
        const timeEl = panelElement?.querySelector('#panel-time');
        if (!timeEl) return;

        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];
        timeEl.textContent = timeStr;
    }

    // ============================================================
    //  工具函数
    // ============================================================

    function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    console.log('[InfoPanel3D] 科技感3D信息标牌模块加载完成');
})();
