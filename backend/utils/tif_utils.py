import torch
import numpy as np
import rasterio
import torch.nn.functional as F

def read_tif_like_training(image_path):
    """读取和预处理TIFF影像，确保输出为80x80尺寸"""
    with rasterio.open(image_path) as ds:
        image = ds.read().copy()  # 复制到内存，避免文件占用

    image = image.astype(np.float32)

    max_val = np.nanmax(image)
    if max_val > 1.5:
        # GEE下载的Sentinel-2数据是uint16(0-10000)，需要除以10000转为反射率[0,1]
        image = image / 10000.0
        image = np.clip(image, 0, 1.0)
        print(f"✅ 检测到原始DN值 (max={max_val:.2f})，已除以10000归一化到 [0,1]，归一化后 max={np.nanmax(image):.4f}")
    else:
        print(f"✅ 检测到数据已是反射率 (max={max_val:.4f})，无需除以10000")

    print(f"影像数据形状: {image.shape}")
    for i in range(image.shape[0]):
        band = image[i]
        print(f"波段 {i+1:02d}: min={np.nanmin(band):.4f}, "
              f"max={np.nanmax(band):.4f}, mean={np.nanmean(band):.4f}")

    # 调整到80x80，类似训练时的process_data
    h_img, w_img = image.shape[1], image.shape[2]  # (C, H, W)
    h_target, w_target = 80, 80
    c_img = image.shape[0]

    # 创建80x80画布
    new_image = np.zeros((c_img, h_target, w_target), dtype=image.dtype)

    # 计算居中粘贴位置
    cy_target, cx_target = h_target // 2, w_target // 2
    cy_img, cx_img = h_img // 2, w_img // 2

    t_y1 = max(0, cy_target - cy_img)
    t_x1 = max(0, cx_target - cx_img)
    t_y2 = min(h_target, cy_target + (h_img - cy_img))
    t_x2 = min(w_target, cx_target + (w_img - cx_img))

    s_y1 = max(0, cy_img - cy_target)
    s_x1 = max(0, cx_img - cx_target)
    s_y2 = min(h_img, cy_img + (h_target - cy_target))
    s_x2 = min(w_img, cx_img + (w_target - cx_target))

    new_image[:, t_y1:t_y2, t_x1:t_x2] = image[:, s_y1:s_y2, s_x1:s_x2]

    image = new_image

    print(f"预处理后图像形状: {tuple(image.shape)}")

    image = torch.tensor(image, dtype=torch.float32)
    return image.unsqueeze(0)
import rasterio
import numpy as np
import torch
import math
from rasterio.windows import Window
import os

def process_and_save_plume_tiles(image_path, model, threshold=0.8, output_dir='./', min_plume_ratio=0.15):
    """处理图像并只保存有羽流的tile"""
    
    with rasterio.open(image_path) as src:
        width = src.width
        height = src.height
        transform = src.transform
        crs = src.crs
        
        print(f"处理图像: {image_path}, 尺寸: {width}x{height}")
        
        # 计算切分数量 - 使用固定tile_size
        tile_size = 80
        overlap = 10
        
        num_cols = math.ceil(width / (tile_size - overlap))
        num_rows = math.ceil(height / (tile_size - overlap))
        
        print(f"将切分为 {num_rows} 行 x {num_cols} 列")
        
        plume_tiles_info = []
        
        for row in range(num_rows):
            for col in range(num_cols):
                # 计算窗口位置（考虑重叠）
                x_off = col * (tile_size - overlap)
                y_off = row * (tile_size - overlap)
                
                # 确保不超出边界
                win_width = min(tile_size, width - x_off)
                win_height = min(tile_size, height - y_off)
                
                if win_width <= 0 or win_height <= 0:
                    continue
                
                window = Window(x_off, y_off, win_width, win_height)
                
                # 读取数据
                tile_data = src.read(window=window)
                
                # 如果小块尺寸不足，进行填充
                if win_width < tile_size or win_height < tile_size:
                    padded_data = np.zeros((src.count, tile_size, tile_size), dtype=tile_data.dtype)
                    padded_data[:, :win_height, :win_width] = tile_data
                    tile_data = padded_data
                
                # 预处理并预测
                tile_tensor = torch.tensor(tile_data, dtype=torch.float32)
                
                # TOA数据已是0-1范围，无需归一化
                    
                # 填充
                padding = (2, 3, 2, 3)
                tile_tensor = F.pad(tile_tensor.unsqueeze(0), padding)
                
                # 预测
                model.eval()
                with torch.no_grad():
                    output = model(tile_tensor)
                
                output = output.squeeze().cpu().numpy()
                
                # Sigmoid
                logits = np.clip(output, -50.0, 50.0)
                output_prob = 1.0 / (1.0 + np.exp(-logits))
                output_mask = (output_prob >= threshold).astype(np.uint8)
                
                # 计算羽流比例
                plume_ratio = np.mean(output_mask)
                
                # 只保存有羽流的tile
                if plume_ratio >= min_plume_ratio:
                    print(f"  检测到羽流! Tile [{row},{col}], 羽流比例: {plume_ratio:.2%}")
                    
                    # 计算tile的四个角坐标
                    transform_tile = rasterio.windows.transform(window, transform)
                    
                    # 四个角坐标 (左上, 右上, 右下, 左下)
                    corners = [
                        transform_tile * (0, 0),  # 左上
                        transform_tile * (win_width, 0),  # 右上  
                        transform_tile * (win_width, win_height),  # 右下
                        transform_tile * (0, win_height)  # 左下
                    ]
                    
                    # 保存tile的原始数据
                    tile_filename = f"plume_tile_{os.path.basename(image_path).replace('.tif', '')}_{row}_{col}.tif"
                    tile_output_path = os.path.join(output_dir, tile_filename)
                    
                    with rasterio.open(tile_output_path, 'w',
                                     driver='GTiff',
                                     height=win_height,
                                     width=win_width,
                                     count=src.count,
                                     dtype=tile_data.dtype,
                                     crs=crs,
                                     transform=transform_tile) as dst:
                        # 写入原始数据（去除填充）
                        actual_data = tile_data[:, :win_height, :win_width] if (win_width < tile_size or win_height < tile_size) else tile_data
                        dst.write(actual_data)
                    
                    # 保存预测结果
                    prob_filename = f"plume_prob_{os.path.basename(image_path).replace('.tif', '')}_{row}_{col}.tif"
                    prob_output_path = os.path.join(output_dir, prob_filename)
                    
                    with rasterio.open(prob_output_path, 'w',
                                     driver='GTiff',
                                     height=win_height,
                                     width=win_width,
                                     count=1,
                                     dtype='float32',
                                     crs=crs,
                                     transform=transform_tile) as dst:
                        # 调整概率图尺寸以匹配实际窗口
                        actual_prob = output_prob[:win_height, :win_width] if output_prob.shape != (win_height, win_width) else output_prob
                        dst.write(actual_prob.astype(np.float32), 1)
                    
                    plume_tiles_info.append({
                        'tile_path': tile_output_path,
                        'prob_path': prob_output_path,
                        'grid_coords': (row, col),
                        'pixel_coords': (x_off, y_off, win_width, win_height),
                        'geo_corners': corners,
                        'plume_ratio': plume_ratio,
                        'mean_prob': float(np.mean(output_prob))
                    })
        
        return plume_tiles_info

