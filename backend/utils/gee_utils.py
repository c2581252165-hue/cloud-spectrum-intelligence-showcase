import ee
import os
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import rasterio
import math
import time

# 创建带重试的 requests session（应对 GEE SSL/网络瞬时故障）
def _get_retry_session(retries=3, backoff_factor=2):
    session = requests.Session()
    retry = Retry(total=retries, backoff_factor=backoff_factor,
                  status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    return session

def _gee_call_with_retry(fn, max_retries=3, delay=3):
    """对 GEE 服务端调用 (.getInfo / .getDownloadURL 等) 做重试"""
    last_err = None
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            last_err = e
            msg = str(e)
            if any(kw in msg for kw in ['SSL', 'EOF', 'RemoteDisconnected',
                                         'ConnectionReset', 'Proxy', 'timeout']):
                wait = delay * (2 ** attempt)
                print(f"  ⚠️ GEE 网络错误 (尝试 {attempt+1}/{max_retries}), {wait}s 后重试: {msg[:80]}")
                time.sleep(wait)
            else:
                raise
    raise last_err
# ================= 辅助函数 =================
def export_80x80_sentinel2_local(lat, lon, scale=10,
                                 time_start='2024-05-01',
                                 time_end='2024-05-31',
                                 file_name='sentinel2_80x80',
                                 pixels=80,
                                 output_dir='./'):
    """从 GEE 获取 ~80×80 像素的 13 波段 Sentinel-2 影像"""
    desired_bands = ['B1','B2','B3','B4','B5','B6','B7','B8','B8A','B9','B10','B11','B12']
    point = ee.Geometry.Point([lon, lat])
    half_size_m = (pixels * scale) / 2
    region = point.buffer(half_size_m).bounds()

    # 使用 harmonized 数据集，避免 S2 老数据集的弃用警告 ★★★
    datasets = [
        {'name': 'COPERNICUS/S2_HARMONIZED', 'desc': 'Level-1C harmonized (13 bands)'},
        {'name': 'COPERNICUS/S2_SR_HARMONIZED', 'desc': 'Level-2A harmonized (B10 可能缺)'}
    ]

    for dataset_info in datasets:
        try:
            dataset = dataset_info['name']
            print(f"尝试数据集: {dataset_info['desc']}")

            collection = (ee.ImageCollection(dataset)
                          .filterBounds(region)
                          .filterDate(time_start, time_end)
                          .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 5)))

            image = collection.sort('CLOUDY_PIXEL_PERCENTAGE').first()

            if image is None:
                print(f"  {dataset} 无可用影像")
                continue

            available_bands = _gee_call_with_retry(lambda: image.bandNames().getInfo())
            print(f"  可用波段: {available_bands}")

            band_images = []
            for band in desired_bands:
                if band in available_bands:
                    band_images.append(image.select(band))
                else:
                    replacement = 'B11' if 'B11' in available_bands else ('B8' if band in ['B8A','B9','B10'] else 'B4')
                    band_images.append(image.select(replacement).rename(band))

            final_image = ee.Image.cat(band_images).select(desired_bands)

            url = _gee_call_with_retry(lambda: final_image.getDownloadURL({
                'region': region,
                'scale': scale,
                'format': 'GEO_TIFF',
                'crs': 'EPSG:4326'
            }))

            output_path = os.path.join(output_dir, f"{file_name}.tif")
            print(f"📥 开始下载到本地: {output_path}")
            session = _get_retry_session()
            response = session.get(url, timeout=300)
            if response.status_code == 200:
                with open(output_path, 'wb') as f:
                    f.write(response.content)

                # 用 rasterio 检查（with 会自动关闭句柄） ★★★
                with rasterio.open(output_path) as src:
                    print(f"✅ 文件保存成功: {output_path}")
                    print(f"  尺寸: {src.width}x{src.height} 像素, 波段数: {src.count}")
                    data = src.read()
                    print(f"  数据形状: {data.shape}, 数据类型: {data.dtype}")
                
                return {
                    "success": True,
                    "file_path": output_path,
                    "bands": desired_bands,
                    "lat": lat,
                    "lon": lon,
                    "dataset": dataset,
                    "output_path": output_path
                }
            else:
                print(f"❌ 下载失败，状态码: {response.status_code}")
                continue

        except Exception as e:
            print(f"  数据集 {dataset} 处理失败: {e}")
            continue

    return {"success": False, "error": "所有数据集尝试均失败"}

