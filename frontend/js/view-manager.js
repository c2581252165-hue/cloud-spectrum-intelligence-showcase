// ============================================================
// View Manager
// 负责底部导航切换与跨视图清理
// ============================================================

class ViewManager {
    constructor() {
        this.currentView = "main-view";
        this.initEvents();
        console.log("[ViewManager] initialized");
    }

    initEvents() {
        const navButtons = document.querySelectorAll(".nav-btn");
        navButtons.forEach((btn) => {
            btn.addEventListener("click", (event) => {
                const targetView = event.currentTarget.getAttribute("data-target");
                this.switchView(targetView, event.currentTarget);
            });
        });
    }

    cleanupMainEffectsForView(targetView) {
        if (targetView === "main-view") return;

        if (window.AnimationTimeline && typeof window.AnimationTimeline.abort === "function") {
            window.AnimationTimeline.abort();
        }
        if (window.cinematicReset && typeof window.cinematicReset === "function") {
            window.cinematicReset();
        }
        if (window.WindParticles && typeof window.WindParticles.stop === "function") {
            window.WindParticles.stop(false);
        }
        if (window.HeatmapCanvas && typeof window.HeatmapCanvas.clear === "function") {
            window.HeatmapCanvas.clear();
        }
        if (window.Heatmap3D && typeof window.Heatmap3D.clear === "function") {
            window.Heatmap3D.clear();
        }
        if (window.TechMarker && typeof window.TechMarker.hide === "function") {
            window.TechMarker.hide(false);
        }
        if (window.InfoPanel3D && typeof window.InfoPanel3D.hide === "function") {
            window.InfoPanel3D.hide();
        }
        if (window.PerformanceMonitor && typeof window.PerformanceMonitor.stop === "function") {
            window.PerformanceMonitor.stop();
        }

        const forceHideSelectors = [
            "#wind-particles-canvas",
            "#heatmap-canvas",
            ".cft-wind-canvas",
            ".cft-overlay",
            ".timeline-dim-overlay",
            "#tech-marker",
            ".cft-card",
            ".cft-radar"
        ];
        forceHideSelectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((el) => {
                el.style.display = "none";
                el.style.opacity = "0";
            });
        });
    }

    emitViewChanged(fromView, toView) {
        document.dispatchEvent(
            new CustomEvent("viewChanged", {
                detail: {
                    from: fromView,
                    target: toView
                }
            })
        );
    }

    switchView(targetView, button) {
        if (!targetView || targetView === this.currentView) return;

        const fromView = this.currentView;
        console.log(`[ViewManager] switch: ${fromView} -> ${targetView}`);

        document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.remove("active"));
        if (button) button.classList.add("active");

        const currentViewElement = document.getElementById(fromView);
        const targetViewElement = document.getElementById(targetView);
        if (!currentViewElement || !targetViewElement) {
            console.error("[ViewManager] target view element not found");
            return;
        }

        const sentinelLegend = document.getElementById("sentinel-legend");
        const layerInfo = document.getElementById("layerInfo");
        if (targetView === "main-view") {
            if (window.sentinelHeatmapManager && window.sentinelHeatmapManager.layer) {
                if (sentinelLegend) sentinelLegend.style.display = "block";
                if (layerInfo) layerInfo.style.display = "block";
            }
        } else {
            if (sentinelLegend) sentinelLegend.style.display = "none";
            if (layerInfo) layerInfo.style.display = "none";
        }

        const cosmicTitle = document.querySelector(".cosmic-title");
        if (cosmicTitle) {
            if (targetView === "main-view") {
                cosmicTitle.classList.remove("hide");
                cosmicTitle.classList.add("show");
            } else {
                cosmicTitle.classList.remove("show");
                cosmicTitle.classList.add("hide");
            }
        }

        currentViewElement.classList.add("prev");
        currentViewElement.classList.remove("active");
        targetViewElement.classList.add("active");
        targetViewElement.classList.remove("prev");

        this.currentView = targetView;
        this.cleanupMainEffectsForView(targetView);
        this.emitViewChanged(fromView, targetView);

        setTimeout(() => {
            currentViewElement.classList.remove("prev");
            targetViewElement.classList.remove("prev");
        }, 600);
    }

    getCurrentView() {
        return this.currentView;
    }

    showView(viewId) {
        const button = document.querySelector(`[data-target="${viewId}"]`);
        if (!button) return;
        this.switchView(viewId, button);
    }
}

function initViewManager() {
    if (window.viewManager) return;
    window.viewManager = new ViewManager();

    // 支持 URL 参数切换视图，例如 main.html?view=model-view
    const params = new URLSearchParams(window.location.search);
    const targetView = params.get("view");
    if (targetView && targetView !== "main-view") {
        setTimeout(() => window.viewManager.showView(targetView), 200);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    setTimeout(initViewManager, 100);
});

if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(initViewManager, 100);
}
