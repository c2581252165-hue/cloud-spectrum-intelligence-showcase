from flask import Blueprint, request, jsonify
import os, torch, traceback, base64, rasterio, re, time
import matplotlib.pyplot as plt
import numpy as np
from model.unet import Unet
from utils.gee_utils import export_80x80_sentinel2_local, get_huanghua_region_by_grid, _gee_call_with_retry
from utils.predict_utils import predict_with_model,create_plume_overview_map
from utils.tif_utils import process_and_save_plume_tiles
from utils.flux_utils import calculate_plume_flux
from utils.agent_workflow import run_agent_closed_loop
import tempfile
from datetime import datetime, timedelta
import ee
sentinel_bp = Blueprint('sentinel', __name__)

# 排放率计算短期缓存（避免重复参数反复打 GEE）
_FLUX_CACHE = {}
_FLUX_CACHE_TTL_SEC = 15 * 60
_FLUX_CACHE_MAX_ITEMS = 100

# 影像级缓存：同地点/同时段/同气体复用一次 GEE 拉取结果
_FLUX_IMAGE_CACHE = {}
_FLUX_IMAGE_CACHE_TTL_SEC = 30 * 60
_FLUX_IMAGE_CACHE_MAX_ITEMS = 40


def _flux_cache_cleanup():
    now = time.time()
    expired = [k for k, v in _FLUX_CACHE.items() if now - v.get('ts', 0) > _FLUX_CACHE_TTL_SEC]
    for k in expired:
        _FLUX_CACHE.pop(k, None)
    # 防止缓存无限增长
    if len(_FLUX_CACHE) > _FLUX_CACHE_MAX_ITEMS:
        oldest = sorted(_FLUX_CACHE.items(), key=lambda item: item[1].get('ts', 0))
        for k, _ in oldest[:len(_FLUX_CACHE) - _FLUX_CACHE_MAX_ITEMS]:
            _FLUX_CACHE.pop(k, None)


def _flux_image_cache_cleanup():
    now = time.time()
    expired = [k for k, v in _FLUX_IMAGE_CACHE.items() if now - v.get('ts', 0) > _FLUX_IMAGE_CACHE_TTL_SEC]
    for k in expired:
        _FLUX_IMAGE_CACHE.pop(k, None)
    if len(_FLUX_IMAGE_CACHE) > _FLUX_IMAGE_CACHE_MAX_ITEMS:
        oldest = sorted(_FLUX_IMAGE_CACHE.items(), key=lambda item: item[1].get('ts', 0))
        for k, _ in oldest[:len(_FLUX_IMAGE_CACHE) - _FLUX_IMAGE_CACHE_MAX_ITEMS]:
            _FLUX_IMAGE_CACHE.pop(k, None)


def _validate_file_name(name):
    """楠岃瘉 file_name 鍙寘鍚畨鍏ㄥ瓧绗︼紝闃叉璺緞閬嶅巻"""
    return bool(re.match(r'^[A-Za-z0-9_\-]+$', name))


def _validate_lat_lon(lat, lon):
    """验证经纬度范围。"""
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return -90 <= lat <= 90 and -180 <= lon <= 180


_GAS_LAYER_CONFIG = {
    'CH4': {
        'collection': 'COPERNICUS/S5P/OFFL/L3_CH4',
        'band': 'CH4_column_volume_mixing_ratio_dry_air',
        'unit': 'ppb',
    },
    'CO': {
        'collection': 'COPERNICUS/S5P/OFFL/L3_CO',
        'band': 'CO_column_number_density',
        'unit': 'mol/m²',
    },
    'NO2': {
        'collection': 'COPERNICUS/S5P/OFFL/L3_NO2',
        'band': 'tropospheric_NO2_column_number_density',
        'unit': 'mol/m²',
    },
}

_GAS_ALIASES = {
    'N2O': 'NO2',  # 当前链路暂以 NO2 作为第三气体实时指标
}


def _normalize_requested_gas(gas_type):
    requested = (gas_type or 'CH4').strip().upper()
    normalized = _GAS_ALIASES.get(requested, requested)
    return requested, normalized


def _safe_float(value):
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if np.isnan(out) or np.isinf(out):
        return None
    return out


def _default_time_range(days=14):
    end_date = datetime.utcnow().date()
    start_date = end_date - timedelta(days=days)
    return start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d')


def _resize_array2d(values, rows, cols):
    arr = np.array(values, dtype=np.float64)
    if arr.size == 0:
        return np.zeros((rows, cols), dtype=np.float64)

    if arr.ndim == 1:
        arr = arr.reshape((-1, 1))
    if arr.ndim != 2:
        arr = arr.reshape((arr.shape[0], -1))

    src_rows, src_cols = arr.shape
    if src_rows == rows and src_cols == cols:
        return np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)

    row_idx = np.rint(np.linspace(0, max(0, src_rows - 1), rows)).astype(int)
    col_idx = np.rint(np.linspace(0, max(0, src_cols - 1), cols)).astype(int)
    resized = arr[np.ix_(row_idx, col_idx)]
    return np.nan_to_num(resized, nan=0.0, posinf=0.0, neginf=0.0)


def _sample_image_grid(image, band_name, roi, rows, cols):
    sample = _gee_call_with_retry(
        lambda: image.sampleRectangle(region=roi, defaultValue=0).getInfo(),
        max_retries=2,
        delay=2,
    )
    raw = (sample or {}).get('properties', {}).get(band_name, [])
    return _resize_array2d(raw, rows, cols)


def _build_grid_cells(values, min_lon, max_lon, min_lat, max_lat):
    rows, cols = values.shape
    lon_step = (max_lon - min_lon) / max(1, cols - 1)
    lat_step = (max_lat - min_lat) / max(1, rows - 1)

    grid = []
    for i in range(rows):
        row = []
        lat = max_lat - i * lat_step
        for j in range(cols):
            lon = min_lon + j * lon_step
            row.append({
                'lon': float(lon),
                'lat': float(lat),
                'value': float(values[i, j]),
            })
        grid.append(row)
    return grid


def _grid_variation_stats(values):
    arr = np.array(values, dtype=np.float64)
    if arr.size == 0:
        return {
            'min': 0.0,
            'max': 0.0,
            'range': 0.0,
            'unique': 0,
        }

    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    vmin = float(np.min(arr))
    vmax = float(np.max(arr))
    unique = int(np.unique(np.round(arr, 10)).size)
    return {
        'min': vmin,
        'max': vmax,
        'range': float(vmax - vmin),
        'unique': unique,
    }


def _repair_grid_missing(values, gas_type):
    arr = np.array(values, dtype=np.float64)
    if arr.size == 0:
        return arr

    arr = np.nan_to_num(arr, nan=np.nan, posinf=np.nan, neginf=np.nan)
    if gas_type == 'CH4':
        valid = np.isfinite(arr) & (arr > 100.0)
    else:
        valid = np.isfinite(arr) & (arr > 0.0)

    if np.any(valid):
        fill = float(np.nanmedian(arr[valid]))
        arr = np.where(valid, arr, fill)
    else:
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)

    return arr


def _compute_panel_values(roi, time_start, time_end):
    panel = {'CH4': None, 'CO': None, 'NO2': None}

    for gas_type in ('CH4', 'CO', 'NO2'):
        cfg = _GAS_LAYER_CONFIG[gas_type]
        try:
            collection = ee.ImageCollection(cfg['collection']) \
                .filterBounds(roi) \
                .filterDate(time_start, time_end) \
                .select(cfg['band'])

            count = int(_gee_call_with_retry(lambda: collection.size().getInfo(), max_retries=2, delay=1))
            if count <= 0:
                continue

            stats = _gee_call_with_retry(
                lambda: collection.median().clip(roi).reduceRegion(
                    reducer=ee.Reducer.mean(),
                    geometry=roi,
                    scale=5500,
                    maxPixels=1e8
                ).getInfo(),
                max_retries=2,
                delay=1
            )
            panel[gas_type] = _safe_float((stats or {}).get(cfg['band']))
        except Exception as exc:
            print(f"[env-grid] panel summary failed for {gas_type}: {exc}")

    # 保持前端兼容：若界面仍读取 N2O，则映射 NO2 真值（不再随机）
    panel['N2O'] = panel.get('NO2')
    return panel


