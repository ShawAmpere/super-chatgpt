. (Join-Path $PSScriptRoot 'runtime-config.ps1')
$ErrorActionPreference = 'Stop'

function Write-McpJson([string]$Path, $Value) {
  $temporary = $Path + '.new'
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
  else { [IO.File]::Move($temporary, $Path) }
}
function Assert-McpChild([string]$Root, [string]$Relative) {
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $target = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
  if (-not $target.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release path escaped its target directory.' }
  if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Release target is a link: $target" }
  $parent = Split-Path -Parent $target
  while ($parent.Length -ge $resolvedRoot.TrimEnd('\').Length) {
    if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Release parent is a link: $parent" }
    $next = Split-Path -Parent $parent
    if ($next -eq $parent) { break }; $parent = $next
  }
  return $target
}
function Restore-McpRelease([string]$Runtime, [string]$ReleaseBase) {
  $journalPath = Join-Path $Runtime '.release-pending.json'
  if (-not (Test-Path -LiteralPath $journalPath)) { return }
  $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
  $release = Assert-McpChild $ReleaseBase $journal.release
  if ($journal.published_hashes) {
    foreach ($relative in @($journal.files)) {
      $target = Assert-McpChild $Runtime $relative
      if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or $relative -eq '.release-manifest.json') { continue }
      $backup = Assert-McpChild (Join-Path $release 'backup') $relative
      $currentHash = (Get-FileHash -LiteralPath $target).Hash
      $publishedHash = $journal.published_hashes.PSObject.Properties[$relative].Value
      $oldHash = if (Test-Path -LiteralPath $backup -PathType Leaf) { (Get-FileHash -LiteralPath $backup).Hash } else { $null }
      if ($currentHash -ne $publishedHash -and $currentHash -ne $oldHash) { throw 'Recovery refused to overwrite a user change in the pending release. Preserve the file and resolve this conflict before rerunning.' }
    }
  }
  foreach ($relative in @($journal.files)) {
    $target = Assert-McpChild $Runtime $relative
    $backup = Assert-McpChild (Join-Path $release 'backup') $relative
    if (Test-Path -LiteralPath $backup) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -LiteralPath $backup -Destination $target -Force
    } elseif ((Test-Path -LiteralPath $target) -and $relative -in @($journal.newFiles)) {
      $quarantine = Assert-McpChild (Join-Path $release 'incomplete') $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $quarantine) -Force | Out-Null
      Move-Item -LiteralPath $target -Destination $quarantine -Force
    }
  }
  $modules = Join-Path $Runtime 'node_modules'
  $oldModules = Join-Path $release 'old-node_modules'
  if (Test-Path -LiteralPath $oldModules) {
    if (Test-Path -LiteralPath $modules) { Move-Item -LiteralPath (Assert-McpChild $Runtime 'node_modules') -Destination (Assert-McpChild $release 'incomplete-node_modules') }
    Move-Item -LiteralPath (Assert-McpChild $release 'old-node_modules') -Destination $modules
  } elseif ($journal.replaceDependencies -and -not $journal.hadDependencies -and (Test-Path -LiteralPath $modules)) {
    Move-Item -LiteralPath (Assert-McpChild $Runtime 'node_modules') -Destination (Assert-McpChild $release 'incomplete-node_modules')
  }
  [IO.File]::Delete($journalPath)
  $metadataPath = Join-Path $release '.release-owned.json'
  if (Test-Path -LiteralPath $metadataPath) {
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $metadata.state = 'recovered'
    Write-McpJson $metadataPath $metadata
  }
  Write-Host 'Recovered the previous managed release after an interrupted update.'
}
function Publish-McpModule([string]$Source, [string]$RuntimeBase = $(if ($env:LOCAL_MCP_RUNTIME_ROOT) { $env:LOCAL_MCP_RUNTIME_ROOT } else { Get-McpRuntimeRoot }), [switch]$WorkspaceGuardHeld) {
  if (-not $WorkspaceGuardHeld) {
    return Invoke-McpWorkspaceGuard $RuntimeBase { Publish-McpModule $Source $RuntimeBase -WorkspaceGuardHeld }
  }
  $Source = (Resolve-Path -LiteralPath $Source).Path
  $name = Split-Path -Leaf $Source
  if ($name -notin @('shared','local-file-reader','local-computer-control','local-mcp-gateway')) { throw 'Unexpected managed module name.' }
  $RuntimeBase = [IO.Path]::GetFullPath($RuntimeBase)
  $runtime = Assert-McpChild $RuntimeBase $name
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  $guard = $null; $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not $guard) {
    try { $guard = [IO.File]::Open((Join-Path $runtime '.publish.guard'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { if ([DateTime]::UtcNow -ge $deadline) { throw 'Runtime publication is busy.' }; Start-Sleep -Milliseconds 100 }
  }
  try {
    $releaseBase = Join-Path $RuntimeBase '.releases'
    Restore-McpRelease $runtime $releaseBase
    $manifestPath = Join-Path $runtime '.release-manifest.json'
    $previous = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }
    $files = @{}; $changed = @(); $newFiles = @()
    foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File -Force) {
      $relative = $file.FullName.Substring($Source.Length + 1)
      if ($relative -match '(^|[\\/])(node_modules|tests|\.git|__pycache__|build|[^\\/]+\.egg-info)([\\/]|$)' -or $relative -match '^\.(release|publish)') { continue }
      if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Source release contains a link: $relative" }
      $safeSource = Assert-McpChild $Source $relative
      $hash = (Get-FileHash -LiteralPath $safeSource -Algorithm SHA256).Hash
      $files[$relative] = $hash
      $destination = Assert-McpChild $runtime $relative
      if (-not (Test-Path -LiteralPath $destination)) { $changed += $relative; $newFiles += $relative }
      elseif ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $hash) { $changed += $relative }
    }
    $obsolete = @()
    if ($previous) {
      foreach ($entry in $previous.files.PSObject.Properties) {
        if (-not $files.ContainsKey($entry.Name)) {
          $destination = Assert-McpChild $runtime $entry.Name
          # User-edited/untracked files are never removed as obsolete code.
          if ((Test-Path -LiteralPath $destination) -and (Get-FileHash -LiteralPath $destination).Hash -eq $entry.Value) { $obsolete += $entry.Name }
        }
      }
    }
    $lockFile = Join-Path $Source 'package-lock.json'
    $marker = Join-Path $runtime 'node_modules\.mcp-lock-sha256'
    $needDependencies = $false; $lockHash = ''
    if (Test-Path -LiteralPath $lockFile) {
      $lockHash = (Get-FileHash -LiteralPath $lockFile).Hash
      $installed = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { '' }
      $needDependencies = $installed -ne $lockHash
      $package = Get-Content -LiteralPath (Join-Path $Source 'package.json') -Raw | ConvertFrom-Json
      foreach ($dependency in $package.dependencies.PSObject.Properties) {
        $dependencyFile = Join-Path $runtime "node_modules\$($dependency.Name)\package.json"
        if (-not (Test-Path -LiteralPath $dependencyFile) -or (Get-Content -LiteralPath $dependencyFile -Raw | ConvertFrom-Json).version -ne $dependency.Value) { $needDependencies = $true }
      }
    }
    if (-not $changed.Count -and -not $obsolete.Count -and -not $needDependencies -and $previous) { return [pscustomobject]@{module=$name;changed=0;obsolete=0;dependencies_installed=$false;release=$previous.release} }
    $releaseId = $name + '\' + [Guid]::NewGuid().ToString('N')
    $release = Assert-McpChild $releaseBase $releaseId
    $stage = Join-Path $release 'stage'; $backupRoot = Join-Path $release 'backup'
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Write-McpJson (Join-Path $release '.release-owned.json') @{format=1;owner='local-mcp-deployer';id=$releaseId;module=$name;state='staging';created_at=[DateTime]::UtcNow.ToString('o')}
    foreach ($relative in $changed) {
      $target = Assert-McpChild $stage $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $Source $relative) -Destination $target
      if ((Get-FileHash -LiteralPath $target).Hash -ne $files[$relative]) { throw 'Source changed between hashing and staging; installed release was not changed.' }
    }
    if ($needDependencies) {
      $dependencyStage = Join-Path $release 'dependencies'
      New-Item -ItemType Directory -Path $dependencyStage -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $Source 'package.json'), $lockFile -Destination $dependencyStage
      Push-Location $dependencyStage
      try { npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund | Out-Host; if ($LASTEXITCODE -ne 0) { throw 'Dependency staging failed; installed release was not changed.' } }
      finally { Pop-Location }
      [IO.File]::WriteAllText((Join-Path $dependencyStage 'node_modules\.mcp-lock-sha256'), $lockHash, [Text.UTF8Encoding]::new($false))
    }
    $managed = @($changed) + @($obsolete) + @('.release-manifest.json')
    if (-not $previous) { $newFiles += '.release-manifest.json' }
    foreach ($relative in $managed) {
      $existing = Assert-McpChild $runtime $relative
      if (Test-Path -LiteralPath $existing) {
        $backup = Assert-McpChild $backupRoot $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
        Copy-Item -LiteralPath $existing -Destination $backup
      }
    }
    $journal = @{release=$releaseId;files=$managed;newFiles=$newFiles;published_hashes=$files;replaceDependencies=$needDependencies;hadDependencies=(Test-Path -LiteralPath (Join-Path $runtime 'node_modules'))}
    Write-McpJson (Join-Path $runtime '.release-pending.json') $journal
    try {
      foreach ($relative in $changed) {
        $target = Assert-McpChild $runtime $relative; $staged = Assert-McpChild $stage $relative
        if ((Get-FileHash -LiteralPath $staged).Hash -ne $files[$relative]) { throw 'Staged release changed before publication.' }
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        if (Test-Path -LiteralPath $target) { [IO.File]::Replace($staged, $target, [NullString]::Value) } else { [IO.File]::Move($staged, $target) }
      }
      foreach ($relative in $obsolete) {
        $quarantine = Assert-McpChild (Join-Path $release 'obsolete') $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $quarantine) -Force | Out-Null
        Move-Item -LiteralPath (Assert-McpChild $runtime $relative) -Destination $quarantine
      }
      if ($needDependencies) {
        if ($journal.hadDependencies) { Move-Item -LiteralPath (Assert-McpChild $runtime 'node_modules') -Destination (Assert-McpChild $release 'old-node_modules') }
        Move-Item -LiteralPath (Assert-McpChild (Join-Path $release 'dependencies') 'node_modules') -Destination (Join-Path $runtime 'node_modules')
      }
      $dependencyFiles = @{}
      $package = Get-Content -LiteralPath (Join-Path $runtime 'package.json') -Raw | ConvertFrom-Json
      foreach ($dependency in $package.dependencies.PSObject.Properties) {
        $dependencyRoot = Assert-McpChild $runtime ('node_modules\' + $dependency.Name)
        $dependencyPackage = Get-Content -LiteralPath (Join-Path $dependencyRoot 'package.json') -Raw | ConvertFrom-Json
        $critical = @('package.json')
        if ($dependencyPackage.main) { $critical += $dependencyPackage.main }
        if ($dependency.Name -eq '@modelcontextprotocol/sdk') { $critical += @('dist/esm/client/index.js','dist/esm/server/index.js','dist/esm/shared/protocol.js') }
        foreach ($entry in $critical | Select-Object -Unique) {
          $criticalPath = Assert-McpChild $dependencyRoot $entry
          if (Test-Path -LiteralPath $criticalPath -PathType Leaf) { $dependencyFiles[$criticalPath.Substring($runtime.Length+1)] = (Get-FileHash -LiteralPath $criticalPath).Hash }
        }
      }
      Write-McpJson $manifestPath @{version=2;files=$files;dependency_files=$dependencyFiles;release=$releaseId;at=[DateTime]::UtcNow.ToString('o')}
      Set-McpReleaseVerified $release $releaseId $name
      [IO.File]::Delete((Join-Path $runtime '.release-pending.json'))
    } catch { Restore-McpRelease $runtime $releaseBase; throw }
    return [pscustomobject]@{module=$name;changed=$changed.Count;obsolete=$obsolete.Count;dependencies_installed=$needDependencies;release=$releaseId}
  } finally { $guard.Dispose() }
}

. (Join-Path $PSScriptRoot 'workspace-deploy.ps1')
