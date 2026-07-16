import sys
import os

# 设置 UTF-8 编码
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except:
        pass
    
    # 设置环境变量
    os.environ['PYTHONIOENCODING'] = 'utf-8'

# 启动 uvicorn
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "fastapi_main:app",
        host="0.0.0.0",
        port=5000,
        reload=True,
        log_level="info"
    )