# *** 浣跨敤鐩稿浜庡綋鍓嶆枃浠剁殑璺緞 ***
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))  # routes directory
PARENT_DIR = os.path.dirname(CURRENT_DIR)  # backend directory
MODEL_CHECKPOINT_PATH = os.path.join(PARENT_DIR, 'model', 'best_epoch_weights.pth')
GLOBAL_MODEL = None  # *** 鍏ㄥ眬妯″瀷鍙橀噺 ***


def load_global_model():
    global GLOBAL_MODEL
    if GLOBAL_MODEL is None:
        model = Unet(num_classes=2, in_channels=13)
        try:
            checkpoint = torch.load(MODEL_CHECKPOINT_PATH, map_location='cpu', weights_only=False)
            state_dict = checkpoint.get('model', checkpoint)
            state_dict = {k.replace('module.', ''): v for k, v in state_dict.items()}
            model.load_state_dict(state_dict)
            model.eval()  # *** 鍒囨崲涓烘帹鐞嗘ā寮?***
            GLOBAL_MODEL = model
            print("鉁?鍏ㄥ眬妯″瀷鍔犺浇鎴愬姛!")
        except Exception as e:
            print(f"鉂?鍏ㄥ眬妯″瀷鍔犺浇澶辫触: {e}")
            raise e
    return GLOBAL_MODEL

# 鍚姩鏃剁珛鍗冲姞杞芥ā鍨?
model=load_global_model()  # *** 纭繚 Flask 鍚姩鏃舵ā鍨嬪氨鍔犺浇濂?***


from flask_cors import cross_origin

@sentinel_bp.route('/process_sentinel', methods=['POST', 'OPTIONS'])
@cross_origin()
def process_sentinel():
    try:
        # 澶勭悊棰勬璇锋眰
        if request.method == 'OPTIONS':
            return jsonify({'status': 'ok'}), 200
            
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '璇锋眰鏁版嵁鏃犳晥'}), 400
        print(f"鏀跺埌璇锋眰鍙傛暟: {data}")
        
        # 鍙傛暟
        lat = data.get('lat', 50.9042)
        lon = data.get('lon', 19.4074)
        scale = data.get('scale', 10)
        time_start = data.get('time_start', '2024-05-01')
        time_end = data.get('time_end', '2024-05-31')
        file_name = data.get('file_name', 'Sentinel2_80x80')
        threshold = data.get('threshold', 0.5)
        location_name = data.get('name', '监测点')
        
        # 鍙傛暟鏍￠獙
        if not _validate_lat_lon(lat, lon):
            return jsonify({'success': False, 'error': '经纬度参数无效'}), 400
        if not _validate_file_name(file_name):
            return jsonify({'success': False, 'error': 'file_name 鍙厑璁稿瓧姣嶃€佹暟瀛椼€佷笅鍒掔嚎鍜岃繛瀛楃'}), 400
        
        print(f"澶勭悊浣嶇疆: {location_name} ({lat}, {lon}), 鏃堕棿: {time_start} 鍒?{time_end}")
        
        # Create a temp download directory and store final artifacts under backend/output.
        temp_output_root = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'output', 'temp')
        os.makedirs(temp_output_root, exist_ok=True)
        temp_dir = os.path.join(temp_output_root, file_name)
        os.makedirs(temp_dir, exist_ok=True)
        
        # 鏈€缁堣緭鍑虹洰褰曪紙鐢ㄤ簬淇濆瓨RGB鍜屾帺鑶滐級
        # Resolve the final output directory under backend/output.
        final_output_dir = os.path.join(os.path.dirname(__file__), '..', 'output', file_name)
        final_output_dir = os.path.abspath(final_output_dir)
        os.makedirs(final_output_dir, exist_ok=True)
        print(f"馃搧 鏈€缁堣緭鍑虹洰褰曪紙缁濆璺緞锛? {final_output_dir}")

        # 1) 涓嬭浇褰卞儚
        result = export_80x80_sentinel2_local(
            lat=lat, lon=lon, scale=scale,
            time_start=time_start, time_end=time_end,
            file_name=file_name, output_dir=temp_dir
        )
        if not result['success']:
            return jsonify({'success': False, 'error': result.get('error', '褰卞儚涓嬭浇澶辫触')}), 400
        
        output_path = result['output_path']
        
        # 2) 棰勬祴
        output_prob, output_mask, mean_concentration = predict_with_model(
            output_path, model, threshold=threshold
        )
        
        # 3) 鍙鍖栫粨鏋?- 鐩存帴淇濆瓨PNG
        print(f"馃搳 寮€濮嬬敓鎴愬浘鍍?..")
        from PIL import Image
        
        try:
            # 璇诲彇TIF
            with rasterio.open(output_path) as src:
                img_np = src.read().astype(np.float32)
            
            # TOA鏁版嵁宸叉槸0-1鑼冨洿锛屾棤闇€褰掍竴鍖?

            # 鎻愬彇RGB (B4, B3, B2)
            rgb = np.stack([img_np[3], img_np[2], img_np[1]], axis=-1)
            rgb = np.nan_to_num(rgb, nan=0.0)
            m = np.nanmax(rgb)
            if m == 0 or np.isnan(m):
                m = 1.0
            rgb = np.clip(rgb / m, 0, 1) * 255
            rgb = rgb.astype(np.uint8)
            
            # 淇濆瓨RGB
            rgb_path = os.path.join(final_output_dir, 'rgb.png')
            Image.fromarray(rgb).save(rgb_path)
            print(f"鉁?RGB宸蹭繚瀛? {rgb_path}")
            
        except Exception as e:
            print(f"⚠️ RGB生成失败: {e}, 使用灰色占位图")
            rgb_path = os.path.join(final_output_dir, 'rgb.png')
            Image.new('RGB', (80, 80), color=(100, 100, 100)).save(rgb_path)
        
        try:
            # 淇濆瓨鎺╄啘
            mask_uint8 = (output_mask * 255).astype(np.uint8)
            mask_path = os.path.join(final_output_dir, 'mask.png')
            Image.fromarray(mask_uint8, mode='L').save(mask_path)
            print(f"鉁?鎺╄啘宸蹭繚瀛? {mask_path}")
            
        except Exception as e:
            print(f"⚠️ 掩膜生成失败: {e}, 使用黑色占位图")
            mask_path = os.path.join(final_output_dir, 'mask.png')
            Image.new('L', (80, 80), color=0).save(mask_path)
        
        # 纭鏂囦欢瀛樺湪
        rgb_exists = os.path.exists(rgb_path)
        mask_exists = os.path.exists(mask_path)
        print(f"馃搵 鏂囦欢妫€鏌?- RGB瀛樺湪: {rgb_exists}, 鎺╄啘瀛樺湪: {mask_exists}")
        
        image_paths = {
            'rgb': rgb_path,
            'mask': mask_path
        }

        detection_ratio = float(output_mask.mean())
        city_name = data.get('city', '')
        agent_workflow = run_agent_closed_loop(
            lat=float(lat),
            lon=float(lon),
            location_name=str(location_name),
            city=str(city_name),
            gas_type='CH4',
            mean_concentration=float(mean_concentration),
            detection_ratio=detection_ratio,
            threshold_used=float(threshold),
            time_start=str(time_start),
            time_end=str(time_end),
            rgb_image=f"/flaskk/output/{file_name}/rgb.png",
            mask_image=f"/flaskk/output/{file_name}/mask.png",
            operator=str(data.get('operator', 'agent-auto')),
            persist=True,
        )

        # 杩斿洖缁撴灉 - 杩斿洖瀹屾暣鐨?URL锛堝寘鎷湇鍔″櫒鍦板潃锛?
        return jsonify({
            'success': True,
            'message': '澶勭悊瀹屾垚（智能体闭环已执行）',
            'images': {
                'rgb': f"http://localhost:5000/flaskk/output/{file_name}/rgb.png",
                'mask': f"http://localhost:5000/flaskk/output/{file_name}/mask.png"
            },
            'analysis_results': {
                'mean_concentration': float(mean_concentration),
                'detection_ratio': detection_ratio,
                'threshold_used': threshold
            },
            'location_info': {
                'lat': lat,
                'lon': lon,
                'name': location_name,
                'city': city_name
            },
            'time_range': {
                'start': time_start,
                'end': time_end
            },
            'monitor_data': {
                'processed_at': datetime.now().isoformat(),
                'location_type': '监测点'
            },
            'agent_workflow': agent_workflow
        })

    except Exception as e:
        error_traceback = traceback.format_exc()
        print(f"澶勭悊杩囩▼涓彂鐢熼敊璇? {str(e)}")
        return jsonify({
            'success': False,
            'error': f'澶勭悊杩囩▼涓彂鐢熼敊璇? {str(e)}'
        }), 500


