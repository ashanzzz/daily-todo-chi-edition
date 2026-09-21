param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 8080,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$dataDirectory = Join-Path $root 'data'
$dataPrefix = $dataDirectory.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$backupDirectory = Join-Path $dataDirectory 'backups'
$dataPath = Join-Path $dataDirectory 'daily-todo-data.json'
$serverToken = [Guid]::NewGuid().ToString('N')
$maxRequestBytes = 5MB
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

function Add-ApiHeaders {
  param($Response)
  $Response.Headers['X-Daily-Todo-Local'] = 'true'
  $Response.Headers['Cache-Control'] = 'no-store'
  $Response.Headers['X-Content-Type-Options'] = 'nosniff'
}

function Send-TextResponse {
  param($Response, [int]$StatusCode, [string]$Message, [switch]$IsApi)
  if ($IsApi) { Add-ApiHeaders $Response }
  $bytes = [Text.Encoding]::UTF8.GetBytes($Message)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = 'text/plain; charset=utf-8'
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.Close()
}

function Send-JsonResponse {
  param($Response, [int]$StatusCode, $Payload)
  Add-ApiHeaders $Response
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Depth 32))
  $Response.StatusCode = $StatusCode
  $Response.ContentType = 'application/json; charset=utf-8'
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.Close()
}

function Test-AllowedHost {
  param($Request)
  return $Request.Url.Port -eq $Port -and @('localhost', '127.0.0.1') -contains $Request.Url.Host
}

function Test-AllowedOrigin {
  param($Request)
  $origin = $Request.Headers['Origin']
  if ($origin -and -not (@("http://localhost:$Port", "http://127.0.0.1:$Port") -contains $origin)) { return $false }
  return $Request.Headers['Sec-Fetch-Site'] -ne 'cross-site'
}

function Read-BoundedBody {
  param($Request)
  if ($Request.ContentLength64 -gt $maxRequestBytes) { throw [IO.InvalidDataException]::new('Payload too large.') }
  $buffer = New-Object byte[] 8192
  $stream = [IO.MemoryStream]::new()
  try {
    while (($read = $Request.InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      if ($stream.Length + $read -gt $maxRequestBytes) { throw [IO.InvalidDataException]::new('Payload too large.') }
      $stream.Write($buffer, 0, $read)
    }
    return [Text.Encoding]::UTF8.GetString($stream.ToArray())
  } finally {
    $stream.Dispose()
  }
}

function Write-AtomicText {
  param([string]$Path, [string]$Content)
  $directory = Split-Path -Parent $Path
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $tempPath = Join-Path $directory ".daily-todo-$([Guid]::NewGuid().ToString('N')).tmp"
  [IO.File]::WriteAllText($tempPath, $Content, [Text.UTF8Encoding]::new($false))
  try {
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tempPath, $Path, $null) }
    else { [IO.File]::Move($tempPath, $Path) }
  } catch {
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
  }
}

function Test-Snapshot {
  param($Snapshot)
  if ($null -eq $Snapshot -or $null -eq $Snapshot.tasks -or $null -eq $Snapshot.prefs) { return $false }
  if ($Snapshot.tasks -is [string] -or $Snapshot.tasks -isnot [Collections.IEnumerable]) { return $false }
  if ($Snapshot.prefs -is [Collections.IEnumerable] -or $Snapshot.prefs -isnot [PSCustomObject]) { return $false }
  $tasks = @($Snapshot.tasks)
  if ($tasks.Count -gt 10000) { return $false }
  foreach ($task in $tasks) {
    if ($task -isnot [PSCustomObject]) { return $false }
    if ($task.id -isnot [string] -or $task.id -notmatch '^[A-Za-z0-9_-]{1,200}$') { return $false }
    if ($task.title -isnot [string] -or $task.title.Length -gt 2000) { return $false }
    if ($task.date -isnot [string] -or $task.date -notmatch '^\d{4}-\d{2}-\d{2}$') { return $false }
    if ($task.time -and ($task.time -isnot [string] -or $task.time -notmatch '^([01]\d|2[0-3]):[0-5]\d$')) { return $false }
    if ($task.repeat -and ($task.repeat -isnot [string] -or @('none', 'daily', 'weekdays', 'weekly') -notcontains $task.repeat)) { return $false }
    if ($task.important -isnot [bool] -or $task.completed -isnot [bool]) { return $false }
    if ($null -ne $task.notes -and $task.notes -isnot [string]) { return $false }
    if ($task.notes -and $task.notes.Length -gt 20000) { return $false }
  }
  return $true
}

