// ============================================================
// tech-marker.js
// Clean data marker panel aligned with Cesium canvas coordinates.
// ============================================================
(function () {
    'use strict';

    const CONFIG = {
        panel: {
            width: 330,
            height: 276,
            offsetHeight: 60,
            clampPadding: 12
        },
        animation: {
            numberDuration: 900,
            updateStepMs: 24
        },
        thresholds: {
            CH4: { warning: 2000, critical: 2500 },
            CO: { warning: 0.04, critical: 0.08 },
            NO2: { warning: 0.00008, critical: 0.00015 }
        },
        defaults: {
            CH4: null,
            CO: null,
            NO2: null
        }
    };

    let viewer = null;
    let markerEl = null;
    let isVisible = false;
    let trackingId = null;
    let currentPosition = null;
    const numberTimers = {};

    window.TechMarker = window.TechMarker || {};

    TechMarker.init = function (cesiumViewer) {
        viewer = cesiumViewer || window.viewer;
        if (!viewer) return false;
        ensureStyles();
        createMarkerElement();
        return true;
    };

    TechMarker.show = function (options = {}) {
        const lon = Number(options.lon);
        const lat = Number(options.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;

        if (!markerEl && !TechMarker.init()) return;

        const data = {
            CH4: options.data?.CH4 ?? CONFIG.defaults.CH4,
            CO: options.data?.CO ?? CONFIG.defaults.CO,
            NO2: options.data?.NO2 ?? options.data?.N2O ?? CONFIG.defaults.NO2
        };

        currentPosition = {
            lon,
            lat,
            name: options.name || '目标区域'
        };

        updateLocationInfo(currentPosition);
        bindLayerControls();
        markerEl.style.display = 'block';
        markerEl.classList.add('show');
        markerEl.classList.remove('hide');

        if (options.animated !== false) {
            animateTo('CH4', data.CH4);
            animateTo('CO', data.CO);
            animateTo('NO2', data.NO2);
        } else {
            setValue('CH4', data.CH4);
            setValue('CO', data.CO);
            setValue('NO2', data.NO2);
        }

        isVisible = true;
        positionMarker(lon, lat);
        startTracking();
    };

    TechMarker.update = function (data = {}) {
        if (!markerEl || !isVisible) return;
        if (data.CH4 !== undefined) animateTo('CH4', data.CH4);
        if (data.CO !== undefined) animateTo('CO', data.CO);
        if (data.NO2 !== undefined || data.N2O !== undefined) {
            animateTo('NO2', data.NO2 ?? data.N2O);
        }
    };

    TechMarker.hide = function (animated = true) {
        if (!markerEl) return;

        stopTracking();
        isVisible = false;

        Object.keys(numberTimers).forEach((key) => {
            if (numberTimers[key]) {
                clearInterval(numberTimers[key]);
                numberTimers[key] = null;
            }
        });

        if (!animated) {
            markerEl.style.display = 'none';
            markerEl.classList.remove('show', 'hide');
            return;
        }

        markerEl.classList.remove('show');
        markerEl.classList.add('hide');
        setTimeout(() => {
            if (!markerEl) return;
            markerEl.style.display = 'none';
            markerEl.classList.remove('hide');
        }, 280);
    };

    TechMarker.destroy = function () {
        TechMarker.hide(false);
        if (markerEl && markerEl.parentNode) {
            markerEl.parentNode.removeChild(markerEl);
        }
        markerEl = null;
    };

    function createMarkerElement() {
        const existing = document.getElementById('tech-marker');
        if (existing) existing.remove();

        markerEl = document.createElement('div');
        markerEl.id = 'tech-marker';
        markerEl.className = 'tech-marker';
        markerEl.innerHTML = `
            <div class="tm-panel">
                <div class="tm-header">
                    <span class="tm-title">区域温室气体监测</span>
                    <span class="tm-live"><span class="tm-live-dot"></span>LIVE</span>
                </div>
                <div class="tm-location">
                    <div id="tm-name">目标区域</div>
                    <div id="tm-coord">--, --</div>
                </div>
                <div class="tm-layer-switches">
                    <label class="tm-switch-row" for="toggleHeatmapLayer">
                        <span class="tm-switch-label">热力图</span>
                        <input type="checkbox" id="toggleHeatmapLayer" checked />
                    </label>
                    <label class="tm-switch-row" for="toggleParticleLayer">
                        <span class="tm-switch-label">粒子图</span>
                        <input type="checkbox" id="toggleParticleLayer" checked />
                    </label>
                </div>
                <div class="tm-gas-row">
                    <span class="tm-gas-row-label">图层气体</span>
                    <select id="layerGasSelect" class="tm-gas-select">
                        <option value="CH4">CH4</option>
                        <option value="CO">CO</option>
                        <option value="N2O">N2O</option>
                    </select>
                </div>
                <div class="tm-grid">
                    <div class="tm-row" data-gas="CH4">
                        <div class="tm-gas">CH₄</div>
                        <div class="tm-num" id="tm-val-CH4">--</div>
                        <div class="tm-unit">ppb</div>
                        <div class="tm-state" id="tm-state-CH4">无数据</div>
                    </div>
                    <div class="tm-row" data-gas="CO">
                        <div class="tm-gas">CO</div>
                        <div class="tm-num" id="tm-val-CO">--</div>
                        <div class="tm-unit">mol/m²</div>
                        <div class="tm-state" id="tm-state-CO">无数据</div>
                    </div>
                    <div class="tm-row" data-gas="NO2">
                        <div class="tm-gas">NO<sub>2</sub></div>
                        <div class="tm-num" id="tm-val-NO2">--</div>
                        <div class="tm-unit">mol/m²</div>
                        <div class="tm-state" id="tm-state-NO2">无数据</div>
                    </div>
                </div>
                <div class="tm-footer">
                    <span id="tm-time">--:--:--</span>
                    <span>数据源: Sentinel-5P / TROPOMI</span>
                </div>
                <div class="tm-pointer"></div>
            </div>
        `;

        const host = viewer?.container || document.getElementById('cesiumContainer') || document.body;
        host.appendChild(markerEl);
        markerEl.style.display = 'none';
        bindLayerControls();
    }

    function ensureStyles() {
        if (document.getElementById('tech-marker-styles')) return;

        const style = document.createElement('style');
        style.id = 'tech-marker-styles';
        style.textContent = `
            .tech-marker {
                position: absolute;
                z-index: 1000;
                pointer-events: auto;
                left: 0;
                top: 0;
            }
            .tm-panel {
                width: ${CONFIG.panel.width}px;
                height: ${CONFIG.panel.height}px;
                box-sizing: border-box;
                padding: 14px 16px;
                border: 1px solid rgba(0,243,255,0.55);
                border-radius: 12px;
                background: linear-gradient(140deg, rgba(5,20,34,0.95), rgba(8,34,54,0.92));
                color: #d9f7ff;
                backdrop-filter: blur(6px);
                box-shadow: 0 0 24px rgba(0,243,255,0.28);
                transform-origin: center;
                transform: scale(0.92);
                opacity: 0;
                transition: transform 0.25s ease, opacity 0.25s ease;
                position: relative;
            }
            .tech-marker.show .tm-panel {
                transform: scale(1);
                opacity: 1;
            }
            .tech-marker.hide .tm-panel {
                transform: scale(0.94);
                opacity: 0;
            }
            .tm-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
            }
            .tm-title {
                font-size: 14px;
                font-weight: 600;
                letter-spacing: 0.5px;
                color: #ffffff;
            }
            .tm-live {
                font-size: 11px;
                color: #9be8ff;
                display: inline-flex;
                align-items: center;
                gap: 5px;
            }
            .tm-live-dot {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: #1de9b6;
                box-shadow: 0 0 8px #1de9b6;
                animation: tmBlink 1s infinite;
            }
            @keyframes tmBlink {
                0%,100% { opacity: 1; }
                50% { opacity: 0.35; }
            }
            .tm-location {
                display: flex;
                justify-content: space-between;
                color: #92dfff;
                font-size: 12px;
                border-bottom: 1px dashed rgba(146,223,255,0.35);
                padding-bottom: 7px;
                margin-bottom: 8px;
            }
            .tm-layer-switches {
                display: flex;
                gap: 8px;
                margin-bottom: 6px;
            }
            .tm-switch-row {
                flex: 1;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 4px 8px;
                border-radius: 7px;
                background: rgba(133,205,255,0.12);
                border: 1px solid rgba(133,205,255,0.2);
                font-size: 11px;
                color: #e7faff;
                cursor: pointer;
                user-select: none;
            }
            .tm-switch-label {
                letter-spacing: 0.2px;
            }
            .tm-switch-row input[type="checkbox"] {
                width: 14px;
                height: 14px;
                accent-color: #38d7ff;
                cursor: pointer;
            }
            .tm-gas-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
                padding: 4px 8px;
                border-radius: 7px;
                background: rgba(133,205,255,0.10);
                border: 1px solid rgba(133,205,255,0.18);
            }
            .tm-gas-row-label {
                font-size: 11px;
                color: #e7faff;
                letter-spacing: 0.2px;
            }
            .tm-gas-select {
                min-width: 92px;
                height: 24px;
                border-radius: 6px;
                border: 1px solid rgba(100, 207, 255, 0.45);
                background: rgba(6, 26, 42, 0.95);
                color: #e7faff;
                font-size: 11px;
                padding: 0 6px;
                outline: none;
                cursor: pointer;
            }
            .tm-gas-select:focus {
                border-color: #38d7ff;
                box-shadow: 0 0 0 2px rgba(56, 215, 255, 0.22);
            }
            .tm-grid {
                display: grid;
                grid-template-columns: 1fr;
                gap: 8px;
                margin-bottom: 8px;
            }
            .tm-row {
                display: grid;
                grid-template-columns: 58px 1fr 62px 42px;
                align-items: center;
                gap: 8px;
                padding: 6px 8px;
                border-radius: 8px;
                background: rgba(133,205,255,0.08);
            }
            .tm-row.warning { background: rgba(255,193,7,0.16); }
            .tm-row.critical { background: rgba(255,82,82,0.18); }
            .tm-gas {
                color: #bdeeff;
                font-size: 12px;
                font-weight: 600;
            }
            .tm-num {
                color: #ffffff;
                font-size: 18px;
                line-height: 1;
                font-family: Consolas, Monaco, monospace;
                text-shadow: 0 0 10px rgba(157,235,255,0.45);
            }
            .tm-unit {
                color: #8ccde9;
                font-size: 11px;
            }
            .tm-state {
                color: #80ffaa;
                font-size: 11px;
                text-align: right;
            }
            .tm-row.warning .tm-state { color: #ffd166; }
            .tm-row.critical .tm-state { color: #ff8f8f; }
            .tm-footer {
                display: flex;
                justify-content: space-between;
                font-size: 10px;
                color: rgba(180,225,244,0.9);
            }
            .tm-pointer {
                position: absolute;
                left: 50%;
                bottom: -12px;
                width: 18px;
                height: 18px;
                transform: translateX(-50%) rotate(45deg);
                border-right: 1px solid rgba(0,243,255,0.55);
                border-bottom: 1px solid rgba(0,243,255,0.55);
                background: rgba(8,34,54,0.92);
            }
        `;
        document.head.appendChild(style);
    }

    function updateLocationInfo(position) {
        const nameEl = document.getElementById('tm-name');
        const coordEl = document.getElementById('tm-coord');
        if (nameEl) nameEl.textContent = position.name || '目标区域';
        if (coordEl) coordEl.textContent = `${position.lon.toFixed(4)}°E, ${position.lat.toFixed(4)}°N`;
    }

    function bindLayerControls() {
        if (!markerEl || !window.EffectsVisibility || typeof EffectsVisibility.bindControls !== 'function') return;
        EffectsVisibility.bindControls(markerEl);
    }

    function startTracking() {
        stopTracking();
        const loop = () => {
            if (!isVisible || !currentPosition) return;
            positionMarker(currentPosition.lon, currentPosition.lat);
            updateClock();
            trackingId = requestAnimationFrame(loop);
        };
        trackingId = requestAnimationFrame(loop);
    }

    function stopTracking() {
        if (trackingId) {
            cancelAnimationFrame(trackingId);
            trackingId = null;
        }
    }

    function positionMarker(lon, lat) {
        if (!markerEl || !viewer || !viewer.scene) return;

        const cartesian = Cesium.Cartesian3.fromDegrees(lon, lat, CONFIG.panel.offsetHeight);
        const canvasPos = viewer.scene.cartesianToCanvasCoordinates(cartesian);
        if (!canvasPos) return;

        const host = viewer.container || markerEl.parentElement;
        const hostWidth = host?.clientWidth || window.innerWidth;
        const hostHeight = host?.clientHeight || window.innerHeight;

        const rawLeft = canvasPos.x - CONFIG.panel.width / 2;
        const rawTop = canvasPos.y - Math.round(CONFIG.panel.height * 0.58);

        const left = clamp(rawLeft, CONFIG.panel.clampPadding, hostWidth - CONFIG.panel.width - CONFIG.panel.clampPadding);
        const top = clamp(rawTop, CONFIG.panel.clampPadding, hostHeight - CONFIG.panel.height - CONFIG.panel.clampPadding);

        markerEl.style.left = `${left}px`;
        markerEl.style.top = `${top}px`;
    }

    function animateTo(gasType, targetValue) {
        const valEl = document.getElementById(`tm-val-${gasType}`);
        if (!valEl) return;

        const target = Number(targetValue);
        if (!Number.isFinite(target)) {
            setValue(gasType, null);
            return;
        }

        if (numberTimers[gasType]) {
            clearInterval(numberTimers[gasType]);
            numberTimers[gasType] = null;
        }

        const start = Number(String(valEl.textContent).replace(/,/g, '')) || 0;
        const diff = target - start;
        const steps = Math.max(1, Math.round(CONFIG.animation.numberDuration / CONFIG.animation.updateStepMs));
        let i = 0;

        numberTimers[gasType] = setInterval(() => {
            i += 1;
            const t = i / steps;
            const eased = 1 - Math.pow(1 - t, 3);
            const value = start + diff * eased;
            setValue(gasType, value);

            if (i >= steps) {
                clearInterval(numberTimers[gasType]);
                numberTimers[gasType] = null;
                setValue(gasType, target);
            }
        }, CONFIG.animation.updateStepMs);
    }

    function setValue(gasType, value) {
        const valEl = document.getElementById(`tm-val-${gasType}`);
        const rowEl = markerEl?.querySelector(`.tm-row[data-gas="${gasType}"]`);
        const stateEl = document.getElementById(`tm-state-${gasType}`);

        if (!rowEl || !stateEl) return;
        rowEl.classList.remove('warning', 'critical');

        if (!Number.isFinite(Number(value))) {
            if (valEl) valEl.textContent = '--';
            stateEl.textContent = '无数据';
            return;
        }

        const numeric = Number(value);
        if (valEl) valEl.textContent = formatGasValue(gasType, numeric);

        const threshold = CONFIG.thresholds[gasType];
        if (!threshold) {
            stateEl.textContent = '正常';
            return;
        }

        if (numeric >= threshold.critical) {
            rowEl.classList.add('critical');
            stateEl.textContent = '严重';
        } else if (numeric >= threshold.warning) {
            rowEl.classList.add('warning');
            stateEl.textContent = '预警';
        } else {
            stateEl.textContent = '正常';
        }
    }

    function formatGasValue(gasType, value) {
        if (gasType === 'CH4') {
            return Math.round(value).toLocaleString();
        }

        const abs = Math.abs(value);
        if (abs >= 1) return value.toFixed(3);
        if (abs >= 0.01) return value.toFixed(4);
        if (abs >= 0.0001) return value.toFixed(6);
        return value.toExponential(2);
    }

    function updateClock() {
        const clockEl = document.getElementById('tm-time');
        if (!clockEl) return;
        clockEl.textContent = new Date().toTimeString().slice(0, 8);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    console.log('[TechMarker] loaded');
})();