# ======================================================
# 澶氭皵浣?CO/NO2)澶勭悊 - 鍩轰簬 Sentinel-5P 娴撳害鏁版嵁
# ======================================================
@sentinel_bp.route('/process_sentinel_gas', methods=['POST', 'OPTIONS'])
@cross_origin()
def process_sentinel_gas():
    """处理 CO/NO2 气体检测请求，使用 Sentinel-5P 数据生成浓度分析与掩膜。"""
    gas_type = 'NO2'
    try:
        if request.method == 'OPTIONS':
            return jsonify({'status': 'ok'}), 200

        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '璇锋眰鏁版嵁鏃犳晥'}), 400
        lat = data.get('lat', 38.5348)
        lon = data.get('lon', 117.6791)
        time_start = data.get('time_start', '2024-05-01')
        time_end = data.get('time_end', '2024-05-31')
        file_name = data.get('file_name', 'S5P_gas')
        threshold = data.get('threshold', 0.5)
        location_name = data.get('name', '监测点')
        gas_type = data.get('gas_type', 'NO2').upper()

        if not _validate_lat_lon(lat, lon):
            return jsonify({'success': False, 'error': '经纬度参数无效'}), 400
        if not _validate_file_name(file_name):
            return jsonify({'success': False, 'error': 'file_name 鍙厑璁稿瓧姣嶃€佹暟瀛椼€佷笅鍒掔嚎鍜岃繛瀛楃'}), 400

        if gas_type not in ('CO', 'NO2'):
            return jsonify({'success': False, 'error': f'涓嶆敮鎸佺殑姘斾綋绫诲瀷: {gas_type}锛屼粎鏀寔 CO, NO2'}), 400

        print(f"馃敩 澶勭悊 {gas_type} 璇锋眰: {location_name} ({lat}, {lon})")

        gas_configs = {
            'NO2': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_NO2',
                'band': 'tropospheric_NO2_column_number_density',
                'unit': 'mol/m虏',
                'palette': ['black', 'blue', 'purple', 'cyan', 'green', 'yellow', 'red'],
                'det_threshold': 0.00005,  # 50 渭mol/m虏, NO鈧傚亸楂橀槇鍊?
            },
            'CO': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_CO',
                'band': 'CO_column_number_density',
                'unit': 'mol/m虏',
                'palette': ['black', 'blue', 'purple', 'cyan', 'green', 'yellow', 'red'],
                'det_threshold': 0.035,  # 0.035 mol/m虏, CO鍋忛珮闃堝€?
            }
        }
        config = gas_configs[gas_type]

        # 杈撳嚭鐩綍
        final_output_dir = os.path.join(os.path.dirname(__file__), '..', 'output', file_name)
        final_output_dir = os.path.abspath(final_output_dir)
        os.makedirs(final_output_dir, exist_ok=True)

        # 浠ョ洰鏍囩偣涓轰腑蹇冩瀯寤?ROI锛堢害 0.5掳 鈮?55km锛?
        half_deg = 0.5
        roi = ee.Geometry.Rectangle([lon - half_deg, lat - half_deg, lon + half_deg, lat + half_deg])

        # 鑾峰彇 S5P 鏁版嵁
        collection = ee.ImageCollection(config['collection']) \
            .filterBounds(roi) \
            .filterDate(time_start, time_end) \
            .select(config['band'])

        count = _gee_call_with_retry(lambda: collection.size().getInfo())
        if count == 0:
            return jsonify({'success': False, 'error': f'{gas_type} 在时间段 {time_start}~{time_end} 无数据'}), 404

        median_img = collection.median().clip(roi)

        # 鑾峰彇娴撳害鏁版嵁
        pixel_data = _gee_call_with_retry(lambda: median_img.sampleRectangle(region=roi, defaultValue=0).getInfo())
        band_data = pixel_data['properties'][config['band']]
        image_array = np.array(band_data, dtype=np.float64)

        if image_array.size == 0:
            return jsonify({'success': False, 'error': '获取的影像数据为空'}), 400

        h, w = image_array.shape
        mean_conc = float(np.nanmean(image_array))
        max_conc = float(np.nanmax(image_array))

        # 鐢熸垚浼僵鑹叉祿搴﹀浘浣滀负 RGB
        from PIL import Image
        import matplotlib.cm as cm

        norm_arr = image_array.copy()
        vmin, vmax = np.nanpercentile(norm_arr[norm_arr > 0], [5, 95]) if np.any(norm_arr > 0) else (0, 1)
        if vmax <= vmin:
            vmax = vmin + 1e-10
        norm_arr = np.clip((norm_arr - vmin) / (vmax - vmin), 0, 1)
        norm_arr = np.nan_to_num(norm_arr, nan=0.0)

        colormap = cm.get_cmap('jet')
        rgb_arr = (colormap(norm_arr)[:, :, :3] * 255).astype(np.uint8)

        # 缂╂斁鍒?80x80
        rgb_img = Image.fromarray(rgb_arr).resize((80, 80), Image.BILINEAR)
        rgb_path = os.path.join(final_output_dir, 'rgb.png')
        rgb_img.save(rgb_path)

        # 鐢熸垚妫€娴嬫帺鑶滐紙楂樹簬绉戝闃堝€煎尯鍩熸爣涓烘鍑猴級
        det_threshold = config['det_threshold']
        mask_arr = (image_array > det_threshold).astype(np.uint8) * 255
        mask_img = Image.fromarray(mask_arr, mode='L').resize((80, 80), Image.NEAREST)
        mask_path = os.path.join(final_output_dir, 'mask.png')
        mask_img.save(mask_path)

        detection_ratio = float(np.mean(image_array > det_threshold))
        print(f"鉁?{gas_type} 鍒嗘瀽瀹屾垚: 骞冲潎娴撳害={mean_conc:.6f}, 妫€鍑虹巼={detection_ratio:.2%}")
        city_name = data.get('city', '')
        agent_workflow = run_agent_closed_loop(
            lat=float(lat),
            lon=float(lon),
            location_name=str(location_name),
            city=str(city_name),
            gas_type=gas_type,
            mean_concentration=mean_conc,
            detection_ratio=detection_ratio,
            threshold_used=float(det_threshold),
            time_start=str(time_start),
            time_end=str(time_end),
            rgb_image=f"/flaskk/output/{file_name}/rgb.png",
            mask_image=f"/flaskk/output/{file_name}/mask.png",
            operator=str(data.get('operator', 'agent-auto')),
            persist=True,
        )

        return jsonify({
            'success': True,
            'message': f'{gas_type} 澶勭悊瀹屾垚（智能体闭环已执行）',
            'images': {
                'rgb': f"http://localhost:5000/flaskk/output/{file_name}/rgb.png",
                'mask': f"http://localhost:5000/flaskk/output/{file_name}/mask.png"
            },
            'analysis_results': {
                'mean_concentration': mean_conc,
                'max_concentration': max_conc,
                'detection_ratio': detection_ratio,
                'threshold_used': float(det_threshold)
            },
            'location_info': {
                'lat': lat, 'lon': lon,
                'name': location_name,
                'city': city_name
            },
            'time_range': {'start': time_start, 'end': time_end},
            'gas_type': gas_type,
            'data_count': count,
            'image_size': {'h': h, 'w': w},
            'agent_workflow': agent_workflow
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'{gas_type} 澶勭悊澶辫触: {str(e)}'}), 500

    
@sentinel_bp.route('/process_huanghua_roi_batch', methods=['POST'])
def process_huanghua_roi_batch():
    """鍒嗘壒娆″鐞嗛粍楠匯OI鍖哄煙锛屽彧淇濆瓨鏈夌窘娴佺殑tile"""
    try:
        data = request.json
        print(f"鏀跺埌榛勯獏ROI鍖哄煙鍒嗘壒娆″鐞嗚姹? {data}")
        
        # 鍙傛暟
        scale = data.get('scale', 10)
        time_start = data.get('time_start', '2024-05-01')
        time_end = data.get('time_end', '2024-05-31')
        checkpoint_path = data.get('checkpoint_path')
        threshold = data.get('threshold', 0.5)
        grid_size_km = data.get('grid_size_km', 5)
        min_plume_ratio = data.get('min_plume_ratio', 0.01)
        
        if not checkpoint_path:
            return jsonify({'success': False, 'error': '缂哄皯蹇呰鍙傛暟: checkpoint_path'}), 400
        
        # 鍥哄畾杈撳嚭鐩綍
        output_root = "output"
        plume_output_dir = os.path.join(output_root, 'plume_tiles_roi')
        os.makedirs(plume_output_dir, exist_ok=True)
        
        with tempfile.TemporaryDirectory() as temp_dir:
            # 1) 鍒嗘壒娆′笅杞介粍楠匯OI鍖哄煙缃戞牸褰卞儚
            print("姝ラ1: 鍒嗘壒娆′笅杞介粍楠匯OI鍖哄煙缃戞牸褰卞儚...")
            grid_result = get_huanghua_region_by_grid(
                scale=scale,
                time_start=time_start,
                time_end=time_end,
                output_dir=temp_dir,
                grid_size_km=grid_size_km
            )
            
            if not grid_result['success']:
                return jsonify({'success': False, 'error': '娌℃湁鎴愬姛涓嬭浇浠讳綍缃戞牸褰卞儚'}), 400
            
            print(f"成功下载 {grid_result['successful_count']} 个与ROI相交的网格")
            
            # 2) 鍔犺浇妯″瀷
            print("姝ラ2: 鍔犺浇妯″瀷...")
            model = Unet(num_classes=2, in_channels=13)
            try:
                checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
                state_dict = checkpoint.get('model', checkpoint)
                state_dict = {k.replace('module.', ''): v for k, v in state_dict.items()}
                model.load_state_dict(state_dict)
                print("鉁?妯″瀷鍔犺浇鎴愬姛!")
            except Exception as e:
                return jsonify({'success': False, 'error': f'妯″瀷鍔犺浇澶辫触: {str(e)}'}), 400
            
            # 3) 澶勭悊姣忎釜缃戞牸锛屾娴嬬窘娴?
            print("姝ラ3: 澶勭悊缃戞牸骞舵娴嬬窘娴?..")
            all_plume_tiles = []
            
            for i, grid_info in enumerate(grid_result['grids']):
                print(f"澶勭悊缃戞牸 {i+1}/{len(grid_result['grids'])}: {grid_info['file_path']}")
                
                plume_tiles = process_and_save_plume_tiles(
                    image_path=grid_info['file_path'],
                    model=model,
                    threshold=threshold,
                    output_dir=plume_output_dir,
                    min_plume_ratio=min_plume_ratio
                )
                
                if plume_tiles:
                    print(f"  鍦ㄧ綉鏍间腑鍙戠幇 {len(plume_tiles)} 涓湁缇芥祦鐨則ile")
                    all_plume_tiles.extend(plume_tiles)
                else:
                    print(f"  缃戞牸涓湭妫€娴嬪埌缇芥祦")
            
            # 4) 鍒涘缓姒傝鍥?
            print("姝ラ4: 鍒涘缓缇芥祦妫€娴嬫瑙堝浘...")
            overview_path = create_plume_overview_map(all_plume_tiles, plume_output_dir, grid_result.get('roi_bounds'))
            
            # 5) 鍑嗗杩斿洖缁撴灉
            plume_results = []
            for tile_info in all_plume_tiles:
                plume_results.append({
                    'tile_path': tile_info['tile_path'],
                    'prob_path': tile_info['prob_path'],
                    'geo_corners': tile_info['geo_corners'],
                    'plume_ratio': tile_info['plume_ratio'],
                    'mean_prob': tile_info['mean_prob']
                })
            
            # 6) 杞崲涓篵ase64锛堝鏋滈渶瑕侊級
            images_b64 = {}
            if overview_path:
                with open(overview_path, 'rb') as f:
                    images_b64['overview'] = base64.b64encode(f.read()).decode('utf-8')
            
            return jsonify({
                'success': True,
                'message': f'榛勯獏ROI鍖哄煙鍒嗘壒娆″鐞嗗畬鎴愶紝鍙戠幇 {len(all_plume_tiles)} 涓湁缇芥祦鐨則ile',
                'plume_tiles_count': len(all_plume_tiles),
                'plume_tiles': plume_results,
                'images': images_b64,
                'overview_path': overview_path,
                'plume_output_dir': plume_output_dir,
                'roi_bounds': grid_result.get('roi_bounds'),
                'request_params': {
                    'scale': scale,
                    'time_start': time_start,
                    'time_end': time_end,
                    'threshold': threshold,
                    'grid_size_km': grid_size_km,
                    'min_plume_ratio': min_plume_ratio
                }
            })
            
    except Exception as e:
        error_traceback = traceback.format_exc()
        print(f"榛勯獏ROI鍖哄煙鍒嗘壒娆″鐞嗚繃绋嬩腑鍙戠敓閿欒: {str(e)}")
        print(f"閿欒璇︽儏: {error_traceback}")
        return jsonify({
            'success': False,
            'error': '榛勯獏ROI鍖哄煙鍒嗘壒娆″鐞嗚繃绋嬩腑鍙戠敓閿欒'
        }), 500