function Read-Envelope {
  if (-not (Test-Path -LiteralPath $dataPath -PathType Leaf)) { return $null }
  $value = ([IO.File]::ReadAllText($dataPath, [Text.Encoding]::UTF8)) | ConvertFrom-Json
  if ($null -eq $value.tasks -or $null -eq $value.prefs) { throw 'The local data file has an invalid format.' }
  $revision = if ([string]$value.revision -match '^\d+$') { [int64]$value.revision } else { 0 }
  return [PSCustomObject]@{
    schemaVersion = 1
    revision = $revision
    savedAt = if ($value.savedAt) { $value.savedAt } else { '' }
    tasks = $value.tasks
    prefs = $value.prefs
  }
}

function Save-DailyBackup {
  param([string]$Content)
  $date = Get-Date -Format 'yyyy-MM-dd'
  Write-AtomicText -Path (Join-Path $backupDirectory "daily-todo-backup-$date.json") -Content $Content
}

function Clear-ExpiredBackups {
  $cutoff = (Get-Date).Date.AddDays(-89)
  Get-ChildItem -LiteralPath $backupDirectory -Filter 'daily-todo-backup-*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
    $match = [regex]::Match($_.Name, '^daily-todo-backup-(\d{4}-\d{2}-\d{2})\.json$')
    if ($match.Success) {
      $date = [DateTime]::ParseExact($match.Groups[1].Value, 'yyyy-MM-dd', $null)
      if ($date -lt $cutoff) { Remove-Item -LiteralPath $_.FullName -Force }
    }
  }
}

function Handle-ConfigApi {
  param($Context)
  if (-not (Test-AllowedHost $Context.Request)) {
    Send-TextResponse -Response $Context.Response -StatusCode 403 -Message 'Forbidden.' -IsApi
    return
  }
  Send-JsonResponse -Response $Context.Response -StatusCode 200 -Payload @{ token = $serverToken; dataPath = 'data/daily-todo-data.json'; retentionDays = 90 }
}

