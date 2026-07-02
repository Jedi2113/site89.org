<?php
header('Content-Type: text/plain; charset=UTF-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

$apiUrl = 'https://api.mcsrvstat.us/2/play.site89.org';
$context = stream_context_create([
    'http' => [
        'method' => 'GET',
        'timeout' => 3,
        'ignore_errors' => true,
        'header' => "User-Agent: Site89-Status/1.0\r\n"
    ]
]);

$response = @file_get_contents($apiUrl, false, $context);
if ($response === false) {
    echo "§6Status Unavailable";
    exit;
}

$data = json_decode($response, true);
if (!is_array($data)) {
    echo "§6Status Unavailable";
    exit;
}

$isOnline = (!empty($data['online']) || !empty($data['ip']));
if ($isOnline) {
    $players = isset($data['players']['online']) ? (int)$data['players']['online'] : 0;
    $maxPlayers = isset($data['players']['max']) ? (int)$data['players']['max'] : 0;

    echo "§aOnline | {$players}/{$maxPlayers} players";
    exit;
}

echo "§cOffline";
