@echo off
REM SkyMethane backend launcher (FastAPI unified entry)
setlocal

echo ======================================
echo  SkyMethane Backend Launcher
echo  Mode: FastAPI (Unified Entry)
echo ======================================
echo.

cd /d "%~dp0backend"

echo [1] Current directory: %cd%
echo [2] Checking Python runtime...

set "PY_EXE="
set "PY_EXTRA="

call :probe "%LocalAppData%\Programs\Python\Python312\python.exe"
call :probe "%LocalAppData%\Programs\Python\Python311\python.exe"
call :probe "C:\ProgramData\Miniconda3\python.exe"

if not defined PY_EXE (
    where python >nul 2>&1
    if not errorlevel 1 call :probe "python"
)

if not defined PY_EXE (
    where py >nul 2>&1
    if not errorlevel 1 (
        py -3 --version >nul 2>&1
        if not errorlevel 1 call :probe "py" "-3"
    )
)

if not defined PY_EXE (
    echo ERROR: No suitable Python runtime found.
    echo A suitable runtime must run and import fastapi + uvicorn.
    echo Try: py -3 -m pip install fastapi uvicorn
    pause
    exit /b 1
)

"%PY_EXE%" %PY_EXTRA% --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Selected Python runtime cannot execute.
    pause
    exit /b 1
)

echo [2] Using Python runtime:
"%PY_EXE%" %PY_EXTRA% --version

set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":5000 .*LISTENING"') do (
    set "PORT_PID=%%P"
    goto :port_check_done
)

:port_check_done
if defined PORT_PID (
    echo ERROR: Port 5000 is already in use.
    echo PID: %PORT_PID%
    tasklist /FI "PID eq %PORT_PID%"
    echo.
    echo Stop old process and retry:
    echo   taskkill /PID %PORT_PID% /F
    pause
    exit /b 1
)

echo [3] Starting FastAPI on http://localhost:5000 ...
echo.
echo Health:   http://localhost:5000/health-fastapi
echo Legacy APIs remain available:
echo   /sentinel/*  /auth/*  /admin/*  /chat/*
echo.
echo Press Ctrl+C to stop
echo ======================================
echo.

"%PY_EXE%" %PY_EXTRA% -m uvicorn fastapi_main:app --host 0.0.0.0 --port 5000

pause
exit /b %errorlevel%

:probe
if defined PY_EXE goto :eof

set "CAND_EXE=%~1"
set "CAND_EXTRA=%~2"

if "%CAND_EXE%"=="" goto :eof

if /I not "%CAND_EXE%"=="python" if /I not "%CAND_EXE%"=="py" (
    if not exist "%CAND_EXE%" goto :eof
)

"%CAND_EXE%" %CAND_EXTRA% --version >nul 2>&1
if errorlevel 1 goto :eof

"%CAND_EXE%" %CAND_EXTRA% -c "import fastapi, uvicorn" >nul 2>&1
if errorlevel 1 goto :eof

set "PY_EXE=%CAND_EXE%"
set "PY_EXTRA=%CAND_EXTRA%"
goto :eof
