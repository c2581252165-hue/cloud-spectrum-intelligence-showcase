// ============================================================
// 🌍 sentinel-heatmap.js — 完整版本（包含颜色强度控制）
// ============================================================

class SentinelHeatmapManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.layer = null;
        this.currentData = null;
        this.isLoading = false;
        this.initEvents();
        this.createLegend();
        this.setupErrorHandling();
        this.initSliders(); // 初始化滑动条事件
    }

    // ------------------------------
    // 初始化滑动条事件
    // ------------------------------
    initSliders() {
        // 阈值滑动条
        const thresholdSlider = document.getElementById('thresholdSlider');
        const thresholdValue = document.getElementById('thresholdValue');

        thresholdSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value).toFixed(1);
            thresholdValue.textContent = value;
        });

        // 新增：颜色强度滑动条
        const intensitySlider = document.getElementById('intensitySlider');
        const intensityValue = document.getElementById('intensityValue');

        intensitySlider.addEventListener('input', (e) => {
            const value = e.target.value;
            intensityValue.textContent = value;
            this.updateColorIntensity(value / 100);
        });

        // 透明度滑动条
        const opacitySlider = document.getElementById('opacitySlider');
        const opacityValue = document.getElementById('opacityValue');

        opacitySlider.addEventListener('input', (e) => {
            const value = e.target.value;
            opacityValue.textContent = value;
            this.updateLayerOpacity(value / 100);
        });
    }

    // ------------------------------
    // 更新图层透明度
    // ------------------------------
    updateLayerOpacity(opacity) {
        if (this.layer) {
            this.layer.alpha = opacity;
        }
    }

    // ------------------------------
    // 更新颜色强度
    // ------------------------------
    updateColorIntensity(intensity) {
        if (this.layer && this.currentData) {
            // 这里可以添加颜色强度调整的逻辑
            // 例如：重新加载图层时应用新的强度参数
            console.log(`更新颜色强度: ${intensity}`);
            // 在实际应用中，你可能需要重新请求后端并传递强度参数
        }
    }

    // ------------------------------
    // 设置错误处理
    // ------------------------------
    setupErrorHandling() {
        this.viewer.scene.renderError.addEventListener(() => {
            console.warn('⚠️ Cesium 渲染错误，尝试恢复...');
            this.handleRenderError();
        });

        window.addEventListener('memorywarning', () => {
            console.warn('⚠️ 内存警告，清理资源...');
            this.cleanup();
        });
    }

    // ------------------------------
    // 处理渲染错误
    // ------------------------------
    handleRenderError() {
        this.removeLayer();
        if (window.gc) {
            window.gc();
        }
        setTimeout(() => {
            this.viewer.scene.requestRender();
        }, 100);
    }

    // ------------------------------
    // 初始化事件
    // ------------------------------
    initEvents() {
        const loadBtn = document.getElementById('btnLoadSentinel5PCH4');
        const removeBtn = document.getElementById('btnRemoveSentinel5PCH4');

        if (!loadBtn || !removeBtn) {
            console.error('❌ 按钮未找到');
            return;
        }

        loadBtn.addEventListener('click', () => this.loadSentinel5PCH4Heatmap(loadBtn));
        removeBtn.addEventListener('click', () => this.removeLayer());
    }

    // ------------------------------
    // 创建图例
    // ------------------------------
    createLegend() {
        const existingLegend = document.getElementById('sentinel-legend');
        if (existingLegend) {
            existingLegend.remove();
        }

        const legend = document.createElement('div');
        legend.id = 'sentinel-legend';
        legend.style.cssText = `
            position: absolute;
            bottom: 220px;
            left:320px;
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 10px;
            border-radius: 5px;
            font-family: Arial, sans-serif;
            font-size: 12px;
            z-index: 1000;
            display: none;
            max-width: 150px;
        `;

        legend.innerHTML = `
            <div style="margin-bottom: 5px; font-weight: bold;">CH4 浓度 (ppm)</div>
            <div style="display: flex; align-items: center;">
                <div style="width: 20px; height: 80px; background: linear-gradient(to top, blue, cyan, green, yellow, red); margin-right: 5px;"></div>
                <div style="display: flex; flex-direction: column; justify-content: space-between; height: 80px;">
                    <span id="legend-max">--</span>
                    <span id="legend-min">--</span>
                </div>
            </div>
            <div id="legend-threshold" style="margin-top: 5px; font-size: 11px;">阈值: --</div>
        `;

        document.body.appendChild(legend);
        this.legend = legend;
    }

    // ------------------------------
    // 加载热力图
    // ------------------------------
    async loadSentinel5PCH4Heatmap(loadBtn) {
        if (this.isLoading) {
            console.log('⚠️ 已有加载任务在进行中');
            return;
        }

        const startDate = document.getElementById('startTime')?.value || '2025-10-19';
        const endDate = document.getElementById('endTime')?.value || '2025-10-26';
        const threshold = parseFloat(document.getElementById('thresholdSlider')?.value || '1.9');
        const intensity = parseFloat(document.getElementById('intensitySlider')?.value || '80');

        if (startDate > endDate) {
            alert('❌ 起始时间不能晚于结束时间');
            return;
        }

        this.isLoading = true;
        loadBtn.disabled = true;
        loadBtn.textContent = '加载中...';

        try {
            this.cleanup();

            const response = await fetch('http://127.0.0.1:5000/sentinel/sentinel5p_gas_tiles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    start_date: startDate,
                    end_date: endDate,
                    threshold: threshold,
                    intensity: intensity,
                    gas_type: 'CH4'
                })
            });

            if (!response.ok) throw new Error(`HTTP错误 ${response.status}`);
            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error || '后端返回失败');
            }

            await new Promise(resolve => setTimeout(resolve, 100));

            this.layer = this.addTileLayer(result);
            this.currentData = result;

            // 应用当前透明度设置
            const currentOpacity = document.getElementById('opacitySlider').value / 100;
            this.updateLayerOpacity(currentOpacity);

            // 应用当前颜色强度设置
            const currentIntensity = document.getElementById('intensitySlider').value / 100;
            this.updateColorIntensity(currentIntensity);

            this.updateLegend(result.stats);
            this.updateLayerInfo(startDate, endDate, threshold, intensity);
            this.flyToROI(result.roi_bounds);

            console.log('✅ Sentinel-5P CH4 热力图加载成功');

        } catch (err) {
            console.error('❌ 加载失败:', err);
            alert(`❌ 加载失败: ${err.message}`);
            this.cleanup();
        } finally {
            this.isLoading = false;
            loadBtn.disabled = false;
            loadBtn.textContent = '加载哨兵5P甲烷图层';
        }
    }

    // ------------------------------
    // 更新图层信息显示
    // ------------------------------
    updateLayerInfo(startDate, endDate, threshold, intensity) {
        const layerInfo = document.getElementById('layerInfo');
        const dateRange = document.getElementById('infoDateRange');
        const infoThreshold = document.getElementById('infoThreshold');
        const infoIntensity = document.getElementById('infoIntensity');

        if (dateRange) dateRange.textContent = `${startDate} 至 ${endDate}`;
        if (infoThreshold) infoThreshold.textContent = `${threshold} ppm`;
        if (infoIntensity) infoIntensity.textContent = `${intensity}%`;
        if (layerInfo) layerInfo.style.display = 'block';
    }

    // ------------------------------
    // 添加瓦片图层
    // ------------------------------
    addTileLayer(data) {
        const { url_template, roi_bounds } = data;

        if (!roi_bounds || !Array.isArray(roi_bounds)) {
            throw new Error('无效的ROI边界数据');
        }

        const west = Math.min(...roi_bounds.map(p => p[0]));
        const south = Math.min(...roi_bounds.map(p => p[1]));
        const east = Math.max(...roi_bounds.map(p => p[0]));
        const north = Math.max(...roi_bounds.map(p => p[1]));

        const validWest = Math.max(west, -180);
        const validSouth = Math.max(south, -90);
        const validEast = Math.min(east, 180);
        const validNorth = Math.min(north, 90);

        const rectangle = Cesium.Rectangle.fromDegrees(validWest, validSouth, validEast, validNorth);

        const imageryProvider = new Cesium.UrlTemplateImageryProvider({
            url: url_template,
            rectangle: rectangle,
            credit: 'Sentinel-5P CH4 Data',
            minimumLevel: 0,
            maximumLevel: 12,
            tileWidth: 256,
            tileHeight: 256
        });

        const layer = this.viewer.imageryLayers.addImageryProvider(imageryProvider);
        layer.alpha = 0.75; // 默认透明度

        return layer;
    }

    // ------------------------------
    // 更新图例
    // ------------------------------
    updateLegend(stats) {
        if (!stats || !this.legend) return;

        const maxElement = document.getElementById('legend-max');
        const minElement = document.getElementById('legend-min');
        const thresholdElement = document.getElementById('legend-threshold');

        if (maxElement) maxElement.textContent = stats.max?.toFixed(2) || '--';
        if (minElement) minElement.textContent = stats.min?.toFixed(2) || '--';
        if (thresholdElement) thresholdElement.textContent = `阈值: ${stats.threshold}`;

        this.legend.style.display = 'block';
    }

    // ------------------------------
    // 移除图层
    // ------------------------------
    removeLayer() {
        if (this.layer) {
            try {
                this.viewer.imageryLayers.remove(this.layer);
                if (this.layer.imageryProvider && this.layer.imageryProvider.destroy) {
                    this.layer.imageryProvider.destroy();
                }
            } catch (error) {
                console.warn('移除图层时出错:', error);
            }
            this.layer = null;
        }

        if (this.legend) {
            this.legend.style.display = 'none';
        }

        // 隐藏图层信息
        const layerInfo = document.getElementById('layerInfo');
        if (layerInfo) {
            layerInfo.style.display = 'none';
        }
    }

    // ------------------------------
    // 清理资源
    // ------------------------------
    cleanup() {
        this.removeLayer();
        this.currentData = null;
    }

    // ------------------------------
    // 飞到ROI区域
    // ------------------------------
    flyToROI(roiBounds) {
        if (!roiBounds || !roiBounds.length) return;

        const west = Math.min(...roiBounds.map(p => p[0]));
        const south = Math.min(...roiBounds.map(p => p[1]));
        const east = Math.max(...roiBounds.map(p => p[0]));
        const north = Math.max(...roiBounds.map(p => p[1]));

        this.viewer.camera.flyTo({
            destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
            duration: 2.0,
            maximumHeight: 10000000,
            complete: () => {
                this.viewer.scene.requestRender();
            }
        });
    }

    // ------------------------------
    // 销毁管理器
    // ------------------------------
    destroy() {
        this.cleanup();
        if (this.legend) {
            this.legend.remove();
        }
    }
}

// ==================================================
// 🌍 初始化入口
// ==================================================
function initSentinelHeatmapManager() {
    try {
        if (window.viewer) {
            if (window.sentinelHeatmapManager) {
                window.sentinelHeatmapManager.destroy();
            }
            window.sentinelHeatmapManager = new SentinelHeatmapManager(window.viewer);
            console.log('✅ SentinelHeatmapManager 初始化完成');
        } else {
            setTimeout(initSentinelHeatmapManager, 1000);
        }
    } catch (error) {
        console.error('❌ SentinelHeatmapManager 初始化失败:', error);
    }
}

// 安全的初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(initSentinelHeatmapManager, 500);
    });
} else {
    setTimeout(initSentinelHeatmapManager, 500);
}

// 页面卸载时清理资源
window.addEventListener('beforeunload', () => {
    if (window.sentinelHeatmapManager) {
        window.sentinelHeatmapManager.destroy();
    }
});