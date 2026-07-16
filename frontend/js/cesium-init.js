// cesium-init.js
// 全局变量（供其他模块使用）
let viewer, wtfs, isNamesVisible = true, isImageryVisible = true, markers = [];

(function initCesium() {
    // 天地图Token和基础配置
    const token = 'YOUR_TIANDITU_TOKEN';
    const tdtUrl = 'https://t{s}.tianditu.gov.cn/';
    const subdomains = ['0', '1', '2', '3', '4', '5', '6', '7'];

    // 1. 加载影像服务（天地图影像）
    /*const imgMap = new Cesium.UrlTemplateImageryProvider({
        url: 'https://t{s}.tianditu.gov.cn/img_w/wmts?service=wmts&request=GetTile&version=1.0.0' +
            '&LAYER=img&tileMatrixSet=w&TileMatrix={z}&TileRow={y}&TileCol={x}&style=default&format=tiles&tk=' + token,
        subdomains: subdomains,
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        maximumLevel: 18
    });*/
    const imgMap = new Cesium.UrlTemplateImageryProvider({
        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', // ***
        tilingScheme: new Cesium.WebMercatorTilingScheme(), // ***
        maximumLevel: 50, // ***
        credit: 'ArcGIS World Imagery' // ***
    });



    // 2. 加载地形服务（天地图地形）
    const terrainUrls = [];
    for (let i = 0; i < subdomains.length; i++) {
        const url = tdtUrl.replace('{s}', subdomains[i]) + 'mapservice/swdx?T=elv_c&tk=' + token;
        terrainUrls.push(url);
    }
    const terrainProvider = new Cesium.GeoTerrainProvider({ urls: terrainUrls });

    // 3. 初始化Cesium Viewer
    viewer = new Cesium.Viewer('cesiumContainer', {
        infoBox: false,
        baseLayerPicker: false,
        terrain: new Cesium.Terrain(terrainProvider),
        baseLayer: new Cesium.ImageryLayer(imgMap),
        timeline: false,
        animation: false,
    });

    // 隐藏Cesium版权信息
    viewer._cesiumWidget._creditContainer.style.display = 'none';
    // 优化渲染（支持像素化处理）
    if (Cesium.FeatureDetection.supportsImageRenderingPixelated()) {
        viewer.resolutionScale = window.devicePixelRatio;
    }
    viewer.scene.postProcessStages.fxaa.enabled = true;

    // 4. 加载国界服务
    const iboMap = new Cesium.UrlTemplateImageryProvider({
        url: tdtUrl + 'DataServer?T=ibo_w&x={x}&y={y}&l={z}&tk=' + token,
        subdomains: subdomains,
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        maximumLevel: 18,
        enablePickFeatures: false
    });
    viewer.imageryLayers.addImageryProvider(iboMap);

    // 5. 加载三维地名服务
    wtfs = new Cesium.GeoWTFS({
        viewer,
        subdomains: subdomains,
        metadata: {
            boundBox: { minX: -180, minY: -90, maxX: 180, maxY: 90 },
            minLevel: 1,
            maxLevel: 20
        },
        aotuCollide: true,
        collisionPadding: [5, 10, 8, 5],
        serverFirstStyle: true,
        labelGraphics: {
            font: "28px sans-serif",
            fontSize: 28,
            fillColor: Cesium.Color.WHITE,
            scale: 0.5,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 5,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: false,
            backgroundColor: Cesium.Color.RED,
            backgroundPadding: new Cesium.Cartesian2(10, 10),
            horizontalOrigin: Cesium.HorizontalOrigin.MIDDLE,
            verticalOrigin: Cesium.VerticalOrigin.TOP,
            eyeOffset: Cesium.Cartesian3.ZERO,
            pixelOffset: new Cesium.Cartesian2(0, 8)
        },
        billboardGraphics: {
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            eyeOffset: Cesium.Cartesian3.ZERO,
            pixelOffset: Cesium.Cartesian2.ZERO,
            alignedAxis: Cesium.Cartesian3.ZERO,
            color: Cesium.Color.WHITE,
            rotation: 0,
            scale: 1,
            width: 18,
            height: 18
        }
    });
    // 配置地名服务URL
    wtfs.getTileUrl = function () {
        return tdtUrl + 'mapservice/GetTiles?lxys={z},{x},{y}&VERSION=1.0.0&tk=' + token;
    };
    wtfs.getIcoUrl = function () {
        return tdtUrl + 'mapservice/GetIcon?id={id}&tk=' + token;
    };
    // 初始化地名服务范围（中国区域）
    wtfs.initTDT([
        { x: 6, y: 1, level: 2, boundBox: { minX: 90, minY: 0, maxX: 135, maxY: 45 } },
        { x: 7, y: 1, level: 2, boundBox: { minX: 135, minY: 0, maxX: 180, maxY: 45 } },
        { x: 6, y: 0, level: 2, boundBox: { minX: 90, minY: 45, maxX: 135, maxY: 90 } },
        { x: 7, y: 0, level: 2, boundBox: { minX: 135, minY: 45, maxX: 180, maxY: 90 } },
        { x: 5, y: 1, level: 2, boundBox: { minX: 45, minY: 0, maxX: 90, maxY: 45 } },
        { x: 4, y: 1, level: 2, boundBox: { minX: 0, minY: 0, maxX: 45, maxY: 45 } },
        { x: 5, y: 0, level: 2, boundBox: { minX: 45, minY: 45, maxX: 90, maxY: 90 } },
        { x: 4, y: 0, level: 2, boundBox: { minX: 0, minY: 45, maxX: 45, maxY: 90 } }
    ]);

    // 6. 初始定位到中国
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(103.84, 31.15, 20000000),
        orientation: {
            heading: Cesium.Math.toRadians(348.4202942851978),
            pitch: Cesium.Math.toRadians(-89.74026687972041),
            roll: Cesium.Math.toRadians(0)
        },
        imageryProvider: new Cesium.WebMapTileServiceImageryProvider({
            url: 'https://t{0-7}.tianditu.gov.cn/ibo_w/wmts?tk=YOUR_TOKEN',
            layer: 'ibo',
            style: 'default',
            format: 'tiles',
            tileMatrixSetID: 'w',
            maximumLevel: 18,
            // 添加重试配置
            retryAttempts: 3,
            retryDelay: 1000,
        }),
        complete: () => showTooltip('已定位到中国')
    });
    window.viewer = viewer;
})();

// 全局提示框函数（供所有模块使用）
function showTooltip(message) {
    const tooltip = document.getElementById('infoTooltip');
    tooltip.textContent = message;
    tooltip.style.display = 'block';
    setTimeout(() => tooltip.style.display = 'none', 2000);
}

