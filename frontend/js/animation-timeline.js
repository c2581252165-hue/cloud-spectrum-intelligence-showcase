// ============================================================
// animation-timeline.js - 鍏ㄥ眬涓夋寮忓姩鐢荤紪鎺?// 璺緞锛氳Е鍙?-> 璺冭縼 -> 瀹氭牸 -> 鐑姏鍥?-> 绮掑瓙娴佸満
// ============================================================
(function () {
    "use strict";

    const PHASES = {
        IDLE: "idle",
        SEARCH_TRIGGER: "search-trigger",
        CAMERA_LEAP: "camera-leap",
        CAMERA_FOCUS: "camera-focus",
        REGION_HIGHLIGHT: "region-highlight",
        CARD_POPUP: "card-popup",
        HEATMAP_REVEAL: "heatmap-reveal",
        PARTICLES_START: "particles-start",
        FLOW_RUNNING: "flow-running",
        CLEANUP: "cleanup"
    };

    const TIMING = {
        searchDelayBeforeFly: 300,
        highlightDelay: 200,
        cardPopupDelay: 500,
        heatmapDelay: 500,
        particlesDelay: 120,
        particlesFadeInDuration: 800
    };

    let currentPhase = PHASES.IDLE;
    let currentSession = null;
    let isLocked = false;
    let phaseTimers = [];
    const subscribers = new Map();
    
    function isHeatmapEnabled() {
        if (window.EffectsVisibility && typeof window.EffectsVisibility.isHeatmapEnabled === "function") {
            return window.EffectsVisibility.isHeatmapEnabled();
        }
        return true;
    }

    function isParticlesEnabled() {
        if (window.EffectsVisibility && typeof window.EffectsVisibility.isParticlesEnabled === "function") {
            return window.EffectsVisibility.isParticlesEnabled();
        }
        return true;
    }

    function getSelectedGasType() {
        if (window.EffectsVisibility && typeof window.EffectsVisibility.getSelectedGas === "function") {
            return window.EffectsVisibility.getSelectedGas();
        }
        return "CH4";
    }

    window.AnimationTimeline = window.AnimationTimeline || {};

    AnimationTimeline.start = async function (options) {
        if (!isMainViewActive()) {
            console.warn("[Timeline] not in main-view, skip start");
            return;
        }
        if (isLocked) {
            console.warn("[Timeline] sequence is running, skip");
            return;
        }

        isLocked = true;
        cleanup();
        clearAllTimers();

        currentSession = {
            lon: parseFloat(options?.lon),
            lat: parseFloat(options?.lat),
            name: options?.name || "目标区域",
            city: options?.city || "",
            regionId: options?.regionId || null,
            envData: options?.envData || null,
            aborted: false,
            startTime: performance.now()
        };

        transitionTo(PHASES.SEARCH_TRIGGER);
        emit("phaseChange", { phase: PHASES.SEARCH_TRIGGER, session: currentSession });

        schedulePhase(TIMING.searchDelayBeforeFly, () => {
            if (!currentSession || currentSession.aborted) return;
            executeLeapPhase();
        });
    };

    AnimationTimeline.abort = function () {
        if (!currentSession) return;
        currentSession.aborted = true;
        clearAllTimers();
        transitionTo(PHASES.CLEANUP);
        emit("phaseChange", { phase: PHASES.CLEANUP, session: currentSession });
        cleanup();
        transitionTo(PHASES.IDLE);
        isLocked = false;
    };

    AnimationTimeline.getCurrentPhase = function () {
        return currentPhase;
    };

    AnimationTimeline.getSession = function () {
        return currentSession;
    };

    AnimationTimeline.reloadGasLayer = async function (gasType) {
        if (!currentSession || currentSession.aborted || !isMainViewActive()) return false;
        try {
            await fetchSessionEnvData(currentSession, gasType);
            renderHeatmapAndMarker(currentSession, false);
            if (isParticlesEnabled() && window.WindParticles && currentSession.envData) {
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
            return true;
        } catch (err) {
            console.warn("[Timeline] reload gas layer failed:", err);
            return false;
        }
    };

    AnimationTimeline.on = function (event, callback) {
        if (!subscribers.has(event)) subscribers.set(event, []);
        subscribers.get(event).push(callback);
        return () => AnimationTimeline.off(event, callback);
    };

    AnimationTimeline.off = function (event, callback) {
        const list = subscribers.get(event);
        if (!list) return;
        const index = list.indexOf(callback);
        if (index >= 0) list.splice(index, 1);
    };

    AnimationTimeline.setTiming = function (newTiming) {
        Object.assign(TIMING, newTiming || {});
    };

    AnimationTimeline.getTiming = function () {
        return { ...TIMING };
    };

    AnimationTimeline.skipTo = function (phase) {
        if (!currentSession) return;
        clearAllTimers();
        if (phase === PHASES.CAMERA_LEAP) executeLeapPhase();
        if (phase === PHASES.REGION_HIGHLIGHT) executeHighlightPhase();
        if (phase === PHASES.CARD_POPUP) executeCardPhase();
        if (phase === PHASES.HEATMAP_REVEAL) executeHeatmapPhase();
        if (phase === PHASES.PARTICLES_START) executeParticlesPhase();
        if (phase === PHASES.FLOW_RUNNING) enterFlowRunning();
    };

    function executeLeapPhase() {
        transitionTo(PHASES.CAMERA_LEAP);
        emit("phaseChange", { phase: PHASES.CAMERA_LEAP, session: currentSession });

        if (window.viewer && window.viewer.camera) {
            window.viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(
                    currentSession.lon,
                    currentSession.lat,
                    9000
                ),
                orientation: {
                    heading: Cesium.Math.toRadians(0),
                    pitch: Cesium.Math.toRadians(-88),
                    roll: 0
                },
                duration: 2.0,
                complete: () => {
                    transitionTo(PHASES.CAMERA_FOCUS);
                    emit("phaseChange", { phase: PHASES.CAMERA_FOCUS, session: currentSession });
                    schedulePhase(TIMING.highlightDelay, executeHighlightPhase);
                }
            });
            return;
        }

        emit("error", { phase: PHASES.CAMERA_LEAP, error: "No flight engine" });
        isLocked = false;
    }

    async function executeHighlightPhase() {
        if (!currentSession || currentSession.aborted || !isMainViewActive()) {
            AnimationTimeline.abort();
            return;
        }

        transitionTo(PHASES.REGION_HIGHLIGHT);
        emit("phaseChange", { phase: PHASES.REGION_HIGHLIGHT, session: currentSession });

        if (window.GeoJSONBoundaries && window.WebGISEngine && currentSession.regionId) {
            try {
                const geojson = await GeoJSONBoundaries.get(currentSession.regionId);
                if (geojson && !currentSession.aborted) {
                    WebGISEngine.highlightRegion(currentSession.regionId, geojson);
                }
            } catch (err) {
                console.warn("[Timeline] region highlight failed:", err);
            }
        }

        showDimOverlay();
        schedulePhase(TIMING.cardPopupDelay, executeCardPhase);
    }

    function executeCardPhase() {
        if (!currentSession || currentSession.aborted || !isMainViewActive()) {
            AnimationTimeline.abort();
            return;
        }

        transitionTo(PHASES.CARD_POPUP);
        emit("phaseChange", { phase: PHASES.CARD_POPUP, session: currentSession });

        if (window.TechMarker) {
            TechMarker.init(window.viewer);
            TechMarker.show({
                lon: currentSession.lon,
                lat: currentSession.lat,
                name: currentSession.name,
                data: {},
                animated: true
            });
        }

        emit("showCard", { session: currentSession });
        schedulePhase(TIMING.heatmapDelay, executeHeatmapPhase);
    }

    async function executeHeatmapPhase() {
        if (!currentSession || currentSession.aborted || !isMainViewActive()) {
            AnimationTimeline.abort();
            return;
        }

        transitionTo(PHASES.HEATMAP_REVEAL);
        emit("phaseChange", { phase: PHASES.HEATMAP_REVEAL, session: currentSession });

        try {
            if (!currentSession.envData) {
                await fetchSessionEnvData(currentSession);
            }
        } catch (err) {
            console.warn("[Timeline] fetch env data failed:", err);
        }

        renderHeatmapAndMarker(currentSession, true);

        schedulePhase(TIMING.particlesDelay, executeParticlesPhase);
    }

    function executeParticlesPhase() {
        if (!currentSession || currentSession.aborted || !isMainViewActive()) {
            AnimationTimeline.abort();
            return;
        }

        transitionTo(PHASES.PARTICLES_START);
        emit("phaseChange", { phase: PHASES.PARTICLES_START, session: currentSession });

        if (!isParticlesEnabled()) {
            if (window.WindParticles) WindParticles.stop(false);
            schedulePhase(TIMING.particlesFadeInDuration, enterFlowRunning);
            return;
        }

        if (window.WindParticles) {
            if (currentSession.envData) WindParticles.setData(currentSession.envData);
            WindParticles.start({
                centerLon: currentSession.lon,
                centerLat: currentSession.lat,
                radius: 180,
                fadeIn: true
            });
        }

        schedulePhase(TIMING.particlesFadeInDuration, enterFlowRunning);
    }

    function enterFlowRunning() {
        if (!currentSession || currentSession.aborted) return;
        transitionTo(PHASES.FLOW_RUNNING);
        emit("phaseChange", { phase: PHASES.FLOW_RUNNING, session: currentSession });
        emit("complete", { session: currentSession });
        isLocked = false;
    }

    function showDimOverlay() {
        let overlay = document.querySelector(".timeline-dim-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.className = "timeline-dim-overlay";
            overlay.style.cssText = `
                position: fixed;
                inset: 0;
                background: radial-gradient(circle at center, transparent 20%, rgba(0, 10, 30, 0.6) 80%);
                pointer-events: none;
                z-index: 50;
                opacity: 0;
                transition: opacity ${TIMING.highlightFadeDuration}ms ease-out;
            `;
            document.body.appendChild(overlay);
        }
        requestAnimationFrame(() => {
            overlay.style.opacity = "1";
        });
    }

    function hideDimOverlay() {
        const overlay = document.querySelector(".timeline-dim-overlay");
        if (!overlay) return;
        overlay.style.opacity = "0";
        setTimeout(() => {
            overlay.remove();
        }, 500);
    }

    function cleanup() {
        if (window.WindParticles) WindParticles.stop(false);
        if (window.HeatmapCanvas) HeatmapCanvas.clear();
        if (window.Heatmap3D) Heatmap3D.clear();
        if (window.WebGISEngine) WebGISEngine.clearHighlight();
        if (window.TechMarker) TechMarker.hide(false);
        if (window.cinematicReset) cinematicReset();
        hideDimOverlay();
        currentSession = null;
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

    function renderHeatmapAndMarker(session, animated) {
        const envData = session?.envData;
        if (!envData) return;

        if (isHeatmapEnabled()) {
            if (window.HeatmapCanvas) {
                HeatmapCanvas.init(window.viewer);
                HeatmapCanvas.render(envData, { animated: animated !== false });
            } else if (window.Heatmap3D) {
                Heatmap3D.init(window.viewer);
                Heatmap3D.render(envData, { animated: animated !== false });
            }
        } else {
            if (window.HeatmapCanvas) HeatmapCanvas.clear();
            if (window.Heatmap3D) Heatmap3D.clear();
        }

        if (window.TechMarker && envData.grid) {
            TechMarker.update(calculatePanelDataFromGrid(envData));
        }
    }

    function transitionTo(newPhase) {
        const oldPhase = currentPhase;
        currentPhase = newPhase;
        console.log(`[Timeline] ${oldPhase} -> ${newPhase}`);
    }

    function schedulePhase(delay, callback) {
        const timer = setTimeout(() => {
            if (!currentSession || currentSession.aborted) return;
            callback();
        }, delay);
        phaseTimers.push(timer);
    }

    function clearAllTimers() {
        phaseTimers.forEach((timer) => clearTimeout(timer));
        phaseTimers = [];
    }

    function emit(event, data) {
        const list = subscribers.get(event);
        if (!list || !list.length) return;
        list.forEach((callback) => {
            try {
                callback(data);
            } catch (err) {
                console.error("[Timeline] subscriber error:", err);
            }
        });
    }

    function isMainViewActive() {
        if (window.viewManager && typeof window.viewManager.getCurrentView === "function") {
            return window.viewManager.getCurrentView() === "main-view";
        }
        const activeView = document.querySelector(".view.active");
        return !activeView || activeView.id === "main-view";
    }

    function calculatePanelDataFromGrid(envData) {
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

    function normalizeNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    AnimationTimeline.PHASES = PHASES;
    window.startAnimationSequence = AnimationTimeline.start;
    window.abortAnimationSequence = AnimationTimeline.abort;

    document.addEventListener("viewChanged", (event) => {
        const target = event?.detail?.target;
        if (target && target !== "main-view") {
            AnimationTimeline.abort();
        }
    });

    document.addEventListener("effectsGasChanged", async (event) => {
        if (!currentSession || currentSession.aborted || !isMainViewActive()) return;
        const gasType = event?.detail?.gasType || getSelectedGasType();
        await AnimationTimeline.reloadGasLayer(gasType);
    });

    console.log("[AnimationTimeline] initialized");
})();


