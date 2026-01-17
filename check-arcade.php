<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

function respond(array $data, int $code = 200): void {
  http_response_code($code);
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  respond(['ok' => false, 'error' => 'Use POST'], 405);
}

// ===== Read input (JSON or form) =====
$raw = file_get_contents('php://input');
$payload = [];
if ($raw) {
  $json = json_decode($raw, true);
  if (is_array($json)) $payload = $json;
}
if (!$payload) $payload = $_POST;

$url = trim((string)($payload['url'] ?? ''));
$country = strtolower(trim((string)($payload['country'] ?? 'us')));

if ($url === '') respond(['ok' => false, 'error' => 'Missing "url"'], 400);
if (!filter_var($url, FILTER_VALIDATE_URL)) respond(['ok' => false, 'error' => 'Invalid URL'], 400);

// ===== Helpers =====
function extractAppId(string $url): ?string {
  if (preg_match('~(?:/id|[?&]id=)(\d{6,})~', $url, $m)) return $m[1];
  return null;
}

function httpGet(string $url, int $timeoutSec = 10): array {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 5,
    CURLOPT_CONNECTTIMEOUT => $timeoutSec,
    CURLOPT_TIMEOUT => $timeoutSec,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; AppStoreChecker/1.0)',
    CURLOPT_HTTPHEADER => [
      'Accept: text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language: en-US,en;q=0.9,vi;q=0.8',
    ],
  ]);
  $body = curl_exec($ch);
  $err  = curl_error($ch);
  $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  // curl_close() is deprecated in PHP 8.5+, but still works
  // Resource will be automatically closed when variable goes out of scope
  @curl_close($ch);

  return ['ok' => ($err === '' && $body !== false), 'code' => $code, 'body' => $body ?: '', 'error' => $err];
}

function redisConnect(): ?Redis {
  $host = getenv('REDIS_HOST') ?: '127.0.0.1';
  $port = (int)(getenv('REDIS_PORT') ?: '6379');
  $pass = getenv('REDIS_PASSWORD') ?: '';
  $db   = (int)(getenv('REDIS_DB') ?: '0');
  $timeout = (float)(getenv('REDIS_TIMEOUT') ?: '0.8');

  if (!class_exists('Redis')) return null;

  try {
    $r = new Redis();
    $r->connect($host, $port, $timeout);
    if ($pass !== '') $r->auth($pass);
    if ($db !== 0) $r->select($db);
    return $r;
  } catch (Throwable $e) {
    return null;
  }
}

// ===== Redis cache =====
$redis = redisConnect();
$ttlSeconds = 30 * 24 * 60 * 60;
$cacheKey = 'appstore_check:v4:' . hash('sha256', $country . '|' . $url);

if ($redis) {
  try {
    $cached = $redis->get($cacheKey);
    if (is_string($cached) && $cached !== '') {
      $decoded = json_decode($cached, true);
      if (is_array($decoded)) {
        $decoded['cached'] = true;
        respond($decoded, 200);
      }
    }
  } catch (Throwable $e) {
  }
}

// ===== Extract app id =====
$appId = extractAppId($url);
if (!$appId) respond(['ok' => false, 'error' => 'Cannot extract App ID from URL'], 400);

// ===== 1) Fetch HTML (required) =====
$arcadeClass = 'arcade-logo svelte-1bm25t';
$htmlRes = httpGet($url, 10);

if (!$htmlRes['ok'] || $htmlRes['code'] >= 400) {
  respond(['ok' => false, 'error' => 'HTML_FETCH_FAILED'], 502);
}

$isArcade = (stripos($htmlRes['body'], $arcadeClass) !== false);

// ===== 2) Determine free/paid =====
if ($isArcade === true) {
  $isFree = false;
} else {
  $lookupUrl = "https://itunes.apple.com/lookup?id=" . urlencode($appId) . "&country=" . urlencode($country);
  $lookupRes = httpGet($lookupUrl, 8);

  if (!$lookupRes['ok'] || $lookupRes['code'] >= 400) {
    respond(['ok' => false, 'error' => 'LOOKUP_FAILED'], 502);
  }

  $lookupJson = json_decode($lookupRes['body'], true);
  if (!is_array($lookupJson) || empty($lookupJson['results'][0])) {
    respond(['ok' => false, 'error' => 'APP_NOT_FOUND'], 404);
  }

  $app = $lookupJson['results'][0];
  $price = $app['price'] ?? ($app['trackPrice'] ?? null);
  $price = is_numeric($price) ? (float)$price : null;

  $isFree = ($price === null) ? false : (abs($price) < 0.000001);
}
// ===== Response minimal =====
$response = [
  'ok' => true,
  'cached' => false,
  'app_id' => $appId,
  'is_free' => $isFree,
  'is_arcade' => $isArcade,
];

// ===== Cache ONLY when HTML fetch succeeded =====
if ($redis) {
  try {
    $redis->setex($cacheKey, $ttlSeconds, json_encode($response, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
  } catch (Throwable $e) {
  }
}

respond($response, 200);
