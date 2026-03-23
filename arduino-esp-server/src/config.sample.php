<?php

declare(strict_types=1);

return [
    'db' => [
        'host' => '127.0.0.1',
        'port' => 3306,
        'name' => 'arduino_esp_platform',
        'user' => 'arduino_esp_user',
        'pass' => 'change-me',
        'charset' => 'utf8mb4',
    ],
    'app' => [
        'base_url' => 'http://192.168.2.47:8181',
        'session_name' => 'ARDUINO_ESP_SESSID',
        'timezone' => 'America/Montreal',
        'require_https' => false,
    ],
];
