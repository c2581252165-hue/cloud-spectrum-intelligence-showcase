// ============================================================
// heatmap-canvas.js
// 2D screen-space heatmap rendered in Cesium container coordinates.
// ============================================================
(function () {
    'use strict';

    const CONFIG = {
        colorStops: [
            { value: 0.0, color: [0, 80, 200, 0.3] },
            { value: 0.2, color: [0, 180, 255, 0.4] },
            { value: 0.4, color: [0, 255, 180, 0.5] },
            { value: 0.6, color: [180, 255, 0, 0.6] },
            { value: 0.8, color: [255, 180, 0, 0.75] },
            { value: 1.0, color: [255, 50, 50, 0.9] }
        ],
        render: {
            cellPadding: 2,
            minCellSize: 2,
            maxCellSize: 60,
            fadeInDuration: 800,
            pulseEnabled: true,
            pulsePeriod: 2000,
            glowRadius: 3,
            // When screen projection becomes very small, switch to an overview hotspot earlier.
            overviewSpanPx: 70,
            overviewMinRadius: 10,
            overviewMaxRadius: 46
        }
    };

    let canvas = null;
    let ctx = null;
    let viewer = null;
    let currentData = null;
    let isRunning = false;
    let animationFrameId = null;
    let fadeProgress = 1;
    let fadeStartTime = 0;
    let viewGuardBound = false;

    window.HeatmapCanvas = window.HeatmapCanvas || {};

    HeatmapCanvas.init = function (cesiumViewer) {
        viewer = cesiumViewer || window.viewer;
        if (!viewer) {
            console.error('[HeatmapCanvas] viewer is not ready');
            return false;
        }

        createCanvas();
        bindViewGuard();
        return true;
    };

    HeatmapCanvas.render = function (gridData, options = {}) {
        if (!isMainViewActive()) {
            HeatmapCanvas.clear();
            return;
        }

        if (!viewer && !HeatmapCanvas.init()) return;

        currentData = gridData || null;
        if (!currentData) return;

        if (options.animated !== false) {
            fadeProgress = 0;
            fadeStartTime = performance.now();
        } else {
            fadeProgress = 1;
        }

        start();
    };

    HeatmapCanvas.update = function (newGridData) {
        currentData = newGridData || null;
    };

    HeatmapCanvas.clear = function () {
        stop();
        if (ctx && canvas) {
            const css = getCanvasCssSize();
            ctx.clearRect(0, 0, css.width, css.height);
        }
        currentData = null;
    };

    HeatmapCanvas.stop = function () {
        stop();
    };

    HeatmapCanvas.isActive = function () {
        return Boolean(currentData) && isRunning && isMainViewActive();
    };

    HeatmapCanvas.destroy = function () {
        stop();
        if (canvas && canvas.parentNode) {
            canvas.parentNode.removeChild(canvas);
        }
        canvas = null;
        ctx = null;
    };

    function createCanvas() {
        const existing = document.getElementById('heatmap-canvas');
        if (existing) existing.remove();

        const container = viewer.container || document.getElementById('cesiumContainer');
        if (!container) return;

        canvas = document.createElement('canvas');
        canvas.id = 'heatmap-canvas';
        canvas.style.cssText = [
            'position:absolute',
            'top:0',
            'left:0',
            'width:100%',
            'height:100%',
            'pointer-events:none',
            'z-index:1'
        ].join(';');

        container.appendChild(canvas);
        ctx = canvas.getContext('2d');

        onResize();
        window.addEventListener('resize', onResize);
    }

    function onResize() {
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = getContainerRect();
        const cssWidth = Math.max(1, Math.round(rect.width || window.innerWidth));
        const cssHeight = Math.max(1, Math.round(rect.height || window.innerHeight));

        canvas.width = cssWidth * dpr;
        canvas.height = cssHeight * dpr;
        canvas.style.width = cssWidth + 'px';
        canvas.style.height = cssHeight + 'px';

        if (ctx && typeof ctx.setTransform === 'function') {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(dpr, dpr);
        }
    }

    function start() {
        if (!isMainViewActive()) return;
        if (isRunning) return;
        isRunning = true;
        if (canvas) canvas.style.display = 'block';
        renderLoop();
    }

    function stop() {
        isRunning = false;
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        if (canvas) {
            canvas.style.display = 'none';
        }
    }

    function renderLoop() {
        if (!isRunning || !currentData) return;

        if (!isMainViewActive()) {
            stop();
            if (ctx && canvas) {
                const css = getCanvasCssSize();
                ctx.clearRect(0, 0, css.width, css.height);
            }
            return;
        }

        if (fadeProgress < 1) {
            const elapsed = performance.now() - fadeStartTime;
            fadeProgress = Math.min(1, elapsed / CONFIG.render.fadeInDuration);
        }

        const css = getCanvasCssSize();
        ctx.clearRect(0, 0, css.width, css.height);

        renderHeatmap();
        animationFrameId = requestAnimationFrame(renderLoop);
    }

    function renderHeatmap() {
        if (!currentData || !currentData.grid || !currentData.bounds) return;

        const grid = currentData.grid;
        const bounds = currentData.bounds;
        if (!grid.length || !grid[0]?.length) return;

        const { minVal, maxVal } = calculateRange(grid);
        let boundsScreen = getScreenBounds(bounds);
        if (!boundsScreen) {
            boundsScreen = getScreenBoundsFromGrid(grid);
        }
        if (!boundsScreen) {
            renderOverviewHeatSpot(
                grid,
                bounds,
                minVal,
                maxVal,
                CONFIG.render.overviewSpanPx,
                CONFIG.render.overviewSpanPx
            );
            return;
        }

        const rawWidth = boundsScreen.maxX - boundsScreen.minX;
        const rawHeight = boundsScreen.maxY - boundsScreen.minY;
        const screenWidth = Math.max(0, rawWidth);
        const screenHeight = Math.max(0, rawHeight);

        const rows = grid.length;
        const cols = grid[0].length;

        if (
            rawWidth <= 0 ||
            rawHeight <= 0 ||
            screenWidth < CONFIG.render.overviewSpanPx ||
            screenHeight < CONFIG.render.overviewSpanPx
        ) {
            renderOverviewHeatSpot(grid, bounds, minVal, maxVal, screenWidth, screenHeight);
            return;
        }

        const cellWidth = clamp(screenWidth / cols, CONFIG.render.minCellSize, CONFIG.render.maxCellSize);
        const cellHeight = clamp(screenHeight / rows, CONFIG.render.minCellSize, CONFIG.render.maxCellSize);

        const pulse = CONFIG.render.pulseEnabled
            ? 0.85 + 0.15 * Math.sin((performance.now() % CONFIG.render.pulsePeriod) / CONFIG.render.pulsePeriod * Math.PI * 2)
            : 1;

        for (let i = 0; i < rows; i++) {
            for (let j = 0; j < cols; j++) {
                const cell = grid[i][j];
                const normalized = normalizeValue(cell.value, minVal, maxVal);
                const screenPos = lonLatToScreen(cell.lon, cell.lat);
                if (!screenPos) continue;

                const color = getColorFromValue(
                    normalized,
                    fadeProgress * (normalized > 0.7 ? pulse : 1)
                );

                drawHeatCell(screenPos.x, screenPos.y, cellWidth, cellHeight, color, normalized);
            }
        }
    }

    function drawHeatCell(x, y, width, height, color, intensity) {
        const padding = CONFIG.render.cellPadding;
        const w = Math.max(1, width - padding * 2);
        const h = Math.max(1, height - padding * 2);

        const drawX = x - w / 2;
        const drawY = y - h / 2;

        if (intensity > 0.6) {
            const glowRadius = CONFIG.render.glowRadius * intensity;
            ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a * 0.5})`;
            ctx.shadowBlur = glowRadius;
        } else {
            ctx.shadowBlur = 0;
        }

        ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
        ctx.beginPath();
        roundRect(ctx, drawX, drawY, w, h, 3);
        ctx.fill();

        ctx.shadowBlur = 0;
    }

    function renderOverviewHeatSpot(grid, bounds, minVal, maxVal, screenWidth, screenHeight) {
        const centerLon = (bounds.minLon + bounds.maxLon) / 2;
        const centerLat = (bounds.minLat + bounds.maxLat) / 2;
        const center = lonLatToScreen(centerLon, centerLat, { allowOffscreen: true });
        if (!center) return;

        const css = getCanvasCssSize();
        const cx = clamp(center.x, -64, css.width + 64);
        const cy = clamp(center.y, -64, css.height + 64);

        let peakNormalized = 0;
        for (const row of grid) {
            for (const cell of row) {
                const n = normalizeValue(cell.value, minVal, maxVal);
                if (n > peakNormalized) peakNormalized = n;
            }
        }

        // Far zoom: keep a readable hotspot instead of disappearing.
        const radiusBase = Math.max(screenWidth, screenHeight) * 0.8;
        const radius = clamp(
            radiusBase,
            CONFIG.render.overviewMinRadius,
            CONFIG.render.overviewMaxRadius
        );
        const intensity = clamp(peakNormalized, 0.6, 1);
        const color = getColorFromValue(intensity, fadeProgress);

        const gradient = ctx.createRadialGradient(
            cx,
            cy,
            radius * 0.15,
            cx,
            cy,
            radius
        );
        gradient.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`);
        gradient.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`);

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    function roundRect(context, x, y, w, h, r) {
        context.moveTo(x + r, y);
        context.lineTo(x + w - r, y);
        context.quadraticCurveTo(x + w, y, x + w, y + r);
        context.lineTo(x + w, y + h - r);
        context.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        context.lineTo(x + r, y + h);
        context.quadraticCurveTo(x, y + h, x, y + h - r);
        context.lineTo(x, y + r);
        context.quadraticCurveTo(x, y, x + r, y);
        context.closePath();
    }

    function lonLatToScreen(lon, lat, options = {}) {
        if (!viewer || !canvas) return null;

        const position = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
        const canvasPos = viewer.scene.cartesianToCanvasCoordinates(position);
        if (!canvasPos) return null;

        const localX = canvasPos.x;
        const localY = canvasPos.y;
        if (!Number.isFinite(localX) || !Number.isFinite(localY)) return null;

        const allowOffscreen = options.allowOffscreen === true;
        if (!allowOffscreen) {
            const css = getCanvasCssSize();
            if (localX < -50 || localX > css.width + 50 || localY < -50 || localY > css.height + 50) {
                return null;
            }
        }

        if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
            return null;
        }

        return { x: localX, y: localY };
    }

    function getScreenBounds(bounds) {
        const corners = [
            { lon: bounds.minLon, lat: bounds.minLat },
            { lon: bounds.maxLon, lat: bounds.minLat },
            { lon: bounds.minLon, lat: bounds.maxLat },
            { lon: bounds.maxLon, lat: bounds.maxLat }
        ];

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        let validCount = 0;

        let lastPoint = null;
        for (const corner of corners) {
            const screen = lonLatToScreen(corner.lon, corner.lat, { allowOffscreen: true });
            if (!screen) continue;
            lastPoint = screen;
            minX = Math.min(minX, screen.x);
            maxX = Math.max(maxX, screen.x);
            minY = Math.min(minY, screen.y);
            maxY = Math.max(maxY, screen.y);
            validCount += 1;
        }

        if (validCount === 0) return null;
        if (validCount === 1 && lastPoint) {
            return {
                minX: lastPoint.x - 0.5,
                maxX: lastPoint.x + 0.5,
                minY: lastPoint.y - 0.5,
                maxY: lastPoint.y + 0.5
            };
        }
        return { minX, maxX, minY, maxY };
    }

    function getScreenBoundsFromGrid(grid) {
        if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0]) || !grid[0].length) {
            return null;
        }

        const rowStep = Math.max(1, Math.floor(grid.length / 8));
        const colStep = Math.max(1, Math.floor(grid[0].length / 8));

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        let validCount = 0;

        for (let i = 0; i < grid.length; i += rowStep) {
            for (let j = 0; j < grid[i].length; j += colStep) {
                const cell = grid[i][j];
                if (!cell) continue;
                const screen = lonLatToScreen(cell.lon, cell.lat, { allowOffscreen: true });
                if (!screen) continue;
                minX = Math.min(minX, screen.x);
                maxX = Math.max(maxX, screen.x);
                minY = Math.min(minY, screen.y);
                maxY = Math.max(maxY, screen.y);
                validCount += 1;
            }
        }

        if (validCount === 0) return null;
        if (validCount === 1) {
            return { minX: minX - 0.5, maxX: maxX + 0.5, minY: minY - 0.5, maxY: maxY + 0.5 };
        }
        return { minX, maxX, minY, maxY };
    }

    function getColorFromValue(normalized, alphaMultiplier = 1) {
        const stops = CONFIG.colorStops;

        let lower = stops[0];
        let upper = stops[stops.length - 1];

        for (let i = 0; i < stops.length - 1; i++) {
            if (normalized >= stops[i].value && normalized <= stops[i + 1].value) {
                lower = stops[i];
                upper = stops[i + 1];
                break;
            }
        }

        const t = (normalized - lower.value) / (upper.value - lower.value || 1);
        const lc = lower.color;
        const uc = upper.color;

        return {
            r: Math.round(lc[0] + t * (uc[0] - lc[0])),
            g: Math.round(lc[1] + t * (uc[1] - lc[1])),
            b: Math.round(lc[2] + t * (uc[2] - lc[2])),
            a: (lc[3] + t * (uc[3] - lc[3])) * alphaMultiplier
        };
    }

    function calculateRange(grid) {
        const values = [];
        for (const row of grid) {
            for (const cell of row) {
                const value = Number(cell?.value);
                if (Number.isFinite(value)) values.push(value);
            }
        }

        if (!values.length) {
            return { minVal: 0, maxVal: 1 };
        }

        values.sort((a, b) => a - b);
        const n = values.length;
        const p05 = values[Math.min(n - 1, Math.max(0, Math.floor((n - 1) * 0.05)))];
        const p95 = values[Math.min(n - 1, Math.max(0, Math.floor((n - 1) * 0.95)))];

        let minVal = Number.isFinite(p05) ? p05 : values[0];
        let maxVal = Number.isFinite(p95) ? p95 : values[n - 1];

        if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || maxVal - minVal < 1e-9) {
            minVal = values[0];
            maxVal = values[n - 1];
        }

        if (maxVal - minVal < 1e-9) {
            const center = values[Math.floor(n / 2)] || 0;
            const delta = Math.max(Math.abs(center) * 0.002, 1e-6);
            minVal = center - delta;
            maxVal = center + delta;
        }

        return { minVal, maxVal };
    }

    function normalizeValue(value, min, max) {
        if (max === min) return 0.5;
        let n = clamp((value - min) / (max - min), 0, 1);
        // Contrast stretch: make mid/high differences more visible.
        n = clamp((n - 0.02) / 0.92, 0, 1);
        n = clamp((n - 0.5) * 1.35 + 0.5, 0, 1);
        n = Math.pow(n, 0.72);
        return clamp(n * 1.05, 0, 1);
    }

    function getContainerRect() {
        const container = (canvas && canvas.parentElement) || viewer?.container;
        return container
            ? container.getBoundingClientRect()
            : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }

    function getCanvasCssSize() {
        if (!canvas) return { width: window.innerWidth, height: window.innerHeight };
        const width = canvas.clientWidth || parseFloat(canvas.style.width || '0') || window.innerWidth;
        const height = canvas.clientHeight || parseFloat(canvas.style.height || '0') || window.innerHeight;
        return { width, height };
    }

    function isMainViewActive() {
        if (window.viewManager && typeof window.viewManager.getCurrentView === 'function') {
            return window.viewManager.getCurrentView() === 'main-view';
        }
        const activeView = document.querySelector('.view.active');
        return !activeView || activeView.id === 'main-view';
    }

    function bindViewGuard() {
        if (viewGuardBound) return;
        viewGuardBound = true;

        document.addEventListener('viewChanged', (event) => {
            const target = event?.detail?.target;
            if (target && target !== 'main-view') {
                HeatmapCanvas.clear();
            }
        });
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    console.log('[HeatmapCanvas] loaded');
})();

