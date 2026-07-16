// view-info.js —— 根据“鼠标位置”实时显示经纬度 & 高程（地表点）+ 视角高度
(function initViewInfo() {
    const lonEl = document.getElementById('lonValue');
    const latEl = document.getElementById('latValue');
    const altEl = document.getElementById('altValue');
    const heightEl = document.getElementById('heightValue');
    const markerEl = document.getElementById('markerCount');

    // 1) 鼠标移动时，拾取鼠标所在像素下的地表点
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
    handler.setInputAction((move) => {
        const pos = move.endPosition;

        // 首选地球表面（地形）拾取；若没有地形/取不到，则回退到椭球表面
        const ray = viewer.camera.getPickRay(pos);
        let cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cartesian) {
            cartesian = Cesium.SceneTransforms.wgs84ToWindowCoordinates(viewer.scene, viewer.camera.position)
                ? Cesium.Ellipsoid.WGS84.cartesianToCartographic(
                    Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(
                        Cesium.Cartesian3.clone(viewer.camera.position)
                    )
                )
                : null;
        }

        // 转经纬度 + 椭球高（HAE）
        if (cartesian) {
            const carto = Cesium.Cartographic.fromCartesian(cartesian);
            const lon = Cesium.Math.toDegrees(carto.longitude);
            const lat = Cesium.Math.toDegrees(carto.latitude);
            const hae = carto.height; // 椭球高（与 Google Earth AMSL 有基准差）

            lonEl.textContent = lon.toFixed(6);   // 保留 6 位更精细
            latEl.textContent = lat.toFixed(6);
            altEl.textContent = hae.toFixed(2);
        }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // 2) 视角高度：相机到屏幕中心对应地表点的距离（与“相机高度”不同）
    function updateViewHeight() {
        const center = new Cesium.Cartesian2(
            viewer.canvas.clientWidth / 2,
            viewer.canvas.clientHeight / 2
        );
        const ray = viewer.camera.getPickRay(center);
        const ground = viewer.scene.globe.pick(ray, viewer.scene);
        const h = ground
            ? Cesium.Cartesian3.distance(viewer.camera.position, ground)
            : 0.0;
        heightEl.textContent = h.toFixed(2);

        // 标记点数量（你原来依赖全局 markers）
        if (typeof markers !== 'undefined') {
            markerEl.textContent = markers.length;
        }
    }

    // 时钟驱动“视角高度”等信息更新
    viewer.clock.onTick.addEventListener(updateViewHeight);
})();
