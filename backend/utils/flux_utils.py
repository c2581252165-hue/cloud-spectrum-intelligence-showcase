import numpy as np
from scipy.ndimage import map_coordinates, gaussian_filter

# S5P 各气体原始单位转换为 kg/m² 的系数
# CH4: ppb → kg/m²
#   XCH4(ppb) * 1e-9 * N_dry_air(2.12e25 molec/m²) * m_CH4(2.664e-26 kg) = XCH4 * 5.648e-10
# NO2: mol/m² → kg/m²  (M = 0.046 kg/mol)
# CO:  mol/m² → kg/m²  (M = 0.02801 kg/mol)
UNIT_CONVERSION = {
    'CH4': 5.648e-10,   # ppb → kg/m²
    'NO2': 0.046,       # mol/m² → kg/m²
    'CO':  0.02801,     # mol/m² → kg/m²
}


def _sample_cross_section(image_data, center_yx, line_angle_rad, half_length, num_samples=100):
    """在给定中心和方向上采样一条截面线"""
    t = np.linspace(-half_length, half_length, num_samples)
    sample_x = center_yx[1] + t * np.cos(line_angle_rad)
    sample_y = center_yx[0] - t * np.sin(line_angle_rad)
    coords = np.vstack((sample_y, sample_x))
    vals = map_coordinates(image_data, coords, order=1, mode='constant', cval=np.nan)
    return vals, sample_x, sample_y


def _find_plume_peak(image_data, source_yx, wind_dx, wind_dy, max_search_px):
    """
    沿下风向扫描，找到浓度增强的峰值位置。
    对图像做轻微平滑以去除噪声，然后沿下风向轴采样找到最高浓度点。
    """
    h, w = image_data.shape
    smoothed = gaussian_filter(image_data, sigma=1.0)
    source_val = smoothed[int(np.clip(source_yx[0], 0, h-1)),
                          int(np.clip(source_yx[1], 0, w-1))]

    best_dist = 1.0
    best_val = -np.inf

    # 沿下风向每 0.5 像素步长扫描
    for d in np.arange(0.5, max_search_px + 0.5, 0.5):
        py = source_yx[0] - wind_dy * d
        px = source_yx[1] + wind_dx * d
        iy, ix = int(round(py)), int(round(px))
        if 0 <= iy < h and 0 <= ix < w:
            val = smoothed[iy, ix]
            if val > best_val:
                best_val = val
                best_dist = d

    return best_dist, best_val


def calculate_plume_flux(
    image_data: np.ndarray,
    source_yx: tuple,
    wind_speed: float,
    wind_dir_deg: float,
    gas_type: str = 'CH4',
    pixel_size_m: float = 5500.0,
    downwind_dist_px: float = 3.0,
    line_length_px: float = 10.0
):
    """
    使用跨截面通量法计算点源排放率 (Cross-Sectional Flux Method)

    改进：自动在多个下风向距离处扫描截面线，选择增强量最大（最可能穿越烟羽）的截面。

    参数:
        image_data: 2D numpy array, 卫星影像的浓度数据 (S5P NO2/CO/CH4)
        source_yx: tuple, 排放源在图像中的像素坐标 (y, x)
        wind_speed: float, 风速 (m/s)
        wind_dir_deg: float, 风向角度 (气象学定义：风吹来的方向。0度为北风，90度为东风)
        gas_type: str, 气体类型 ('CH4', 'NO2', 'CO')
        pixel_size_m: float, 单个像素代表的实际物理宽度 (Sentinel-5P 约为 5500 米)
        downwind_dist_px: float, 截面线距离排放源的下风向距离 (像素)，作为最大搜索距离
        line_length_px: float, 截面线的总长度 (像素)

    返回:
        dict: 包含计算结果、提取的曲线数据等信息
    """
    h, w = image_data.shape

    # 1. 气象风向转换 (将"风吹来的方向"转换为"风吹去的方向"的数学角度)
    math_angle_deg = (270 - wind_dir_deg) % 360
    math_angle_rad = np.radians(math_angle_deg)

    # 风的单位向量 (数学坐标系)
    wind_dx = np.cos(math_angle_rad)
    wind_dy = np.sin(math_angle_rad)

    # 截面线方向 (垂直于风向)
    line_angle_rad = math_angle_rad + np.pi / 2
    half_length = line_length_px / 2.0
    num_samples = 100

    # 2. 在多个下风向距离处扫描截面线，找到增强量最大的那条
    #    搜索范围：从 1px 到 downwind_dist_px，每 0.5px 一步
    max_search = max(downwind_dist_px, 2.0)
    search_distances = np.arange(1.0, max_search + 0.5, 0.5)

    best_enhancement_sum = -np.inf
    best_dist = search_distances[0]
    best_profile = None
    best_sample_x = None
    best_sample_y = None
    best_background = 0

    for dist in search_distances:
        # 计算截面线中心 (下风向 dist 像素处)
        cy = source_yx[0] - (wind_dy * dist)
        cx = source_yx[1] + (wind_dx * dist)

        # 采样截面线
        vals, sx, sy = _sample_cross_section(
            image_data, (cy, cx), line_angle_rad, half_length, num_samples
        )

        valid = vals[~np.isnan(vals)]
        if len(valid) < 10:
            continue

        # 背景估计：取截面线两端各 15% 的平均值
        edge_n = max(2, int(len(valid) * 0.15))
        bg = (np.mean(valid[:edge_n]) + np.mean(valid[-edge_n:])) / 2.0

        # 增强量 = 浓度 - 背景 (只取正值)
        enh = np.maximum(valid - bg, 0)
        enh_sum = np.sum(enh)

        if enh_sum > best_enhancement_sum:
            best_enhancement_sum = enh_sum
            best_dist = dist
            best_profile = valid
            best_sample_x = sx
            best_sample_y = sy
            best_background = bg

    if best_profile is None:
        raise ValueError(
            f"在所有搜索距离上均无法获取有效截面数据。"
            f"图像尺寸={image_data.shape}，源坐标={source_yx}"
        )

    # 3. 用最佳截面计算通量
    valid_conc = best_profile
    background = best_background
    enhancement = np.maximum(valid_conc - background, 0)

    # 单位转换：将原始增强量转换为 kg/m²
    conv = UNIT_CONVERSION.get(gas_type.upper(), 1.0)
    enhancement_kg_m2 = enhancement * conv

    # Q = ∫ ΔΩ(kg/m²) · u(m/s) dx(m)
    actual_line_length_m = line_length_px * pixel_size_m
    dx_m = actual_line_length_m / len(valid_conc)

    integrated_column = np.sum(enhancement_kg_m2 * dx_m)  # kg/m
    flux_kg_per_s = integrated_column * wind_speed          # kg/s

    # 4. 诊断信息：检查剖面是否有峰值（钟形曲线）
    peak_idx = np.argmax(valid_conc)
    is_bell_shaped = (0.15 * len(valid_conc) < peak_idx < 0.85 * len(valid_conc))
    profile_type = "bell" if is_bell_shaped else "gradient"

    return {
        "flux_kg_per_s": float(flux_kg_per_s),
        "flux_kg_per_hr": float(flux_kg_per_s * 3600),
        "background_val": float(background),
        "wind_speed": float(wind_speed),
        "wind_dir_deg": float(wind_dir_deg),
        "cross_section_profile": valid_conc.tolist(),
        "enhancement_profile": enhancement.tolist(),
        "line_coords": {"x": best_sample_x.tolist(), "y": best_sample_y.tolist()},
        "best_downwind_dist_px": float(best_dist),
        "profile_type": profile_type,
        "image_shape": list(image_data.shape)
    }
