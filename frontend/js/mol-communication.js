// js/mol-communication.js

// 模型视图通信管理
class MolCommunication {
    constructor() {
        this.molIframe = null;
        this.isMolReady = false;
        this.locationData = [];
        this.init();
    }

    init() {
        console.log('初始化 mol.html 通信模块');

        // 监听来自 mol.html 的消息
        window.addEventListener('message', this.handleMessage.bind(this));

        // 监听视图切换
        document.addEventListener('viewChanged', this.handleViewChange.bind(this));

        // 监听定位列表变化
        this.setupLocationObserver();

        // 初始加载位置数据
        this.updateLocationData();
    }

    handleMessage(event) {
        if (!event.data || !event.data.type) return;

        console.log('收到来自 mol.html 的消息:', event.data);

        switch (event.data.type) {
            case 'MOL_READY':
                this.handleMolReady(event);
                break;
            case 'REQUEST_LOCATION_DATA':
                this.sendLocationData();
                break;
            case 'PREDICTION_RESULT':
                this.handlePredictionResult(event.data);
                break;
            case 'PREDICTION_ERROR':
                this.handlePredictionError(event.data);
                break;
        }
    }

    handleMolReady(event) {
        this.molIframe = event.source;
        this.isMolReady = true;
        console.log('mol.html 已准备就绪');

        // 更新状态显示
        this.updateModelStatus('connected', '已连接模型界面');

        // 立即发送位置数据
        this.sendLocationData();
    }

