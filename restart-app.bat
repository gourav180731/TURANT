@echo off
echo ========================================
echo TURANT Application Restart Script
echo ========================================
echo.

echo Step 1: Stopping any running instances...
echo Looking for Java processes on port 8080...

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do (
    echo Found process: %%a
    taskkill /PID %%a /F
    echo Process killed.
)

echo.
echo Step 2: Rebuilding application with fixes...
call mvn clean package -DskipTests

if %ERRORLEVEL% NEQ 0 (
    echo BUILD FAILED!
    pause
    exit /b 1
)

echo.
echo Step 3: Starting application...
echo Application will start on http://localhost:8080
echo Press Ctrl+C to stop the application
echo.

java -jar target\turant-0.1.0.jar

pause
