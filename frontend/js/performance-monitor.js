// ============================================================
//  performance-monitor.js — WebGIS 性能监控与优化
//  功能：FPS监控、GPU资源管理、自适应渲染质量
// ============================================================
(function () {
    'use strict';

    // ===== 配置 =====
    const CONFIG = {
        // 目标性能
        target: {
            fps: 60,
            minFps: 30,
            warningFps: 45
        },
        // 采样参数
        sampling: {
            interval: 1000,           // 采样间隔 (ms)
            historySize: 30,          // 历史记录数量
            smoothingFactor: 0.3      // 平滑因子
        },
        // 自适应阈值
        adaptive: {
            enabled: true,
            degradeThreshold: 40,     // 低于此FPS开始降级
            recoverThreshold: 55,     // 高于此FPS开始恢复
            degradeSteps: [
                'reduceParticles',
                'simplifyHeatmap',
                'disableGlow',
                'reduceResolution'
            ]
        },
        // UI显示
        display: {
            enabled: true,
            position: 'bottom-right',
            showGraph: true,
            graphWidth: 120,
            graphHeight: 40
        }
    };

    // ===== 状态 =====
    let isMonitoring = false;
    let frameCount = 0;
    let lastFrameTime = 0;
    let fpsHistory = [];
    let currentFps = 60;
    let smoothedFps = 60;
    let degradationLevel = 0;
    let animationFrameId = null;
    let lastSampleTime = 0;

    // UI元素
    let monitorPanel = null;
    let fpsDisplay = null;
    let graphCanvas = null;
    let graphCtx = null;

    // 性能指标
    let metrics = {
        fps: 60,
        frameTime: 16.67,
        particleCount: 0,
        heatmapEntities: 0,
        memoryUsage: 0,
        gpuTime: 0
    };

    // ============================================================
    //  公共 API
    // ============================================================
    window.PerformanceMonitor = window.PerformanceMonitor || {};

    /**
     * 启动性能监控
     */
    PerformanceMonitor.start = function () {
        if (isMonitoring) return;
        
        isMonitoring = true;
        frameCount = 0;
        lastFrameTime = performance.now();
        lastSampleTime = lastFrameTime;
        fpsHistory = [];
        degradationLevel = 0;

        if (CONFIG.display.enabled) {
            createMonitorUI();
        }

        monitorLoop();
        console.log('[PerformanceMonitor] 性能监控已启动');
    };

    /**
     * 停止性能监控
     */
    PerformanceMonitor.stop = function () {
        isMonitoring = false;
        
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        if (monitorPanel) {
            monitorPanel.remove();
            monitorPanel = null;
        }

        console.log('[PerformanceMonitor] 性能监控已停止');
    };

    /**
     * 获取当前FPS
     */
    PerformanceMonitor.getFPS = function () {
        return Math.round(smoothedFps);
    };

    /**
     * 获取完整性能指标
     */
    PerformanceMonitor.getMetrics = function () {
        return { ...metrics };
    };

    /**
     * 获取FPS历史
     */
    PerformanceMonitor.getHistory = function () {
        return [...fpsHistory];
    };

    /**
     * 获取当前降级等级
     */
    PerformanceMonitor.getDegradationLevel = function () {
        return degradationLevel;
    };

    /**
     * 手动触发性能降级
     */
    PerformanceMonitor.degradePerformance = function () {
        applyDegradation();
    };

    /**
     * 手动恢复性能
     */
    PerformanceMonitor.recoverPerformance = function () {
        recoverQuality();
    };

    /**
     * 重置到最高质量
     */
    PerformanceMonitor.resetQuality = function () {
        degradationLevel = 0;
        applyQualitySettings();
    };

    /**
     * 更新配置
     */
    PerformanceMonitor.setConfig = function (newConfig) {
        deepMerge(CONFIG, newConfig);
    };

    /**
     * 显示/隐藏监控面板
     */
    PerformanceMonitor.toggleDisplay = function (show) {
        if (show === undefined) {
            CONFIG.display.enabled = !CONFIG.display.enabled;
        } else {
            CONFIG.display.enabled = show;
        }

        if (CONFIG.display.enabled && isMonitoring && !monitorPanel) {
            createMonitorUI();
        } else if (!CONFIG.display.enabled && monitorPanel) {
            monitorPanel.remove();
            monitorPanel = null;
        }
    };

    /**
     * 注册自定义指标
     */
    PerformanceMonitor.setMetric = function (name, value) {
        metrics[name] = value;
    };

    // ============================================================
    //  监控循环
    // ============================================================

    function monitorLoop() {
        if (!isMonitoring) return;

        const now = performance.now();
        frameCount++;

        // 计算即时帧时间
        const frameTime = now - lastFrameTime;
        lastFrameTime = now;
        metrics.frameTime = frameTime;

        // 每秒采样一次FPS
        if (now - lastSampleTime >= CONFIG.sampling.interval) {
            const elapsed = now - lastSampleTime;
            currentFps = (frameCount * 1000) / elapsed;
            
            // 平滑FPS值
            smoothedFps = smoothedFps * (1 - CONFIG.sampling.smoothingFactor) + 
                         currentFps * CONFIG.sampling.smoothingFactor;
            
            metrics.fps = Math.round(smoothedFps);

            // 记录历史
            fpsHistory.push(smoothedFps);
            if (fpsHistory.length > CONFIG.sampling.historySize) {
                fpsHistory.shift();
            }

            // 更新其他指标
            updateMetrics();

            // 自适应质量调整
            if (CONFIG.adaptive.enabled) {
                adjustQuality();
            }

            // 更新UI
            if (CONFIG.display.enabled && monitorPanel) {
                updateUI();
            }

            frameCount = 0;
            lastSampleTime = now;
        }

        animationFrameId = requestAnimationFrame(monitorLoop);
    }

    function updateMetrics() {
        // 粒子数量
        if (window.WindParticles) {
            metrics.particleCount = WindParticles.getParticleCount();
        }

        // 热力图实体数
        if (window.viewer && window.viewer.dataSources) {
            const ds = window.viewer.dataSources.getByName('heatmap-3d');
            if (ds && ds.length > 0) {
                metrics.heatmapEntities = ds[0].entities.values.length;
            }
        }

        // 内存使用 (如果可用)
        if (performance.memory) {
            metrics.memoryUsage = Math.round(performance.memory.usedJSHeapSize / 1048576);
        }
    }

    // ============================================================
    //  自适应质量控制
    // ============================================================

    function adjustQuality() {
        const fps = smoothedFps;
        const adaptive = CONFIG.adaptive;

        if (fps < adaptive.degradeThreshold) {
            // 需要降级
            if (degradationLevel < adaptive.degradeSteps.length) {
                applyDegradation();
            }
        } else if (fps > adaptive.recoverThreshold) {
            // 可以恢复
            if (degradationLevel > 0) {
                recoverQuality();
            }
        }
    }

    function applyDegradation() {
        const steps = CONFIG.adaptive.degradeSteps;
        if (degradationLevel >= steps.length) return;

        const step = steps[degradationLevel];
        console.log(`[PerformanceMonitor] 性能降级 Level ${degradationLevel + 1}: ${step}`);

        switch (step) {
            case 'reduceParticles':
                if (window.WindParticles) {
                    WindParticles.setConfig({
                        particle: { maxCount: 1500 }
                    });
                }
                break;

            case 'simplifyHeatmap':
                if (window.Heatmap3D) {
                    Heatmap3D.setConfig({
                        render: { gridResolution: 25 }
                    });
                }
                break;

            case 'disableGlow':
                if (window.WindParticles) {
                    WindParticles.setConfig({
                        colormap: { glowIntensity: 0 }
                    });
                }
                break;

            case 'reduceResolution':
                // 降低Cesium渲染分辨率
                if (window.viewer) {
                    viewer.resolutionScale = 0.75;
                }
                break;
        }

        degradationLevel++;
    }

    function recoverQuality() {
        if (degradationLevel <= 0) return;

        degradationLevel--;
        const step = CONFIG.adaptive.degradeSteps[degradationLevel];
        console.log(`[PerformanceMonitor] 性能恢复 Level ${degradationLevel}: ${step}`);

        switch (step) {
            case 'reduceParticles':
                if (window.WindParticles) {
                    WindParticles.setConfig({
                        particle: { maxCount: 3000 }
                    });
                }
                break;

            case 'simplifyHeatmap':
                if (window.Heatmap3D) {
                    Heatmap3D.setConfig({
                        render: { gridResolution: 40 }
                    });
                }
                break;

            case 'disableGlow':
                if (window.WindParticles) {
                    WindParticles.setConfig({
                        colormap: { glowIntensity: 0.6 }
                    });
                }
                break;

            case 'reduceResolution':
                if (window.viewer) {
                    viewer.resolutionScale = 1.0;
                }
                break;
        }
    }

    function applyQualitySettings() {
        // 重置所有模块到默认设置
        if (window.WindParticles) {
            WindParticles.setConfig({
                particle: { maxCount: 3000 },
                colormap: { glowIntensity: 0.6 }
            });
        }

        if (window.Heatmap3D) {
            Heatmap3D.setConfig({
                render: { gridResolution: 40 }
            });
        }

        if (window.viewer) {
            viewer.resolutionScale = 1.0;
        }
    }

    // ============================================================
    //  监控UI
    // ============================================================

    function createMonitorUI() {
        if (monitorPanel) return;

        monitorPanel = document.createElement('div');
        monitorPanel.className = 'perf-monitor-panel';
        
        const positions = {
            'top-left': 'top: 10px; left: 10px;',
            'top-right': 'top: 10px; right: 10px;',
            'bottom-left': 'bottom: 60px; left: 10px;',
            'bottom-right': 'bottom: 60px; right: 10px;'
        };

        monitorPanel.style.cssText = `
            position: fixed;
            ${positions[CONFIG.display.position] || positions['bottom-right']}
            background: rgba(0, 20, 40, 0.85);
            border: 1px solid rgba(0, 243, 255, 0.3);
            border-radius: 8px;
            padding: 8px 12px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            color: #00f3ff;
            z-index: 9999;
            pointer-events: none;
            backdrop-filter: blur(4px);
            min-width: 140px;
        `;

        monitorPanel.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <span style="width: 6px; height: 6px; background: #00ff88; border-radius: 50%;"></span>
                <span style="font-weight: 600;">PERFORMANCE</span>
            </div>
            <div class="perf-fps-row" style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span>FPS</span>
                <span class="perf-fps-value" style="font-weight: 600;">60</span>
            </div>
            <div class="perf-frame-row" style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span>Frame</span>
                <span class="perf-frame-value">16.7ms</span>
            </div>
            <div class="perf-particles-row" style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span>Particles</span>
                <span class="perf-particles-value">0</span>
            </div>
            <div class="perf-degrade-row" style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                <span>Quality</span>
                <span class="perf-degrade-value">HIGH</span>
            </div>
            ${CONFIG.display.showGraph ? `
                <canvas class="perf-graph" width="${CONFIG.display.graphWidth}" height="${CONFIG.display.graphHeight}" 
                        style="width: 100%; height: ${CONFIG.display.graphHeight}px; border-radius: 4px; background: rgba(0,0,0,0.3);"></canvas>
            ` : ''}
        `;

        document.body.appendChild(monitorPanel);

        fpsDisplay = monitorPanel.querySelector('.perf-fps-value');
        
        if (CONFIG.display.showGraph) {
            graphCanvas = monitorPanel.querySelector('.perf-graph');
            graphCtx = graphCanvas.getContext('2d');
        }
    }

    function updateUI() {
        if (!monitorPanel) return;

        // FPS值及颜色
        const fpsVal = monitorPanel.querySelector('.perf-fps-value');
        fpsVal.textContent = Math.round(smoothedFps);
        
        if (smoothedFps >= 55) {
            fpsVal.style.color = '#00ff88';
        } else if (smoothedFps >= 40) {
            fpsVal.style.color = '#ffcc00';
        } else {
            fpsVal.style.color = '#ff4444';
        }

        // 帧时间
        const frameVal = monitorPanel.querySelector('.perf-frame-value');
        frameVal.textContent = metrics.frameTime.toFixed(1) + 'ms';

        // 粒子数
        const particlesVal = monitorPanel.querySelector('.perf-particles-value');
        particlesVal.textContent = metrics.particleCount;

        // 质量等级
        const degradeVal = monitorPanel.querySelector('.perf-degrade-value');
        const qualityNames = ['HIGH', 'MED+', 'MED', 'LOW+', 'LOW'];
        degradeVal.textContent = qualityNames[degradationLevel] || 'LOW';
        degradeVal.style.color = degradationLevel === 0 ? '#00ff88' : 
                                 degradationLevel <= 2 ? '#ffcc00' : '#ff4444';

        // 绘制图表
        if (CONFIG.display.showGraph && graphCtx) {
            drawFPSGraph();
        }
    }

    function drawFPSGraph() {
        const w = graphCanvas.width;
        const h = graphCanvas.height;
        
        graphCtx.clearRect(0, 0, w, h);

        if (fpsHistory.length < 2) return;

        // 目标线
        const targetY = h - (CONFIG.target.fps / 70) * h;
        graphCtx.strokeStyle = 'rgba(0, 255, 136, 0.3)';
        graphCtx.lineWidth = 1;
        graphCtx.setLineDash([4, 4]);
        graphCtx.beginPath();
        graphCtx.moveTo(0, targetY);
        graphCtx.lineTo(w, targetY);
        graphCtx.stroke();
        graphCtx.setLineDash([]);

        // FPS曲线
        const step = w / (CONFIG.sampling.historySize - 1);
        
        graphCtx.beginPath();
        graphCtx.strokeStyle = '#00f3ff';
        graphCtx.lineWidth = 1.5;

        fpsHistory.forEach((fps, i) => {
            const x = i * step;
            const y = h - (fps / 70) * h;
            
            if (i === 0) {
                graphCtx.moveTo(x, y);
            } else {
                graphCtx.lineTo(x, y);
            }
        });

        graphCtx.stroke();

        // 填充
        graphCtx.lineTo((fpsHistory.length - 1) * step, h);
        graphCtx.lineTo(0, h);
        graphCtx.closePath();
        graphCtx.fillStyle = 'rgba(0, 243, 255, 0.1)';
        graphCtx.fill();
    }

    // ============================================================
    //  工具函数
    // ============================================================

    function deepMerge(target, source) {
        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                target[key] = target[key] || {};
                deepMerge(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
    }

    console.log('[PerformanceMonitor] 性能监控模块加载完成');
})();
