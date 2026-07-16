// ============================================================
//  geojson-boundaries.js — 区域边界数据管理
//  内置常用区域边界 + 动态加载支持
// ============================================================
(function () {
    'use strict';

    // ===== 边界数据缓存 =====
    const boundaryCache = {};

    // ===== 内置示例边界数据 (简化版) =====
    const BUILTIN_BOUNDARIES = {
        // 黄骅市 (简化边界)
        'huanghua': {
            type: 'Feature',
            properties: { name: '黄骅市', adcode: '130983' },
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [117.25, 38.25], [117.45, 38.25], [117.55, 38.35],
                    [117.60, 38.50], [117.55, 38.65], [117.45, 38.72],
                    [117.30, 38.70], [117.20, 38.60], [117.18, 38.45],
                    [117.20, 38.30], [117.25, 38.25]
                ]]
            }
        },
        // 沧州市
        'cangzhou': {
            type: 'Feature',
            properties: { name: '沧州市', adcode: '130900' },
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [116.20, 37.50], [117.50, 37.50], [117.80, 38.00],
                    [117.90, 38.50], [117.70, 38.90], [117.20, 39.00],
                    [116.50, 38.80], [116.10, 38.30], [116.10, 37.80],
                    [116.20, 37.50]
                ]]
            }
        },
        // 天津滨海新区
        'binhai': {
            type: 'Feature',
            properties: { name: '滨海新区', adcode: '120116' },
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [117.40, 38.80], [117.85, 38.80], [117.90, 39.00],
                    [117.85, 39.20], [117.60, 39.30], [117.35, 39.20],
                    [117.30, 39.00], [117.35, 38.85], [117.40, 38.80]
                ]]
            }
        },
        // 东营市 (胜利油田区域)
        'dongying': {
            type: 'Feature',
            properties: { name: '东营市', adcode: '370500' },
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [118.20, 37.20], [119.00, 37.20], [119.20, 37.50],
                    [119.15, 37.90], [118.80, 38.10], [118.40, 38.00],
                    [118.10, 37.70], [118.10, 37.40], [118.20, 37.20]
                ]]
            }
        }
    };

    // ===== 阿里云DataV GeoJSON API =====
    const DATAV_GEO_API = 'https://geo.datav.aliyun.com/areas_v3/bound/';

    // ===== 公共 API =====
    window.GeoJSONBoundaries = {

        /**
         * 获取区域边界数据
         * @param {string} regionId - 区域标识 (内置名称或adcode)
         * @param {Object} options - 选项
         * @returns {Promise<Object>} GeoJSON数据
         */
        async get(regionId, options = {}) {
            // 检查缓存
            if (boundaryCache[regionId]) {
                return boundaryCache[regionId];
            }

            // 检查内置数据
            if (BUILTIN_BOUNDARIES[regionId]) {
                boundaryCache[regionId] = {
                    type: 'FeatureCollection',
                    features: [BUILTIN_BOUNDARIES[regionId]]
                };
                return boundaryCache[regionId];
            }

            // 尝试作为adcode从DataV加载
            if (/^\d{6}$/.test(regionId)) {
                try {
                    const data = await this.loadFromDataV(regionId, options.full);
                    boundaryCache[regionId] = data;
                    return data;
                } catch (e) {
                    console.warn(`[GeoJSON] 从DataV加载失败: ${regionId}`, e);
                }
            }

            // 尝试从本地文件加载
            try {
                const data = await this.loadFromLocal(regionId);
                boundaryCache[regionId] = data;
                return data;
            } catch (e) {
                console.warn(`[GeoJSON] 本地加载失败: ${regionId}`, e);
            }

            return null;
        },

        /**
         * 从阿里云DataV加载
         * @param {string} adcode - 行政区划代码
         * @param {boolean} full - 是否加载完整边界
         */
        async loadFromDataV(adcode, full = false) {
            const suffix = full ? '_full' : '';
            const url = `${DATAV_GEO_API}${adcode}${suffix}.json`;
            
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            return await response.json();
        },

        /**
         * 从本地文件加载
         * @param {string} filename - 文件名 (不含扩展名)
         */
        async loadFromLocal(filename) {
            const url = `data/geojson/${filename}.json`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return await response.json();
        },

        /**
         * 注册自定义边界数据
         * @param {string} id - 区域ID
         * @param {Object} geojsonData - GeoJSON数据
         */
        register(id, geojsonData) {
            boundaryCache[id] = geojsonData;
        },

        /**
         * 清除缓存
         * @param {string} [id] - 指定ID，不传则清除全部
         */
        clearCache(id) {
            if (id) {
                delete boundaryCache[id];
            } else {
                Object.keys(boundaryCache).forEach(key => delete boundaryCache[key]);
            }
        },

        /**
         * 获取内置区域列表
         */
        getBuiltinList() {
            return Object.keys(BUILTIN_BOUNDARIES).map(key => ({
                id: key,
                name: BUILTIN_BOUNDARIES[key].properties.name,
                adcode: BUILTIN_BOUNDARIES[key].properties.adcode
            }));
        },

        /**
         * 根据名称搜索区域
         * @param {string} query - 搜索关键词
         */
        search(query) {
            const results = [];
            const lowerQuery = query.toLowerCase();

            // 搜索内置数据
            Object.entries(BUILTIN_BOUNDARIES).forEach(([id, feature]) => {
                const name = feature.properties.name;
                if (name.toLowerCase().includes(lowerQuery) || id.includes(lowerQuery)) {
                    results.push({
                        id,
                        name,
                        adcode: feature.properties.adcode,
                        source: 'builtin'
                    });
                }
            });

            // 搜索缓存
            Object.entries(boundaryCache).forEach(([id, data]) => {
                if (results.some(r => r.id === id)) return;
                
                const feature = data.features?.[0] || data;
                const name = feature.properties?.name || id;
                
                if (name.toLowerCase().includes(lowerQuery)) {
                    results.push({
                        id,
                        name,
                        adcode: feature.properties?.adcode,
                        source: 'cache'
                    });
                }
            });

            return results;
        }
    };

    // ===== 常用行政区划代码 =====
    window.GeoJSONBoundaries.ADCODES = {
        // 省级
        HEBEI: '130000',
        TIANJIN: '120000',
        SHANDONG: '370000',
        
        // 市级
        CANGZHOU: '130900',
        DONGYING: '370500',
        BINHAI: '120116',
        
        // 县级
        HUANGHUA: '130983',
        HAIXING: '130924',
        YANSHAN: '130921'
    };

    console.log('[GeoJSONBoundaries] 边界数据管理器已加载');

})();
