@echo off
title OsuMapperDownloader Build
cd /d "%~dp0"
echo.
echo ================================================
echo   osu! Mapper Bulk Downloader - EXE Builder
echo ================================================
echo.

:: Check Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.10+ from https://python.org
    pause
    exit /b 1
)

:: Install pinned build dependencies
echo [1/2] Installing build dependencies...
pip install -r requirements.txt pyinstaller==6.19.0 --quiet
if errorlevel 1 (
    echo [ERROR] Failed to install PyInstaller
    pause
    exit /b 1
)

:: Build the exe
echo [2/2] Building executable...
echo.
pyinstaller ^
    --onefile ^
    --noconsole ^
    --name "OsuMapperDownloader" ^
    --add-data "static;static" ^
    --hidden-import=flask ^
    --hidden-import=requests ^
    --hidden-import=webview ^
    --collect-all webview ^
    --hidden-import=tkinter ^
    --hidden-import=tkinter.filedialog ^
    app.py

if errorlevel 1 (
    echo.
    echo [ERROR] Build failed. See output above for details.
    pause
    exit /b 1
)

echo.
echo ================================================
echo   BUILD SUCCESSFUL!
echo ================================================
echo.
echo   Your EXE is at:
echo   dist\OsuMapperDownloader.exe
echo.
echo   Share just that ONE file with anyone!
echo   On first launch it will ask them to set up
echo   their osu! credentials and Songs folder.
echo.
pause