    // 设置定位列表观察器
    setupLocationObserver() {
        // 监听添加标记点事件
        document.addEventListener('markerAdded', (event) => {
            console.log('检测到新标记点添加', event.detail);
            this.handleNewMarker(event.detail);
        });

        // 监听清除标记点事件
        document.addEventListener('markersCleared', () => {
            console.log('检测到标记点清除');
            this.updateLocationData();
        });

        // 监听用户输入确认事件
        document.addEventListener('userLocationAdded', (event) => {
            console.log('检测到用户添加位置', event.detail);
            this.updateLocationData();
        });

        // 使用 MutationObserver 监听定位列表的DOM变化
        const tableBody = document.getElementById('locationTableBody');
        if (tableBody) {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        console.log('定位列表DOM发生变化');
                        this.updateLocationData();
                    }
                });
            });

            observer.observe(tableBody, {
                childList: true,
                subtree: true
            });
        }
    }

    // 处理新添加的标记点
    handleNewMarker(markerData) {
        // 将新标记点添加到位置数据中
        const newLocation = {
            lon: markerData.lon,
            lat: markerData.lat,
            name: markerData.name || '新增采样点',
            city: markerData.city || '未知地区',
            type: 'marker',
            timestamp: new Date().toISOString()
        };

        // 添加到数据数组
        this.locationData.push(newLocation);

        // 通知 mol.html 有新数据
        this.sendLocationUpdate(newLocation, 'added');
    }

    // 获取定位列表数据
    updateLocationData() {
        const locationData = [];
        const tableBody = document.getElementById('locationTableBody');

        if (tableBody) {
            const rows = tableBody.querySelectorAll('tr');
            rows.forEach(row => {
                const lon = row.getAttribute('data-lon');
                const lat = row.getAttribute('data-lat');
                const name = row.getAttribute('data-name');
                const city = row.getAttribute('data-city');

                if (lon && lat) {
                    locationData.push({
                        lon: parseFloat(lon),
                        lat: parseFloat(lat),
                        name: name || '未命名位置',
                        city: city || '未知城市',
                        type: 'table'
                    });
                }
            });
        }

        this.locationData = locationData;
        console.log('更新位置数据:', this.locationData);

        // 如果 mol.html 已就绪，发送更新
        if (this.isMolReady) {
            this.sendLocationData();
        }

        return locationData;
    }

    // 发送位置数据到 mol.html
    sendLocationData() {
        if (!this.isMolReady || !this.molIframe) {
            console.warn('mol.html 未准备就绪，无法发送数据');
            return;
        }

        this.molIframe.postMessage({
            type: 'LOCATION_DATA',
            locations: this.locationData,
            timestamp: new Date().toISOString(),
            total: this.locationData.length
        }, '*');

        console.log('已发送位置数据到 mol.html:', this.locationData.length, '个位置');

        // 更新数据状态
        this.updateDataStatus(`已加载 ${this.locationData.length} 个监测位置`);
    }

    // 发送位置更新（单个位置）
    sendLocationUpdate(location, action) {
        if (!this.isMolReady || !this.molIframe) return;

        this.molIframe.postMessage({
            type: 'LOCATION_UPDATE',
            action: action, // 'added', 'removed', 'updated'
            location: location,
            timestamp: new Date().toISOString(),
            total: this.locationData.length
        }, '*');

        console.log(`发送位置${action}通知:`, location);
    }

    handleViewChange(event) {
        const targetView = event.detail.target;

        if (targetView === 'model-view') {
            // 切换到模型视图时，重新发送数据
            setTimeout(() => {
                this.updateLocationData();
            }, 500);
        }
    }

    handlePredictionResult(data) {
        console.log('收到预测结果:', data);
        this.showNotification('预测完成', `成功处理 ${data.locationCount} 个位置`, 'success');

        // 更新模型状态
        this.updateModelStatus('complete', `预测完成 (${data.locationCount} 个位置)`);
    }

    handlePredictionError(data) {
        console.error('预测错误:', data);
        this.showNotification('预测失败', data.error, 'error');
        this.updateModelStatus('error', `预测失败: ${data.error}`);
    }

    // 更新模型状态显示
    updateModelStatus(status, message) {
        const statusElement = document.getElementById('modelConnectionStatus');
        if (statusElement) {
            switch(status) {
                case 'connecting':
                    statusElement.textContent = '🔄 ' + message;
                    statusElement.style.color = '#f39c12';
                    break;
                case 'connected':
                    statusElement.textContent = '✅ ' + message;
                    statusElement.style.color = '#27ae60';
                    break;
                case 'ready':
                    statusElement.textContent = '✅ ' + message;
                    statusElement.style.color = '#27ae60';
                    break;
                case 'complete':
                    statusElement.textContent = '🎯 ' + message;
                    statusElement.style.color = '#27ae60';
                    break;
                case 'error':
                    statusElement.textContent = '❌ ' + message;
                    statusElement.style.color = '#e74c3c';
                    break;
            }
        }
    }

    // 更新数据状态显示
    updateDataStatus(message) {
        const dataElement = document.getElementById('modelDataStatus');
        if (dataElement) {
            dataElement.textContent = message;
        }
    }

    // 更新 iframe 状态
    updateIframeStatus(status, message) {
        const iframeStatus = document.getElementById('molIframeStatus');
        if (iframeStatus) {
            iframeStatus.className = '';
            iframeStatus.classList.add(status);
            iframeStatus.textContent = message;
        }
    }

    showNotification(title, message, type = 'info') {
        const tooltip = document.getElementById('infoTooltip');
        if (tooltip) {
            tooltip.textContent = `${title}: ${message}`;
            tooltip.style.display = 'block';
            tooltip.style.background = type === 'error' ? '#e74c3c' :
                type === 'success' ? '#27ae60' : '#3498db';

            setTimeout(() => {
                tooltip.style.display = 'none';
            }, 5000);
        }
    }
}

// 初始化通信模块
const molComm = new MolCommunication();

// 全局函数，供 iframe onload 调用
function onMolIframeLoad() {
    console.log('mol.html iframe 加载完成');
    molComm.updateIframeStatus('success', '模型界面加载成功');
}

function onMolIframeError() {
    console.error('mol.html iframe 加载失败');
    molComm.updateIframeStatus('error', '模型界面加载失败，请检查 mol.html 文件是否存在');
    molComm.updateModelStatus('error', '连接模型界面失败');
}