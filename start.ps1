param(
    [ValidateRange(1, 65535)][int]$Port = 4318,
    [ValidateRange(1, 8)][int]$Concurrency = 2,
    [string]$DataDir = $env:ARM_DATA_DIR
)
$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$runtimeNode = Join-Path $runtimeRoot 'bin\node.exe'
$runtimeModules = Join-Path $runtimeRoot 'node_modules'
$oldPort = $env:ARM_PORT
$oldConcurrency = $env:ARM_CONCURRENCY
$oldNodePath = $env:NODE_PATH
$oldDataDir = $env:ARM_DATA_DIR
$oldZcodeCjs = $env:ARM_ZCODE_CJS
$oldConsoleEncoding = [Console]::OutputEncoding
try {
    # Node writes UTF-8 even when Windows uses a legacy console code page.
    # PowerShell decodes native output before Tee-Object writes the log.
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $env:ARM_PORT = [string]$Port
    $env:ARM_CONCURRENCY = [string]$Concurrency
    $selectedDataDir = if ([string]::IsNullOrWhiteSpace($DataDir)) { 'local' } else { $DataDir }
    if (-not [IO.Path]::IsPathRooted($selectedDataDir)) { $selectedDataDir = Join-Path $PSScriptRoot $selectedDataDir }
    $selectedDataDir = [IO.Path]::GetFullPath($selectedDataDir)
    $env:ARM_DATA_DIR = $selectedDataDir
    New-Item -ItemType Directory -Path $selectedDataDir -Force | Out-Null
    $logsDir = Join-Path $selectedDataDir 'logs'
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    if ($env:ARM_RUNTIME_DIR) {
        $runtimeNode = Join-Path $env:ARM_RUNTIME_DIR 'node.exe'
        $env:NODE_PATH = Join-Path $env:ARM_RUNTIME_DIR 'node_modules'
    } elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules')) {
        if (-not (Test-Path -LiteralPath $runtimeNode)) { $runtimeNode = (Get-Command node -ErrorAction Stop).Source }
        $env:NODE_PATH = Join-Path $PSScriptRoot 'node_modules'
    } elseif ((Test-Path -LiteralPath $runtimeNode) -and (Test-Path -LiteralPath $runtimeModules)) {
        $env:NODE_PATH = $runtimeModules
    } else {
        $runtimeNode = (Get-Command node -ErrorAction Stop).Source
    }
    & $runtimeNode -e "require.resolve('playwright'); require.resolve('sharp');"
    if ($LASTEXITCODE -ne 0) { throw 'Нужен существующий Node с playwright и sharp. Укажите NODE_PATH; зависимости автоматически не устанавливаются.' }
    if (-not $env:ARM_ZCODE_CJS) {
        $zcodeCli = Join-Path $env:ProgramFiles 'ZCode\resources\glm\zcode.cjs'
        if (-not (Test-Path -LiteralPath $zcodeCli) -and $env:ProgramFiles -and ${env:ProgramFiles(x86)}) {
            $zcodeCli = Join-Path ${env:ProgramFiles(x86)} 'ZCode\resources\glm\zcode.cjs'
        }
        if (-not (Test-Path -LiteralPath $zcodeCli)) { throw 'ZCode CLI не найден. Установите ZCode Desktop или задайте ARM_ZCODE_CJS путём к zcode.cjs.' }
        $env:ARM_ZCODE_CJS = $zcodeCli
    }
    if (-not $env:ARM_ZCODE_API_KEY) { Write-Warning 'ARM_ZCODE_API_KEY не задан: QA-стадия будет недоступна, пока не задан API-ключ Z.ai.' }
    $serverLog = Join-Path $logsDir ('server-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
    & $runtimeNode (Join-Path $PSScriptRoot 'src\server.cjs') 2>&1 | Tee-Object -FilePath $serverLog
} finally {
    [Console]::OutputEncoding = $oldConsoleEncoding
    $env:ARM_PORT = $oldPort
    $env:ARM_CONCURRENCY = $oldConcurrency
    $env:NODE_PATH = $oldNodePath
    $env:ARM_DATA_DIR = $oldDataDir
    $env:ARM_ZCODE_CJS = $oldZcodeCjs
}
