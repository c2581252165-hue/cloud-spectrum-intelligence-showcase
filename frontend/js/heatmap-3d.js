// ============================================================
//  heatmap-3d.js — 3D浓度热力图渲染器
//  功能：基于实时气体浓度生成立体热力图
//  Z轴凸起效果 + 2.5D视角下的地形高度映射
// ============================================================
(function () {
    'use strict';

    // ===== 配置 =====
    const CONFIG = {
        // 高度映射
        height: {
            minHeight: 50,          // 最低高度 (米)
            maxHeight: 800,         // 最高高度 (米)
            exaggeration: 2.0,      // 高度夸张系数
            smoothTransition: true  // 平滑过渡
        },
        // 颜色映射 (浓度 -> 颜色)
        colormap: {
            // 梯度色阶: [浓度比例, R, G, B, A]
            stops: [
                [0.0, 0, 80, 200, 0.3],      // 低浓度: 深蓝
                [0.2, 0, 180, 255, 0.4],      // 低-中: 青色
                [0.4, 0, 255, 180, 0.5],      // 中: 青绿
                [0.6, 180, 255, 0, 0.6],      // 中-高: 黄绿
                [0.8, 255, 180, 0, 0.75],     // 高: 橙色
                [1.0, 255, 50, 50, 0.9]       // 极高: 红色
            ],
            // 预警阈值
            warningThreshold: 0.7,
            criticalThreshold: 0.9
        },
        // 渲染参数
        render: {
            gridResolution: 40,      // 网格分辨率
            cellSize: 600,           // 单元格大小 (米)
            updateInterval: 100,     // 动画更新间隔 (ms)
            fadeInDuration: 1500,    // 渐显时长 (ms)
            pulsePeriod: 2000        // 高浓度脉动周期 (ms)
        },
        // 轮廓线
        contour: {
            enabled: true,
            levels: [0.3, 0.5, 0.7, 0.9],
            color: '#00f3ff',
            width: 2,
            glowWidth: 4
        }
    };

    // ===== 状态 =====
    let heatmapEntities = [];
    let contourEntities = [];
    let animationFrameId = null;
    let currentData = null;
    let fadeProgress = 0;
    let isAnimating = false;

    // Cesium资源
    let viewer = null;
    let heatmapDataSource = null;

    // 相机缩放相关
    let cameraChangeHandler = null;
    let lastCameraHeight = 0;
    let currentCenterLon = 0;
    let currentCenterLat = 0;
    let baseHeightScale = 1.0;      // 基础高度缩放系数
    let baseSizeScale = 1.0;        // 基础尺寸缩放系数

    // ============================================================
    //  公共 API
    // ============================================================
    window.Heatmap3D = window.Heatmap3D || {};

    /**
     * 初始化3D热力图渲染器
     * @param {Cesium.Viewer} cesiumViewer
     */
    Heatmap3D.init = function (cesiumViewer) {
        viewer = cesiumViewer || window.viewer;
        if (!viewer) {
            console.error('[Heatmap3D] Cesium viewer未初始化');
            return false;
        }

        // 创建专用DataSource
        if (!heatmapDataSource) {
            heatmapDataSource = new Cesium.CustomDataSource('heatmap-3d');
            viewer.dataSources.add(heatmapDataSource);
        }

        // 添加相机变化监听器
        setupCameraListener();

        console.log('[Heatmap3D] 3D热力图渲染器初始化完成');
        return true;
    };

    /**
     * 渲染3D热力图
     * @param {Object} gridData - 网格数据 (来自EnvDataService)
     * @param {Object} [options] - 渲染选项
     */
    Heatmap3D.render = async function (gridData, options = {}) {
        if (!viewer) {
            if (!Heatmap3D.init()) return;
        }

        currentData = gridData;
        const { animated = true, immediate = false } = options;

        // 根据当前相机高度设置初始缩放比例
        const cameraHeight = getCameraHeight();
        lastCameraHeight = cameraHeight;
        const baseRefHeight = 50000;
        const heightRatio = Math.log10(cameraHeight / 1000 + 1) / Math.log10(baseRefHeight / 1000 + 1);
        baseHeightScale = Math.max(0.3, Math.min(5.0, heightRatio * 1.5));
        baseSizeScale = Math.max(0.8, Math.min(2.0, heightRatio * 1.2));

        // 清除旧的热力图
        clearHeatmap();

        // 计算浓度范围用于归一化
        const { minVal, maxVal } = calculateRange(gridData.grid);

        // 创建网格单元
        const entities = [];
        const grid = gridData.grid;
        
        for (let i = 0; i < grid.length; i++) {
            for (let j = 0; j < grid[i].length; j++) {
                const cell = grid[i][j];
                const normalized = normalizeValue(cell.value, minVal, maxVal);
                
                const entity = createHeatCell(
                    cell.lon, cell.lat, cell.value,
                    normalized, gridData.bounds
                );
                
                if (entity) {
                    entities.push(entity);
                    heatmapDataSource.entities.add(entity);
                }
            }
        }

        heatmapEntities = entities;

        // 创建等值线
        if (CONFIG.contour.enabled) {
            renderContours(gridData, minVal, maxVal);
        }

        // 动画渐显
        if (animated && !immediate) {
            fadeProgress = 0;
            isAnimating = true;
            animateFadeIn();
        } else {
            fadeProgress = 1;
            updateEntityStyles(1);
        }

        // 启动脉动动画
        startPulseAnimation();

        console.log(`[Heatmap3D] 渲染完成: ${entities.length} 个热力点`);
    };

    /**
     * 更新热力图数据 (平滑过渡)
     */
    Heatmap3D.update = function (newGridData) {
        if (!currentData || heatmapEntities.length === 0) {
            return Heatmap3D.render(newGridData);
        }

        // 平滑过渡到新数据
        smoothTransition(newGridData);
    };

    /**
     * 清除热力图
     */
    Heatmap3D.clear = function () {
        removeCameraListener();
        clearHeatmap();
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        isAnimating = false;
        currentData = null;
        baseHeightScale = 1.0;
        baseSizeScale = 1.0;
    };

    /**
     * 设置高度夸张系数
     */
    Heatmap3D.setHeightExaggeration = function (factor) {
        CONFIG.height.exaggeration = Math.max(0.5, Math.min(5, factor));
        if (currentData) {
            Heatmap3D.render(currentData, { immediate: true });
        }
    };

    /**
     * 获取当前配置
     */
    Heatmap3D.getConfig = function () {
        return JSON.parse(JSON.stringify(CONFIG));
    };

    /**
     * 更新配置
     */
    Heatmap3D.setConfig = function (newConfig) {
        Object.assign(CONFIG, newConfig);
    };

    // ============================================================
    //  热力单元创建
    // ============================================================

    function createHeatCell(lon, lat, value, normalized, bounds) {
        // 计算高度 (应用缩放系数)
        const heightRange = CONFIG.height.maxHeight - CONFIG.height.minHeight;
        const baseHeight = CONFIG.height.minHeight + 
                       normalized * heightRange * CONFIG.height.exaggeration;
        const height = baseHeight * baseHeightScale;

        // 计算颜色
        const color = getColorFromValue(normalized);

        // 计算单元格大小 (根据bounds动态调整)
        const lonSpan = bounds.maxLon - bounds.minLon;
        const latSpan = bounds.maxLat - bounds.minLat;
        const gridSize = currentData.grid.length;
        const cellLonSize = lonSpan / gridSize;
        const cellLatSize = latSpan / gridSize;

        // 应用尺寸缩放
        const cellWidth = cellLonSize * 111000 * 0.9 * baseSizeScale;
        const cellDepth = cellLatSize * 111000 * 0.9 * baseSizeScale;

        // 创建立方体/柱体
        const entity = new Cesium.Entity({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, height / 2),
            box: {
                dimensions: new Cesium.Cartesian3(cellWidth, cellDepth, height),
                material: new Cesium.ColorMaterialProperty(color),
                outline: false,
                shadows: Cesium.ShadowMode.DISABLED
            },
            properties: {
                value: value,
                normalized: normalized,
                baseColor: color,
                lon: lon,
                lat: lat,
                baseHeight: baseHeight,    // 保存原始高度
                height: height,
                cellWidth: cellLonSize * 111000 * 0.9,   // 保存原始尺寸
                cellDepth: cellLatSize * 111000 * 0.9
            }
        });

        return entity;
    }

    // ============================================================
    //  颜色映射
    // ============================================================

    function getColorFromValue(normalized) {
        const stops = CONFIG.colormap.stops;
        
        // 找到所在区间
        let lower = stops[0];
        let upper = stops[stops.length - 1];
        
        for (let i = 0; i < stops.length - 1; i++) {
            if (normalized >= stops[i][0] && normalized <= stops[i + 1][0]) {
                lower = stops[i];
                upper = stops[i + 1];
                break;
            }
        }

        // 线性插值
        const t = (normalized - lower[0]) / (upper[0] - lower[0] || 1);
        const r = Math.round(lower[1] + t * (upper[1] - lower[1]));
        const g = Math.round(lower[2] + t * (upper[2] - lower[2]));
        const b = Math.round(lower[3] + t * (upper[3] - lower[3]));
        const a = lower[4] + t * (upper[4] - lower[4]);

        return new Cesium.Color(r / 255, g / 255, b / 255, a);
    }

    // ============================================================
    //  等值线渲染
    // ============================================================

    function renderContours(gridData, minVal, maxVal) {
        const levels = CONFIG.contour.levels;
        const grid = gridData.grid;
        
        levels.forEach(level => {
            const contourPolygons = extractContour(grid, level, minVal, maxVal);
            
            contourPolygons.forEach(polygon => {
                const positions = polygon.map(p => 
                    Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 20)
                );

                if (positions.length < 3) return;

                const entity = heatmapDataSource.entities.add({
                    polyline: {
                        positions: positions,
                        width: CONFIG.contour.width,
                        material: new Cesium.PolylineGlowMaterialProperty({
                            glowPower: 0.3,
                            color: Cesium.Color.fromCssColorString(CONFIG.contour.color)
                        }),
                        clampToGround: false
                    }
                });

                contourEntities.push(entity);
            });
        });
    }

    /**
     * 简单的等值线提取 (Marching Squares 简化版)
     */
    function extractContour(grid, level, minVal, maxVal) {
        const threshold = minVal + level * (maxVal - minVal);
        const contours = [];
        const visited = new Set();

        for (let i = 0; i < grid.length - 1; i++) {
            for (let j = 0; j < grid[i].length - 1; j++) {
                const key = `${i},${j}`;
                if (visited.has(key)) continue;

                // 检查单元格四角
                const v00 = grid[i][j].value;
                const v10 = grid[i + 1]?.[j]?.value || v00;
                const v01 = grid[i][j + 1]?.value || v00;
                const v11 = grid[i + 1]?.[j + 1]?.value || v00;

                const above00 = v00 > threshold;
                const above10 = v10 > threshold;
                const above01 = v01 > threshold;
                const above11 = v11 > threshold;

                // 如果有交叉，添加边界点
                if (above00 !== above10 || above00 !== above01 || above00 !== above11) {
                    const points = [];
                    
                    // 简化：添加高于阈值的点
                    if (above00) points.push({ lon: grid[i][j].lon, lat: grid[i][j].lat });
                    if (above10) points.push({ lon: grid[i + 1][j].lon, lat: grid[i + 1][j].lat });
                    if (above01) points.push({ lon: grid[i][j + 1].lon, lat: grid[i][j + 1].lat });
                    if (above11) points.push({ lon: grid[i + 1][j + 1].lon, lat: grid[i + 1][j + 1].lat });

                    if (points.length >= 2) {
                        contours.push(points);
                    }
                    visited.add(key);
                }
            }
        }

        return contours;
    }

    // ============================================================
    //  动画系统
    // ============================================================

    function animateFadeIn() {
        if (!isAnimating) return;

        fadeProgress += 16 / CONFIG.render.fadeInDuration;
        
        if (fadeProgress >= 1) {
            fadeProgress = 1;
            isAnimating = false;
        }

        updateEntityStyles(easeOutCubic(fadeProgress));

        if (fadeProgress < 1) {
            animationFrameId = requestAnimationFrame(animateFadeIn);
        }
    }

    function updateEntityStyles(progress) {
        heatmapEntities.forEach(entity => {
            if (!entity.box) return;

            const props = entity.properties;
            const baseColor = props.baseColor.getValue();
            const height = props.height.getValue();

            // 高度动画
            const currentHeight = height * progress;
            entity.position = Cesium.Cartesian3.fromDegrees(
                props.lon.getValue(),
                props.lat.getValue(),
                currentHeight / 2
            );

            // 透明度动画
            const newColor = new Cesium.Color(
                baseColor.red,
                baseColor.green,
                baseColor.blue,
                baseColor.alpha * progress
            );
            entity.box.material = new Cesium.ColorMaterialProperty(newColor);
        });
    }

    function startPulseAnimation() {
        // 高浓度区域脉动效果
        const pulseLoop = () => {
            if (!currentData) return;

            const t = (Date.now() % CONFIG.render.pulsePeriod) / CONFIG.render.pulsePeriod;
            const pulse = 0.85 + 0.15 * Math.sin(t * Math.PI * 2);

            heatmapEntities.forEach(entity => {
                const props = entity.properties;
                const normalized = props.normalized.getValue();

                // 只对高浓度区域应用脉动
                if (normalized > CONFIG.colormap.warningThreshold) {
                    const baseColor = props.baseColor.getValue();
                    const pulseIntensity = (normalized - CONFIG.colormap.warningThreshold) / 
                                           (1 - CONFIG.colormap.warningThreshold);
                    
                    const newAlpha = baseColor.alpha * (0.9 + pulseIntensity * (pulse - 0.9));
                    
                    entity.box.material = new Cesium.ColorMaterialProperty(
                        new Cesium.Color(baseColor.red, baseColor.green, baseColor.blue, newAlpha)
                    );
                }
            });

            if (currentData) {
                requestAnimationFrame(pulseLoop);
            }
        };

        requestAnimationFrame(pulseLoop);
    }

    function smoothTransition(newData) {
        const oldGrid = currentData.grid;
        const newGrid = newData.grid;
        const { minVal: newMin, maxVal: newMax } = calculateRange(newGrid);

        let transitionProgress = 0;
        const duration = 800;
        const startTime = performance.now();

        const animate = () => {
            const elapsed = performance.now() - startTime;
            transitionProgress = Math.min(elapsed / duration, 1);
            const eased = easeOutCubic(transitionProgress);

            // 插值更新每个单元格
            heatmapEntities.forEach((entity, idx) => {
                const row = Math.floor(idx / newGrid[0].length);
                const col = idx % newGrid[0].length;

                if (!newGrid[row] || !newGrid[row][col]) return;

                const oldVal = oldGrid[row]?.[col]?.value || newGrid[row][col].value;
                const newVal = newGrid[row][col].value;
                const currentVal = oldVal + (newVal - oldVal) * eased;
                const normalized = normalizeValue(currentVal, newMin, newMax);

                // 更新高度和颜色
                const height = CONFIG.height.minHeight + 
                              normalized * (CONFIG.height.maxHeight - CONFIG.height.minHeight) * 
                              CONFIG.height.exaggeration;
                const color = getColorFromValue(normalized);

                entity.position = Cesium.Cartesian3.fromDegrees(
                    newGrid[row][col].lon,
                    newGrid[row][col].lat,
                    height / 2
                );
                entity.box.material = new Cesium.ColorMaterialProperty(color);

                // 更新属性
                entity.properties.value = currentVal;
                entity.properties.normalized = normalized;
                entity.properties.height = height;
                entity.properties.baseColor = color;
            });

            if (transitionProgress < 1) {
                requestAnimationFrame(animate);
            } else {
                currentData = newData;
            }
        };

        requestAnimationFrame(animate);
    }

    // ============================================================
    //  工具函数
    // ============================================================

    function calculateRange(grid) {
        let minVal = Infinity;
        let maxVal = -Infinity;

        for (const row of grid) {
            for (const cell of row) {
                if (cell.value < minVal) minVal = cell.value;
                if (cell.value > maxVal) maxVal = cell.value;
            }
        }

        return { minVal, maxVal };
    }

    function normalizeValue(value, min, max) {
        if (max === min) return 0.5;
        return Math.max(0, Math.min(1, (value - min) / (max - min)));
    }

    function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    function clearHeatmap() {
        if (heatmapDataSource) {
            heatmapDataSource.entities.removeAll();
        }
        heatmapEntities = [];
        contourEntities = [];
    }

    // ============================================================
    //  相机缩放监听 - 动态调整热力图
    // ============================================================

    /**
     * 设置相机变化监听器
     */
    function setupCameraListener() {
        if (!viewer || cameraChangeHandler) return;

        // 记录初始相机高度
        lastCameraHeight = getCameraHeight();

        // 监听相机移动结束事件
        cameraChangeHandler = viewer.camera.moveEnd.addEventListener(() => {
            if (heatmapEntities.length === 0) return;

            const newHeight = getCameraHeight();
            if (Math.abs(newHeight - lastCameraHeight) / lastCameraHeight > 0.1) {
                // 高度变化超过10%时更新热力图
                updateHeatmapScale(newHeight);
                lastCameraHeight = newHeight;
            }
        });
    }

    /**
     * 获取当前相机高度
     */
    function getCameraHeight() {
        if (!viewer) return 50000;
        const cartographic = viewer.camera.positionCartographic;
        return cartographic ? cartographic.height : 50000;
    }

    /**
     * 根据相机高度更新热力图缩放
     * @param {number} cameraHeight - 相机高度 (米)
     */
    function updateHeatmapScale(cameraHeight) {
        // 基准高度 (约50km时为1.0倍)
        const baseRefHeight = 50000;
        
        // 计算高度缩放比例 (相机越高，热力图越高以保持可见)
        // 使用对数缩放使变化更平滑
        const heightRatio = Math.log10(cameraHeight / 1000 + 1) / Math.log10(baseRefHeight / 1000 + 1);
        baseHeightScale = Math.max(0.3, Math.min(5.0, heightRatio * 1.5));
        
        // 尺寸缩放 (相机越高，格子相对变小，需要略微增大保持可见性)
        baseSizeScale = Math.max(0.8, Math.min(2.0, heightRatio * 1.2));

        // 更新所有热力图实体
        heatmapEntities.forEach(entity => {
            if (!entity.box || !entity.properties) return;

            const props = entity.properties;
            const lon = props.lon?.getValue ? props.lon.getValue() : props.lon;
            const lat = props.lat?.getValue ? props.lat.getValue() : props.lat;
            const baseHeight = props.baseHeight?.getValue ? props.baseHeight.getValue() : (props.height?.getValue ? props.height.getValue() : 100);
            const cellWidth = props.cellWidth?.getValue ? props.cellWidth.getValue() : 500;
            const cellDepth = props.cellDepth?.getValue ? props.cellDepth.getValue() : 500;

            // 计算新高度和尺寸
            const newHeight = baseHeight * baseHeightScale;
            const newWidth = cellWidth * baseSizeScale;
            const newDepth = cellDepth * baseSizeScale;

            // 更新位置 (高度中心点)
            entity.position = Cesium.Cartesian3.fromDegrees(lon, lat, newHeight / 2);

            // 更新尺寸
            entity.box.dimensions = new Cesium.Cartesian3(newWidth, newDepth, newHeight);
        });

        console.log(`[Heatmap3D] 缩放更新: 相机高度=${(cameraHeight/1000).toFixed(1)}km, 高度比=${baseHeightScale.toFixed(2)}, 尺寸比=${baseSizeScale.toFixed(2)}`);
    }

    /**
     * 移除相机监听器
     */
    function removeCameraListener() {
        if (cameraChangeHandler) {
            cameraChangeHandler();
            cameraChangeHandler = null;
        }
    }

    console.log('[Heatmap3D] 3D热力图模块加载完成');
})();
