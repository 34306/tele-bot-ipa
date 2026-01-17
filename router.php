<?php
// Router script for PHP built-in server
// Routes all requests to check-arcade.php

$requestUri = $_SERVER['REQUEST_URI'];
$scriptName = $_SERVER['SCRIPT_NAME'];

// Remove query string
$path = parse_url($requestUri, PHP_URL_PATH);

// Route to check-arcade.php
if ($path === '/check-arcade.php' || $path === '/') {
    require __DIR__ . '/check-arcade.php';
} else {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'error' => 'Not found']);
}
