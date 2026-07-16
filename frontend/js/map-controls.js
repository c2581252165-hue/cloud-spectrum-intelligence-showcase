// 地图控制：定位中国、切换图层、显示/隐藏地名、样本点
(function initMapControls() {
    let markers = [];
    let isImageryVisible = true;
    let isNamesVisible = true;
    // 关键：声明一个全局的事件监听变量，用于存储和销毁旧监听
    let mapClickHandler = null;

    // 1. 定位到中国按钮
    document.getElementById('btnFlyToChina').addEventListener('click', () => {
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(103.84, 31.15, 20000000),
            orientation: {
                heading: Cesium.Math.toRadians(348.4202942851978),
                pitch: Cesium.Math.toRadians(-89.74026687972041),
                roll: Cesium.Math.toRadians(0)
            },
            complete: () => {
                showTooltip('已定位到中国');
                document.querySelectorAll('.location-checkbox').forEach(cb => cb.classList.remove('checked'));
                document.querySelectorAll('#locationTableBody tr').forEach(row => row.classList.remove('location-row-active'));
            }
        });
    });

    // 2. 切换影像图层（保持不变）
    document.getElementById('btnToggleImagery').addEventListener('click', () => {
        isImageryVisible = !isImageryVisible;
        viewer.imageryLayers.get(0).show = isImageryVisible;
        viewer.imageryLayers.get(1).show = isImageryVisible;
        const message = isImageryVisible ? '已显示影像图层' : '已隐藏影像图层';
        showTooltip(message);
    });

    // 3. 显示/隐藏地名（保持不变）
    document.getElementById('btnToggleNames').addEventListener('click', () => {
        isNamesVisible = !isNamesVisible;
        if (wtfs && wtfs._labelPrimitives) {
            wtfs._labelPrimitives.forEach(p => p.show = isNamesVisible);
        }
        if (wtfs && wtfs._primitives) {
            wtfs._primitives.forEach(p => {
                if (p instanceof Cesium.Primitive) p.show = isNamesVisible;
            });
        }
        viewer.entities.values.forEach(e => {
            if (e.label) e.label.show = isNamesVisible;
        });
        const msg = isNamesVisible ? '已显示所有地名' : '已隐藏所有地名';
        showTooltip(msg);
    });

    // 4. 添加样本点按钮（修复：只触发事件，不直接操作DOM）
    document.getElementById('btnAddMarker').addEventListener('click', () => {
        showTooltip('请点击地图添加样本点');

        // 关键步骤：如果存在旧监听，先销毁（避免累积）
        if (mapClickHandler) {
            mapClickHandler.destroy();
            mapClickHandler = null;
        }

        // 创建新的监听（此时确保只有1个监听）
        mapClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);

        mapClickHandler.setInputAction((event) => {
            const ray = viewer.camera.getPickRay(event.position);
            const position = viewer.scene.globe.pick(ray, viewer.scene);

            if (position) {
                // ===== 点击地图时清理飞行可视化效果 =====
                if (window.cinematicReset) {
                    cinematicReset();
                }

                // 按当前样本点数量+1计数（删除后从1开始）
                const currentCount = markers.length + 1;
                const pointName = `样本点${currentCount}`;
                const carto = Cesium.Cartographic.fromCartesian(position);
                const lon = parseFloat(Cesium.Math.toDegrees(carto.longitude).toFixed(6));
                const lat = parseFloat(Cesium.Math.toDegrees(carto.latitude).toFixed(6));

                // 创建样本点
                const entity = viewer.entities.add({
                    id: `sample_${currentCount}`,
                    position: position,
                    point: {
                        pixelSize: 10,
                        color: Cesium.Color.RED,
                        outlineWidth: 2,
                        outlineColor: Cesium.Color.WHITE
                    },
                    label: {
                        text: pointName,
                        font: '14px sans-serif',
                        fillColor: Cesium.Color.WHITE,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(0, -20),
                        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                        show: isNamesVisible
                    }
                });

                const markerData = {
                    count: currentCount,
                    entity: entity,
                    lon: lon,
                    lat: lat,
                    name: pointName
                };

                markers.push(markerData);

                showTooltip(`已添加 ${pointName}`);

                // ============ 修复：只触发事件，不直接操作DOM ============
                const markerEvent = new CustomEvent('markerAdded', {
                    detail: {
                        lon: lon,
                        lat: lat,
                        name: pointName,
                        city: '采样地区',
                        count: currentCount, // 添加计数信息
                        id: `sample_${currentCount}`,
                        timestamp: new Date().toISOString()
                    }
                });
                document.dispatchEvent(markerEvent);

                // 同步到输入框
                document.getElementById('longitude').value = lon;
                document.getElementById('latitude').value = lat;

                // 更新标记点计数
                updateMarkerCount();

                // 销毁当前监听（确保一次点击只生成一个点）
                mapClickHandler.destroy();
                mapClickHandler = null;
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    });

    // 5. 清除样本点按钮（修改为清除所有样本点）
    document.getElementById('btnClearMarkers').addEventListener('click', () => {
        if (markers.length === 0) {
            showTooltip('没有可删除的样本点');
            return;
        }

        // 清除所有标记点实体
        markers.forEach(marker => {
            viewer.entities.remove(marker.entity);
        });

        // 记录被清除的标记点信息
        const clearedMarkers = [...markers];

        // 清空标记点数组
        markers = [];

        // ============ 修复：只触发事件，不直接操作DOM ============
        const clearEvent = new CustomEvent('markersCleared', {
            detail: {
                clearedCount: clearedMarkers.length,
                markers: clearedMarkers
            }
        });
        document.dispatchEvent(clearEvent);

        // 更新标记点计数
        updateMarkerCount();

        showTooltip(`已清除所有样本点（共${clearedMarkers.length}个）`);
    });

    // ============ 删除重复的DOM操作函数 ============
    // 移除 addLocationToTable 和 clearSamplePointsFromTable 函数
    // 这些操作现在由 sidebar.js 统一处理

    // ============ 保留：更新标记点计数 ============
    function updateMarkerCount() {
        const markerCount = markers.length;
        const markerElement = document.getElementById('markerCount');
        if (markerElement) {
            markerElement.textContent = markerCount;
        }
    }

    // ============ 新增：工具提示函数 ============
    function showTooltip(message) {
        const tooltip = document.getElementById('infoTooltip');
        if (tooltip) {
            tooltip.textContent = message;
            tooltip.style.display = 'block';
            tooltip.style.background = '#3498db';

            setTimeout(() => {
                tooltip.style.display = 'none';
            }, 3000);
        }

        // 同时在控制台输出
        console.log(`地图控制: ${message}`);
    }

    // ============ 新增：初始化标记点计数 ============
    document.addEventListener('DOMContentLoaded', function() {
        updateMarkerCount();
    });

})();
