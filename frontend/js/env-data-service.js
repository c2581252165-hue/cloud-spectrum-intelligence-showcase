// ============================================================
//  env-data-service.js 鈥?鐜鏁版嵁鏈嶅姟灞?
//  瀵规帴鍚庣 FastAPI + GEE 缃戞牸鍖栨暟鎹瓵PI
//  鎻愪緵锛氭皵浣撴祿搴︺€侀鍚戦閫?U/V鍒嗛噺)銆佺綉鏍煎寲鐑姏鏁版嵁
// ============================================================
(function () {
    'use strict';

    // ===== 閰嶇疆 =====
    const CONFIG = {
        // API鍩虹璺緞
        apiBase: 'http://127.0.0.1:5000',
        // 前端展示范围缩放（<1 会收紧热力图和粒子图展示范围）
        displayRadiusScale: 0.80,
        // 鏁版嵁鍒锋柊闂撮殧 (ms)
        refreshInterval: 30000,
        // 缂撳瓨杩囨湡鏃堕棿 (ms)
        cacheExpiry: 60000,
        // 缃戞牸鍒嗚鲸鐜?
        gridResolution: 0.01,  // 缁忕含搴︽闀?
        // 妯℃嫙鏁版嵁閰嶇疆
        simulation: {
            enabled: false,     // 鏃犲悗绔椂浣跨敤妯℃嫙鏁版嵁
            gridSize: 40,      // 缃戞牸鐐规暟閲?(姣忚竟)
            windBaseU: 2.5,    // 鍩虹U鍒嗛噺 (m/s)
            windBaseV: 1.8,    // 鍩虹V鍒嗛噺 (m/s)
            ch4Base: 1850,     // 鍩虹鐢茬兎娴撳害 (ppb)
            ch4Max: 2800,      // 鏈€澶х敳鐑锋祿搴?
            noiseScale: 0.3    // 鍣０绯绘暟
        }
    };

    // ===== 鐘舵€?=====
    let dataCache = new Map();
    let refreshTimers = new Map();
    let subscribers = new Map();    // 浜嬩欢璁㈤槄鑰?
    let isConnected = false;

    // ============================================================
    //  鍏叡 API
    // ============================================================
    window.EnvDataService = window.EnvDataService || {};

    /**
     * 鑾峰彇鎸囧畾鍖哄煙鐨勭綉鏍煎寲鐜鏁版嵁
     * @param {Object} options
     * @param {number} options.lon - 涓績缁忓害
     * @param {number} options.lat - 涓績绾害
     * @param {number} [options.radius=0.5] - 鍗婂緞(搴?
     * @param {string} [options.gasType='CH4'] - 姘斾綋绫诲瀷
     * @returns {Promise<Object>} 缃戞牸鏁版嵁
     */
    EnvDataService.fetchGridData = async function (options) {
        const { lon, lat, radius = 0.5, gasType = 'CH4' } = options;
        const cacheKey = `grid_${lon.toFixed(4)}_${lat.toFixed(4)}_${radius}_${gasType}`;

        // 妫€鏌ョ紦瀛?
        const cached = dataCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < CONFIG.cacheExpiry)) {
            return cached.data;
        }

        let data;
        try {
            // 灏濊瘯浠庡悗绔幏鍙?
            data = await fetchFromBackend(lon, lat, radius, gasType);
            isConnected = true;
        } catch (e) {
            console.error('[EnvDataService] 后端连接失败:', e.message);
            isConnected = false;
            throw e;
        }

        // 鏇存柊缂撳瓨
        dataCache.set(cacheKey, {
            timestamp: Date.now(),
            data: data
        });

        // 閫氱煡璁㈤槄鑰?
        emit('dataUpdate', { region: cacheKey, data });

        return data;
    };

    /**
     * 璁㈤槄鏁版嵁鏇存柊浜嬩欢
     * @param {string} event - 浜嬩欢鍚嶇О
     * @param {Function} callback - 鍥炶皟鍑芥暟
     */
    EnvDataService.subscribe = function (event, callback) {
        if (!subscribers.has(event)) {
            subscribers.set(event, []);
        }
        subscribers.get(event).push(callback);
    };

    /**
     * 鍙栨秷璁㈤槄
     */
    EnvDataService.unsubscribe = function (event, callback) {
        const subs = subscribers.get(event);
        if (subs) {
            const idx = subs.indexOf(callback);
            if (idx !== -1) subs.splice(idx, 1);
        }
    };

    /**
     * 鍚姩鑷姩鍒锋柊
     * @param {Object} region - 鍖哄煙閰嶇疆 {lon, lat, radius}
     * @param {number} [interval] - 鍒锋柊闂撮殧
     */
    EnvDataService.startAutoRefresh = function (region, interval = CONFIG.refreshInterval) {
        const key = `${region.lon}_${region.lat}`;
        
        // 娓呴櫎宸叉湁瀹氭椂鍣?
        if (refreshTimers.has(key)) {
            clearInterval(refreshTimers.get(key));
        }

        const timer = setInterval(async () => {
            try {
                await EnvDataService.fetchGridData(region);
            } catch (e) {
                console.error('[EnvDataService] 鑷姩鍒锋柊澶辫触:', e);
            }
        }, interval);

        refreshTimers.set(key, timer);
    };

    /**
     * 鍋滄鑷姩鍒锋柊
     */
    EnvDataService.stopAutoRefresh = function (region) {
        if (region) {
            const key = `${region.lon}_${region.lat}`;
            if (refreshTimers.has(key)) {
                clearInterval(refreshTimers.get(key));
                refreshTimers.delete(key);
            }
        } else {
            // 鍋滄鎵€鏈?
            refreshTimers.forEach(timer => clearInterval(timer));
            refreshTimers.clear();
        }
    };

    /**
     * 鑾峰彇椋庡満鏁版嵁 (U/V鍒嗛噺)
     * @param {number} lon
     * @param {number} lat
     * @returns {Object} {u, v, speed, direction}
     */
    EnvDataService.getWindAtPoint = function (lon, lat) {
        // 浠庣紦瀛樹腑鏌ユ壘鏈€杩戠殑缃戞牸鏁版嵁
        for (const [key, cached] of dataCache) {
            if (key.startsWith('grid_') && cached.data && cached.data.wind) {
                const wind = interpolateWind(cached.data.wind, lon, lat);
                if (wind) return wind;
            }
        }
        
        return null;
    };

    /**
     * 鑾峰彇鏌愮偣鐨勬皵浣撴祿搴?
     */
    EnvDataService.getConcentrationAtPoint = function (lon, lat, gasType = 'CH4') {
        for (const [key, cached] of dataCache) {
            if (key.startsWith('grid_') && key.includes(gasType) && cached.data) {
                const conc = interpolateConcentration(cached.data.grid, lon, lat);
                if (conc !== null) return conc;
            }
        }
        return null;
    };

    /**
     * 娓呴櫎缂撳瓨
     */
    EnvDataService.clearCache = function () {
        dataCache.clear();
    };

    /**
     * 妫€鏌ュ悗绔繛鎺ョ姸鎬?
     */
    EnvDataService.isConnected = function () {
        return isConnected;
    };

    // ============================================================
    //  鍚庣API璋冪敤
    // ============================================================

    async function fetchFromBackend(lon, lat, radius, gasType) {
        const url = `${CONFIG.apiBase}/sentinel/env-grid`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                center_lon: lon,
                center_lat: lat,
                radius: radius,
                gas_type: gasType,
                resolution: CONFIG.gridResolution
            }),
            timeout: 10000
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'API Error');
        }

        return normalizeBackendData(result.data);
    }

    /**
     * 鏍囧噯鍖栧悗绔繑鍥炴暟鎹牸寮?
     */
    function normalizeBackendData(raw) {
        const effectiveBounds = {
            minLon: raw.bounds?.min_lon || raw.min_lon,
            maxLon: raw.bounds?.max_lon || raw.max_lon,
            minLat: raw.bounds?.min_lat || raw.min_lat,
            maxLat: raw.bounds?.max_lat || raw.max_lat
        };

        const requestedBounds = raw.requested_bounds
            ? {
                minLon: raw.requested_bounds.min_lon,
                maxLon: raw.requested_bounds.max_lon,
                minLat: raw.requested_bounds.min_lat,
                maxLat: raw.requested_bounds.max_lat
            }
            : null;

        const renderBounds = isValidBounds(requestedBounds) ? requestedBounds : effectiveBounds;
        const displayBounds = shrinkBounds(renderBounds, CONFIG.displayRadiusScale);
        const remapped = remapGridAndWindToBounds(
            raw.grid || raw.concentration_grid || [],
            {
                u: raw.wind?.u || raw.u_component || [],
                v: raw.wind?.v || raw.v_component || []
            },
            effectiveBounds,
            displayBounds
        );

        return {
            bounds: displayBounds,
            grid: remapped.grid,
            wind: remapped.wind,
            panel: raw.panel || null,
            metadata: {
                gasType: raw.gas_type || 'CH4',
                requestedGasType: raw.requested_gas_type || raw.gas_type || 'CH4',
                unit: raw.unit || 'ppb',
                timestamp: raw.timestamp || Date.now(),
                source: raw.source || 'GEE',
                requestedRadius: raw.requested_radius,
                effectiveRadius: raw.effective_radius,
                effectiveBounds: effectiveBounds,
                renderBounds: renderBounds,
                displayRadiusScale: CONFIG.displayRadiusScale
            }
        };
    }

    function shrinkBounds(bounds, scale) {
        if (!isValidBounds(bounds)) return bounds;
        const s = Math.max(0.35, Math.min(1, Number(scale) || 1));
        if (s >= 0.999) return bounds;

        const centerLon = (bounds.minLon + bounds.maxLon) * 0.5;
        const centerLat = (bounds.minLat + bounds.maxLat) * 0.5;
        const halfLon = (bounds.maxLon - bounds.minLon) * 0.5 * s;
        const halfLat = (bounds.maxLat - bounds.minLat) * 0.5 * s;

        return {
            minLon: centerLon - halfLon,
            maxLon: centerLon + halfLon,
            minLat: centerLat - halfLat,
            maxLat: centerLat + halfLat
        };
    }

    function isValidBounds(bounds) {
        if (!bounds) return false;
        return Number.isFinite(bounds.minLon) &&
            Number.isFinite(bounds.maxLon) &&
            Number.isFinite(bounds.minLat) &&
            Number.isFinite(bounds.maxLat) &&
            bounds.maxLon > bounds.minLon &&
            bounds.maxLat > bounds.minLat;
    }

    function remapGridAndWindToBounds(grid, wind, sourceBounds, targetBounds) {
        if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0]) || !grid[0].length || !isValidBounds(sourceBounds) || !isValidBounds(targetBounds)) {
            return {
                grid: grid || [],
                wind: {
                    u: wind?.u || [],
                    v: wind?.v || []
                }
            };
        }

        const rows = grid.length;
        const cols = grid[0].length;
        const outRows = clampInt(rows, 20, 36);
        const outCols = clampInt(cols, 20, 36);

        const windU = Array.isArray(wind?.u) ? wind.u : [];
        const windV = Array.isArray(wind?.v) ? wind.v : [];
        const targetGrid = [];
        const targetU = [];
        const targetV = [];

        for (let i = 0; i < outRows; i++) {
            const row = [];
            const uRow = [];
            const vRow = [];
            const lat = interpolate(targetBounds.maxLat, targetBounds.minLat, outRows <= 1 ? 0 : i / (outRows - 1));

            for (let j = 0; j < outCols; j++) {
                const lon = interpolate(targetBounds.minLon, targetBounds.maxLon, outCols <= 1 ? 0 : j / (outCols - 1));
                const value = sampleGridByLonLat(grid, sourceBounds, lon, lat, (cell) => Number(cell?.value));
                row.push({
                    lon,
                    lat,
                    value: Number.isFinite(value) ? value : 0
                });

                const u = sampleGridByLonLat(windU, sourceBounds, lon, lat);
                const v = sampleGridByLonLat(windV, sourceBounds, lon, lat);
                uRow.push(Number.isFinite(u) ? u : 0);
                vRow.push(Number.isFinite(v) ? v : 0);
            }

            targetGrid.push(row);
            targetU.push(uRow);
            targetV.push(vRow);
        }

        return {
            grid: targetGrid,
            wind: { u: targetU, v: targetV }
        };
    }

    function sampleGridByLonLat(grid, bounds, lon, lat, accessor) {
        if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0]) || !grid[0].length || !isValidBounds(bounds)) {
            return null;
        }

        const rows = grid.length;
        const cols = grid[0].length;
        const width = Math.max(1e-9, bounds.maxLon - bounds.minLon);
        const height = Math.max(1e-9, bounds.maxLat - bounds.minLat);

        const nx = clamp((lon - bounds.minLon) / width, 0, 1);
        const ny = clamp((bounds.maxLat - lat) / height, 0, 1);

        const gx = nx * Math.max(0, cols - 1);
        const gy = ny * Math.max(0, rows - 1);

        const j0 = Math.floor(gx);
        const i0 = Math.floor(gy);
        const j1 = Math.min(cols - 1, j0 + 1);
        const i1 = Math.min(rows - 1, i0 + 1);
        const tx = gx - j0;
        const ty = gy - i0;

        const read = (i, j) => {
            const cell = grid[i]?.[j];
            const raw = accessor
                ? accessor(cell, i, j)
                : (typeof cell === 'number' ? cell : Number(cell?.value));
            const v = Number(raw);
            return Number.isFinite(v) ? v : NaN;
        };

        const v00 = read(i0, j0);
        const v10 = read(i0, j1);
        const v01 = read(i1, j0);
        const v11 = read(i1, j1);

        if (Number.isFinite(v00) && Number.isFinite(v10) && Number.isFinite(v01) && Number.isFinite(v11)) {
            const top = v00 * (1 - tx) + v10 * tx;
            const bottom = v01 * (1 - tx) + v11 * tx;
            return top * (1 - ty) + bottom * ty;
        }
        const nearest = read(Math.round(gy), Math.round(gx));
        return Number.isFinite(nearest) ? nearest : null;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function clampInt(value, min, max) {
        return Math.max(min, Math.min(max, Math.round(value)));
    }

    function interpolate(a, b, t) {
        return a + (b - a) * t;
    }

    // ============================================================
    //  妯℃嫙鏁版嵁鐢熸垚 (鍚庣涓嶅彲鐢ㄦ椂)
    // ============================================================

    function generateSimulatedData(centerLon, centerLat, radius, gasType) {
        const sim = CONFIG.simulation;
        const gridSize = sim.gridSize;
        const step = (radius * 2) / gridSize;

        const grid = [];
        const uField = [];
        const vField = [];

        // 鍙繚鐣欌€滃綋鍓嶅畾浣嶅煄甯傗€濅竴涓富鐑偣锛岄伩鍏嶅嚭鐜板鍥㈢儹鍔?绮掑瓙
        const hotspots = [
            { lon: centerLon, lat: centerLat, intensity: 1.0 }
        ];

        for (let i = 0; i < gridSize; i++) {
            const row = [];
            const uRow = [];
            const vRow = [];
            
            const lat = centerLat - radius + step * i;
            
            for (let j = 0; j < gridSize; j++) {
                const lon = centerLon - radius + step * j;

                // 璁＄畻娴撳害 (鍙犲姞楂樻柉鐑偣)
                let concentration = sim.ch4Base;
                hotspots.forEach(hs => {
                    const dx = lon - hs.lon;
                    const dy = lat - hs.lat;
                    const dist2 = dx * dx + dy * dy;
                    const sigma2 = Math.max(0.00035, radius * radius * 0.08);
                    concentration += (sim.ch4Max - sim.ch4Base) * hs.intensity * 
                                     Math.exp(-dist2 / (2 * sigma2));
                });
                
                // 娣诲姞鍣０
                concentration += (Math.random() - 0.5) * 100 * sim.noiseScale;
                row.push({
                    lon: lon,
                    lat: lat,
                    value: Math.max(1800, Math.min(sim.ch4Max + 200, concentration))
                });

                // 椋庡満 (甯︽棆杞拰婀嶆祦)
                const angle = Math.atan2(lat - centerLat, lon - centerLon);
                const dist = Math.sqrt(
                    Math.pow(lon - centerLon, 2) + Math.pow(lat - centerLat, 2)
                );
                
                // 涓婚鍚?+ 灞€閮ㄦ箥娴?
                const turbulence = (Math.random() - 0.5) * 0.8;
                const u = sim.windBaseU + Math.cos(angle * 0.5 + turbulence) * 0.5;
                const v = sim.windBaseV + Math.sin(angle * 0.3 + turbulence) * 0.5;
                
                uRow.push(u);
                vRow.push(v);
            }
            
            grid.push(row);
            uField.push(uRow);
            vField.push(vRow);
        }

        return {
            bounds: {
                minLon: centerLon - radius,
                maxLon: centerLon + radius,
                minLat: centerLat - radius,
                maxLat: centerLat + radius
            },
            grid: grid,
            wind: {
                u: uField,
                v: vField
            },
            metadata: {
                gasType: gasType,
                unit: 'ppb',
                timestamp: Date.now(),
                source: 'simulation'
            }
        };
    }

    /**
     * 鍦ㄥ崟鐐圭敓鎴愰鍦烘暟鎹?
     */
    function generatePointWind(lon, lat) {
        const sim = CONFIG.simulation;
        const turbulence = (Math.random() - 0.5) * 0.5;
        const u = sim.windBaseU + turbulence;
        const v = sim.windBaseV + turbulence * 0.8;
        
        return {
            u: u,
            v: v,
            speed: Math.sqrt(u * u + v * v),
            direction: Math.atan2(v, u) * 180 / Math.PI
        };
    }

    // ============================================================
    //  鏁版嵁鎻掑€?
    // ============================================================

    function interpolateWind(windData, lon, lat) {
        if (!windData || !windData.u || !windData.v) return null;
        
        // 绠€鍗曞弻绾挎€ф彃鍊?(TODO: 鎻愬崌绮惧害)
        const gridSize = windData.u.length;
        if (gridSize === 0) return null;

        // 鍋囪鍧囧寑缃戞牸
        const idx = Math.floor(gridSize / 2);
        const u = windData.u[idx]?.[idx];
        const v = windData.v[idx]?.[idx];
        if (!Number.isFinite(u) || !Number.isFinite(v)) return null;

        return {
            u: u,
            v: v,
            speed: Math.sqrt(u * u + v * v),
            direction: Math.atan2(v, u) * 180 / Math.PI
        };
    }

    function interpolateConcentration(grid, lon, lat) {
        if (!grid || grid.length === 0) return null;
        
        // 鎵炬渶杩戠偣
        let minDist = Infinity;
        let value = null;
        
        for (const row of grid) {
            for (const cell of row) {
                const dx = cell.lon - lon;
                const dy = cell.lat - lat;
                const dist = dx * dx + dy * dy;
                if (dist < minDist) {
                    minDist = dist;
                    value = cell.value;
                }
            }
        }
        
        return value;
    }

    // ============================================================
    //  浜嬩欢鍙戝皠
    // ============================================================

    function emit(event, data) {
        const subs = subscribers.get(event);
        if (subs) {
            subs.forEach(callback => {
                try {
                    callback(data);
                } catch (e) {
                    console.error('[EnvDataService] 璁㈤槄鑰呭洖璋冮敊璇?', e);
                }
            });
        }
    }

    console.log('[EnvDataService] initialized');
})();