@sentinel_bp.route('/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'healthy', 'message': 'Backend API running (legacy compatibility layer)'})
@sentinel_bp.route('/sentinel5p_ch4_tiles', methods=['POST'])
def process_sentinel5p_ch4_tiles():
    """鍏煎鏃ф帴鍙ｏ紝杞彂鍒伴€氱敤姘斾綋鎺ュ彛"""
    return process_sentinel5p_gas_tiles()

@sentinel_bp.route('/sentinel5p_gas_tiles', methods=['POST'])
def process_sentinel5p_gas_tiles():
    """获取 Sentinel-5P 气体（CH4/CO/NO2）浓度图层瓦片。"""
    try:
        data = request.get_json()
        start_date = data.get('start_date', '2025-10-19')
        end_date = data.get('end_date', '2025-10-26')
        gas_type = data.get('gas_type', 'CH4').upper()

        # 閽堝涓嶅悓姘斾綋鐨?Earth Engine 閰嶇疆
        gas_configs = {
            'CH4': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_CH4',
                'band': 'CH4_column_volume_mixing_ratio_dry_air',
                'default_threshold': 1.9,
                'palette': ['#440154', '#482878', '#3e4989', '#31688e', '#26828e',
                            '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725']
            },
            'NO2': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_NO2',
                'band': 'tropospheric_NO2_column_number_density',
                'default_threshold': 0.00001,
                'palette': ['black', 'blue', 'purple', 'cyan', 'green', 'yellow', 'red']
            },
            'CO': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_CO',
                'band': 'CO_column_number_density',
                'default_threshold': 0.02,
                'palette': ['black', 'blue', 'purple', 'cyan', 'green', 'yellow', 'red']
            }
        }

        if gas_type not in gas_configs:
            return jsonify({'success': False, 'error': f'涓嶆敮鎸佺殑姘斾綋绫诲瀷: {gas_type}锛屾敮鎸? CH4, CO, NO2'}), 400

        config = gas_configs[gas_type]
        threshold = data.get('threshold', config['default_threshold'])

        # ROI锛氭敮鎸佸墠绔紶鍏ヨ嚜瀹氫箟杈圭晫 [west, south, east, north]锛岄粯璁や腑鍥藉叏鍩?
        bounds = data.get('bounds', None)
        if bounds and len(bounds) == 4:
            roi_geom = ee.Geometry.Rectangle(bounds)
        else:
            # 榛樿涓浗澶ч檰鑼冨洿
            roi_geom = ee.Geometry.Rectangle([73.0, 18.0, 135.0, 53.5])

        # 鑾峰彇鏁版嵁
        s5p_collection = ee.ImageCollection(config['collection']) \
            .filterBounds(roi_geom) \
            .filterDate(start_date, end_date) \
            .select(config['band'])

        if _gee_call_with_retry(lambda: s5p_collection.size().getInfo()) == 0:
            return jsonify({'success': False, 'error': f'{gas_type} 鍦ㄨ鏃堕棿娈垫棤鏁版嵁'}), 404

        # 浣跨敤涓綅鏁板悎鎴愶紝骞朵弗鏍兼寜ROI瑁佸壀
        median_img = s5p_collection.median().clip(roi_geom)

        # 搴旂敤闃堝€兼帺鑶?
        median_img_masked = median_img.updateMask(median_img.gt(threshold))

        # 鍔ㄦ€佽绠楅鑹茶寖鍥?(5% - 95%)
        stats = _gee_call_with_retry(lambda: median_img_masked.reduceRegion(
            reducer=ee.Reducer.percentile([5, 95]),
            geometry=roi_geom,
            scale=5000,
            maxPixels=1e9
        ).getInfo())

        min_val = stats.get(f"{config['band']}_p5", threshold)
        max_val = stats.get(f"{config['band']}_p95", threshold * 1.5)

        vis_params = {
            'min': min_val,
            'max': max_val,
            'palette': config['palette']
        }

        # 鑾峰彇鍦板浘鐡︾墖
        mapid = _gee_call_with_retry(lambda: median_img_masked.getMapId(vis_params))
        tile_url = mapid['tile_fetcher'].url_format

        # 杩斿洖绮剧‘鐨凴OI杈圭晫鐢ㄤ簬鐩告満瀹氫綅
        roi_bounds = _gee_call_with_retry(lambda: roi_geom.bounds().getInfo())
        coords = roi_bounds['coordinates'][0]

        return jsonify({
            'success': True,
            'gas_type': gas_type,
            'url_template': tile_url,
            'roi_bounds': coords,
            'start_date': start_date,
            'end_date': end_date,
            'stats': {
                'min': min_val,
                'max': max_val,
                'threshold': threshold
            }
        })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ======================================================
