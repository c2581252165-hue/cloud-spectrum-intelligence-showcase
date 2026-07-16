document.addEventListener('DOMContentLoaded', function () {
    const viewer = window.viewer;
    const customLocateBtn = document.getElementById('customLocateBtn');
    const clearCustomLocationBtn = document.getElementById('clearCustomLocationBtn');
    const clearPoiBtn = document.getElementById('clearPoiBtn');

    if (customLocateBtn) {
        customLocateBtn.addEventListener('click', function () {
            const lon = parseFloat((document.getElementById('customLongitude')?.value || '').trim());
            const lat = parseFloat((document.getElementById('customLatitude')?.value || '').trim());

            if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
                showTooltip('请输入有效的经纬度');
                return;
            }

            const locateName = `经纬度 ${lon.toFixed(4)}, ${lat.toFixed(4)}`;

            // Force one pipeline to avoid duplicated effects.
            if (window.AnimationTimeline && typeof window.AnimationTimeline.start === 'function') {
                window.AnimationTimeline.start({
                    lon,
                    lat,
                    name: locateName,
                    city: '自定义定位'
                });
            } else if (viewer && viewer.camera) {
                viewer.camera.flyTo({
                    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1000),
                    duration: 2.5
                });
            }

            showTooltip(`已定位到经度 ${lon}，纬度 ${lat}`);
        });
    }

    if (clearCustomLocationBtn) {
        clearCustomLocationBtn.addEventListener('click', function () {
            const lonInput = document.getElementById('customLongitude');
            const latInput = document.getElementById('customLatitude');
            if (lonInput) lonInput.value = '';
            if (latInput) latInput.value = '';
        });
    }

    if (clearPoiBtn) {
        clearPoiBtn.addEventListener('click', function () {
            const ids = ['provinceCityArea', 'prefectureCity', 'districtCounty', 'poiRequest', 'poiCategory'];
            ids.forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
        });
    }

    function showTooltip(msg) {
        const tooltip = document.getElementById('infoTooltip');
        if (!tooltip) return;
        tooltip.textContent = msg;
        tooltip.style.display = 'block';
        setTimeout(() => {
            tooltip.style.display = 'none';
        }, 2000);
    }
});