def get_huanghua_roi_geometry():
    """从Earth Engine获取黄骅ROI几何形状"""
    try:
        # 加载黄骅ROI
        huanghua_roi = ee.FeatureCollection(os.getenv("GEE_HUANGHUA_ASSET", "users/your-account/huanghua"))
        
        # 获取几何形状和边界
        roi_geometry = huanghua_roi.geometry()
        bounds = roi_geometry.bounds()
        
        # 获取边界坐标
        coords = bounds.coordinates().getInfo()
        # 提取最小最大坐标
        flat_coords = [item for sublist in coords[0] for item in sublist]
        min_lon = min(flat_coords[0::2])
        max_lon = max(flat_coords[0::2])
        min_lat = min(flat_coords[1::2])
        max_lat = max(flat_coords[1::2])
        
        print(f"黄骅ROI边界: [{min_lon:.4f}, {min_lat:.4f}, {max_lon:.4f}, {max_lat:.4f}]")
        
        return {
            'geometry': roi_geometry,
            'bounds': [min_lon, min_lat, max_lon, max_lat],
            'success': True
        }
    except Exception as e:
        print(f"获取黄骅ROI失败: {e}")
        return {
            'success': False,
            'error': f'获取黄骅ROI失败: {str(e)}'
        }

def get_huanghua_region_by_grid(scale=10, 
                               time_start='2024-05-01', 
                               time_end='2024-05-31',
                               output_dir='./',
                               grid_size_km=5):
    """分批次获取黄骅ROI区域影像，避免50MB限制"""
    
    # 获取黄骅ROI几何形状和边界
    roi_info = get_huanghua_roi_geometry()
    if not roi_info['success']:
        return {"success": False, "error": roi_info.get('error', '无法获取黄骅ROI')}
    
    huanghua_geometry = roi_info['geometry']
    huanghua_bbox = roi_info['bounds']
    min_lon, min_lat, max_lon, max_lat = huanghua_bbox
    
    desired_bands = ['B1','B2','B3','B4','B5','B6','B7','B8','B8A','B9','B10','B11','B12']
    
    # 计算网格划分
    # 1度经度 ≈ 111km * cos(lat)，1度纬度 ≈ 111km
    lat_center = (min_lat + max_lat) / 2
    lon_degree_per_km = 1 / (111 * math.cos(math.radians(lat_center)))
    lat_degree_per_km = 1 / 111
    
    grid_size_degree = grid_size_km * lon_degree_per_km  # 经度方向网格大小
    
    # 计算网格数量
    lon_range = max_lon - min_lon
    lat_range = max_lat - min_lat
    
    num_cols = math.ceil(lon_range / grid_size_degree)
    num_rows = math.ceil(lat_range / (grid_size_km * lat_degree_per_km))
    
    print(f"黄骅ROI区域划分: {num_rows}行 × {num_cols}列, 每格约{grid_size_km}km×{grid_size_km}km")
    
    datasets = [
        {'name': 'COPERNICUS/S2_HARMONIZED', 'desc': 'Level-1C harmonized (13 bands)'},
        {'name': 'COPERNICUS/S2_SR_HARMONIZED', 'desc': 'Level-2A harmonized'}
    ]
    
    successful_grids = []
    
    for row in range(num_rows):
        for col in range(num_cols):
            # 计算当前网格的边界
            grid_min_lon = min_lon + col * grid_size_degree
            grid_max_lon = min(grid_min_lon + grid_size_degree, max_lon)
            grid_min_lat = min_lat + row * (grid_size_km * lat_degree_per_km)
            grid_max_lat = min(grid_min_lat + (grid_size_km * lat_degree_per_km), max_lat)
            
            grid_bbox = [grid_min_lon, grid_min_lat, grid_max_lon, grid_max_lat]
            grid_center_lon = (grid_min_lon + grid_max_lon) / 2
            grid_center_lat = (grid_min_lat + grid_max_lat) / 2
            
            # 创建网格几何形状并检查是否与黄骅ROI相交
            grid_geometry = ee.Geometry.Rectangle(grid_bbox)
            intersection = grid_geometry.intersection(huanghua_geometry, 10)  # 10米误差
            
            # 检查交集面积是否足够大
            grid_area = grid_geometry.area().getInfo()
            intersection_area = intersection.area().getInfo()
            
            if intersection_area < 10000:  # 如果交集面积小于1公顷，跳过
                print(f"跳过网格 [{row},{col}]: 与ROI交集面积太小 ({intersection_area:.0f} m²)")
                continue
            
            print(f"处理网格 [{row},{col}]: {grid_bbox}, 交集面积: {intersection_area:.0f} m²")
            
            for dataset_info in datasets:
                try:
                    dataset = dataset_info['name']
                    print(f"  尝试数据集: {dataset_info['desc']}")

                    collection = (ee.ImageCollection(dataset)
                                  .filterBounds(grid_geometry)
                                  .filterDate(time_start, time_end)
                                  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 15)))

                    image = collection.sort('CLOUDY_PIXEL_PERCENTAGE').first()

                    if image is None:
                        print(f"    {dataset} 无可用影像")
                        continue

                    available_bands = image.bandNames().getInfo()
                    print(f"    可用波段: {available_bands}")

                    # 选择需要的波段，处理缺失波段
                    band_images = []
                    for band in desired_bands:
                        if band in available_bands:
                            band_images.append(image.select(band))
                        else:
                            # 用最接近的波段替代
                            replacement = 'B11' if 'B11' in available_bands else ('B8' if band in ['B8A','B9','B10'] else 'B4')
                            band_images.append(image.select(replacement).rename(band))

                    final_image = ee.Image.cat(band_images).select(desired_bands)

                    # 使用ROI交集区域进行裁剪，减少数据量
                    final_image = final_image.clip(intersection)

                    # 获取下载URL
                    url = final_image.getDownloadURL({
                        'region': intersection,  # 使用交集区域而不是整个网格
                        'scale': scale,
                        'format': 'GEO_TIFF',
                        'crs': 'EPSG:4326'
                    })

                    grid_filename = f"huanghua_roi_grid_{row}_{col}.tif"
                    output_path = os.path.join(output_dir, grid_filename)
                    print(f"    📥 开始下载网格影像: {output_path}")
                    
                    response = requests.get(url, timeout=300)
                    if response.status_code == 200:
                        with open(output_path, 'wb') as f:
                            f.write(response.content)

                        # 验证文件
                        with rasterio.open(output_path) as src:
                            print(f"    ✅ 网格文件保存成功: {output_path}")
                            print(f"      尺寸: {src.width}x{src.height} 像素, 边界: {src.bounds}")
                            
                        successful_grids.append({
                            'file_path': output_path,
                            'bounds': grid_bbox,
                            'intersection_bounds': intersection.bounds().getInfo(),
                            'grid_coords': (row, col),
                            'center': (grid_center_lon, grid_center_lat),
                            'dataset': dataset,
                            'intersection_area': intersection_area
                        })
                        break  # 成功下载后跳出数据集循环
                    else:
                        print(f"    ❌ 下载失败，状态码: {response.status_code}")
                        continue

                except Exception as e:
                    print(f"    数据集 {dataset} 处理失败: {e}")
                    continue
            else:
                print(f"  ⚠️ 网格 [{row},{col}] 所有数据集尝试均失败")

    return {
        "success": len(successful_grids) > 0,
        "grids": successful_grids,
        "total_grids": num_rows * num_cols,
        "successful_count": len(successful_grids),
        "roi_bounds": huanghua_bbox
    }

