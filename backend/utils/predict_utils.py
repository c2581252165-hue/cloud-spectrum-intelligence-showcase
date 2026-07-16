import numpy as np
import torch
from utils.tif_utils import read_tif_like_training
import matplotlib.pyplot as plt
import os

def predict_with_model(image_path, model, threshold=0.8):
    """使用模型进行预测（稳定 Sigmoid，避免 exp 溢出警告）"""
    image = read_tif_like_training(image_path)
    print(f"预处理后图像形状: {tuple(image.shape)}")

    model.eval()
    with torch.no_grad():
        output = model(image)

    output = output.squeeze(0).cpu().numpy()  # (2, h, w)

    # 使用 plume 通道 (channel 1) 的 logits
    plume_logits = output[1]  # (h, w)
    logits = np.clip(plume_logits, -50.0, 50.0)
    output_prob = 1.0 / (1.0 + np.exp(-logits))

    output_mask = (output_prob >= threshold).astype(np.uint8)
    mean_concentration = float(plume_logits[output_mask == 1].mean()) if output_mask.any() else 0.0
        
    print(f"预测输出范围: {output_prob.min():.4e} ~ {output_prob.max():.4e}")
    print(f"阈值 {threshold:.2f} → 检测比例: {output_mask.mean():.2%}")
    print(f"检测区域平均浓度值: {mean_concentration:.4f}")

    return output_prob, output_mask, mean_concentration

def create_plume_overview_map(plume_tiles_list, output_dir, roi_bounds=None):
    """创建羽流检测概览图"""
    if not plume_tiles_list:
        print("没有检测到羽流，跳过概览图创建")
        return None
    
    # 收集所有羽流tile的边界
    all_corners = []
    for tile_info in plume_tiles_list:
        all_corners.extend(tile_info['geo_corners'])
    
    # 计算整体边界
    lons = [coord[0] for coord in all_corners]
    lats = [coord[1] for coord in all_corners]
    
    # 如果没有羽流tile，使用ROI边界
    if not lons or not lats:
        if roi_bounds:
            min_lon, min_lat, max_lon, max_lat = roi_bounds
        else:
            return None
    else:
        min_lon = min(lons)
        max_lon = max(lons)
        min_lat = min(lats)
        max_lat = max(lats)
    
    overall_bounds = {
        'min_lon': min_lon,
        'max_lon': max_lon,
        'min_lat': min_lat,
        'max_lat': max_lat
    }
    
    # 创建概览图
    plt.figure(figsize=(12, 10))
    
    # 绘制每个羽流tile的位置
    for i, tile_info in enumerate(plume_tiles_list):
        corners = tile_info['geo_corners']
        lons_tile = [coord[0] for coord in corners] + [corners[0][0]]  # 闭合多边形
        lats_tile = [coord[1] for coord in corners] + [corners[0][1]]
        
        # 根据羽流比例设置颜色
        plume_ratio = tile_info['plume_ratio']
        color_intensity = min(plume_ratio * 5, 1.0)  # 增强颜色差异
        color = (color_intensity, 0.2, 0.2, 0.7)  # 红色系
        
        plt.fill(lons_tile, lats_tile, color=color, alpha=0.6)
        plt.plot(lons_tile, lats_tile, 'r-', linewidth=1)
        
        # 标注羽流比例
        center_lon = sum(lons_tile[:4]) / 4
        center_lat = sum(lats_tile[:4]) / 4
        plt.text(center_lon, center_lat, f'{plume_ratio:.1%}', 
                fontsize=8, ha='center', va='center', color='darkred')
    
    plt.xlabel('经度')
    plt.ylabel('纬度')
    plt.title('黄骅ROI区域羽流检测概览图')
    plt.grid(True, alpha=0.3)
    
    # 设置合适的显示范围
    lon_margin = (overall_bounds['max_lon'] - overall_bounds['min_lon']) * 0.1
    lat_margin = (overall_bounds['max_lat'] - overall_bounds['min_lat']) * 0.1
    
    plt.xlim(overall_bounds['min_lon'] - lon_margin, overall_bounds['max_lon'] + lon_margin)
    plt.ylim(overall_bounds['min_lat'] - lat_margin, overall_bounds['max_lat'] + lat_margin)
    
    overview_path = os.path.join(output_dir, 'plume_overview_map.png')
    plt.savefig(overview_path, dpi=300, bbox_inches='tight')
    plt.close()
    
    print(f"✅ 羽流概览图已保存: {overview_path}")
    return overview_path