# 閫氱敤澶勭悊鍑芥暟 - 鏀寔澶氱妯″紡
# ======================================================
@sentinel_bp.route('/process_sentinel_general', methods=['POST'])
def process_sentinel_general():
    """
    缁熶竴澶勭悊鎺ュ彛
    鍙傛暟锛?
        mode: 'single' / 'roi' / 'sentinel5p_gas'
        gas_type: 'CH4' / 'CO' / 'NO2' (褰?mode 涓?sentinel5p_gas 鏃堕渶鎻愪緵锛岄粯璁?CH4)
    """
    try:
        data = request.json
        mode = data.get('mode', 'single')

        print(f"馃摗 鏀跺埌澶勭悊璇锋眰锛屾ā寮? {mode}")
        print(f"   鍙傛暟: {list(data.keys())}")

        if mode == 'single':
            return process_sentinel()
        elif mode == 'roi':
            return process_huanghua_roi_batch()
        elif mode in ('sentinel5p_gas', 'sentinel5p_ch4'):
            return process_sentinel5p_gas_tiles()
        else:
            return jsonify({
                'success': False,
                'error': f'鏈煡妯″紡: {mode}锛屾敮鎸佺殑妯″紡: single, roi, sentinel5p_gas'
            }), 400

    except Exception as e:
        error_traceback = traceback.format_exc()
        print(f"鉂?澶勭悊杩囩▼涓彂鐢熼敊璇? {str(e)}")
        return jsonify({
            'success': False,
            'error': '处理过程中发生错误'
        }), 500


