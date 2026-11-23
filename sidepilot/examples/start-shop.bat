@echo off
chcp 65001 >nul
cd /d "%~dp0demo-shop"
set NODE=D:\soft\node\node.exe
if not exist "%NODE%" set NODE=node
echo.
echo   启动 山间咖啡 · 门店后台
echo   管理页 http://localhost:8080
echo   助手   http://localhost:8080/pilot
echo.
"%NODE%" server.mjs
pause
