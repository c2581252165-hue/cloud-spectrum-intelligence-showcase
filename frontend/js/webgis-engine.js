// ============================================================
//  webgis-engine.js — WebGIS 核心引擎与镜头控制
//  功能：抛物线飞行、2.5D视角、掩膜高亮、坐标锚定
// ============================================================
(function () {
    'use strict';

    // ===== 配置 =====
    const CONFIG = {
        // 飞行参数
        flight: {
            apexHeight: 600000,      // 抛物线顶点高度 (米)
            targetHeight: 5000,      // 目标高度 (米) - 降低以获得更准确的定位
            phase1Duration: 2.0,     // 上升阶段时长 (秒)
            phase2Duration: 2.5,     // 下降阶段时长 (秒)
            easingUp: 'CUBIC_OUT',
            easingDown: 'CUBIC_IN_OUT'
        },
        // 2.5D视角
        view25D: {
            targetPitch: -50,        // 目标俯仰角 (度) -45 ~ -60
            transitionDuration: 1.5, // 过渡时长 (秒)
            headingOffset: 15        // 航向偏移 (增加动感)
        },
        // 掩膜样式
        mask: {
            highlightColor: '#00f3ff',
            highlightAlpha: 0.6,
            fillColor: 'rgba(0, 20, 60, 0.5)',
            borderWidth: 3,
            glowIntensity: 15,
            runningLightSpeed: 2000,  // 跑马灯周期 (ms)
            dimOpacity: 0.7          // 周边暗化程度
        },
        // 锚定更新
        anchor: {
            updateInterval: 16,       // 更新间隔 (ms) ~60fps
            smoothFactor: 0.15        // 平滑因子
        }
    };

    // ===== 状态 =====
    let activeSession = null;
    let anchorUpdateId = null;
    let maskEntities = [];
    let dimLayer = null;
    let trackedAnchors = new Map();  // 被跟踪的DOM元素

    // ===== GeoJSON边界数据缓存 =====
    const regionBoundaries = {};     // 按名称缓存

    // ============================================================
    //  公共 API
    // ============================================================

    /**
     * 执行电影级飞行到目标位置
     * @param {Object} options - 飞行选项
     * @param {number} options.lon - 目标经度
     * @param {number} options.lat - 目标纬度
     * @param {string} options.name - 区域名称
     * @param {string} [options.regionId] - 区域ID (用于加载GeoJSON边界)
     * @param {Function} [options.onPhaseChange] - 阶段变化回调
     * @param {Function} [options.onComplete] - 完成回调
     */
    window.WebGISEngine = window.WebGISEngine || {};

    WebGISEngine.flyTo = function (options) {
        if (!window.viewer) {
            console.error('[WebGISEngine] Cesium viewer 未初始化');
            return Promise.reject('Viewer not ready');
        }

        return new Promise((resolve, reject) => {
            // 清理之前的会话
            cleanup();

            const session = {
                lon: parseFloat(options.lon),
                lat: parseFloat(options.lat),
                name: options.name || '目标区域',
                regionId: options.regionId || null,
                onPhaseChange: options.onPhaseChange || (() => {}),
                onComplete: options.onComplete || (() => {}),
                aborted: false,
                phase: 0,
                resolve,
                reject
            };

            activeSession = session;

            // 开始Phase 1: 抛物线跃迁
            session.onPhaseChange('leap', 1);
            executeParabolicFlight(session);
        });
    };

    /**
     * 重置/清理所有效果
     */
    WebGISEngine.reset = function () {
        cleanup();
    };

    /**
     * 注册DOM元素跟踪 (坐标锚定)
     * @param {HTMLElement} element - 要跟踪的DOM元素
     * @param {number} lon - 经度
     * @param {number} lat - 纬度
     * @param {Object} [offset] - 像素偏移 {x, y}
     * @returns {string} 跟踪ID
     */
    WebGISEngine.trackElement = function (element, lon, lat, offset = { x: 0, y: 0 }) {
        const id = 'track_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        trackedAnchors.set(id, {
            element,
            lon: parseFloat(lon),
            lat: parseFloat(lat),
            offset,
            lastScreen: { x: 0, y: 0 },
            visible: true
        });

        // 确保锚点更新循环运行
        startAnchorUpdateLoop();

        return id;
    };

    /**
     * 取消DOM元素跟踪
     * @param {string} trackId - 跟踪ID
     */
    WebGISEngine.untrackElement = function (trackId) {
        trackedAnchors.delete(trackId);
        if (trackedAnchors.size === 0) {
            stopAnchorUpdateLoop();
        }
    };

    /**
     * 更新跟踪元素的坐标
     * @param {string} trackId - 跟踪ID
     * @param {number} lon - 新经度
     * @param {number} lat - 新纬度
     */
    WebGISEngine.updateTrackPosition = function (trackId, lon, lat) {
        const anchor = trackedAnchors.get(trackId);
        if (anchor) {
            anchor.lon = parseFloat(lon);
            anchor.lat = parseFloat(lat);
        }
    };

    /**
     * 加载并显示区域高亮
     * @param {string} regionId - 区域ID
     * @param {Object|string} geojsonData - GeoJSON数据或URL
     */
    WebGISEngine.highlightRegion = async function (regionId, geojsonData) {
        // 清除之前的高亮
        clearMaskEntities();

        let geoData = geojsonData;
        
        // 如果是URL，加载数据
        if (typeof geojsonData === 'string' && geojsonData.startsWith('http')) {
            try {
                const response = await fetch(geojsonData);
                geoData = await response.json();
            } catch (e) {
                console.error('[WebGISEngine] 加载GeoJSON失败:', e);
                return;
            }
        }

        // 缓存
        regionBoundaries[regionId] = geoData;

        // 渲染高亮区域
        renderHighlightRegion(geoData);
        
        // 创建周边暗化遮罩
        createDimMask(geoData);
    };

    /**
     * 清除区域高亮
     */
    WebGISEngine.clearHighlight = function () {
        clearMaskEntities();
        removeDimMask();
    };

    /**
     * 平滑切换到2.5D视角
     * @param {number} [targetPitch] - 目标俯仰角 (可选,默认使用配置)
     */
    WebGISEngine.switchTo25DView = function (targetPitch) {
        if (!window.viewer) return;

        const pitch = targetPitch || CONFIG.view25D.targetPitch;
        transitionTo25DView(pitch);
    };

    /**
     * 经纬度转屏幕坐标
     * @param {number} lon - 经度
     * @param {number} lat - 纬度
     * @param {number} [height=0] - 高度
     * @returns {Object|null} {x, y} 或 null
     */
    WebGISEngine.geoToScreen = function (lon, lat, height = 0) {
        if (!window.viewer) return null;

        const cartesian = Cesium.Cartesian3.fromDegrees(lon, lat, height);
        const screenPos = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
            viewer.scene,
            cartesian
        );

        return screenPos ? { x: screenPos.x, y: screenPos.y } : null;
    };

    /**
     * 屏幕坐标转经纬度
     * @param {number} x - 屏幕X
     * @param {number} y - 屏幕Y
     * @returns {Object|null} {lon, lat, height} 或 null
     */
    WebGISEngine.screenToGeo = function (x, y) {
        if (!window.viewer) return null;

        const cartesian = viewer.camera.pickEllipsoid(
            new Cesium.Cartesian2(x, y),
            viewer.scene.globe.ellipsoid
        );

        if (!cartesian) return null;

        const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
        return {
            lon: Cesium.Math.toDegrees(cartographic.longitude),
            lat: Cesium.Math.toDegrees(cartographic.latitude),
            height: cartographic.height
        };
    };

    // ============================================================
    //  Phase 1: 平直飞行 (直接飞向目标,不走抛物线)
    // ============================================================
    function executeParabolicFlight(session) {
        const v = window.viewer;
        const cam = v.camera;
        const cfg = CONFIG.flight;

        // 获取当前相机位置
        const currentCart = cam.positionCartographic;
        const startLon = Cesium.Math.toDegrees(currentCart.longitude);
        const startLat = Cesium.Math.toDegrees(currentCart.latitude);

        // 计算到目标的航向
        const targetHeading = calculateHeading(startLon, startLat, session.lon, session.lat);

        session.phase = 1;
        session.onPhaseChange('leap', 1);

        // ===== 直接平飞到目标 (不经过抛物线顶点) =====
        cam.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
                session.lon,
                session.lat,
                cfg.targetHeight
            ),
            orientation: {
                heading: Cesium.Math.toRadians(targetHeading + CONFIG.view25D.headingOffset),
                pitch: Cesium.Math.toRadians(CONFIG.view25D.targetPitch), // 直接使用2.5D视角
                roll: 0
            },
            duration: cfg.phase1Duration + cfg.phase2Duration, // 合并两阶段时长
            easingFunction: getEasingFunction('CUBIC_IN_OUT'),
            complete: function () {
                if (session.aborted) return;

                // 飞行完成,进入focus阶段
                session.phase = 3;
                session.onPhaseChange('focus', 3);
                
                // 可选: 微调视角
                transitionTo25DView(CONFIG.view25D.targetPitch, session);
            }
        });
    }

    // ============================================================
    //  Phase 2: 2.5D视角平滑过渡
    // ============================================================
    function transitionTo25DView(targetPitch, session) {
        const v = window.viewer;
        const cam = v.camera;
        const cfg = CONFIG.view25D;

        const duration = cfg.transitionDuration * 1000; // 转毫秒
        const startTime = performance.now();
        const startPitch = Cesium.Math.toDegrees(cam.pitch);
        const startHeading = Cesium.Math.toDegrees(cam.heading);
        const finalPitch = targetPitch;
        const finalHeading = startHeading; // 保持航向

        function animatePitch(currentTime) {
            if (session && session.aborted) return;

            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // 使用平滑缓动
            const easeProgress = easeInOutCubic(progress);

            const newPitch = startPitch + (finalPitch - startPitch) * easeProgress;

            // 设置相机视角
            cam.setView({
                orientation: {
                    heading: Cesium.Math.toRadians(finalHeading),
                    pitch: Cesium.Math.toRadians(newPitch),
                    roll: 0
                }
            });

            if (progress < 1) {
                requestAnimationFrame(animatePitch);
            } else {
                // 过渡完成
                if (session) {
                    session.phase = 4;
                    session.onPhaseChange('complete', 4);
                    session.onComplete();
                    session.resolve({ lon: session.lon, lat: session.lat, name: session.name });
                }
            }
        }

        requestAnimationFrame(animatePitch);
    }

    // ============================================================
    //  掩膜与高亮渲染
    // ============================================================
    function renderHighlightRegion(geojsonData) {
        if (!window.viewer || !geojsonData) return;

        const cfg = CONFIG.mask;

        // 解析GeoJSON
        const features = geojsonData.features || [geojsonData];

        features.forEach((feature, index) => {
            const geometry = feature.geometry;
            if (!geometry) return;

            const coords = extractCoordinates(geometry);
            if (!coords || coords.length === 0) return;

            // 创建霓虹发光边界
            coords.forEach(ring => {
                // 主边界线
                const borderEntity = viewer.entities.add({
                    polyline: {
                        positions: Cesium.Cartesian3.fromDegreesArray(ring.flat()),
                        width: cfg.borderWidth,
                        material: new Cesium.PolylineGlowMaterialProperty({
                            glowPower: cfg.glowIntensity / 100,
                            taperPower: 0.5,
                            color: Cesium.Color.fromCssColorString(cfg.highlightColor).withAlpha(cfg.highlightAlpha)
                        }),
                        clampToGround: true
                    }
                });
                maskEntities.push(borderEntity);

                // 跑马灯效果线
                const runningLightEntity = viewer.entities.add({
                    polyline: {
                        positions: Cesium.Cartesian3.fromDegreesArray(ring.flat()),
                        width: cfg.borderWidth + 2,
                        material: createRunningLightMaterial(cfg),
                        clampToGround: true
                    }
                });
                maskEntities.push(runningLightEntity);
            });

            // 内部填充
            if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
                const fillPositions = coords[0].map(c => Cesium.Cartesian3.fromDegrees(c[0], c[1]));
                
                const fillEntity = viewer.entities.add({
                    polygon: {
                        hierarchy: new Cesium.PolygonHierarchy(fillPositions),
                        material: Cesium.Color.fromCssColorString(cfg.fillColor),
                        classificationType: Cesium.ClassificationType.BOTH
                    }
                });
                maskEntities.push(fillEntity);
            }
        });
    }

    /**
     * 创建跑马灯材质
     */
    function createRunningLightMaterial(cfg) {
        // 使用Cesium的条纹材质模拟跑马灯
        return new Cesium.StripeMaterialProperty({
            evenColor: Cesium.Color.fromCssColorString(cfg.highlightColor).withAlpha(0.9),
            oddColor: Cesium.Color.TRANSPARENT,
            offset: new Cesium.CallbackProperty(function(time) {
                return (Date.now() % cfg.runningLightSpeed) / cfg.runningLightSpeed;
            }, false),
            repeat: 20
        });
    }

    /**
     * 创建周边暗化遮罩
     */
    function createDimMask(geojsonData) {
        // 创建全屏暗化图层
        if (!dimLayer) {
            dimLayer = document.createElement('div');
            dimLayer.className = 'webgis-dim-mask';
            dimLayer.style.cssText = `
                position: fixed;
                top: 0; left: 0;
                width: 100%; height: 100%;
                background: radial-gradient(circle at center, transparent 20%, rgba(0,0,0,${CONFIG.mask.dimOpacity}) 70%);
                pointer-events: none;
                z-index: 50;
                opacity: 0;
                transition: opacity 0.8s ease;
            `;
            document.body.appendChild(dimLayer);
        }

        // 淡入
        requestAnimationFrame(() => {
            dimLayer.style.opacity = '1';
        });
    }

    function removeDimMask() {
        if (dimLayer) {
            dimLayer.style.opacity = '0';
            setTimeout(() => {
                if (dimLayer && dimLayer.parentNode) {
                    dimLayer.parentNode.removeChild(dimLayer);
                    dimLayer = null;
                }
            }, 800);
        }
    }

    function clearMaskEntities() {
        maskEntities.forEach(entity => {
            if (viewer && viewer.entities.contains(entity)) {
                viewer.entities.remove(entity);
            }
        });
        maskEntities = [];
    }

    // ============================================================
    //  坐标锚定与DOM更新
    // ============================================================
    function startAnchorUpdateLoop() {
        if (anchorUpdateId) return;

        function updateAnchors() {
            if (!window.viewer || trackedAnchors.size === 0) {
                anchorUpdateId = null;
                return;
            }

            trackedAnchors.forEach((anchor, id) => {
                const screenPos = WebGISEngine.geoToScreen(anchor.lon, anchor.lat);
                
                if (screenPos) {
                    // 平滑插值
                    const smoothX = anchor.lastScreen.x + (screenPos.x - anchor.lastScreen.x) * CONFIG.anchor.smoothFactor;
                    const smoothY = anchor.lastScreen.y + (screenPos.y - anchor.lastScreen.y) * CONFIG.anchor.smoothFactor;

                    // 首次或大幅跳跃时直接定位
                    if (anchor.lastScreen.x === 0 && anchor.lastScreen.y === 0) {
                        anchor.lastScreen.x = screenPos.x;
                        anchor.lastScreen.y = screenPos.y;
                    } else {
                        anchor.lastScreen.x = smoothX;
                        anchor.lastScreen.y = smoothY;
                    }

                    // 应用到DOM元素
                    const finalX = anchor.lastScreen.x + anchor.offset.x;
                    const finalY = anchor.lastScreen.y + anchor.offset.y;

                    anchor.element.style.transform = `translate(${finalX}px, ${finalY}px)`;
                    
                    // 检查是否在视口内
                    const inViewport = finalX > -100 && finalX < window.innerWidth + 100 &&
                                       finalY > -100 && finalY < window.innerHeight + 100;
                    
                    if (inViewport !== anchor.visible) {
                        anchor.visible = inViewport;
                        anchor.element.style.display = inViewport ? '' : 'none';
                    }
                } else {
                    // 点不在视野内
                    if (anchor.visible) {
                        anchor.visible = false;
                        anchor.element.style.display = 'none';
                    }
                }
            });

            anchorUpdateId = requestAnimationFrame(updateAnchors);
        }

        anchorUpdateId = requestAnimationFrame(updateAnchors);
    }

    function stopAnchorUpdateLoop() {
        if (anchorUpdateId) {
            cancelAnimationFrame(anchorUpdateId);
            anchorUpdateId = null;
        }
    }

    // ============================================================
    //  工具函数
    // ============================================================
    function calculateHeading(lon1, lat1, lon2, lat2) {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const lat1Rad = lat1 * Math.PI / 180;
        const lat2Rad = lat2 * Math.PI / 180;
        
        const y = Math.sin(dLon) * Math.cos(lat2Rad);
        const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
                  Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
        
        let heading = Math.atan2(y, x) * 180 / Math.PI;
        return (heading + 360) % 360;
    }

    function getEasingFunction(name) {
        const easings = {
            'LINEAR': Cesium.EasingFunction.LINEAR_NONE,
            'CUBIC_IN': Cesium.EasingFunction.CUBIC_IN,
            'CUBIC_OUT': Cesium.EasingFunction.CUBIC_OUT,
            'CUBIC_IN_OUT': Cesium.EasingFunction.CUBIC_IN_OUT,
            'QUADRATIC_IN_OUT': Cesium.EasingFunction.QUADRATIC_IN_OUT
        };
        return easings[name] || Cesium.EasingFunction.CUBIC_IN_OUT;
    }

    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function extractCoordinates(geometry) {
        switch (geometry.type) {
            case 'Polygon':
                return geometry.coordinates;
            case 'MultiPolygon':
                // 合并所有多边形的外环
                return geometry.coordinates.map(poly => poly[0]);
            case 'LineString':
                return [geometry.coordinates];
            case 'MultiLineString':
                return geometry.coordinates;
            default:
                return null;
        }
    }

    function cleanup() {
        if (activeSession) {
            activeSession.aborted = true;
            activeSession = null;
        }

        clearMaskEntities();
        removeDimMask();
    }

    // ============================================================
    //  初始化
    // ============================================================
    console.log('[WebGISEngine] 核心引擎已加载');

})();
