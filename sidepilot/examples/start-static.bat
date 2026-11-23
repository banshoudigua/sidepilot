@echo off
chcp 65001 >nul
cd /d "%~dp0demo-static"
set NODE=D:\soft\node\node.exe
if not exist "%NODE%" set NODE=node
echo.
echo   启动 山间咖啡官网（纯静态，无接口）
echo   网站   http://localhost:8081
echo   改页面 http://localhost:8081/pilot
echo.
"%NODE%" server.mjs
pause