# ============ 闅忔満鎺╄啘鎺ュ彛 ============
@sentinel_bp.route('/get_random_mask', methods=['GET'])
def get_random_mask():
    """鑾峰彇闅忔満鎺╄啘鍥剧墖 - 浠?unetme 鐩綍闅忔満閫夋嫨 PNG"""
    import random
    from PIL import Image
    import io
    
    try:
        # unetme 鐩綍锛堢粷瀵硅矾寰勶級
        unetme_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'unetme')
        print(f"馃搨 鎺╄啘鐩綍: {unetme_dir}")
        
        if not os.path.exists(unetme_dir):
            print(f"鉂?鎺╄啘鐩綍涓嶅瓨鍦? {unetme_dir}")
            return jsonify({'success': False, 'error': '掩膜目录不存在'}), 404
        
        # 鑾峰彇鎵€鏈塒NG鏂囦欢
        png_files = [f for f in os.listdir(unetme_dir) if f.endswith('.png')]
        
        if not png_files:
            print(f"鉂?鏈壘鍒癙NG鎺╄啘鏂囦欢")
            return jsonify({'success': False, 'error': '鏈壘鍒癙NG鎺╄啘鏂囦欢'}), 404
        
        # 闅忔満閫夋嫨涓€涓?
        random_file = random.choice(png_files)
        mask_path = os.path.join(unetme_dir, random_file)
        
        print(f"鉁?闅忔満閫夋嫨鎺╄啘: {random_file}")
        
        # 璇诲彇PNG骞惰繑鍥?
        with open(mask_path, 'rb') as f:
            img_data = f.read()
        
        img_io = io.BytesIO(img_data)
        img_io.seek(0)
        
        from flask import send_file
        return send_file(img_io, mimetype='image/png')
        
    except Exception as e:
        print(f"鉂?鑾峰彇闅忔満鎺╄啘澶辫触: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ============ 鎺掓斁鐜囪绠楁帴鍙?============
@sentinel_bp.route('/calculate_flux', methods=['POST'])
@cross_origin()
def calculate_flux():
    """浣跨敤璺ㄦ埅闈㈤€氶噺娉曡绠楃偣婧愭帓鏀剧巼"""
    try:
        req_t0 = time.perf_counter()
        stage_ms = {}
        data = request.get_json()
        gas_type = data.get('gas_type', 'CH4').upper()
        start_date = data.get('start_date', '2025-10-19')
        end_date = data.get('end_date', '2025-10-26')
        source_lat = data.get('source_lat')
        source_lon = data.get('source_lon')
        wind_speed = data.get('wind_speed', 5.0)
        wind_dir_deg = data.get('wind_dir_deg', 0.0)
        downwind_dist_px = data.get('downwind_dist_px', 3.0)
        line_length_px = data.get('line_length_px', 10.0)

        if source_lat is None or source_lon is None:
            return jsonify({'success': False, 'error': '缂哄皯 source_lat 鎴?source_lon'}), 400
        if not _validate_lat_lon(source_lat, source_lon):
            return jsonify({'success': False, 'error': '经纬度参数无效'}), 400

        # 日期有效性检查，避免无效参数导致长时间等待
        try:
            dt_start = datetime.strptime(start_date, '%Y-%m-%d')
            dt_end = datetime.strptime(end_date, '%Y-%m-%d')
            if dt_start > dt_end:
                return jsonify({'success': False, 'error': '开始日期不能晚于结束日期'}), 400
        except Exception:
            return jsonify({'success': False, 'error': '日期格式应为 YYYY-MM-DD'}), 400

        source_lat = float(source_lat)
        source_lon = float(source_lon)
        wind_speed = float(wind_speed)
        wind_dir_deg = float(wind_dir_deg)
        downwind_dist_px = float(downwind_dist_px)
        line_length_px = float(line_length_px)

        gas_configs = {
            'CH4': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_CH4',
                'band': 'CH4_column_volume_mixing_ratio_dry_air',
                'pixel_size_m': 5500.0
            },
            'NO2': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_NO2',
                'band': 'tropospheric_NO2_column_number_density',
                'pixel_size_m': 5500.0
            },
            'CO': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_CO',
                'band': 'CO_column_number_density',
                'pixel_size_m': 5500.0
            }
        }

        if gas_type not in gas_configs:
            return jsonify({'success': False, 'error': f'涓嶆敮鎸佺殑姘斾綋绫诲瀷: {gas_type}'}), 400

        config = gas_configs[gas_type]

        # 同参数重复请求优先走缓存，避免重复访问 GEE
        cache_key = (
            gas_type,
            round(source_lat, 5),
            round(source_lon, 5),
            start_date,
            end_date,
            round(wind_speed, 3),
            round(wind_dir_deg % 360.0, 2),
            round(downwind_dist_px, 2),
            round(line_length_px, 2),
        )
        _flux_cache_cleanup()
        cached = _FLUX_CACHE.get(cache_key)
        if cached and time.time() - cached.get('ts', 0) <= _FLUX_CACHE_TTL_SEC:
            payload = dict(cached['data'])
            payload['cached'] = True
            payload['elapsed_ms'] = int((time.perf_counter() - req_t0) * 1000)
            return jsonify(payload)

        image_cache_key = (
            gas_type,
            round(source_lat, 5),
            round(source_lon, 5),
            start_date,
            end_date
        )
        _flux_image_cache_cleanup()
        image_cached = False
        image_array = None
        count = None

        # 构建以排放源为中心的 ROI（约 330km x 330km）
        roi_half_deg = 1.5
        roi = ee.Geometry.Rectangle([
            source_lon - roi_half_deg, source_lat - roi_half_deg,
            source_lon + roi_half_deg, source_lat + roi_half_deg
        ])

        cached_image_item = _FLUX_IMAGE_CACHE.get(image_cache_key)
        if cached_image_item and time.time() - cached_image_item.get('ts', 0) <= _FLUX_IMAGE_CACHE_TTL_SEC:
            image_cached = True
            image_array = cached_image_item['image_array']
            count = int(cached_image_item['count'])
            stage_ms['image_cache_hit'] = 0
        else:
            # 获取 S5P 数据
            collection = ee.ImageCollection(config['collection']) \
                .filterBounds(roi) \
                .filterDate(start_date, end_date) \
                .select(config['band'])

            t0 = time.perf_counter()
            count = _gee_call_with_retry(lambda: collection.size().getInfo(), max_retries=2, delay=2)
            stage_ms['gee_count'] = int((time.perf_counter() - t0) * 1000)
            if count == 0:
                return jsonify({'success': False, 'error': f'{gas_type} 鍦ㄨ鏃堕棿娈垫棤鏁版嵁'}), 404

            median_img = collection.median().clip(roi)

            # 将影像导出为 numpy 数组
            t0 = time.perf_counter()
            pixel_data = _gee_call_with_retry(
                lambda: median_img.sampleRectangle(region=roi, defaultValue=0).getInfo(),
                max_retries=2,
                delay=2
            )
            stage_ms['gee_sample_rectangle'] = int((time.perf_counter() - t0) * 1000)
            band_data = pixel_data['properties'][config['band']]
            t0 = time.perf_counter()
            image_array = np.array(band_data, dtype=np.float64)
            stage_ms['numpy_convert'] = int((time.perf_counter() - t0) * 1000)
            _FLUX_IMAGE_CACHE[image_cache_key] = {
                'ts': time.time(),
                'image_array': image_array,
                'count': int(count),
            }

        if image_array.size == 0:
            return jsonify({'success': False, 'error': '获取的影像数据为空'}), 400

        # 璁＄畻鎺掓斁婧愬湪鍥惧儚涓殑鍍忕礌鍧愭爣
        h, w = image_array.shape
        source_x = int(w * (source_lon - (source_lon - roi_half_deg)) / (2 * roi_half_deg))
        source_y = int(h * ((source_lat + roi_half_deg) - source_lat) / (2 * roi_half_deg))
        source_x = max(0, min(source_x, w - 1))
        source_y = max(0, min(source_y, h - 1))

        # 鑷姩缂╂斁鎴潰鍙傛暟浠ラ€傞厤鍥惧儚灏哄
        max_dim = min(h, w)
        max_downwind = max(1.0, max_dim * 0.15)
        max_line_len = max(3.0, max_dim * 0.4)
        downwind_dist_px = min(downwind_dist_px, max_downwind)
        line_length_px = min(line_length_px, max_line_len)

        # 璁＄畻閫氶噺
        t0 = time.perf_counter()
        result = calculate_plume_flux(
            image_data=image_array,
            source_yx=(source_y, source_x),
            wind_speed=wind_speed,
            wind_dir_deg=wind_dir_deg,
            gas_type=gas_type,
            pixel_size_m=config['pixel_size_m'],
            downwind_dist_px=downwind_dist_px,
            line_length_px=line_length_px
        )
        stage_ms['flux_compute'] = int((time.perf_counter() - t0) * 1000)

        response_data = {
            'success': True,
            'gas_type': gas_type,
            'emission_rate_kg_s': result['flux_kg_per_s'],
            'emission_rate_kg_hr': result['flux_kg_per_hr'],
            'background_val': result['background_val'],
            'wind_speed': result['wind_speed'],
            'wind_dir_deg': result['wind_dir_deg'],
            'cross_section_profile': result['cross_section_profile'],
            'enhancement_profile': result['enhancement_profile'],
            'image_size': {'h': h, 'w': w},
            'source_pixel': {'y': source_y, 'x': source_x},
            'time_range': {'start': start_date, 'end': end_date},
            'data_count': count,
            'best_downwind_dist_px': result.get('best_downwind_dist_px'),
            'profile_type': result.get('profile_type'),
            'image_cached': image_cached,
            'cached': False,
            'timings_ms': stage_ms,
            'elapsed_ms': int((time.perf_counter() - req_t0) * 1000)
        }

        _FLUX_CACHE[cache_key] = {'ts': time.time(), 'data': response_data}

        return jsonify(response_data)

    except ValueError as ve:
        return jsonify({'success': False, 'error': str(ve)}), 400
    except Exception as e:
        print(f"鉂?鎺掓斁鐜囪绠楀け璐? {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


# ======================================================
# 环境网格接口（热力图/粒子图真实链路）
# ======================================================
@sentinel_bp.route('/env-grid', methods=['POST', 'OPTIONS'])
@cross_origin()
def env_grid():
    try:
        if request.method == 'OPTIONS':
            return jsonify({'status': 'ok'}), 200

        data = request.get_json(silent=True) or {}

        center_lon = data.get('center_lon')
        center_lat = data.get('center_lat')
        if not _validate_lat_lon(center_lat, center_lon):
            return jsonify({'success': False, 'message': '经纬度参数无效'}), 400
        center_lon = float(center_lon)
        center_lat = float(center_lat)

        requested_gas, gas_type = _normalize_requested_gas(data.get('gas_type', 'CH4'))
        if gas_type not in _GAS_LAYER_CONFIG:
            return jsonify({
                'success': False,
                'message': f'不支持的气体类型: {requested_gas}，支持: CH4 / CO / NO2'
            }), 400

        radius = _safe_float(data.get('radius'))
        if radius is None:
            radius = 0.12
        radius = max(0.03, min(radius, 1.20))

        resolution = _safe_float(data.get('resolution'))
        if resolution is None:
            resolution = 0.01
        resolution = max(0.002, min(resolution, 0.05))

        grid_size = int(max(20, min(80, round((radius * 2.0) / resolution) + 1)))

        default_start, default_end = _default_time_range(days=14)
        time_start = str(data.get('time_start') or default_start)
        time_end = str(data.get('time_end') or default_end)

        try:
            dt_start = datetime.strptime(time_start, '%Y-%m-%d')
            dt_end = datetime.strptime(time_end, '%Y-%m-%d')
        except ValueError:
            return jsonify({'success': False, 'message': '日期格式应为 YYYY-MM-DD'}), 400
        if dt_start > dt_end:
            return jsonify({'success': False, 'message': '开始日期不能晚于结束日期'}), 400

        requested_bounds = {
            'min_lon': center_lon - radius,
            'max_lon': center_lon + radius,
            'min_lat': center_lat - radius,
            'max_lat': center_lat + radius,
        }
        requested_roi = ee.Geometry.Rectangle([
            requested_bounds['min_lon'],
            requested_bounds['min_lat'],
            requested_bounds['max_lon'],
            requested_bounds['max_lat'],
        ])

        gas_cfg = _GAS_LAYER_CONFIG[gas_type]
        gas_collection = ee.ImageCollection(gas_cfg['collection']) \
            .filterBounds(requested_roi) \
            .filterDate(time_start, time_end) \
            .select(gas_cfg['band'])

        gas_count = int(_gee_call_with_retry(lambda: gas_collection.size().getInfo(), max_retries=2, delay=2))
        if gas_count <= 0:
            fallback_start, fallback_end = _default_time_range(days=60)
            gas_collection = ee.ImageCollection(gas_cfg['collection']) \
                .filterBounds(requested_roi) \
                .filterDate(fallback_start, fallback_end) \
                .select(gas_cfg['band'])
            gas_count = int(_gee_call_with_retry(lambda: gas_collection.size().getInfo(), max_retries=2, delay=2))
            if gas_count <= 0:
                return jsonify({
                    'success': False,
                    'message': f'{gas_type} 在所选时段无数据'
                }), 404
            time_start, time_end = fallback_start, fallback_end

        gas_image = gas_collection.median()
        effective_radius = radius
        effective_bounds = dict(requested_bounds)
        effective_roi = requested_roi
        gas_values = None
        gas_stats = None
        variation_note = None

        # Sentinel-5P 在小范围内可能退化成单值；仅做轻量扩圈，避免可视范围过大。
        for factor in (1.0, 1.3, 1.6, 2.0):
            try_radius = max(0.03, min(1.20, radius * factor))
            try_bounds = {
                'min_lon': center_lon - try_radius,
                'max_lon': center_lon + try_radius,
                'min_lat': center_lat - try_radius,
                'max_lat': center_lat + try_radius,
            }
            try_roi = ee.Geometry.Rectangle([
                try_bounds['min_lon'],
                try_bounds['min_lat'],
                try_bounds['max_lon'],
                try_bounds['max_lat'],
            ])
            try_values = _sample_image_grid(
                gas_image.clip(try_roi),
                gas_cfg['band'],
                try_roi,
                grid_size,
                grid_size
            )
            try_values = _repair_grid_missing(try_values, gas_type)
            try_stats = _grid_variation_stats(try_values)

            gas_values = try_values
            gas_stats = try_stats
            effective_radius = try_radius
            effective_bounds = try_bounds
            effective_roi = try_roi

            if try_stats['range'] > 1e-10 and try_stats['unique'] >= 3:
                break

        if gas_stats and (gas_stats['range'] <= 1e-10 or gas_stats['unique'] < 3):
            variation_note = (
                f'{gas_type} 在当前时段空间分辨率较低，图层变化有限。'
            )
        elif effective_radius > radius + 1e-9:
            variation_note = (
                f'{gas_type} 已自动扩大采样范围以增强空间对比。'
            )

        wind_collection = ee.ImageCollection('ECMWF/ERA5_LAND/HOURLY') \
            .filterBounds(effective_roi) \
            .filterDate(time_start, time_end) \
            .select(['u_component_of_wind_10m', 'v_component_of_wind_10m'])
        wind_count = int(_gee_call_with_retry(lambda: wind_collection.size().getInfo(), max_retries=2, delay=2))
        if wind_count <= 0:
            wind_start, wind_end = _default_time_range(days=30)
            wind_collection = ee.ImageCollection('ECMWF/ERA5_LAND/HOURLY') \
                .filterBounds(effective_roi) \
                .filterDate(wind_start, wind_end) \
                .select(['u_component_of_wind_10m', 'v_component_of_wind_10m'])
            wind_count = int(_gee_call_with_retry(lambda: wind_collection.size().getInfo(), max_retries=2, delay=2))
            if wind_count <= 0:
                return jsonify({'success': False, 'message': '风场数据不可用'}), 404

        wind_image = wind_collection.mean().clip(effective_roi)
        wind_sample = _gee_call_with_retry(
            lambda: wind_image.sampleRectangle(region=effective_roi, defaultValue=0).getInfo(),
            max_retries=2,
            delay=2,
        )
        props = (wind_sample or {}).get('properties', {})
        wind_u = _resize_array2d(props.get('u_component_of_wind_10m', []), grid_size, grid_size)
        wind_v = _resize_array2d(props.get('v_component_of_wind_10m', []), grid_size, grid_size)

        panel = _compute_panel_values(requested_roi, time_start, time_end)

        payload = {
            'bounds': {
                'min_lon': float(effective_bounds['min_lon']),
                'max_lon': float(effective_bounds['max_lon']),
                'min_lat': float(effective_bounds['min_lat']),
                'max_lat': float(effective_bounds['max_lat']),
            },
            'requested_bounds': requested_bounds,
            'grid': _build_grid_cells(
                gas_values,
                effective_bounds['min_lon'],
                effective_bounds['max_lon'],
                effective_bounds['min_lat'],
                effective_bounds['max_lat']
            ),
            'wind': {
                'u': wind_u.tolist(),
                'v': wind_v.tolist(),
            },
            'panel': panel,
            'gas_type': gas_type,
            'requested_gas_type': requested_gas,
            'requested_radius': float(radius),
            'effective_radius': float(effective_radius),
            'unit': gas_cfg['unit'],
            'source': 'GEE',
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'time_start': time_start,
            'time_end': time_end,
            'grid_size': grid_size,
            'data_count': gas_count,
            'grid_variation': gas_stats,
        }

        if variation_note:
            payload['variation_note'] = variation_note
        if requested_gas == 'N2O':
            payload['note'] = '当前 N2O 由 NO2 实时遥感值映射，前端不再使用随机值。'

        return jsonify({'success': True, 'data': payload})
    except Exception as e:
        print(f"❌ env-grid 生成失败: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': f'env-grid 生成失败: {str(e)}'}), 500


# ======================================================
# 鎵归噺绔欑偣娴撳害鏌ヨ - 涓?analysis / zhexian 椤甸潰鎻愪緵鐪熷疄鏁版嵁
# ======================================================
@sentinel_bp.route('/query_stations', methods=['POST'])
@cross_origin()
def query_stations():
    """
    鎵归噺鏌ヨ澶氫釜绔欑偣鐨?CH4 娴撳害锛堟潵鑷?Sentinel-5P锛夈€?
    璇锋眰浣? {
        stations: [{name, lat, lon}, ...],
        time_start, time_end,
        gas_type: 'CH4' (榛樿)
    }
    杩斿洖: { success, stations: [{name, lat, lon, mean_concentration, max_concentration}, ...] }
    """
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '璇锋眰鏁版嵁鏃犳晥'}), 400

        stations = data.get('stations', [])
        time_start = data.get('time_start', '2024-05-01')
        time_end = data.get('time_end', '2024-05-31')
        gas_type = data.get('gas_type', 'CH4').upper()

        gas_configs = {
            'CH4': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_CH4',
                'band': 'CH4_column_volume_mixing_ratio_dry_air',
            },
            'NO2': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_NO2',
                'band': 'tropospheric_NO2_column_number_density',
            },
            'CO': {
                'collection': 'COPERNICUS/S5P/OFFL/L3_CO',
                'band': 'CO_column_number_density',
            }
        }

        if gas_type not in gas_configs:
            return jsonify({'success': False, 'error': f'涓嶆敮鎸佺殑姘斾綋绫诲瀷: {gas_type}'}), 400
        if not stations or len(stations) > 20:
            return jsonify({'success': False, 'error': '绔欑偣鏁伴噺搴斿湪 1-20 涔嬮棿'}), 400

        config = gas_configs[gas_type]
        results = []

        for station in stations:
            name = station.get('name', '鏈煡')
            lat = station.get('lat')
            lon = station.get('lon')

            if not _validate_lat_lon(lat, lon):
                results.append({'name': name, 'error': '经纬度无效'})
                continue

            lat, lon = float(lat), float(lon)

            try:
                # 浠ョ珯鐐逛负涓績 0.2掳 鈮?22km 鐨?ROI
                half_deg = 0.2
                roi = ee.Geometry.Rectangle([lon - half_deg, lat - half_deg,
                                             lon + half_deg, lat + half_deg])

                collection = ee.ImageCollection(config['collection']) \
                    .filterBounds(roi) \
                    .filterDate(time_start, time_end) \
                    .select(config['band'])

                count = _gee_call_with_retry(lambda: collection.size().getInfo())
                if count == 0:
                    results.append({'name': name, 'lat': lat, 'lon': lon,
                                    'mean_concentration': None, 'error': '璇ユ椂娈垫棤鏁版嵁'})
                    continue

                stats = _gee_call_with_retry(lambda: collection.median().clip(roi).reduceRegion(
                    reducer=ee.Reducer.mean().combine(ee.Reducer.max(), sharedInputs=True),
                    geometry=roi,
                    scale=5000,
                    maxPixels=1e8
                ).getInfo())

                mean_val = stats.get(f"{config['band']}_mean")
                max_val = stats.get(f"{config['band']}_max")

                results.append({
                    'name': name,
                    'lat': lat,
                    'lon': lon,
                    'mean_concentration': float(mean_val) if mean_val is not None else None,
                    'max_concentration': float(max_val) if max_val is not None else None,
                    'data_count': count
                })
                print(f"鉁?绔欑偣 {name}: mean={mean_val}, max={max_val}")

            except Exception as e:
                print(f"鈿狅笍 绔欑偣 {name} 鏌ヨ澶辫触: {e}")
                results.append({'name': name, 'lat': lat, 'lon': lon, 'error': str(e)})

        return jsonify({
            'success': True,
            'gas_type': gas_type,
            'time_range': {'start': time_start, 'end': time_end},
            'stations': results
        })

    except Exception as e:
        print(f"鉂?鎵归噺绔欑偣鏌ヨ澶辫触: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': '鏌ヨ澶辫触'}), 500


@sentinel_bp.route('/query_wind', methods=['POST'])
@cross_origin()
def query_wind():
    """
    查询站点风场数据（来自 ERA5-Land）。
    请求体:
      {
        stations: [{name, lat, lon}, ...],
        time_start, time_end
      }
    返回:
      {
        success,
        stations: [{name, lat, lon, wind_speed, wind_dir_deg, data_count}, ...]
      }
    """
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': '请求数据无效'}), 400

        stations = data.get('stations', [])
        time_start = data.get('time_start', '2024-05-01')
        time_end = data.get('time_end', '2024-05-31')

        if not stations or len(stations) > 20:
            return jsonify({'success': False, 'error': '站点数量应在 1-20 之间'}), 400

        results = []

        for station in stations:
            name = station.get('name', '未知')
            lat = station.get('lat')
            lon = station.get('lon')

            if not _validate_lat_lon(lat, lon):
                results.append({'name': name, 'error': '经纬度无效'})
                continue

            lat, lon = float(lat), float(lon)

            try:
                half_deg = 0.2
                roi = ee.Geometry.Rectangle([lon - half_deg, lat - half_deg,
                                             lon + half_deg, lat + half_deg])

                collection = ee.ImageCollection('ECMWF/ERA5_LAND/HOURLY') \
                    .filterBounds(roi) \
                    .filterDate(time_start, time_end) \
                    .select(['u_component_of_wind_10m', 'v_component_of_wind_10m'])

                count = _gee_call_with_retry(lambda: collection.size().getInfo())
                if count == 0:
                    results.append({
                        'name': name,
                        'lat': lat,
                        'lon': lon,
                        'wind_speed': None,
                        'wind_dir_deg': None,
                        'error': '该时段无数据'
                    })
                    continue

                # 对 u/v 做时空平均，再换算风速和气象风向（风从哪里来）
                stats = _gee_call_with_retry(lambda: collection.mean().reduceRegion(
                    reducer=ee.Reducer.mean(),
                    geometry=roi,
                    scale=11132,
                    maxPixels=1e8
                ).getInfo())

                u_val = stats.get('u_component_of_wind_10m')
                v_val = stats.get('v_component_of_wind_10m')

                if u_val is None or v_val is None:
                    results.append({
                        'name': name,
                        'lat': lat,
                        'lon': lon,
                        'wind_speed': None,
                        'wind_dir_deg': None,
                        'error': '风场数据为空',
                        'data_count': count
                    })
                    continue

                u = float(u_val)
                v = float(v_val)
                wind_speed = float(np.sqrt(u ** 2 + v ** 2))
                # 气象风向: 0=北风, 90=东风（表示风吹来的方向）
                wind_dir_deg = float((270.0 - np.degrees(np.arctan2(v, u))) % 360.0)

                results.append({
                    'name': name,
                    'lat': lat,
                    'lon': lon,
                    'wind_speed': round(wind_speed, 2),
                    'wind_dir_deg': round(wind_dir_deg, 1),
                    'u_mean': round(u, 3),
                    'v_mean': round(v, 3),
                    'data_count': count
                })
                print(f"✅ 风场 {name}: speed={wind_speed:.2f} m/s, dir={wind_dir_deg:.1f}°")

            except Exception as e:
                print(f"⚠️ 站点 {name} 风场查询失败: {e}")
                results.append({'name': name, 'lat': lat, 'lon': lon, 'error': str(e)})

        return jsonify({
            'success': True,
            'time_range': {'start': time_start, 'end': time_end},
            'stations': results
        })

    except Exception as e:
        print(f"❌ 风场查询失败: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': '风场查询失败'}), 500
