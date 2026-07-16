// ============================================================
// cinematic-flyto.js
// Cinematic location flow: leap -> focus -> flow.
// ============================================================
(function () {
    'use strict';

    let currentSession = null;
    let phaseTimers = [];
    let cardTrackRaf = null;

    let overlayEl = null;
    let cardEl = null;

    window.CinematicFlow = window.CinematicFlow || {};
    window.CinematicFlow.getSession = function () {
        return currentSession;
    };
    
    function isHeatmapEnabled() {
        if (window.EffectsVisibility && typeof window.EffectsVisibility.isHeatmapEnabled === 'function') {
            return window.EffectsVisibility.isHeatmapEnabled();
        }
        return true;
    }

    function isParticlesEnabled() {
        if (window.EffectsVisibility && typeof window.EffectsVisibility.isParticlesEnabled === 'function') {
            return window.EffectsVisibility.isParticlesEnabled();
        }
        return true;
    }

    function getSelectedGasType() {
        if (window.EffectsVisibility && typeof window.EffectsVisibility.getSelectedGas === 'function') {
            return window.EffectsVisibility.getSelectedGas();
        }
        return 'CH4';
    }

    window.cinematicFlyTo = function (lon, lat, name, opts = {}) {
        if (!window.viewer) return;

        const parsedLon = Number(lon);
        const parsedLat = Number(lat);
        if (!Number.isFinite(parsedLon) || !Number.isFinite(parsedLat)) return;

        cleanup();

        const session = {
            lon: parsedLon,
            lat: parsedLat,
            name: name || '目标区域',
            city: opts.city || '',
            regionId: opts.regionId || null,
            aborted: false,
            envData: null
        };

        currentSession = session;
        ensureDom();
        showOverlay(true);

        phaseLeap(session);
    };

    window.cinematicReset = function () {
        cleanup();
    };

    function phaseLeap(session) {
        if (session.aborted) return;

        if (window.WebGISEngine && typeof WebGISEngine.flyTo === 'function') {
            WebGISEngine.flyTo({
                lon: session.lon,
                lat: session.lat,
                name: session.name,
                regionId: session.regionId,
                onComplete: function () {
                    if (!session.aborted) {
                        phaseFocus(session);
                    }
                }
            }).catch((err) => {
                console.warn('[Cinematic] WebGISEngine fly failed, fallback to camera fly:', err);
                basicFlyTo(session, () => phaseFocus(session));
            });
            return;
        }

        basicFlyTo(session, () => phaseFocus(session));
    }

    function basicFlyTo(session, done) {
        const viewer = window.viewer;
        if (!viewer || !viewer.camera) {
            if (done) done();
            return;
        }

        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(session.lon, session.lat, 12000),
            orientation: {
                heading: Cesium.Math.toRadians(0),
                pitch: Cesium.Math.toRadians(-55),
                roll: 0
            },
            duration: 2.0,
            complete: () => {
                if (done) done();
            }
        });
    }

    function phaseFocus(session) {
        if (session.aborted) return;

        showCard(session);

        if (window.TechMarker) {
            TechMarker.init(window.viewer);
            TechMarker.show({
                lon: session.lon,
                lat: session.lat,
                name: session.name,
                data: {},
                animated: true
            });
        }

        schedule(500, () => phaseFlow(session));
    }

    async function phaseFlow(session) {
        if (session.aborted) return;

        try {
            await fetchSessionEnvData(session);
        } catch (err) {
            console.warn('[Cinematic] env data fetch failed:', err);
        }

        if (session.aborted) return;

        if (session.envData) {
            if (isHeatmapEnabled()) {
                if (window.HeatmapCanvas) {
                    HeatmapCanvas.init(window.viewer);
                    HeatmapCanvas.render(session.envData, { animated: true });
                } else if (window.Heatmap3D) {
                    Heatmap3D.init(window.viewer);
                    Heatmap3D.render(session.envData, { animated: true });
                }
            } else {
                if (window.HeatmapCanvas) HeatmapCanvas.clear();
                if (window.Heatmap3D) Heatmap3D.clear();
            }

            if (isParticlesEnabled() && window.WindParticles) {
                WindParticles.setData(session.envData);
                WindParticles.start({
                    centerLon: session.lon,
                    centerLat: session.lat,
                    radius: 180,
                    fadeIn: true
                });
            } else if (window.WindParticles) {
                WindParticles.stop(false);
            }

            if (window.TechMarker) {
                TechMarker.update(calculatePanelData(session.envData));
            }
        }

        if (window.PerformanceMonitor) {
            PerformanceMonitor.start();
        }
    }

    function calculatePanelData(envData) {
        const panel = envData?.panel || envData?.metadata?.panel || null;
        if (panel) {
            return {
                CH4: normalizeNumber(panel.CH4),
                CO: normalizeNumber(panel.CO),
                NO2: normalizeNumber(panel.NO2 ?? panel.N2O)
            };
        }

        let sum = 0;
        let count = 0;

        if (envData && Array.isArray(envData.grid)) {
            envData.grid.forEach((row) => {
                row.forEach((cell) => {
                    sum += Number(cell.value || 0);
                    count += 1;
                });
            });
        }

        const ch4 = count > 0 ? sum / count : null;
        return {
            CH4: normalizeNumber(ch4),
            CO: null,
            NO2: null
        };
    }

    async function fetchSessionEnvData(session, gasType) {
        if (!session || session.aborted || !window.EnvDataService) return null;
        const data = await EnvDataService.fetchGridData({
            lon: session.lon,
            lat: session.lat,
            radius: 0.12,
            gasType: gasType || getSelectedGasType()
        });
        session.envData = data;
        return data;
    }

    function isMainViewActive() {
        if (window.viewManager && typeof window.viewManager.getCurrentView === 'function') {
            return window.viewManager.getCurrentView() === 'main-view';
        }
        const activeView = document.querySelector('.view.active');
        return !activeView || activeView.id === 'main-view';
    }

    function normalizeNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function ensureDom() {
        if (!overlayEl) {
            overlayEl = document.createElement('div');
            overlayEl.className = 'cft-overlay';
            overlayEl.style.opacity = '0';
            document.body.appendChild(overlayEl);
        }

        if (!cardEl) {
            cardEl = document.createElement('div');
            cardEl.className = 'cft-card';
            cardEl.style.display = 'none';
            document.body.appendChild(cardEl);
        }
    }

    function showOverlay(visible) {
        if (!overlayEl) return;
        overlayEl.style.opacity = visible ? '1' : '0';
        overlayEl.style.display = 'block';
    }

    function showCard(session) {
        if (!cardEl) return;

        cardEl.innerHTML = `
            <div class="cft-card-header">
                <span class="cft-card-dot"></span>
                <span class="cft-card-title">区域温室气体监测</span>
                <button class="cft-card-close" type="button" onclick="cinematicReset()">×</button>
            </div>
            <div class="cft-card-location">${session.name}${session.city ? ' · ' + session.city : ''}</div>
            <div class="cft-card-coord">${session.lon.toFixed(4)}°E &nbsp; ${session.lat.toFixed(4)}°N</div>
            <div class="cft-card-footer">定位完成，正在渲染热力图与粒子流场…</div>
        `;

        cardEl.style.display = 'block';
        cardEl.classList.add('cft-card-show');
        startCardTracking(session);
    }

    function startCardTracking(session) {
        if (cardTrackRaf) {
            cancelAnimationFrame(cardTrackRaf);
            cardTrackRaf = null;
        }

        const tick = () => {
            if (!currentSession || currentSession.aborted || !cardEl || !window.viewer) return;

            const point = Cesium.Cartesian3.fromDegrees(session.lon, session.lat, 0);
            const screen = Cesium.SceneTransforms.wgs84ToWindowCoordinates(window.viewer.scene, point);
            if (screen) {
                cardEl.style.left = `${screen.x - 170}px`;
                cardEl.style.top = `${screen.y - 300}px`;
            }

            cardTrackRaf = requestAnimationFrame(tick);
        };

        cardTrackRaf = requestAnimationFrame(tick);
    }

    function schedule(delay, task) {
        const timer = setTimeout(() => {
            if (!currentSession || currentSession.aborted) return;
            task();
        }, delay);
        phaseTimers.push(timer);
    }

    function clearTimers() {
        phaseTimers.forEach((id) => clearTimeout(id));
        phaseTimers = [];
    }

    function cleanup() {
        if (currentSession) {
            currentSession.aborted = true;
        }

        clearTimers();

        if (cardTrackRaf) {
            cancelAnimationFrame(cardTrackRaf);
            cardTrackRaf = null;
        }

        if (window.WindParticles) {
            WindParticles.stop(false);
        }
        if (window.HeatmapCanvas) {
            HeatmapCanvas.clear();
        }
        if (window.Heatmap3D) {
            Heatmap3D.clear();
        }
        if (window.TechMarker) {
            TechMarker.hide(false);
        }
        if (window.InfoPanel3D) {
            InfoPanel3D.hide();
        }
        if (window.PerformanceMonitor) {
            PerformanceMonitor.stop();
        }
        if (window.WebGISEngine) {
            WebGISEngine.clearHighlight();
        }

        if (overlayEl) {
            overlayEl.style.opacity = '0';
            overlayEl.style.display = 'none';
        }
        if (cardEl) {
            cardEl.classList.remove('cft-card-show');
            cardEl.style.display = 'none';
        }

        currentSession = null;
    }

    document.addEventListener('effectsGasChanged', async (event) => {
        if (!currentSession || currentSession.aborted || !isMainViewActive()) return;
        try {
            await fetchSessionEnvData(currentSession, event?.detail?.gasType || getSelectedGasType());
            if (isHeatmapEnabled()) {
                if (window.HeatmapCanvas) {
                    HeatmapCanvas.init(window.viewer);
                    HeatmapCanvas.render(currentSession.envData, { animated: false });
                } else if (window.Heatmap3D) {
                    Heatmap3D.init(window.viewer);
                    Heatmap3D.render(currentSession.envData, { animated: false });
                }
            } else {
                if (window.HeatmapCanvas) HeatmapCanvas.clear();
                if (window.Heatmap3D) Heatmap3D.clear();
            }

            if (isParticlesEnabled() && window.WindParticles) {
                WindParticles.setData(currentSession.envData);
                WindParticles.start({
                    centerLon: currentSession.lon,
                    centerLat: currentSession.lat,
                    radius: 180,
                    fadeIn: false
                });
            } else if (window.WindParticles) {
                WindParticles.stop(false);
            }

            if (window.TechMarker) {
                TechMarker.update(calculatePanelData(currentSession.envData));
            }
        } catch (err) {
            console.warn('[Cinematic] reload gas layer failed:', err);
        }
    });

    console.log('[Cinematic] loaded');
})();
