// ============================================================
// wind-particles.js
// Screen-space wind particles constrained to the active heatmap area.
// ============================================================
(function () {
    'use strict';

    const CONFIG = {
        particle: {
            maxCount: 3000,
            minCount: 500,
            baseSize: 1.5,
            maxSize: 4,
            tailLength: 12,
            maxTailLength: 25,
            baseLife: 100,
            maxLife: 200,
            fadeRate: 0.015
        },
        colormap: {
            stops: [
                [0.0, 220, 80, 50],
                [0.3, 180, 75, 55],
                [0.5, 120, 70, 50],
                [0.7, 60, 85, 50],
                [0.85, 30, 90, 50],
                [1.0, 0, 100, 50]
            ],
            glowIntensity: 0.6,
            saturationBoost: 1.2
        },
        wind: {
            speedMultiplier: 0.8,
            turbulenceScale: 0.15,
            curlNoise: true,
            noiseFrequency: 0.003
        },
        performance: {
            targetFPS: 60,
            adaptiveParticles: true,
            fpsThreshold: 45,
            renderSkipFrames: 0
        },
        zoom: {
            minHeight: 5000,
            maxHeight: 20000000,
            nearSizeScale: 1.9,
            farSizeScale: 0.55,
            nearTailScale: 2.2,
            farTailScale: 0.65,
            nearSpeedScale: 0.72,
            farSpeedScale: 1.35,
            nearAlphaScale: 1.1,
            farAlphaScale: 0.78,
            nearRadiusScale: 1.35,
            farRadiusScale: 0.75,
            nearDensityScale: 1.0,
            farDensityScale: 0.62,
            smoothing: 0.15
        },
        activeArea: {
            margin: 8,
            minVisibleConcentration: 0.005
        }
    };

    let canvas = null;
    let ctx = null;
    let particles = [];
    let isRunning = false;
    let animationFrameId = null;

    let windField = null;
    let concentrationField = null;
    let dataBounds = null;
    let concentrationMin = 0;
    let concentrationMax = 1;

    let screenBounds = null;
    let dataScreenBounds = null;
    let lastDataScreenBounds = null;

    let regionRadius = 200;
    let baseRegionRadius = 200;
    let regionCenter = null;
    let regionLonLat = null;

    let targetParticleCountByZoom = CONFIG.particle.maxCount;
    let viewEventBound = false;

    const zoomRuntime = {
        t: 0.5,
        sizeScale: 1,
        tailScale: 1,
        speedScale: 1,
        alphaScale: 1,
        radiusScale: 1,
        densityScale: 1
    };

    let frameCount = 0;
    let lastFpsTime = 0;
    let currentFps = 60;
    let currentParticleCount = CONFIG.particle.maxCount;

    window.WindParticles = window.WindParticles || {};

    WindParticles.init = function (targetCanvas) {
        if (targetCanvas) {
            canvas = targetCanvas;
        } else {
            const host =
                (window.viewer && window.viewer.container) ||
                document.getElementById('cesiumContainer') ||
                document.getElementById('main-view');

            canvas = (host || document).querySelector('#wind-particles-canvas');
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.id = 'wind-particles-canvas';
                canvas.className = 'wind-particles-canvas';
                if (host) {
                    host.appendChild(canvas);
                } else {
                    document.body.appendChild(canvas);
                }
            }

            document.querySelectorAll('#wind-particles-canvas').forEach((node) => {
                if (node !== canvas) node.remove();
            });
        }

        canvas.style.cssText = [
            'position:absolute',
            'top:0',
            'left:0',
            'width:100%',
            'height:100%',
            'pointer-events:none',
            'z-index:80',
            'mix-blend-mode:screen'
        ].join(';');

        ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });

        resizeCanvas();
        window.addEventListener('resize', debounce(resizeCanvas, 200));
        bindViewChangeOnce();

        return true;
    };

    WindParticles.setData = function (data) {
        if (!data) return;

        windField = data.wind || { u: [], v: [] };
        concentrationField = data.grid || [];
        dataBounds = data.bounds || null;
        recomputeConcentrationRange();

        updateScreenBounds(false);
    };

    WindParticles.start = function (options = {}) {
        if (!canvas || !ctx) {
            if (!WindParticles.init()) return;
        }

        if (!isMainViewActive()) {
            WindParticles.stop(false);
            return;
        }

        if (!concentrationField || !concentrationField.length || !dataBounds) {
            // Enforce: particles only exist when heatmap data exists.
            WindParticles.stop(false);
            return;
        }

        const heatmap2DActive = window.HeatmapCanvas && typeof window.HeatmapCanvas.isActive === 'function'
            ? window.HeatmapCanvas.isActive()
            : true;
        const heatmap3DActive = window.Heatmap3D && typeof window.Heatmap3D.isActive === 'function'
            ? window.Heatmap3D.isActive()
            : false;
        const requireActiveHeatmap =
            !(window.EffectsVisibility && typeof window.EffectsVisibility.isHeatmapEnabled === 'function') ||
            window.EffectsVisibility.isHeatmapEnabled();
        if (requireActiveHeatmap && !heatmap2DActive && !heatmap3DActive) {
            WindParticles.stop(false);
            return;
        }

        if (isRunning) {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            isRunning = false;
            clearCanvas();
            particles = [];
        }

        const {
            centerLon,
            centerLat,
            radius = 200,
            fadeIn = true
        } = options;

        if (Number.isFinite(centerLon) && Number.isFinite(centerLat)) {
            regionLonLat = { lon: centerLon, lat: centerLat };
        } else if (dataBounds) {
            regionLonLat = {
                lon: (dataBounds.minLon + dataBounds.maxLon) / 2,
                lat: (dataBounds.minLat + dataBounds.maxLat) / 2
            };
        }

        updateScreenBounds(false);
        const startRadius = clamp(Number(radius) || 200, 90, 360);
        baseRegionRadius = startRadius;
        regionRadius = startRadius;
        updateRegionCenter();
        if (!regionCenter) {
            WindParticles.stop(false);
            return;
        }

        updateZoomRuntime(true);

        currentParticleCount = Math.max(
            CONFIG.particle.minCount,
            Math.min(CONFIG.particle.maxCount, Math.floor(targetParticleCountByZoom))
        );

        initParticles();

        isRunning = true;
        canvas.style.display = 'block';

        if (fadeIn) {
            canvas.style.opacity = '0';
            setTimeout(() => {
                if (!canvas) return;
                canvas.style.transition = 'opacity 0.8s ease-out';
                canvas.style.opacity = '1';
            }, 50);
        } else {
            canvas.style.opacity = '1';
        }

        lastFpsTime = performance.now();
        frameCount = 0;
        renderLoop();
    };

    WindParticles.stop = function (fadeOut = true) {
        isRunning = false;

        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        if (fadeOut && canvas) {
            canvas.style.transition = 'opacity 0.5s ease-out';
            canvas.style.opacity = '0';
            setTimeout(() => {
                if (!canvas) return;
                canvas.style.display = 'none';
                clearCanvas();
            }, 500);
        } else if (canvas) {
            canvas.style.display = 'none';
            clearCanvas();
        }

        particles = [];
    };

    WindParticles.pause = function () {
        isRunning = false;
    };

    WindParticles.resume = function () {
        if (!isRunning) {
            isRunning = true;
            renderLoop();
        }
    };

    WindParticles.setConfig = function (newConfig) {
        deepMerge(CONFIG, newConfig || {});
    };

    WindParticles.getFPS = function () {
        return Math.round(currentFps);
    };

    WindParticles.getParticleCount = function () {
        return particles.length;
    };

    function initParticles() {
        particles = [];
        updateRegionCenter();

        for (let i = 0; i < currentParticleCount; i++) {
            particles.push(createParticle(true));
        }
    }

    function createParticle(nearCenter = false) {
        let spawn = null;

        if (regionCenter) {
            spawn = randomPointInActiveRegion(nearCenter ? 36 : 20);
        }

        if (!spawn && dataScreenBounds) {
            spawn = {
                x: dataScreenBounds.minX + Math.random() * dataScreenBounds.width,
                y: dataScreenBounds.minY + Math.random() * dataScreenBounds.height
            };
        }

        if (!spawn) {
            const css = getCanvasCssSize();
            spawn = {
                x: css.width * 0.5 + (Math.random() - 0.5) * css.width * 0.4,
                y: css.height * 0.5 + (Math.random() - 0.5) * css.height * 0.4
            };
        }

        const life =
            CONFIG.particle.baseLife +
            Math.random() * (CONFIG.particle.maxLife - CONFIG.particle.baseLife);

        return {
            x: spawn.x,
            y: spawn.y,
            prevX: spawn.x,
            prevY: spawn.y,
            vx: 0,
            vy: 0,
            life,
            maxLife: life,
            size: CONFIG.particle.baseSize + Math.random(),
            hue: 220,
            saturation: 70,
            lightness: 55,
            alpha: 0,
            concentration: 0
        };
    }

    function randomPointInActiveRegion(maxAttempts = 24) {
        if (!regionCenter) return null;

        for (let i = 0; i < maxAttempts; i++) {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * regionRadius;
            const x = regionCenter.x + Math.cos(angle) * r;
            const y = regionCenter.y + Math.sin(angle) * r;

            if (isInsideHeatmapBounds(x, y, 2)) {
                return { x, y };
            }
        }

        if (isInsideHeatmapBounds(regionCenter.x, regionCenter.y, 0)) {
            return { x: regionCenter.x, y: regionCenter.y };
        }

        return null;
    }

    function renderLoop() {
        if (!isRunning) return;

        if (!isMainViewActive()) {
            WindParticles.stop(false);
            return;
        }

        updateZoomRuntime(false);
        updateScreenBounds(true);
        updateRegionCenter();
        applyZoomParticleTarget();

        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
            currentFps = (frameCount * 1000) / (now - lastFpsTime);
            frameCount = 0;
            lastFpsTime = now;

            if (CONFIG.performance.adaptiveParticles) {
                adjustParticleCount();
            }
        }

        updateParticles();
        renderParticles();

        animationFrameId = requestAnimationFrame(renderLoop);
    }

    function updateParticles() {
        particles.forEach((p) => {
            p.prevX = p.x;
            p.prevY = p.y;

            const wind = getWindAtScreen(p.x, p.y);
            const concentration = getConcentrationAtScreen(p.x, p.y);
            p.concentration = concentration;

            p.vx = wind.u * CONFIG.wind.speedMultiplier * zoomRuntime.speedScale;
            p.vy = -wind.v * CONFIG.wind.speedMultiplier * zoomRuntime.speedScale;

            if (CONFIG.wind.curlNoise) {
                const noise = curl2D(p.x, p.y, performance.now() * 0.001);
                p.vx += noise.x * CONFIG.wind.turbulenceScale;
                p.vy += noise.y * CONFIG.wind.turbulenceScale;
            }

            p.x += p.vx;
            p.y += p.vy;

            const color = getColorFromConcentration(concentration);
            p.hue = color.h;
            p.saturation = color.s * CONFIG.colormap.saturationBoost;
            p.lightness = color.l;

            const sizeBoost = 1 + concentration * 1.5;
            const size = CONFIG.particle.baseSize * sizeBoost * zoomRuntime.sizeScale;
            p.size = Math.max(0.5, Math.min(CONFIG.particle.maxSize * 2.2, size));

            p.life -= 1;
            const lifeRatio = p.life / p.maxLife;
            if (lifeRatio > 0.9) {
                p.alpha = (1 - lifeRatio) / 0.1;
            } else if (lifeRatio < 0.2) {
                p.alpha = lifeRatio / 0.2;
            } else {
                p.alpha = 0.7 + concentration * 0.3;
            }
            p.alpha = clamp(p.alpha * zoomRuntime.alphaScale, 0, 1);

            if (p.life <= 0 || isOutOfRegion(p)) {
                resetParticle(p);
            }
        });
    }

    function renderParticles() {
        const css = getCanvasCssSize();

        // Fade previous frame to keep tail effect.
        ctx.fillStyle = `rgba(0, 0, 0, ${CONFIG.particle.fadeRate})`;
        ctx.fillRect(0, 0, css.width, css.height);

        if (dataScreenBounds) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(
                dataScreenBounds.minX,
                dataScreenBounds.minY,
                dataScreenBounds.width,
                dataScreenBounds.height
            );
            ctx.clip();
        }

        particles.forEach((p) => {
            if (p.alpha <= 0) return;
            if (!isInsideHeatmapBounds(p.x, p.y, 4)) return;

            const concentration = Number.isFinite(p.concentration)
                ? p.concentration
                : getConcentrationAtScreen(p.x, p.y);
            if (concentration <= CONFIG.activeArea.minVisibleConcentration) return;

            const tailLength =
                CONFIG.particle.tailLength +
                concentration * (CONFIG.particle.maxTailLength - CONFIG.particle.tailLength);
            const scaledTailLength = tailLength * zoomRuntime.tailScale;

            const dx = p.x - p.prevX;
            const dy = p.y - p.prevY;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const normalX = dx / dist;
            const normalY = dy / dist;

            if (CONFIG.colormap.glowIntensity > 0 && concentration > 0.3) {
                const glowSize = p.size * (2 + concentration * 3);
                const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowSize);
                gradient.addColorStop(
                    0,
                    `hsla(${p.hue}, ${p.saturation}%, ${p.lightness + 20}%, ${p.alpha * CONFIG.colormap.glowIntensity})`
                );
                gradient.addColorStop(
                    1,
                    `hsla(${p.hue}, ${p.saturation}%, ${p.lightness}%, 0)`
                );

                ctx.beginPath();
                ctx.fillStyle = gradient;
                ctx.arc(p.x, p.y, glowSize, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.beginPath();
            ctx.strokeStyle = `hsla(${p.hue}, ${p.saturation}%, ${p.lightness}%, ${p.alpha * 0.8})`;
            ctx.lineWidth = Math.max(0.5, p.size * 0.8);
            ctx.lineCap = 'round';
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - normalX * scaledTailLength, p.y - normalY * scaledTailLength);
            ctx.stroke();

            ctx.beginPath();
            ctx.fillStyle = `hsla(${p.hue}, ${p.saturation}%, ${p.lightness + 15}%, ${p.alpha})`;
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        });

        if (dataScreenBounds) {
            ctx.restore();
        }
    }

    function getWindAtScreen(screenX, screenY) {
        if (!windField || !windField.u || !windField.u.length) {
            return { u: 2.5, v: 1.8 };
        }

        const u = sampleScalarGridBilinear(windField.u, screenX, screenY);
        const v = sampleScalarGridBilinear(windField.v || windField.u, screenX, screenY);
        if (!Number.isFinite(u) || !Number.isFinite(v)) {
            return { u: 0, v: 0 };
        }

        return { u, v };
    }

    function getConcentrationAtScreen(screenX, screenY) {
        if (!concentrationField || !concentrationField.length) {
            if (!regionCenter) return 0;
            const dx = screenX - regionCenter.x;
            const dy = screenY - regionCenter.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const maxDist = Math.max(1, regionRadius);
            return clamp(1 - dist / maxDist, 0, 1);
        }

        const sampledValue = sampleScalarGridBilinear(
            concentrationField,
            screenX,
            screenY,
            (cell) => Number(cell?.value)
        );
        if (!Number.isFinite(sampledValue)) return 0;

        const minVal = concentrationMin;
        const maxVal = concentrationMax;
        const span = Math.max(1e-9, maxVal - minVal);
        let normalized = clamp((sampledValue - minVal) / span, 0, 1);

        // Stretch middle contrast so gas differences are visibly distinguishable.
        normalized = clamp((normalized - 0.08) / 0.84, 0, 1);
        normalized = Math.pow(normalized, 0.72);

        return normalized;
    }

    function recomputeConcentrationRange() {
        if (!concentrationField || !concentrationField.length) {
            concentrationMin = 0;
            concentrationMax = 1;
            return;
        }

        const values = [];
        concentrationField.forEach((row) => {
            row.forEach((cell) => {
                const v = Number(cell?.value);
                if (Number.isFinite(v)) values.push(v);
            });
        });

        if (!values.length) {
            concentrationMin = 0;
            concentrationMax = 1;
            return;
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
            const center = Number.isFinite(values[Math.floor(n / 2)]) ? values[Math.floor(n / 2)] : 0;
            const delta = Math.max(Math.abs(center) * 0.01, 1e-6);
            minVal = center - delta;
            maxVal = center + delta;
        }

        concentrationMin = minVal;
        concentrationMax = maxVal;
    }

    function getGridIndexAtScreen(screenX, screenY, rows, cols) {
        const point = getNormalizedScreenPoint(screenX, screenY);
        if (!point) return null;
        const i = clamp(Math.floor(point.ny * rows), 0, rows - 1);
        const j = clamp(Math.floor(point.nx * cols), 0, cols - 1);
        return { i, j };
    }

    function getNormalizedScreenPoint(screenX, screenY) {
        if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null;

        let nx;
        let ny;

        if (dataScreenBounds && dataScreenBounds.width > 1 && dataScreenBounds.height > 1) {
            nx = (screenX - dataScreenBounds.minX) / dataScreenBounds.width;
            ny = (screenY - dataScreenBounds.minY) / dataScreenBounds.height;
            if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
                return null;
            }
        } else {
            const css = getCanvasCssSize();
            nx = screenX / Math.max(1, css.width);
            ny = screenY / Math.max(1, css.height);
            if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
                return null;
            }
        }

        return { nx: clamp(nx, 0, 1), ny: clamp(ny, 0, 1) };
    }

    function sampleScalarGridBilinear(grid, screenX, screenY, accessor) {
        if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0]) || !grid[0].length) {
            return null;
        }

        const rows = grid.length;
        const cols = grid[0].length;
        const point = getNormalizedScreenPoint(screenX, screenY);
        if (!point) return null;

        const gx = clamp(point.nx * Math.max(0, cols - 1), 0, Math.max(0, cols - 1));
        const gy = clamp(point.ny * Math.max(0, rows - 1), 0, Math.max(0, rows - 1));

        const j0 = Math.floor(gx);
        const i0 = Math.floor(gy);
        const j1 = Math.min(cols - 1, j0 + 1);
        const i1 = Math.min(rows - 1, i0 + 1);
        const tx = gx - j0;
        const ty = gy - i0;

        const readValue = (i, j) => {
            const cell = grid[i]?.[j];
            const raw = accessor
                ? accessor(cell, i, j)
                : (typeof cell === 'number' ? cell : cell?.value);
            const num = Number(raw);
            return Number.isFinite(num) ? num : NaN;
        };

        const v00 = readValue(i0, j0);
        const v10 = readValue(i0, j1);
        const v01 = readValue(i1, j0);
        const v11 = readValue(i1, j1);

        if (
            Number.isFinite(v00) &&
            Number.isFinite(v10) &&
            Number.isFinite(v01) &&
            Number.isFinite(v11)
        ) {
            const top = v00 * (1 - tx) + v10 * tx;
            const bottom = v01 * (1 - tx) + v11 * tx;
            return top * (1 - ty) + bottom * ty;
        }

        const nearest = readValue(Math.round(gy), Math.round(gx));
        return Number.isFinite(nearest) ? nearest : null;
    }

    function getColorFromConcentration(normalized) {
        const stops = CONFIG.colormap.stops;

        let lower = stops[0];
        let upper = stops[stops.length - 1];

        for (let i = 0; i < stops.length - 1; i++) {
            if (normalized >= stops[i][0] && normalized <= stops[i + 1][0]) {
                lower = stops[i];
                upper = stops[i + 1];
                break;
            }
        }

        const t = (normalized - lower[0]) / (upper[0] - lower[0] || 1);

        return {
            h: lower[1] + t * (upper[1] - lower[1]),
            s: lower[2] + t * (upper[2] - lower[2]),
            l: lower[3] + t * (upper[3] - lower[3])
        };
    }

    function curl2D(x, y, t) {
        const freq = CONFIG.wind.noiseFrequency;
        const eps = 1;

        const n1 = noise(x * freq, (y + eps) * freq, t);
        const n2 = noise(x * freq, (y - eps) * freq, t);
        const n3 = noise((x + eps) * freq, y * freq, t);
        const n4 = noise((x - eps) * freq, y * freq, t);

        return {
            x: (n1 - n2) / (2 * eps),
            y: -(n3 - n4) / (2 * eps)
        };
    }

    function noise(x, y, t) {
        return (
            Math.sin(x * 1.5 + t) *
            Math.cos(y * 1.3 + t * 0.7) *
            Math.sin((x + y) * 0.9 + t * 0.5)
        );
    }

    function resetParticle(p) {
        Object.assign(p, createParticle(true));
    }

    function isOutOfRegion(p) {
        if (!isInsideHeatmapBounds(p.x, p.y, CONFIG.activeArea.margin)) {
            return true;
        }

        if (regionCenter) {
            const dx = p.x - regionCenter.x;
            const dy = p.y - regionCenter.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > regionRadius * 1.08) {
                return true;
            }
        }

        return isOutOfBounds(p);
    }

    function isInsideHeatmapBounds(x, y, margin = 0) {
        if (!dataScreenBounds) return true;
        return (
            x >= dataScreenBounds.minX - margin &&
            x <= dataScreenBounds.maxX + margin &&
            y >= dataScreenBounds.minY - margin &&
            y <= dataScreenBounds.maxY + margin
        );
    }

    function isOutOfBounds(p) {
        const css = getCanvasCssSize();
        const margin = 80;
        return (
            p.x < -margin ||
            p.x > css.width + margin ||
            p.y < -margin ||
            p.y > css.height + margin
        );
    }

    function updateRegionCenter() {
        if (!regionLonLat || !window.viewer) {
            regionCenter = null;
            return;
        }

        const projected = projectLonLatToCanvas(regionLonLat.lon, regionLonLat.lat);
        if (projected) {
            regionCenter = projected;
        }
    }

    function resizeCanvas() {
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const parent = canvas.parentElement;
        const rect = parent
            ? parent.getBoundingClientRect()
            : { width: window.innerWidth, height: window.innerHeight };

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

        updateScreenBounds(true);
    }

    function updateScreenBounds(syncParticles = false) {
        if (!window.viewer || !canvas) {
            const css = getCanvasCssSize();
            screenBounds = { centerX: css.width / 2, centerY: css.height / 2 };
            dataScreenBounds = null;
            lastDataScreenBounds = null;
            return;
        }

        if (!dataBounds) {
            const css = getCanvasCssSize();
            screenBounds = { centerX: css.width / 2, centerY: css.height / 2 };
            dataScreenBounds = null;
            lastDataScreenBounds = null;
            return;
        }

        const corners = [
            { lon: dataBounds.minLon, lat: dataBounds.minLat },
            { lon: dataBounds.maxLon, lat: dataBounds.minLat },
            { lon: dataBounds.minLon, lat: dataBounds.maxLat },
            { lon: dataBounds.maxLon, lat: dataBounds.maxLat }
        ];

        const projected = [];
        for (const corner of corners) {
            const point = projectLonLatToCanvas(corner.lon, corner.lat);
            if (point) projected.push(point);
        }

        if (projected.length < 2) {
            dataScreenBounds = null;
            lastDataScreenBounds = null;
            const css = getCanvasCssSize();
            screenBounds = { centerX: css.width / 2, centerY: css.height / 2 };
            return;
        }

        const minX = Math.min(...projected.map((p) => p.x));
        const maxX = Math.max(...projected.map((p) => p.x));
        const minY = Math.min(...projected.map((p) => p.y));
        const maxY = Math.max(...projected.map((p) => p.y));

        const nextBounds = {
            minX,
            maxX,
            minY,
            maxY,
            width: Math.max(1, maxX - minX),
            height: Math.max(1, maxY - minY),
            centerX: (minX + maxX) * 0.5,
            centerY: (minY + maxY) * 0.5
        };

        if (syncParticles && isRunning && lastDataScreenBounds) {
            syncParticlesToBounds(lastDataScreenBounds, nextBounds);
        }

        dataScreenBounds = nextBounds;
        lastDataScreenBounds = nextBounds;

        screenBounds = {
            centerX: nextBounds.centerX,
            centerY: nextBounds.centerY,
            centerLon: (dataBounds.minLon + dataBounds.maxLon) / 2,
            centerLat: (dataBounds.minLat + dataBounds.maxLat) / 2
        };
    }

    function syncParticlesToBounds(prevBounds, nextBounds) {
        if (!particles.length) return;

        const prevW = Math.max(1, prevBounds.width);
        const prevH = Math.max(1, prevBounds.height);
        const nextW = Math.max(1, nextBounds.width);
        const nextH = Math.max(1, nextBounds.height);

        const change =
            Math.abs(nextBounds.minX - prevBounds.minX) +
            Math.abs(nextBounds.minY - prevBounds.minY) +
            Math.abs(nextW - prevW) +
            Math.abs(nextH - prevH);

        if (change < 0.6) return;

        const sx = nextW / prevW;
        const sy = nextH / prevH;

        particles.forEach((p) => {
            p.x = nextBounds.minX + (p.x - prevBounds.minX) * sx;
            p.y = nextBounds.minY + (p.y - prevBounds.minY) * sy;
            p.prevX = nextBounds.minX + (p.prevX - prevBounds.minX) * sx;
            p.prevY = nextBounds.minY + (p.prevY - prevBounds.minY) * sy;
        });
    }

    function projectLonLatToCanvas(lon, lat) {
        if (!window.viewer || !canvas) return null;

        const cartesian = Cesium.Cartesian3.fromDegrees(lon, lat);
        const canvasPos = window.viewer.scene.cartesianToCanvasCoordinates(cartesian);
        if (!canvasPos) return null;

        const x = canvasPos.x;
        const y = canvasPos.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

        return { x, y };
    }

    function clearCanvas() {
        if (!ctx || !canvas) return;
        const css = getCanvasCssSize();
        ctx.clearRect(0, 0, css.width, css.height);
    }

    function getCanvasCssSize() {
        if (!canvas) {
            return { width: window.innerWidth, height: window.innerHeight };
        }
        const width =
            canvas.clientWidth ||
            parseFloat(canvas.style.width || '0') ||
            window.innerWidth;
        const height =
            canvas.clientHeight ||
            parseFloat(canvas.style.height || '0') ||
            window.innerHeight;
        return { width, height };
    }

    function adjustParticleCount() {
        const perf = CONFIG.performance;
        const zoomMax = Math.max(CONFIG.particle.minCount, Math.floor(targetParticleCountByZoom));

        if (currentParticleCount > zoomMax) {
            currentParticleCount = Math.max(zoomMax, Math.floor(currentParticleCount * 0.9));
            particles.splice(currentParticleCount);
            return;
        }

        if (currentFps < perf.fpsThreshold && currentParticleCount > CONFIG.particle.minCount) {
            currentParticleCount = Math.max(
                CONFIG.particle.minCount,
                Math.floor(currentParticleCount * 0.9)
            );
            particles.splice(currentParticleCount);
            return;
        }

        if (currentFps > 55 && currentParticleCount < CONFIG.particle.maxCount) {
            const targetMax = Math.min(CONFIG.particle.maxCount, zoomMax);
            const addCount = Math.min(50, targetMax - currentParticleCount);
            if (addCount <= 0) return;
            for (let i = 0; i < addCount; i++) {
                particles.push(createParticle(true));
            }
            currentParticleCount = particles.length;
        }
    }

    function isMainViewActive() {
        if (window.viewManager && typeof window.viewManager.getCurrentView === 'function') {
            return window.viewManager.getCurrentView() === 'main-view';
        }
        const activeView = document.querySelector('.view.active');
        return !activeView || activeView.id === 'main-view';
    }

    function bindViewChangeOnce() {
        if (viewEventBound) return;
        viewEventBound = true;

        document.addEventListener('viewChanged', (event) => {
            const target = event?.detail?.target;
            if (target && target !== 'main-view') {
                WindParticles.stop(false);
            }
        });
    }

    function getCameraHeight() {
        try {
            return window.viewer?.camera?.positionCartographic?.height || null;
        } catch (_err) {
            return null;
        }
    }

    function getZoomTFromHeight(height) {
        const cfg = CONFIG.zoom;
        const safeHeight = clamp(
            Number.isFinite(height) ? height : cfg.maxHeight,
            cfg.minHeight,
            cfg.maxHeight
        );

        const logMin = Math.log(cfg.minHeight);
        const logMax = Math.log(cfg.maxHeight);
        const logH = Math.log(safeHeight);
        return 1 - clamp((logH - logMin) / (logMax - logMin), 0, 1);
    }

    function updateZoomRuntime(force = false) {
        const cfg = CONFIG.zoom;
        const cameraHeight = getCameraHeight();
        const targetT = getZoomTFromHeight(cameraHeight);
        const smooth = force ? 1 : cfg.smoothing;

        zoomRuntime.t = lerp(zoomRuntime.t, targetT, smooth);
        zoomRuntime.sizeScale = lerp(cfg.farSizeScale, cfg.nearSizeScale, zoomRuntime.t);
        zoomRuntime.tailScale = lerp(cfg.farTailScale, cfg.nearTailScale, zoomRuntime.t);
        zoomRuntime.speedScale = lerp(cfg.farSpeedScale, cfg.nearSpeedScale, zoomRuntime.t);
        zoomRuntime.alphaScale = lerp(cfg.farAlphaScale, cfg.nearAlphaScale, zoomRuntime.t);
        zoomRuntime.radiusScale = lerp(cfg.farRadiusScale, cfg.nearRadiusScale, zoomRuntime.t);
        zoomRuntime.densityScale = lerp(cfg.farDensityScale, cfg.nearDensityScale, zoomRuntime.t);

        const nextRadius = baseRegionRadius * zoomRuntime.radiusScale;
        const minRadius = Math.max(80, baseRegionRadius * 0.62);
        const maxRadius = Math.min(460, baseRegionRadius * 1.18);
        regionRadius = clamp(nextRadius, minRadius, maxRadius);

        const densityTarget =
            CONFIG.particle.minCount +
            (CONFIG.particle.maxCount - CONFIG.particle.minCount) * zoomRuntime.densityScale;
        targetParticleCountByZoom = Math.floor(densityTarget);
    }

    function applyZoomParticleTarget() {
        if (!isRunning) return;

        const desired = Math.max(CONFIG.particle.minCount, Math.floor(targetParticleCountByZoom));

        if (particles.length > desired) {
            particles.splice(desired);
            currentParticleCount = particles.length;
            return;
        }

        if (particles.length < desired && currentFps > CONFIG.performance.fpsThreshold) {
            const addCount = Math.min(35, desired - particles.length);
            for (let i = 0; i < addCount; i++) {
                particles.push(createParticle(true));
            }
            currentParticleCount = particles.length;
        }
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function debounce(fn, delay) {
        let timer = null;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    function deepMerge(target, source) {
        for (const key in source) {
            if (
                source[key] &&
                typeof source[key] === 'object' &&
                !Array.isArray(source[key])
            ) {
                target[key] = target[key] || {};
                deepMerge(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
    }

    console.log('[WindParticles] loaded');
})();

