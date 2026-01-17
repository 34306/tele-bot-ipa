#!/bin/bash

# Start PHP built-in server for check-arcade.php
# This script should be run in the background or in a separate terminal

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PHP_SCRIPT="$SCRIPT_DIR/check-arcade.php"
PORT="${PHP_PORT:-8080}"

# Check if PHP is available
if ! command -v php &> /dev/null; then
    echo "❌ PHP is not installed or not in PATH" >&2
    exit 1
fi

# Check if check-arcade.php exists
if [ ! -f "$PHP_SCRIPT" ]; then
    echo "❌ check-arcade.php not found at: $PHP_SCRIPT" >&2
    exit 1
fi

# Start PHP built-in server with router
ROUTER="$SCRIPT_DIR/router.php"

# Check if router exists
if [ ! -f "$ROUTER" ]; then
    echo "❌ router.php not found at: $ROUTER" >&2
    exit 1
fi

# Start PHP server and capture PID
php -S localhost:$PORT "$ROUTER" > /tmp/php-server-${PORT}.log 2>&1 &
PHP_PID=$!

# Wait a moment to check if it started successfully
sleep 0.5

# Check if process is still running
if ! kill -0 $PHP_PID 2>/dev/null; then
    echo "❌ PHP server failed to start" >&2
    cat /tmp/php-server-${PORT}.log >&2
    exit 1
fi

echo $PHP_PID
