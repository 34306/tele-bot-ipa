#!/bin/bash

# Start both PHP server and Telegram bot
# This script manages both processes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PHP_SCRIPT="$SCRIPT_DIR/start-php-server.sh"
PORT="${PHP_PORT:-8080}"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Starting Telegram IPA Bot with PHP server...${NC}"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}🛑 Shutting down...${NC}"
    if [ ! -z "$PHP_PID" ]; then
        echo "Stopping PHP server (PID: $PHP_PID)..."
        kill $PHP_PID 2>/dev/null
    fi
    if [ ! -z "$BOT_PID" ]; then
        echo "Stopping Telegram bot (PID: $BOT_PID)..."
        kill $BOT_PID 2>/dev/null
    fi
    exit 0
}

# Trap signals
trap cleanup SIGINT SIGTERM

# Start PHP server in background
echo -e "${YELLOW}📡 Starting PHP server on port $PORT...${NC}"
cd "$SCRIPT_DIR"

# Check if port is already in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo -e "${YELLOW}⚠️  Port $PORT is already in use, trying to use existing server...${NC}"
    PHP_PID=$(lsof -Pi :$PORT -sTCP:LISTEN -t | head -1)
    if [ -z "$PHP_PID" ] || ! kill -0 $PHP_PID 2>/dev/null; then
        echo -e "${RED}❌ Port $PORT is in use but process is not valid${NC}"
        exit 1
    fi
    echo -e "${GREEN}✅ Using existing PHP server (PID: $PHP_PID)${NC}"
else
    PHP_PID=$(bash "$PHP_SCRIPT" 2>&1)
    EXIT_CODE=$?
    
    # Check if script failed
    if [ $EXIT_CODE -ne 0 ] || [ -z "$PHP_PID" ] || ! [[ "$PHP_PID" =~ ^[0-9]+$ ]]; then
        echo -e "${RED}❌ Failed to start PHP server${NC}"
        if [ ! -z "$PHP_PID" ]; then
            echo "$PHP_PID" | grep -v "^[0-9]\+$" >&2
        fi
        exit 1
    fi
    
    # Wait a bit for PHP server to start
    sleep 1
    
    # Check if PHP server is running
    if ! kill -0 $PHP_PID 2>/dev/null; then
        echo -e "${RED}❌ PHP server process died immediately${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}✅ PHP server started (PID: $PHP_PID)${NC}"
echo ""

# Start Telegram bot
echo -e "${YELLOW}🤖 Starting Telegram bot...${NC}"
cd "$SCRIPT_DIR"
npm start &
BOT_PID=$!

# Wait a bit for bot to start
sleep 2

# Check if bot is running
if ! kill -0 $BOT_PID 2>/dev/null; then
    echo -e "${RED}❌ Failed to start Telegram bot${NC}"
    kill $PHP_PID 2>/dev/null
    exit 1
fi

echo -e "${GREEN}✅ Telegram bot started (PID: $BOT_PID)${NC}"
echo ""
echo -e "${GREEN}✅ Both services are running!${NC}"
echo -e "${YELLOW}PHP Server PID: $PHP_PID${NC}"
echo -e "${YELLOW}Bot PID: $BOT_PID${NC}"
echo ""
echo "Press Ctrl+C to stop both services"
echo ""

# Wait for both processes
wait
