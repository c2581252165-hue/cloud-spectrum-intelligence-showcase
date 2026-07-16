@echo off
setlocal EnableDelayedExpansion
REM SkyMethane frontend launcher

echo ======================================
echo  SkyMethane Frontend Launcher
echo ======================================
echo.

cd /d "%~dp0frontend"
if errorlevel 1 (
    echo ERROR: Failed to enter frontend directory.
    pause
    exit /b 1
)

if not exist "login.html" (
    echo ERROR: login.html not found in %cd%
    pause
    exit /b 1
)

set "PY_EXE="
set "PY_EXTRA="
if not defined PY_EXE if exist "%LocalAppData%\Programs\Python\Python312\python.exe" set "PY_EXE=%LocalAppData%\Programs\Python\Python312\python.exe"
if not defined PY_EXE if exist "%LocalAppData%\Programs\Python\Python311\python.exe" set "PY_EXE=%LocalAppData%\Programs\Python\Python311\python.exe"
if not defined PY_EXE if exist "C:\ProgramData\Miniconda3\python.exe" set "PY_EXE=C:\ProgramData\Miniconda3\python.exe"

if not defined PY_EXE (
    where python >nul 2>&1
    if not errorlevel 1 set "PY_EXE=python"
)

if not defined PY_EXE (
    where py >nul 2>&1
    if not errorlevel 1 (
        py -3 --version >nul 2>&1
        if not errorlevel 1 (
            set "PY_EXE=py"
            set "PY_EXTRA=-3"
        )
    )
)

if not defined PY_EXE (
    echo ERROR: Python runtime not found.
    pause
    exit /b 1
)

set "PORT="
for %%P in (8080 8090) do (
    netstat -ano | findstr /R /C:":%%P .*LISTENING" >nul
    if errorlevel 1 (
        set "PORT=%%P"
        goto :port_found
    )
)

:port_found
if not defined PORT set "PORT=8090"

echo [1] Current directory: %cd%
echo [2] Python runtime:
"%PY_EXE%" %PY_EXTRA% --version
echo [3] Starting static server...
echo.
echo Frontend URL: http://localhost:%PORT%/login.html
echo Backend URL:  http://localhost:5000/health
if "%PORT%"=="8090" (
    echo Note: 8080 is already in use, switched to 8090.
)
echo.
echo Press Ctrl+C to stop
echo ======================================
echo.

"%PY_EXE%" %PY_EXTRA% -m http.server %PORT%

pause
