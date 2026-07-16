// ============================================================
// effects-visibility.js
// Shared visibility state for heatmap / particles.
// ============================================================
(function () {
    'use strict';

    const STORAGE_KEY = 'effects_visibility_v1';

    const state = {
        heatmap: true,
        particles: true,
        gasType: 'CH4'
    };

    let heatmapToggleEl = null;
    let particleToggleEl = null;
    let gasSelectEl = null;
    let heatmapChangeHandler = null;
    let particleChangeHandler = null;
    let gasChangeHandler = null;

    window.EffectsVisibility = window.EffectsVisibility || {};

    EffectsVisibility.isHeatmapEnabled = function () {
        return !!state.heatmap;
    };

    EffectsVisibility.isParticlesEnabled = function () {
        return !!state.particles;
    };

    EffectsVisibility.getState = function () {
        return { heatmap: state.heatmap, particles: state.particles, gasType: state.gasType };
    };

    EffectsVisibility.getSelectedGas = function () {
        return normalizeGasType(state.gasType);
    };

    EffectsVisibility.setHeatmapEnabled = function (enabled, options = {}) {
        state.heatmap = !!enabled;
        syncDom();
        persist();
        applyVisibility(options);
    };

    EffectsVisibility.setParticlesEnabled = function (enabled, options = {}) {
        state.particles = !!enabled;
        syncDom();
        persist();
        applyVisibility(options);
    };

    EffectsVisibility.setSelectedGas = function (gasType, options = {}) {
        const nextGas = normalizeGasType(gasType);
        const changed = nextGas !== state.gasType;
        state.gasType = nextGas;
        syncDom();
        persist();

        if (!changed && options.force !== true) return;

        document.dispatchEvent(new CustomEvent('effectsGasChanged', {
            detail: {
                gasType: nextGas,
                source: options.source || 'api'
            }
        }));
    };

    EffectsVisibility.applyVisibility = function (options = {}) {
        applyVisibility(options);
    };

    EffectsVisibility.bindControls = function (root = document) {
        bindControls(root);
        syncDom();
    };

    function init() {
        restore();
        bindControls(document);
        applyVisibility({ source: 'init', silent: true });
    }

    function bindControls(root = document) {
        const nextHeatmapToggle = findControl(root, 'toggleHeatmapLayer');
        const nextParticleToggle = findControl(root, 'toggleParticleLayer');
        const nextGasSelect = findControl(root, 'layerGasSelect');

        if (nextHeatmapToggle !== heatmapToggleEl) {
            if (heatmapToggleEl && heatmapChangeHandler) {
                heatmapToggleEl.removeEventListener('change', heatmapChangeHandler);
            }
            heatmapToggleEl = nextHeatmapToggle;
            if (heatmapToggleEl) {
                heatmapChangeHandler = () => {
                    EffectsVisibility.setHeatmapEnabled(!!heatmapToggleEl.checked, { source: 'toggle' });
                };
                heatmapToggleEl.addEventListener('change', heatmapChangeHandler);
            }
        }

        if (nextParticleToggle !== particleToggleEl) {
            if (particleToggleEl && particleChangeHandler) {
                particleToggleEl.removeEventListener('change', particleChangeHandler);
            }
            particleToggleEl = nextParticleToggle;
            if (particleToggleEl) {
                particleChangeHandler = () => {
                    EffectsVisibility.setParticlesEnabled(!!particleToggleEl.checked, { source: 'toggle' });
                };
                particleToggleEl.addEventListener('change', particleChangeHandler);
            }
        }

        if (nextGasSelect !== gasSelectEl) {
            if (gasSelectEl && gasChangeHandler) {
                gasSelectEl.removeEventListener('change', gasChangeHandler);
            }
            gasSelectEl = nextGasSelect;
            if (gasSelectEl) {
                gasChangeHandler = () => {
                    EffectsVisibility.setSelectedGas(gasSelectEl.value, { source: 'selector' });
                };
                gasSelectEl.addEventListener('change', gasChangeHandler);
            }
        }
    }

    function findControl(root, id) {
        if (root && typeof root.querySelector === 'function') {
            const local = root.querySelector(`#${id}`);
            if (local) return local;
        }
        return document.getElementById(id);
    }

    function syncDom() {
        if (heatmapToggleEl) heatmapToggleEl.checked = state.heatmap;
        if (particleToggleEl) particleToggleEl.checked = state.particles;
        if (gasSelectEl) gasSelectEl.value = normalizeGasType(state.gasType);
    }

    function applyVisibility(options = {}) {
        const session = getActiveSession();
        const hasLiveSessionData = session && session.envData && isMainViewActive();

        if (!state.heatmap) {
            if (window.HeatmapCanvas && typeof window.HeatmapCanvas.clear === 'function') {
                HeatmapCanvas.clear();
            }
            if (window.Heatmap3D && typeof window.Heatmap3D.clear === 'function') {
                Heatmap3D.clear();
            }
        } else if (hasLiveSessionData) {
            if (window.HeatmapCanvas && typeof window.HeatmapCanvas.render === 'function') {
                HeatmapCanvas.init(window.viewer);
                HeatmapCanvas.render(session.envData, { animated: false });
            } else if (window.Heatmap3D && typeof window.Heatmap3D.render === 'function') {
                Heatmap3D.init(window.viewer);
                Heatmap3D.render(session.envData, { animated: false });
            }
        }

        if (!state.particles) {
            if (window.WindParticles && typeof window.WindParticles.stop === 'function') {
                WindParticles.stop(false);
            }
        } else if (hasLiveSessionData && window.WindParticles && typeof window.WindParticles.start === 'function') {
            WindParticles.setData(session.envData);
            WindParticles.start({
                centerLon: session.lon,
                centerLat: session.lat,
                radius: 180,
                fadeIn: false
            });
        }

        document.dispatchEvent(new CustomEvent('effectsVisibilityChanged', {
            detail: {
                heatmap: state.heatmap,
                particles: state.particles,
                gasType: state.gasType,
                source: options.source || 'api'
            }
        }));
    }

    function getActiveSession() {
        const timelineSession = window.AnimationTimeline && typeof window.AnimationTimeline.getSession === 'function'
            ? window.AnimationTimeline.getSession()
            : null;
        if (timelineSession && !timelineSession.aborted) return timelineSession;

        const cinematicSession = window.CinematicFlow && typeof window.CinematicFlow.getSession === 'function'
            ? window.CinematicFlow.getSession()
            : null;
        return cinematicSession && !cinematicSession.aborted ? cinematicSession : null;
    }

    function normalizeGasType(gasType) {
        const g = String(gasType || 'CH4').trim().toUpperCase();
        if (g === 'NO2') return 'N2O';
        if (g === 'CH4' || g === 'CO' || g === 'N2O') return g;
        return 'CH4';
    }

    function isMainViewActive() {
        if (window.viewManager && typeof window.viewManager.getCurrentView === 'function') {
            return window.viewManager.getCurrentView() === 'main-view';
        }
        const activeView = document.querySelector('.view.active');
        return !activeView || activeView.id === 'main-view';
    }

    function persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (_err) {
            // ignore
        }
    }

    function restore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (typeof parsed.heatmap === 'boolean') state.heatmap = parsed.heatmap;
            if (typeof parsed.particles === 'boolean') state.particles = parsed.particles;
            state.gasType = normalizeGasType(parsed.gasType);
        } catch (_err) {
            // ignore
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('[EffectsVisibility] loaded');
})();
