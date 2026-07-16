# SkyMethane AI Coding Guidelines

## Project Overview
SkyMethane is a methane plume detection system using Sentinel-2 satellite imagery and U-Net deep learning model. The system downloads 13-band satellite data via Google Earth Engine, processes it through a trained U-Net model, and returns RGB visualizations and detection masks.

## Architecture
- **Backend**: Flask app (`flaskk copy/main.py`) with REST API endpoints
- **Model**: U-Net with VGG16 backbone, trained on 13-channel Sentinel-2 data (B1-B12, B8A)
- **Data Flow**: User request → GEE download → Preprocessing (80x80 crop/center) → Model inference → Postprocessing → PNG outputs
- **Frontend**: HTML/JS interface for visualization and testing

## Key Conventions

### Data Processing
- **Input Size**: All images must be processed to exactly 80x80 pixels for model compatibility
- **Normalization**: Sentinel-2 data divided by 10000.0 to convert from uint16 to [0,1] reflectance
- **Bands**: Use 13 bands: ['B1','B2','B3','B4','B5','B6','B7','B8','B8A','B9','B10','B11','B12']
- **Example**: In `utils/tif_utils.py`, center-crop/pad images to 80x80 before tensor conversion

### Model Handling
- **Global Model**: Load U-Net once at Flask startup, reuse for all predictions
- **Input Channels**: Model expects (1, 13, 80, 80) tensor
- **Output**: Binary segmentation mask, threshold at 0.5 for plume detection
- **Example**: `model = Unet(num_classes=2, in_channels=13)` in `routes/sentinel_route.py`

### API Patterns
- **CORS**: Enable cross-origin for frontend integration
- **Error Handling**: Return JSON with 'success' boolean and descriptive messages
- **File Paths**: Use absolute paths, create directories with `os.makedirs(..., exist_ok=True)`
- **Example**: Routes return `{'success': True, 'images': {'rgb': '/path/to/rgb.png', 'mask': '/path/to/mask.png'}}`

### Directory Structure
- **Temp Files**: `output/temp/` for downloaded TIFs
- **Results**: `output/{file_name}/` for RGB/mask PNGs
- **Model**: `flaskk/model/best_epoch_weights.pth`
- **Logs**: `logs-sentinel/` for training outputs

### Development Workflow
- **Environment**: Use conda pytorch environment with rasterio, torch, flask, ee
- **Testing**: Run `python main.py`, test via `http://localhost:5000/test_frontend.html`
- **Debugging**: Check tensor shapes, ensure 80x80 input size prevents U-Net upsampling mismatches
- **Batch Files**: Use `run_backend.bat` for Windows deployment

### Common Patterns
- **Image Reading**: Use `rasterio.open()` with context manager to avoid file locks
- **Tensor Ops**: Convert to float32, handle NaN values in satellite data
- **Visualization**: RGB from bands [3,2,1], normalize to [0,1] before matplotlib
- **GEE Integration**: Authenticate once, use `ee.ImageCollection` for Sentinel-2 L1C/L2A data

## Critical Reminders
- Always ensure input images are exactly 80x80 pixels before model inference
- Handle missing bands by replacement (e.g., B11 for missing B10) but maintain 13 total
- Use relative paths for web URLs, absolute paths for file operations
- Test with real coordinates (e.g., lat=38.5348, lon=117.6791) to verify GEE downloads</content>
<parameter name="filePath">d:\SkyMethane\.github\copilot-instructions.md