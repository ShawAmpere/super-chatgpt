# Loaded by deploy-runtime.ps1. Single-module and workspace publication use the
# same guard; a failed compatible workspace update remains explicitly recorded.
function Invoke-McpWorkspaceGuard([string]$RuntimeBase, [scriptblock]$Action) {
  New-Item -ItemType Directory -Path $RuntimeBase -Force | Out-Null
  $guard = $null; $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not $guard) {
    try { $guard = [IO.File]::Open((Join-Path $RuntimeBase '.workspace.guard'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { if ([DateTime]::UtcNow -ge $deadline) { throw 'Workspace publication is busy.' }; Start-Sleep -Milliseconds 100 }
  }
  try { & $Action } finally { $guard.Dispose() }
}
function Get-McpComponentVersions([string]$Base, $Policy) {
  if ($Policy.format -ne 1) { throw 'Unsupported workspace compatibility policy.' }
  $versions = @{}
  foreach ($entry in $Policy.component_families.PSObject.Properties) {
    $packagePath = Assert-McpChild $Base ($entry.Name + '\package.json')
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $parts = @($package.version -split '\.')
    $family = @($entry.Value -split '\.')
    if ($package.version -notmatch '^\d+\.\d+\.\d+$' -or $parts[0] -ne $family[0] -or ($family[1] -ne '*' -and $parts[1] -ne $family[1]) -or
        ($package.mcp_compatibility -and ($package.mcp_compatibility.shared_abi -ne $Policy.shared_abi -or $package.mcp_compatibility.broker_protocol -ne $Policy.broker_protocol))) {
      throw "Incompatible workspace component: $($entry.Name)"
    }
    $versions[$entry.Name] = $package.version
  }
  return $versions
}
function Publish-McpWorkspace([string]$SourceBase, [string]$RuntimeBase = $(if ($env:LOCAL_MCP_RUNTIME_ROOT) { $env:LOCAL_MCP_RUNTIME_ROOT } else { Get-McpRuntimeRoot })) {
  $SourceBase = (Resolve-Path -LiteralPath $SourceBase).Path
  $RuntimeBase = [IO.Path]::GetFullPath($RuntimeBase)
  $policy = Get-McpWorkspacePolicy $SourceBase
  $planned = Get-McpComponentVersions $SourceBase $policy
  Invoke-McpWorkspaceGuard $RuntimeBase {
    $pendingPath = Join-Path $RuntimeBase '.workspace-pending.json'
    $journal = @{id=[Guid]::NewGuid().ToString('N');format=1;started_at=[DateTime]::UtcNow.ToString('o');planned_versions=$planned;completed=@();state='publishing'}
    if (Test-Path -LiteralPath $pendingPath) {
      $old = Get-Content -LiteralPath $pendingPath -Raw | ConvertFrom-Json
      $journal.previous_incomplete_release = $old.id
    }
    Write-McpJson $pendingPath $journal
    try {
      $names = @($policy.component_families.PSObject.Properties.Name)
      $order = @('shared','local-computer-control') + @($names | Where-Object { $_ -notin @('shared','local-computer-control','local-mcp-gateway') }) + @('local-mcp-gateway')
      foreach ($name in $order) {
        $journal.current_module = $name; Write-McpJson $pendingPath $journal
        $published = Publish-McpModule (Join-Path $SourceBase $name) $RuntimeBase -WorkspaceGuardHeld
        $journal.completed += $published
        Write-McpJson $pendingPath $journal
      }
      $actual = Get-McpComponentVersions $RuntimeBase $policy
      foreach ($name in $planned.Keys) {
        if ($planned[$name] -ne $actual[$name]) { throw "Workspace version verification failed: $name" }
        $moduleRoot = Assert-McpChild $RuntimeBase $name
        $manifest = Get-Content -LiteralPath (Join-Path $moduleRoot '.release-manifest.json') -Raw | ConvertFrom-Json
        foreach ($entry in $manifest.files.PSObject.Properties) {
          $file = Assert-McpChild $moduleRoot $entry.Name
          if ((Get-FileHash -LiteralPath $file).Hash -ne $entry.Value) { throw "Workspace file verification failed: $name/$($entry.Name)" }
        }
      }
      Write-McpJson (Join-Path $RuntimeBase '.workspace-release.json') @{format=1;id=$journal.id;verified_at=[DateTime]::UtcNow.ToString('o');versions=$actual;modules=$journal.completed;shared_abi=$policy.shared_abi;broker_protocol=$policy.broker_protocol}
      [IO.File]::Delete($pendingPath)
      $journal.completed
      try { Invoke-McpReleaseRetention $RuntimeBase -KeepPerModule $policy.release_retention.per_module -MaxBytes $policy.release_retention.max_bytes -WorkspaceGuardHeld }
      catch { Write-Warning ('Workspace verified, but backup retention could not finish: ' + $_.Exception.Message) }
    } catch {
      $journal.state = 'incomplete'; $journal.error = $_.Exception.Message
      Write-McpJson $pendingPath $journal
      throw
    }
  }
}

function Get-McpReleaseInventory([string]$Release) {
  $files = @{}; $directories = @(); $bytes = [long]0
  foreach ($entry in Get-ChildItem -LiteralPath $Release -Recurse -Force) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Managed release contains a link.' }
    $relative = $entry.FullName.Substring($Release.Length + 1)
    if ($relative -eq '.release-owned.json') { continue }
    if ($entry.PSIsContainer) { $directories += $relative }
    else { $files[$relative] = (Get-FileHash -LiteralPath $entry.FullName).Hash; $bytes += $entry.Length }
  }
  return @{files=$files;directories=$directories;bytes=$bytes}
}
function Set-McpReleaseVerified([string]$Release, [string]$Id, [string]$Module) {
  $inventory = Get-McpReleaseInventory $Release
  Write-McpJson (Join-Path $Release '.release-owned.json') @{format=1;owner='local-mcp-deployer';id=$Id;module=$Module;state='verified';verified_at=[DateTime]::UtcNow.ToString('o');inventory=$inventory}
}
function Invoke-McpReleaseRetention([string]$RuntimeBase, [int]$KeepPerModule = 3, [long]$MaxBytes = 1073741824, [switch]$DryRun, [switch]$WorkspaceGuardHeld) {
  if (-not $WorkspaceGuardHeld) {
    return Invoke-McpWorkspaceGuard $RuntimeBase { Invoke-McpReleaseRetention $RuntimeBase -KeepPerModule $KeepPerModule -MaxBytes $MaxBytes -DryRun:$DryRun -WorkspaceGuardHeld }
  }
  if ($KeepPerModule -lt 1 -or $MaxBytes -lt 0) { throw 'Invalid release retention limits.' }
  $RuntimeBase = [IO.Path]::GetFullPath($RuntimeBase)
  $releaseBase = Assert-McpChild $RuntimeBase '.releases'
  if (-not (Test-Path -LiteralPath $releaseBase)) { return }
  $protected = @{}
  $moduleNames = @((Get-McpWorkspacePolicy $RuntimeBase).component_families.PSObject.Properties.Name)
  foreach ($name in $moduleNames) {
    foreach ($file in @('.release-manifest.json','.release-pending.json')) {
      $recordPath = Assert-McpChild $RuntimeBase ($name + '\' + $file)
      if (Test-Path -LiteralPath $recordPath) {
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        if ($record.release) { $protected[$record.release] = $true }
      }
    }
  }
  foreach ($file in @('.workspace-release.json','.workspace-pending.json')) {
    $recordPath = Join-Path $RuntimeBase $file
    if (Test-Path -LiteralPath $recordPath) {
      $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
      $modules = if ($file -eq '.workspace-release.json') { @($record.modules) } else { @($record.completed) }
      foreach ($module in $modules) { if ($module.release) { $protected[$module.release] = $true } }
    }
  }
  $candidates = @(); $skipped = @()
  foreach ($folder in Get-ChildItem -LiteralPath $releaseBase -Directory -Force) {
    if ($folder.Name -notin $moduleNames) { continue }
    $safeModule = Assert-McpChild $releaseBase $folder.Name
    foreach ($releaseFolder in Get-ChildItem -LiteralPath $safeModule -Directory -Force) {
      $id = $folder.Name + '\' + $releaseFolder.Name
      $release = Assert-McpChild $releaseBase $id
      $marker = Join-Path $release '.release-owned.json'
      if (-not (Test-Path -LiteralPath $marker)) { $skipped += $id; continue }
      $metadata = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
      if ($metadata.format -ne 1 -or $metadata.owner -ne 'local-mcp-deployer' -or $metadata.id -ne $id -or $metadata.module -ne $folder.Name -or $metadata.state -ne 'verified') { $skipped += $id; continue }
      $candidates += [pscustomobject]@{id=$id;module=$folder.Name;path=$release;metadata=$metadata;bytes=[long]$metadata.inventory.bytes;protected=$protected.ContainsKey($id)}
    }
  }
  $total = [long]0; foreach ($candidate in $candidates) { $total += $candidate.bytes }
  $removed = @()
  foreach ($candidate in @($candidates | Sort-Object { $_.metadata.verified_at })) {
    $remaining = @($candidates | Where-Object { $_.module -eq $candidate.module -and $_.id -notin $removed }).Count
    if ($candidate.protected -or ($remaining -le $KeepPerModule -and $total -le $MaxBytes)) { continue }
    # Verify the complete owned tree, including unknown files/empty directories,
    # before deletion. A user addition or edit makes this backup ineligible.
    $inventory = Get-McpReleaseInventory $candidate.path
    $expectedFiles = @($candidate.metadata.inventory.files.PSObject.Properties)
    $valid = $inventory.files.Count -eq $expectedFiles.Count -and $inventory.directories.Count -eq @($candidate.metadata.inventory.directories).Count
    foreach ($entry in $expectedFiles) { if ($inventory.files[$entry.Name] -ne $entry.Value) { $valid = $false } }
    foreach ($directory in $candidate.metadata.inventory.directories) { if ($directory -notin $inventory.directories) { $valid = $false } }
    if (-not $valid) { $skipped += $candidate.id; continue }
    $target = Assert-McpChild $releaseBase $candidate.id
    if (-not $DryRun) { Remove-Item -LiteralPath $target -Recurse -Force }
    $removed += $candidate.id; $total -= $candidate.bytes
  }
  $countLimitMet = $true
  foreach ($group in @($candidates | Where-Object { $_.id -notin $removed } | Group-Object module)) {
    if ($group.Count -gt $KeepPerModule) { $countLimitMet = $false }
  }
  [pscustomobject]@{retention=$true;dry_run=[bool]$DryRun;removed=$removed;skipped=$skipped;retained_managed_bytes=$total;
    count_limit_met=$countLimitMet;limit_met=($total -le $MaxBytes -and $countLimitMet)}
}

function Invoke-McpDefaultRetention([string]$RuntimeBase) {
  $policy = Get-McpWorkspacePolicy $RuntimeBase
  try { Invoke-McpReleaseRetention $RuntimeBase -KeepPerModule $policy.release_retention.per_module -MaxBytes $policy.release_retention.max_bytes }
  catch { Write-Warning ('Publication succeeded, but backup retention could not finish: ' + $_.Exception.Message) }
}
