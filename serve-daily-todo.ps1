param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Prefixes.Add("http://127.0.0.1:$Port/")

$contentTypes = @{
  '.css' = 'text/css; charset=utf-8'
  '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg' = 'image/svg+xml'
}

function Send-TextResponse {
  param($Response, [int]$StatusCode, [string]$Message)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Message)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = 'text/plain; charset=utf-8'
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.Close()
}

try {
  $listener.Start()
  $url = "http://localhost:$Port/"
  Write-Host "Daily Todo is running at $url" -ForegroundColor Green
  Write-Host 'Keep this window open while you use the app. Press Ctrl+C to stop it.'
  Start-Process $url

  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $response = $context.Response
    $relativePath = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = 'index.html' }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath))

    if (-not $candidate.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-TextResponse $response 403 'Forbidden'
      continue
    }

    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      Send-TextResponse $response 404 'Not found'
      continue
    }

    $bytes = [System.IO.File]::ReadAllBytes($candidate)
    $extension = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
    $response.ContentType = if ($contentTypes.ContainsKey($extension)) { $contentTypes[$extension] } else { 'application/octet-stream' }
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.Close()
  }
} finally {
  if ($listener.IsListening) { $listener.Stop() }
  $listener.Close()
}