function Handle-DataApi {
  param($Context)
  $request = $Context.Request
  $response = $Context.Response
  if (-not (Test-AllowedHost $request)) {
    Send-TextResponse -Response $response -StatusCode 403 -Message 'Forbidden.' -IsApi
    return
  }
  if ($request.HttpMethod -eq 'GET') {
    if (-not (Test-Path -LiteralPath $dataPath -PathType Leaf)) {
      Send-TextResponse -Response $response -StatusCode 404 -Message 'No local data file yet.' -IsApi
      return
    }
    try {
      $envelope = Read-Envelope
      $today = Get-Date -Format 'yyyy-MM-dd'
      $snapshotPath = Join-Path $backupDirectory "daily-todo-backup-$today.json"
      $snapshotSaved = $false
      if (Test-Path -LiteralPath $snapshotPath -PathType Leaf) {
        try {
          $dailySnapshot = ([IO.File]::ReadAllText($snapshotPath, [Text.Encoding]::UTF8)) | ConvertFrom-Json
          $snapshotSaved = ([string]$dailySnapshot.revision -eq [string]$envelope.revision)
        } catch { $snapshotSaved = $false }
      }
      $envelope | Add-Member -NotePropertyName snapshotSaved -NotePropertyValue $snapshotSaved -Force
      Send-JsonResponse -Response $response -StatusCode 200 -Payload $envelope
    } catch { Send-TextResponse -Response $response -StatusCode 500 -Message 'The local data file could not be read.' -IsApi }
    return
  }
  if ($request.HttpMethod -ne 'POST') {
    Send-TextResponse -Response $response -StatusCode 405 -Message 'Method not allowed.' -IsApi
    return
  }
  if (-not (Test-AllowedOrigin $request)) {
    Send-TextResponse -Response $response -StatusCode 403 -Message 'Invalid origin.' -IsApi
    return
  }
  if (-not $request.ContentType -or -not $request.ContentType.StartsWith('application/json', [StringComparison]::OrdinalIgnoreCase)) {
    Send-TextResponse -Response $response -StatusCode 415 -Message 'Content-Type must be application/json.' -IsApi
    return
  }
  if ($request.Headers['X-Daily-Todo-Token'] -ne $serverToken) {
    Send-TextResponse -Response $response -StatusCode 403 -Message 'Invalid token.' -IsApi
    return
  }
  try {
    $requestData = (Read-BoundedBody $request) | ConvertFrom-Json
    if ([string]$requestData.baseRevision -notmatch '^\d+$' -or -not (Test-Snapshot $requestData.snapshot)) {
      Send-TextResponse -Response $response -StatusCode 400 -Message 'Invalid data payload.' -IsApi
      return
    }
    $baseRevision = [int64]$requestData.baseRevision
    $current = Read-Envelope
    $currentRevision = if ($current) { $current.revision } else { 0 }
    if ($baseRevision -ne $currentRevision) {
      Send-JsonResponse -Response $response -StatusCode 409 -Payload @{ conflict = $true; current = $current }
      return
    }
    $envelope = [PSCustomObject]@{
      schemaVersion = 1
      revision = $currentRevision + 1
      savedAt = [DateTime]::UtcNow.ToString('o')
      tasks = $requestData.snapshot.tasks
      prefs = $requestData.snapshot.prefs
    }
    $json = $envelope | ConvertTo-Json -Depth 32
    Write-AtomicText -Path $dataPath -Content $json
    $snapshotSaved = $false
    $retentionCleaned = $false
    try { Save-DailyBackup -Content $json; $snapshotSaved = $true } catch { }
    try { Clear-ExpiredBackups; $retentionCleaned = $true } catch { }
    Send-JsonResponse -Response $response -StatusCode 200 -Payload @{ activeSaved = $true; snapshotSaved = $snapshotSaved; retentionCleaned = $retentionCleaned; revision = $envelope.revision }
  } catch [IO.InvalidDataException] {
    Send-TextResponse -Response $response -StatusCode 413 -Message $_.Exception.Message -IsApi
  } catch {
    Send-TextResponse -Response $response -StatusCode 400 -Message 'Unable to save local data.' -IsApi
  }
}

try {
  $listener.Start()
  $url = "http://localhost:$Port/"
  Write-Host "Daily Todo is running at $url" -ForegroundColor Green
  Write-Host "Visible data file: $dataPath" -ForegroundColor Cyan
  Write-Host 'Keep this window open while you use the app. Press Ctrl+C to stop it.'
  if (-not $NoBrowser) { Start-Process $url }
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    if ($request.Url.AbsolutePath -eq '/api/config') { Handle-ConfigApi -Context $context; continue }
    if ($request.Url.AbsolutePath -eq '/api/data') { Handle-DataApi -Context $context; continue }
    if ($request.HttpMethod -ne 'GET') { Send-TextResponse -Response $response -StatusCode 405 -Message 'Method not allowed.'; continue }
    $relativePath = [Uri]::UnescapeDataString($request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = 'index.html' }
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $relativePath))
    if ($candidate -eq $dataDirectory -or $candidate.StartsWith($dataPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Send-TextResponse -Response $response -StatusCode 403 -Message 'Forbidden'
      continue
    }
    if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Send-TextResponse -Response $response -StatusCode 403 -Message 'Forbidden'
      continue
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      Send-TextResponse -Response $response -StatusCode 404 -Message 'Not found'
      continue
    }
    $bytes = [IO.File]::ReadAllBytes($candidate)
    $extension = [IO.Path]::GetExtension($candidate).ToLowerInvariant()
    $response.ContentType = if ($contentTypes.ContainsKey($extension)) { $contentTypes[$extension] } else { 'application/octet-stream' }
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.Close()
  }
} finally {
  if ($listener.IsListening) { $listener.Stop() }
  $listener.Close()
}
