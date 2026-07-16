// 渚ц竟鏍忎氦浜掍笌瀹氫綅鍏ュ彛
// 鐩爣锛氬皢鈥滃垪琛ㄧ偣鍑?/ 鍩庡競杈撳叆 / 鏅鸿兘浣撴寚浠も€濈粺涓€鍒板悓涓€鏉?cinematic 娴佺▼
(function initSidebar() {
    "use strict";

    let activeLocation = null;
    const locationTableBody = document.getElementById("locationTableBody");
    const confirmBtn = document.getElementById("confirmBtn");
    const cityInput = document.getElementById("city");
    const lonInput = document.getElementById("longitude");
    const latInput = document.getElementById("latitude");
    const timeRangeInput = document.getElementById("timeRange");
    const remarkInput = document.getElementById("remark");

    const sidebar = document.getElementById("sidebar");
    const toggleBtn = document.getElementById("toggleBtn");
    const leftPanel = document.getElementById("leftPanel");
    const leftToggleBtn = document.getElementById("leftToggleBtn");

    if (!locationTableBody || !confirmBtn || !sidebar || !toggleBtn) {
        console.warn("[Sidebar] Missing required DOM nodes, sidebar init skipped");
        return;
    }

    toggleBtn.addEventListener("click", () => {
        sidebar.classList.toggle("collapsed");
        toggleBtn.textContent = sidebar.classList.contains("collapsed") ? "<" : ">";
    });

    if (leftPanel && leftToggleBtn) {
        leftToggleBtn.textContent = "<";
        leftToggleBtn.addEventListener("click", () => {
            leftPanel.classList.toggle("collapsed");
            leftToggleBtn.textContent = leftPanel.classList.contains("collapsed") ? ">" : "<";
        });
    }

    bindCheckboxClick();
    bindRowClick();
    bindInputActions();
    exposeLocationNavigator();

    function bindCheckboxClick() {
        locationTableBody.querySelectorAll(".location-checkbox").forEach((checkbox) => {
            checkbox.removeEventListener("click", handleCheckboxClick);
            checkbox.addEventListener("click", handleCheckboxClick);
        });
    }

    function bindRowClick() {
        locationTableBody.addEventListener("click", (event) => {
            const row = event.target.closest("tr");
            if (!row) return;

            // 澶嶉€夋鐐瑰嚮鐢?handleCheckboxClick 澶勭悊锛岄伩鍏嶈Е鍙戜袱娆?            if (event.target.closest(".location-checkbox")) return;
            activateLocationRow(row, { source: "row-click" });
        });
    }

    function bindInputActions() {
        confirmBtn.addEventListener("click", handleUserConfirm);

        // 用户在“城市”输入框回车，直接触发城市定位
        if (cityInput) {
            cityInput.addEventListener("keydown", (event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                handleUserConfirm();
            });
        }
    }

    function handleCheckboxClick(event) {
        event.stopPropagation();
        const row = this.closest("tr");
        if (!row) return;
        activateLocationRow(row, { source: "checkbox" });
    }

    function handleUserConfirm() {
        const city = (cityInput?.value || "").trim();
        const lon = (lonInput?.value || "").trim();
        const lat = (latInput?.value || "").trim();
        const timeRange = (timeRangeInput?.value || "").trim();
        const remark = (remarkInput?.value || "").trim();

        // 蹇€熷畾浣嶆ā寮忥細鍙緭鍏ュ煄甯傦紙渚嬪鈥滈粍楠呭競鈥濓級涔熷彲浠ョ洿鎺ヨЕ鍙戜笁娈靛紡娴佺▼
        if ((!lon || !lat) && city) {
            const matched = focusByKeyword(city, { source: "city-input" });
            if (!matched) {
                showTooltip(`未找到“${city}”对应站点，请检查名称或补充经纬度`);
            }
            return;
        }

        if (!lon || !lat) {
            showTooltip("请输入经度和纬度，或仅输入城市后回车");
            return;
        }
        if (isNaN(parseFloat(lon)) || isNaN(parseFloat(lat))) {
            showTooltip("经纬度必须是数字");
            return;
        }

        const formattedLon = parseFloat(lon).toFixed(6);
        const formattedLat = parseFloat(lat).toFixed(6);
        const message = `已确认：\n城市：${city || "未填写"}\n经度：${formattedLon}\n纬度：${formattedLat}\n时间范围：${timeRange || "未填写"}\n备注：${remark || "无"}`;
        showTooltip(message);

        const name = timeRange ? `用户点 ${timeRange}` : "用户输入点";
        flyToLocation(formattedLon, formattedLat, name, city || "用户输入");
        addUserLocationToTable(city, formattedLon, formattedLat, timeRange, remark);

        document.dispatchEvent(
            new CustomEvent("userLocationAdded", {
                detail: {
                    lon: parseFloat(formattedLon),
                    lat: parseFloat(formattedLat),
                    name,
                    city: city || "用户输入",
                    timeRange,
                    remark,
                    timestamp: new Date().toISOString()
                }
            })
        );

        const userInputForm = document.getElementById("userInputForm");
        if (userInputForm) userInputForm.reset();
    }

    function normalizeKeyword(text) {
        return String(text || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "")
            .replace(/市$/, "")
            .replace(/地区$/, "");
    }

    function getRowLocation(row) {
        if (!row) return null;
        const lon = parseFloat(row.dataset.lon);
        const lat = parseFloat(row.dataset.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        return {
            row,
            lon,
            lat,
            name: row.dataset.name || `${row.dataset.city || "未知城市"}位置`,
            city: row.dataset.city || "",
            regionId: row.dataset.regionId || null
        };
    }

    function getAllLocations() {
        const rows = Array.from(locationTableBody.querySelectorAll("tr"));
        return rows
            .map(getRowLocation)
            .filter(Boolean);
    }

    function findBestLocationByKeyword(rawKeyword) {
        const keyword = normalizeKeyword(rawKeyword);
        if (!keyword) return null;

        const locations = getAllLocations();
        if (!locations.length) return null;

        // 1. 鍩庡競绮惧噯鍖归厤
        let match = locations.find((loc) => normalizeKeyword(loc.city) === keyword);
        if (match) return match;

        // 2. 鍚嶇О绮惧噯鍖归厤
        match = locations.find((loc) => normalizeKeyword(loc.name) === keyword);
        if (match) return match;

        // 3. 鍩庡競鍖呭惈鍖归厤
        match = locations.find((loc) => {
            const city = normalizeKeyword(loc.city);
            return city && (city.includes(keyword) || keyword.includes(city));
        });
        if (match) return match;

        // 4. 鍚嶇О鍖呭惈鍖归厤
        match = locations.find((loc) => normalizeKeyword(loc.name).includes(keyword));
        if (match) return match;

        return null;
    }

    function setActiveRow(row) {
        locationTableBody.querySelectorAll("tr").forEach((r) => {
            r.classList.remove("location-row-active");
            const cb = r.querySelector(".location-checkbox");
            if (cb) cb.classList.remove("checked");
        });

        row.classList.add("location-row-active");
        const activeCheckbox = row.querySelector(".location-checkbox");
        if (activeCheckbox) activeCheckbox.classList.add("checked");
    }

    function activateLocationRow(row, options = {}) {
        const location = getRowLocation(row);
        if (!location) return false;

        setActiveRow(row);
        activeLocation = {
            lon: location.lon,
            lat: location.lat,
            name: location.name,
            city: location.city
        };

        flyToLocation(
            location.lon,
            location.lat,
            location.name,
            location.city,
            location.regionId || guessRegionId(location.name, location.city)
        );

        document.dispatchEvent(
            new CustomEvent("locationFocused", {
                detail: {
                    lon: location.lon,
                    lat: location.lat,
                    name: location.name,
                    city: location.city,
                    source: options.source || "list"
                }
            })
        );

        if (options.silent !== true) {
            showTooltip(`正在定位：${location.city || location.name}`);
        }
        return true;
    }

    function focusByKeyword(keyword, options = {}) {
        const location = findBestLocationByKeyword(keyword);
        if (!location) return false;
        return activateLocationRow(location.row, {
            source: options.source || "keyword",
            silent: options.silent
        });
    }

    function addToLocationList(city, lon, lat, count) {
        const pointName = `样本点 ${count}`;
        const newRow = document.createElement("tr");
        newRow.setAttribute("data-lon", lon);
        newRow.setAttribute("data-lat", lat);
        newRow.setAttribute("data-city", city || "采样地区");
        newRow.setAttribute("data-count", count || "");
        newRow.setAttribute("data-name", pointName);
        newRow.setAttribute("data-type", "sample");

        newRow.innerHTML = `
            <td><div class="location-checkbox"></div></td>
            <td>${city || "采样地区"}</td>
            <td>${pointName}</td>
            <td>${parseFloat(lon).toFixed(6)}</td>
            <td>${parseFloat(lat).toFixed(6)}</td>
        `;
        locationTableBody.appendChild(newRow);
        bindCheckboxClick();
        console.log(`[Sidebar] added sample row: ${pointName}`);
    }

    function addUserLocationToTable(city, lon, lat, timeRange) {
        const name = timeRange ? `用户点 ${timeRange}` : "用户输入点";
        const newRow = document.createElement("tr");
        newRow.setAttribute("data-lon", lon);
        newRow.setAttribute("data-lat", lat);
        newRow.setAttribute("data-city", city || "用户输入");
        newRow.setAttribute("data-name", name);
        newRow.setAttribute("data-type", "user");

        newRow.innerHTML = `
            <td><div class="location-checkbox"></div></td>
            <td>${city || "用户输入"}</td>
            <td>${name}</td>
            <td>${lon}</td>
            <td>${lat}</td>
        `;
        locationTableBody.appendChild(newRow);
        bindCheckboxClick();
        addUserMarker(parseFloat(lon), parseFloat(lat), city || "用户输入", name);
    }

    function addUserMarker(lon, lat, city, name) {
        const cesiumViewer = window.viewer;
        if (!cesiumViewer) return;

        const markerId = `user_marker_${Date.now()}`;
        cesiumViewer.entities.add({
            id: markerId,
            position: Cesium.Cartesian3.fromDegrees(lon, lat),
            point: {
                pixelSize: 8,
                color: Cesium.Color.CYAN,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
            },
            label: {
                text: `${name}`,
                font: "12pt Microsoft YaHei",
                pixelOffset: new Cesium.Cartesian2(0, -15),
                fillColor: Cesium.Color.WHITE,
                backgroundColor: Cesium.Color.BLUE.withAlpha(0.7),
                scale: 0.7,
                showBackground: true
            }
        });
    }

    function flyToLocation(lon, lat, name, city, regionId) {
        const parsedLon = parseFloat(lon);
        const parsedLat = parseFloat(lat);
        if (!Number.isFinite(parsedLon) || !Number.isFinite(parsedLat)) return;

        const resolvedRegionId = regionId || guessRegionId(name, city);
        if (window.AnimationTimeline) {
            window.AnimationTimeline.start({
                lon: parsedLon,
                lat: parsedLat,
                name: name || "目标区域",
                city: city || "",
                regionId: resolvedRegionId
            });
            return;
        }
        if (window.viewer) {
            window.viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(parsedLon, parsedLat, 10000),
                orientation: {
                    heading: Cesium.Math.toRadians(0),
                    pitch: Cesium.Math.toRadians(-90),
                    roll: Cesium.Math.toRadians(0)
                },
                complete: () => showTooltip(`已定位到${name || "目标位置"}`)
            });
        }
    }

    function guessRegionId(name, city) {
        const text = normalizeKeyword(`${name || ""} ${city || ""}`);
        if (text.includes("黄骅") || text.includes("huanghua")) return "huanghua";
        if (text.includes("沧州") || text.includes("cangzhou")) return "cangzhou";
        if (text.includes("滨海") || text.includes("binhai")) return "binhai";
        if (text.includes("东营") || text.includes("dongying")) return "dongying";
        return null;
    }

    const fixedPoints = [];
    fixedPoints.forEach((p) => {
        if (!window.viewer) return;
        window.viewer.entities.add({
            name: p.name,
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
            point: {
                pixelSize: 10,
                color: Cesium.Color.YELLOW,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2
            },
            label: {
                text: `${p.name}`,
                font: "14px sans-serif",
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                pixelOffset: new Cesium.Cartesian2(0, -20)
            }
        });
        addToLocationList(p.city, p.lon, p.lat, p.name.replace("样本点", ""));
    });

    document.addEventListener("markerAdded", (e) => {
        const { lon, lat, city, count } = e.detail;
        addToLocationList(city, lon, lat, count);
    });

    document.addEventListener("removeLastSample", (e) => {
        const { deletedCount, name } = e.detail;
        const row = locationTableBody.querySelector(`tr[data-type="sample"][data-count="${deletedCount}"]`);
        if (!row) return;
        row.remove();
        showTooltip(`已删除列表中的样本点：${name}`);
    });

    document.addEventListener("markersCleared", () => {
        const sampleRows = locationTableBody.querySelectorAll('tr[data-type="sample"]');
        sampleRows.forEach((row) => locationTableBody.removeChild(row));
        showTooltip(`已从列表清除 ${sampleRows.length} 个样本点`);
    });

    window.addEventListener("resize", () => {
        if (sidebar.classList.contains("collapsed")) {
            toggleBtn.style.right = "0";
        } else {
            toggleBtn.style.right = `${sidebar.offsetWidth}px`;
        }

        if (leftPanel && leftToggleBtn) {
            if (leftPanel.classList.contains("collapsed")) {
                leftToggleBtn.style.left = "20px";
            } else {
                leftToggleBtn.style.left = `${leftPanel.offsetWidth + 20}px`;
            }
        }
    });

    function showTooltip(message) {
        const tooltip = document.getElementById("infoTooltip");
        if (tooltip) {
            tooltip.textContent = message;
            tooltip.style.display = "block";
            tooltip.style.background = "#3498db";
            setTimeout(() => {
                tooltip.style.display = "none";
            }, 3000);
        }
        console.log(`[Sidebar] ${message}`);
    }

    function exposeLocationNavigator() {
        window.LocationNavigator = {
            getActiveLocation: () => activeLocation,
            getAll: () => getAllLocations().map((loc) => ({
                lon: loc.lon,
                lat: loc.lat,
                name: loc.name,
                city: loc.city,
                regionId: loc.regionId || guessRegionId(loc.name, loc.city)
            })),
            findByKeyword: (keyword) => {
                const loc = findBestLocationByKeyword(keyword);
                if (!loc) return null;
                return {
                    lon: loc.lon,
                    lat: loc.lat,
                    name: loc.name,
                    city: loc.city,
                    regionId: loc.regionId || guessRegionId(loc.name, loc.city)
                };
            },
            focusByKeyword: (keyword, options = {}) => focusByKeyword(keyword, options),
            focusByCoordinates: (lon, lat, name = "目标位置", city = "目标城市") => {
                flyToLocation(lon, lat, name, city, guessRegionId(name, city));
                return true;
            }
        };
    }
})();

