#requires -Version 7.0
param([string]$Version = '3.0.0')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repo = Split-Path $PSScriptRoot
if ((& go env GOVERSION) -ne 'go1.27.1') { throw 'Reproducible release builds require Go 1.27.1 (set GOTOOLCHAIN=go1.27.1 to download it)' }
if ($Version -ne (Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json).version) { throw 'Release version must match package.json' }
$nodeVersion = '24.21.0'
$nodeSha = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$work = Join-Path $dist ('build-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $work 'package'
$runtime = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
$download = Join-Path $dist "node-v$nodeVersion-win-x64.zip"
if (-not (Test-Path -LiteralPath $download)) { Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $download }
if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeSha) { throw 'Pinned Node archive SHA256 mismatch' }
Expand-Archive -LiteralPath $download -DestinationPath $work
$nodeHome = Join-Path $work "node-v$nodeVersion-win-x64"
$node = Join-Path $nodeHome 'node.exe'
Copy-Item -LiteralPath $node -Destination $runtime
Copy-Item -LiteralPath (Join-Path $nodeHome 'LICENSE') -Destination (Join-Path $runtime 'NODE-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $repo 'package.json'),(Join-Path $repo 'package-lock.json') -Destination $runtime
$oldPath = $env:PATH; $oldNodePath = $env:NODE_PATH; $oldSkip = $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
$oldGoos = $env:GOOS; $oldGoarch = $env:GOARCH; $oldCgo = $env:CGO_ENABLED
try {
    $env:PATH = $nodeHome + [IO.Path]::PathSeparator + $env:PATH
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    & $node (Join-Path $nodeHome 'node_modules/npm/bin/npm-cli.js') ci --omit=dev --prefix $runtime
    $env:NODE_PATH = Join-Path $runtime 'node_modules'
    & $node (Join-Path $PSScriptRoot 'make-icon.cjs')
    Push-Location (Join-Path $PSScriptRoot 'launcher')
    try {
        $env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
        go test ./...
        go run github.com/tc-hib/go-winres@v0.3.3 make --arch amd64
        go build -trimpath -buildvcs=false '-ldflags=-H=windowsgui -s -w -buildid=' -o (Join-Path $stage 'Reestr35 ARM.exe') .
    } finally { Pop-Location }
    Copy-Item -LiteralPath (Join-Path $repo 'src'),(Join-Path $repo 'public') -Destination $stage -Recurse
    Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $runtime 'ARM-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $repo 'public/vendor/LICENSE') -Destination (Join-Path $runtime 'TABLER-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $repo 'public/vendor/ICONS-LICENSE') -Destination (Join-Path $runtime 'TABLER-ICONS-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path (& go env GOROOT) 'LICENSE') -Destination (Join-Path $runtime 'GO-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses') -Destination (Join-Path $runtime 'licenses') -Recurse
    & $node (Join-Path $PSScriptRoot 'validate-package.cjs') $stage
    # Sorted entries and fixed timestamps make ZIP content independent of checkout time.
    $zipPath = Join-Path $dist "Reestr35-ARM-v$Version-win-x64.zip"
    $stream = [IO.File]::Open($zipPath, [IO.FileMode]::Create)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = [IO.Directory]::GetFiles($stage, '*', [IO.SearchOption]::AllDirectories)
        [Array]::Sort($files, [StringComparer]::Ordinal)
        foreach ($file in $files) {
            $relative = [IO.Path]::GetRelativePath($stage, $file).Replace('\','/')
            $entry = $zip.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::new(2026,1,1,0,0,0,[TimeSpan]::Zero)
            $inputFile = [IO.File]::OpenRead($file); $outputFile = $entry.Open()
            try { $inputFile.CopyTo($outputFile) } finally { $outputFile.Dispose(); $inputFile.Dispose() }
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($zipPath + '.sha256', "$hash  $([IO.Path]::GetFileName($zipPath))`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Package: $zipPath"
    Write-Output "SHA256: $hash"
} finally {
    $env:PATH=$oldPath; $env:NODE_PATH=$oldNodePath; $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=$oldSkip
    $env:GOOS=$oldGoos; $env:GOARCH=$oldGoarch; $env:CGO_ENABLED=$oldCgo
}
